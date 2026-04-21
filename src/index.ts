import { createServer } from "node:http";

import { createSlackAdapter } from "@chat-adapter/slack";
import { createRedisState } from "@chat-adapter/state-redis";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { WebClient } from "@slack/web-api";

/** Matches @mariozechner/pi-ai ImageContent */
interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

import { type Attachment, Chat, emoji, type Message, type Thread } from "chat";

// ---------------------------------------------------------------------------
// 1. Config
// ---------------------------------------------------------------------------
const projectDir = (process.env.PI_PROJECT_DIR ?? "").replace(
  /^~/,
  process.env.HOME ?? "",
);
if (!projectDir) throw new Error("PI_PROJECT_DIR env variable is required");
const projectName = projectDir.split("/").filter(Boolean).at(-1);
console.log("[pi] Project dir:", projectDir);

const agentDir = getAgentDir();
console.log("[pi] Agent dir:", agentDir);

const PI_MODEL_ID = process.env.PI_MODEL_ID;
if (!PI_MODEL_ID) throw new Error("PI_MODEL_ID env variable is required");
const [modelProvider, modelId] = PI_MODEL_ID.split("/");
if (!modelProvider || !modelId)
  throw new Error(
    `PI_MODEL_ID must be in the form provider/model, got: ${PI_MODEL_ID}`,
  );

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const model = modelRegistry.find(modelProvider, modelId);
if (!model) throw new Error(`Model ${PI_MODEL_ID} not found`);
console.log("[pi] Model:", model.id);

const tools: string[] = ["read", "grep", "find", "ls"];
console.log("[pi] Tools:", tools.join(", "));

// ---------------------------------------------------------------------------
// 2. Resource loader (shared across all sessions)
// ---------------------------------------------------------------------------
const loader = new DefaultResourceLoader({
  cwd: projectDir,
  agentDir,
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  systemPromptOverride: () =>
    `You are a support assistant for the ${projectName} codebase, helping support agents answer questions quickly and accurately.

You answer questions about ${projectName}, including its code, architecture, features, and behaviour. For questions outside ${projectName}, reply briefly that they are outside the current project scope.

Read the most relevant project files before answering, and base each answer on what the code shows. If the code does not provide a clear answer, say that clearly.

Response format:
Question: Restate the question in your own words to confirm understanding.
Answer: A short, direct response — ideally 2–4 sentences. Use a few bullet points only when listing items.

Guidelines:
- Write for support agents who need a quick, confident answer to relay to a customer.
- Keep the total response under 80 words.
- Describe the end-user visible behaviour only — skip internal mechanics such as callbacks, services, sync flows, concerns, or how data moves between systems behind the scenes.
- Avoid code blocks entirely. Use inline \`code\` sparingly, only for field names a support agent would recognise in the UI.
- Always follow the response format: question first, then answer.
- Base answers only on files in the project directory.`,
});
await loader.reload();

// ---------------------------------------------------------------------------
// 3. Create the bot
//    Reads SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET from env automatically.
// ---------------------------------------------------------------------------

// Redis state — shared between Chat SDK and pi session persistence
const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) throw new Error("REDIS_URL env variable is required");

const state = createRedisState({ url: REDIS_URL });
await state.connect();

const SESSION_KEY_PREFIX = "pi:session:";

async function getSessionPath(threadId: string): Promise<string | null> {
  return state.get(`${SESSION_KEY_PREFIX}${threadId}`);
}

async function setSessionPath(
  threadId: string,
  sessionFile: string,
): Promise<void> {
  await state.set(`${SESSION_KEY_PREFIX}${threadId}`, sessionFile);
}

const bot = new Chat({
  userName: "pi",
  state,
  concurrency: "queue",
  adapters: {
    slack: createSlackAdapter(),
  },
});
await bot.initialize();

// ---------------------------------------------------------------------------
// Attachment helpers
// ---------------------------------------------------------------------------

async function fetchImages(attachments: Attachment[]): Promise<ImageContent[]> {
  const images: ImageContent[] = [];
  for (const attachment of attachments) {
    if (!attachment.mimeType?.startsWith("image/") || !attachment.fetchData)
      continue;
    try {
      const data = await attachment.fetchData();
      images.push({
        type: "image",
        data: data.toString("base64"),
        mimeType: attachment.mimeType,
      });
    } catch (err) {
      console.error(`[pi] Failed to fetch image ${attachment.name}:`, err);
    }
  }
  return images;
}

