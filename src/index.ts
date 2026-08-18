import { createServer } from "node:http";

import { createSlackAdapter } from "@chat-adapter/slack";
import { createRedisState } from "@chat-adapter/state-redis";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { WebClient } from "@slack/web-api";
import claudeExtension, { findClaudeBinary } from "./extensions/claude.ts";
import gitHistoryExtension from "./extensions/git-history.ts";
import { projectCwd } from "./extensions/utils.ts";
import { createProjectProviderServices } from "./provider-config.ts";
import {
  handleSessionPrompt,
  recoverSessionError,
  sessionErrorReply,
  sessionPathKey,
} from "./session-error.ts";

/** Matches pi-ai ImageContent */
interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

import {
  type Attachment,
  Chat,
  type EmojiValue,
  emoji,
  type Message,
  type Thread,
} from "chat";

// ---------------------------------------------------------------------------
// 1. Config
// ---------------------------------------------------------------------------
// Resolved by the claude extension rather than here, so pi's cwd and the
// directory the delegated session is confined to cannot disagree — two
// expansions of one variable is one too many.
const projectDir = projectCwd();
const projectName = projectDir.split("/").filter(Boolean).at(-1);
console.log("[pi] Project dir:", projectDir);

const agentDir = getAgentDir();
console.log("[pi] Agent dir:", agentDir);

const PI_CHAT_MODEL = process.env.PI_CHAT_MODEL;
if (!PI_CHAT_MODEL) throw new Error("PI_CHAT_MODEL env variable is required");
const [modelRef, configuredThinkingLevel = "medium"] = PI_CHAT_MODEL.split(":");
const thinkingLevel = (configuredThinkingLevel || "medium") as ThinkingLevel;
const [modelProvider, modelId] = modelRef.split("/");
if (!modelProvider || !modelId)
  throw new Error(
    `PI_CHAT_MODEL must be in the form provider/model[:thinking], got: ${PI_CHAT_MODEL}`,
  );

const { modelRuntime } = await createProjectProviderServices(
  modelProvider,
  process.env.PI_CHAT_PROVIDER_API_KEY,
);
const model = modelRuntime.getModel(modelProvider, modelId);
if (!model) throw new Error(`Model ${PI_CHAT_MODEL} not found`);
console.log("[pi] Model:", model.id);
console.log("[pi] Thinking level:", thinkingLevel);

// pi identifies intent and delegates investigation to claude. The built-in read
// tools are kept only for trivial lookups and for checking what claude reports —
// see the system prompt below.
const tools: string[] = ["read", "grep", "find", "ls", "git-history", "claude"];
console.log("[pi] Tools:", tools.join(", "));

// The claude tool drives the Claude Code CLI, which ships in a per-platform
// optional dependency and authenticates from its own credential store. Surface a
// broken install at boot rather than on the first delegation.
if (tools.includes("claude") && !findClaudeBinary()) {
  console.warn(
    "[pi] Claude Code CLI not found — the claude tool will fail. Reinstall dependencies without --omit=optional.",
  );
}