async function askPi(thread: Thread, message: Message): Promise<void> {
  console.log(
    `[slack] message from ${message.author.fullName}: ${message.text}`,
  );

  const existingSessionPath = await getSessionPath(thread.id);

  // Fetch image attachments
  const images = await fetchImages(message.attachments);
  if (images.length > 0)
    console.log(`[pi] attachments: ${images.length} image(s)`);

  let prompt: string;
  if (existingSessionPath) {
    // Continuing thread — pi session already has history
    prompt = message.text;
  } else {
    // New thread — fetch history for initial context
    try {
      await thread.refresh();
    } catch (err) {
      if (
        (err as { data?: { error?: string } })?.data?.error !==
        "thread_not_found"
      )
        throw err;
      console.log("[slack] no existing thread — skipping history fetch");
    }
    const history = thread.recentMessages
      .filter((m: Message) => m.id !== message.id)
      .map((m: Message) => `${m.author.fullName}: ${m.text}`)
      .join("\n");
    prompt = history
      ? `Thread context:\n${history}\n\nQuestion: ${message.text}`
      : message.text;
  }

  if (!prompt.trim() && images.length === 0) {
    console.log(`[pi] skipping empty prompt (thread=${thread.id})`);
    return;
  }

  console.log(`[pi] prompt (thread=${thread.id}): ${prompt}`);

  await thread.adapter.addReaction(thread.id, message.id, emoji.eyes);

  const sessionManager = existingSessionPath
    ? SessionManager.open(existingSessionPath as string)
    : SessionManager.create(projectDir);

  const { session } = await createAgentSession({
    cwd: projectDir,
    tools,
    sessionManager,
    model,
    resourceLoader: loader,
  });

  // Store session file path on first message in a thread
  if (!existingSessionPath && session.sessionFile) {
    await setSessionPath(thread.id, session.sessionFile);
    console.log(
      `[pi] new session for thread=${thread.id}: ${session.sessionFile}`,
    );
  }

  let response = "";

  session.subscribe((event) => {
    switch (event.type) {
      case "agent_start":
        console.log("[pi] agent start");
        break;
      case "agent_end":
        console.log("[pi] agent end");
        break;
    }
  });

  try {
    await session.prompt(prompt, images.length > 0 ? { images } : undefined);

    const last = session.messages.findLast((m) => m.role === "assistant");
    if (last && Array.isArray(last.content)) {
      response = last.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("");
    } else if (last && typeof last.content === "string") {
      response = last.content;
    }

    // Strip stray horizontal rules the model sometimes emits
    response = response
      .replace(/^---+\s*$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    console.log(`[slack] response: ${response.length} chars`);
    await thread.post(response ? { markdown: response } : "(no response)");
    await thread.adapter.removeReaction(thread.id, message.id, emoji.eyes);
    await thread.adapter.addReaction(thread.id, message.id, emoji.check);
  } catch (err) {
    console.error("[pi] session error:", err);
    await thread.adapter.removeReaction(thread.id, message.id, emoji.eyes);
    await thread.adapter.addReaction(thread.id, message.id, emoji.x);
    const msg = err instanceof Error ? err.message : String(err);
    await thread.post(`_Error: ${msg}_`);
  }
}

bot.onReaction(["thumbs_up"], async (event) => {
  if (!event.added) return;

  try {
    const raw = event.raw as { item: { channel: string; ts: string } };
    const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
    const data = await slack.chat.getPermalink({
      channel: raw.item.channel,
      message_ts: raw.item.ts,
    });
    if (data.ok) console.log(`[pi] thumbs_up ${data.permalink}`);
  } catch (err) {
    console.error("[pi] thumbs_up permalink error:", err);
  }
});

bot.onNewMention(async (thread, message) => {
  await thread.subscribe();
  await askPi(thread, message);
});

bot.onSubscribedMessage(async (thread, message) => {
  // If the message @-mentions other users but not the bot, ignore it.
  // (e.g. someone tagging a colleague to read the thread)
  const rawText = (message.raw as { text?: string }).text ?? "";
  const hasMentions = /<@[A-Z0-9]+>/.test(rawText);
  if (hasMentions && !message.isMention) {
    console.log(
      `[pi] skipping message with user mentions (no bot mention) in thread=${thread.id}`,
    );
    return;
  }
  await askPi(thread, message);
});

// ---------------------------------------------------------------------------
// 4. HTTP server
//    Bridges Node.js IncomingMessage ↔ Web-standard Request/Response so we
//    can hand requests straight to bot.webhooks.slack without extra deps.
// ---------------------------------------------------------------------------
const PORT = process.env.PORT ?? 4000;
const WEBHOOK_PATH = "/api/webhooks/slack";

const server = createServer(async (req, res) => {
  if (req.method === "POST" && req.url === WEBHOOK_PATH) {
    try {
      // Collect body chunks
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);

      // Convert to a Web-standard Request
      const webReq = new Request(
        `http://${req.headers.host ?? `localhost:${PORT}`}${req.url}`,
        {
          method: req.method,
          headers: Object.fromEntries(
            Object.entries(req.headers).filter(([, v]) => v !== undefined) as [
              string,
              string,
            ][],
          ),
          body: chunks.length ? Buffer.concat(chunks) : undefined,
        },
      );

      // Let the adapter handle it
      const webRes = await bot.webhooks.slack(webReq);

      // Write response back to Node.js
      res.statusCode = webRes.status;
      for (const [key, value] of webRes.headers.entries()) {
        res.setHeader(key, value);
      }
      const body = await webRes.arrayBuffer();
      res.end(Buffer.from(body));
    } catch (err) {
      console.error("Webhook error:", err);
      res.writeHead(500).end("Internal Server Error");
    }
  } else {
    res.writeHead(404).end("Not Found");
  }
});

server.listen(PORT);
server.on("error", (err) =>
  console.error("[server] Failed to listen:", err.message),
);