// ---------------------------------------------------------------------------
// 2. Resource loader (shared across all sessions)
// ---------------------------------------------------------------------------
const loader = new DefaultResourceLoader({
  cwd: projectDir,
  agentDir,
  noExtensions: true,
  extensionFactories: [gitHistoryExtension, claudeExtension],
  noSkills: true,
  noPromptTemplates: true,
  systemPromptOverride: () =>
    `You are a support assistant for the ${projectName} codebase, helping support agents answer questions quickly and accurately.

You answer questions about ${projectName}, including its code, architecture, features, and behaviour. For questions outside ${projectName}, reply briefly that they are outside the current project scope.

Your job is to work out what the user actually needs to know, delegate the investigation to the claude tool, and turn what comes back into a support-agent answer. You do not investigate the codebase yourself.

Delegation discipline (internal work, not part of the reply):
- Always delegate to claude before answering anything about behaviour, features, or how the product works. Do this even when you think you already know the answer, and on follow-up questions in a thread.
- Identify the real question first. Support agents often relay a customer's words, which may name the wrong feature or assume a mechanism that does not exist. Delegate the question the user needs answered, not the words they typed.
- claude starts fresh every time. It cannot see this thread, your earlier questions, or its own previous answers. Each prompt must stand entirely alone.
- Write the delegation as a task, not a forwarded message. State the specific question, the behaviour that matters, and what a complete answer must cover — for example both sides of a state transition, what happens on retry, or which limits and expirations apply.
- Carry the thread forward yourself. If a feature name, customer scenario, or conclusion from an earlier delegation matters, restate it inside the new prompt; claude will not have it otherwise.
- If claude's answer is incomplete, hedged, or leaves a path unverified, delegate again with a narrower and more specific task. Do not fill the gap with a guess.
- claude can only read files in the project directory. It cannot see git history, run commands, or search the web. Use git-history when repository history is needed. If the answer depends on commands or web search, say what could not be checked rather than answering from current code as though it were the whole story.
- Use read, grep, find, ls, and git-history only to confirm a specific detail claude reported, or for a trivial lookup that needs no investigation. Never use them to run your own investigation in place of delegating.

Response format:
Question: Restate the question in your own words to confirm understanding.
Answer: A short, direct response — ideally 2–4 sentences. Use a few bullet points only when listing items.

Guidelines:
- Write for support agents who need a quick, confident answer to relay to a customer.
- Keep the total response under 300 words.
- Describe the end-user visible behaviour only — skip internal mechanics such as callbacks, services, sync flows, concerns, or how data moves between systems behind the scenes.
- Avoid code blocks entirely. Use inline \`code\` sparingly, only for field names a support agent would recognise in the UI.
- Always follow the response format: question first, then answer. This applies to every reply in a thread, including follow-ups.
- Stay in support-agent mode for every reply, including follow-ups. If the user asks for code locations, file paths, class/method names, or implementation details ("where is the logic", "show me the code", "which file"), do not switch into developer-explanation mode. Restate the behaviour in support-agent terms and, at most, name the user-facing setting or business rule involved (e.g. "the 30-day outdated rule"). Internal file paths, class names, private methods, and constants must never appear in a reply.
- Base answers only on what claude reports from the project files, plus any detail you verified yourself. Never answer from general knowledge about how software like this usually works.
- Restate claude's findings in support-agent terms. Its raw output is written for a developer: never pass through its file paths, class names, or internal mechanics.
- Carry claude's own hedging into your answer. If it says a path was not verified, the customer-facing answer must be qualified too — do not present a hedged finding as settled.
- If claude cannot find a clear answer, say so plainly rather than speculating.
- If a faithful answer would exceed 300 words, prefer trimming background, hedging, or restated context over dropping a behaviour-changing caveat (e.g. limits, expirations, exclusions). Caveats that change what the customer sees must stay; prose that does not must go.`,
});
await loader.reload();

// ---------------------------------------------------------------------------
// 3. Create the bot
// ---------------------------------------------------------------------------

// The adapter would read SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET from the
// environment itself, but this project's variables all carry the PI_CHAT_
// prefix — that is what keeps them out of the delegated Claude session — so
// they are passed in explicitly.
const PI_CHAT_SLACK_BOT_TOKEN = process.env.PI_CHAT_SLACK_BOT_TOKEN;
if (!PI_CHAT_SLACK_BOT_TOKEN)
  throw new Error("PI_CHAT_SLACK_BOT_TOKEN env variable is required");

const PI_CHAT_SLACK_SIGNING_SECRET = process.env.PI_CHAT_SLACK_SIGNING_SECRET;
if (!PI_CHAT_SLACK_SIGNING_SECRET)
  throw new Error("PI_CHAT_SLACK_SIGNING_SECRET env variable is required");

// Redis state — shared between Chat SDK and pi session persistence
const PI_CHAT_REDIS_URL = process.env.PI_CHAT_REDIS_URL;
if (!PI_CHAT_REDIS_URL)
  throw new Error("PI_CHAT_REDIS_URL env variable is required");

const state = createRedisState({ url: PI_CHAT_REDIS_URL });
await state.connect();

async function safeRemoveReaction(
  thread: Thread,
  messageId: string,
  reactionEmoji: EmojiValue,
): Promise<void> {
  try {
    await thread.adapter.removeReaction(thread.id, messageId, reactionEmoji);
  } catch (err: unknown) {
    const isNotFound =
      err instanceof Error &&
      (err.message.includes("message_not_found") ||
        err.message.includes("thread_not_found"));
    if (isNotFound) {
      console.warn(
        `[${thread.adapter.name}] message already deleted, skipping removeReaction (thread=${thread.id}, message=${messageId})`,
      );
    } else {
      throw err;
    }
  }
}

async function getSessionPath(threadId: string): Promise<string | null> {
  return state.get(sessionPathKey(threadId));
}

async function setSessionPath(
  threadId: string,
  sessionFile: string,
): Promise<void> {
  await state.set(sessionPathKey(threadId), sessionFile);
}

const bot = new Chat({
  userName: "pi",
  state,
  concurrency: "queue",
  adapters: {
    slack: createSlackAdapter({
      botToken: PI_CHAT_SLACK_BOT_TOKEN,
      signingSecret: PI_CHAT_SLACK_SIGNING_SECRET,
    }),
  },
});
await bot.initialize();

// ---------------------------------------------------------------------------
// Attachment helpers
// ---------------------------------------------------------------------------

async function fetchImages(attachments: Attachment[]): Promise<ImageContent[]> {
  const images: ImageContent[] = [];
  for (const attachment of attachments) {
    if (!attachment.mimeType?.startsWith("image/")) continue;
    try {
      let data: Buffer;
      if (attachment.fetchData) {
        data = await attachment.fetchData();
      } else if (attachment.url) {
        // fetchData is a closure stripped during queue serialization — fall back
        // to fetching url_private directly with the bot token.
        const response = await fetch(attachment.url, {
          headers: { Authorization: `Bearer ${PI_CHAT_SLACK_BOT_TOKEN}` },
        });
        if (!response.ok)
          throw new Error(`HTTP ${response.status} ${response.statusText}`);
        data = Buffer.from(await response.arrayBuffer());
      } else {
        continue;
      }
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
    modelRuntime,
    thinkingLevel,
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

  await handleSessionPrompt({
    prompt: () =>
      session.prompt(prompt, images.length > 0 ? { images } : undefined),
    recoverPromptError: async (err) => {
      console.error("[pi] session error:", err);
      await recoverSessionError(err, {
        invalidateSession: () => state.delete(sessionPathKey(thread.id)),
        removeProgressReaction: () =>
          safeRemoveReaction(thread, message.id, emoji.eyes),
        addFailureReaction: () =>
          thread.adapter.addReaction(thread.id, message.id, emoji.x),
        postReply: (reply) => thread.post(reply).then(() => undefined),
      });
    },
    continueAfterPrompt: async () => {
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
      await safeRemoveReaction(thread, message.id, emoji.eyes);
      await thread.adapter.addReaction(thread.id, message.id, emoji.check);
    },
    reportPostPromptError: async (err) => {
      console.error("[pi] post-prompt error:", err);
      await safeRemoveReaction(thread, message.id, emoji.eyes);
      await thread.adapter.addReaction(thread.id, message.id, emoji.x);
      await thread.post(sessionErrorReply(err));
    },
  });
}

bot.onReaction(["thumbs_up"], async (event) => {
  if (!event.added) return;

  try {
    const raw = event.raw as { item: { channel: string; ts: string } };
    const slack = new WebClient(PI_CHAT_SLACK_BOT_TOKEN);
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
const PORT = process.env.PI_CHAT_PORT ?? 4000;
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
