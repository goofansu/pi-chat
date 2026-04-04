import { createServer } from "node:http";
import { Chat } from "chat";
import { createRedisState } from "@chat-adapter/state-redis";
import { createSlackAdapter } from "@chat-adapter/slack";
import {
  createAgentSession,
  SessionManager,
  createReadOnlyTools,
  AuthStorage,
  ModelRegistry,
  DefaultResourceLoader,
  defineTool,
} from "@mariozechner/pi-coding-agent";
import { execSync } from "node:child_process";
import { Type } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// 1. Config
// ---------------------------------------------------------------------------
const PROJECT_DIR = (process.env.PROJECT_DIR ?? "").replace(/^~/, process.env.HOME);
if (!PROJECT_DIR) throw new Error("PROJECT_DIR env variable is required");
const PROJECT_NAME = PROJECT_DIR.split("/").filter(Boolean).at(-1);
console.log("[pi] Project dir:", PROJECT_DIR);

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const model = modelRegistry.find("github-copilot", "claude-sonnet-4.6");
if (!model) throw new Error("Model github-copilot/claude-sonnet-4.6 not found");
console.log("[pi] Model:", model.id);

const curlTool = defineTool({
  name: "curl",
  label: "curl",
  description: "Execute a curl command to make HTTP requests.",
  parameters: Type.Object({
    command: Type.String({ description: "A curl command to execute" }),
  }),
  execute: async (_id, params) => {
    const command = params.command;
    if (!command.trim().startsWith("curl")) {
      return { content: [{ type: "text", text: "Error: only curl commands are allowed" }], details: {} };
    }
    try {
      const output = execSync(command, { encoding: "utf8", timeout: 15000 });
      return { content: [{ type: "text", text: output }], details: {} };
    } catch (e) {
      return { content: [{ type: "text", text: e.message }], details: {} };
    }
  },
});

const tools = createReadOnlyTools(PROJECT_DIR);
const customTools = [curlTool];
console.log("[pi] Tools:", [...tools, ...customTools].map((t) => t.name).join(", "));

// ---------------------------------------------------------------------------
// 2. Resource loader (shared across all sessions)
// ---------------------------------------------------------------------------
const loader = new DefaultResourceLoader({
  cwd: PROJECT_DIR,
  noExtensions: true,
  noPromptTemplates: true,
  skillsOverride: (current) => ({
    skills: current.skills.filter((s) => s.name === "web-search"),
    diagnostics: current.diagnostics,
  }),
  systemPromptOverride: () =>
    `You are a support assistant for the ${PROJECT_NAME} codebase. You only answer questions about ${PROJECT_NAME} — its code, architecture, features, and behaviour.

If a question is unrelated to ${PROJECT_NAME}, refuse it directly and briefly. Do not attempt to help with unrelated topics.

Always read the relevant source files before answering — do not guess or speculate.
If you cannot find the answer in the code, say so honestly.

Guidelines:
- Be clear and concise. Explain what things do in plain language.
- Include code snippets only when they help.
- Use Markdown: **bold**, _italic_, \`code\`. Use headings sparingly.
- Start with the answer. No preamble, thinking-out-loud, or filler sentences.
- Stay within the project directory. Do not reference or read external files.`,
});
await loader.reload();

// ---------------------------------------------------------------------------
// 3. Create the bot
//    Reads SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET from env automatically.
// ---------------------------------------------------------------------------

// Redis state — shared between Chat SDK and pi session persistence
const state = createRedisState();
await state.connect();

const SESSION_KEY_PREFIX = "pi:session:";

async function getSessionPath(threadId) {
  return state.get(`${SESSION_KEY_PREFIX}${threadId}`);
}

async function setSessionPath(threadId, sessionFile) {
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

async function askPi(thread, message) {
  console.log(`[slack] message from ${message.author.fullName}: ${message.text}`);

  const existingSessionPath = await getSessionPath(thread.id);

  let prompt;
  if (existingSessionPath) {
    // Continuing thread — pi session already has history
    prompt = message.text;
  } else {
    // New thread — fetch history for initial context
    try {
      await thread.refresh();
    } catch (err) {
      if (err?.data?.error !== "thread_not_found") throw err;
      console.log("[slack] no existing thread — skipping history fetch");
    }
    const history = thread.recentMessages
      .filter((m) => m.id !== message.id)
      .map((m) => `${m.author.fullName}: ${m.text}`)
      .join("\n");
    prompt = history
      ? `Thread context:\n${history}\n\nQuestion: ${message.text}`
      : message.text;
  }

  console.log(`[pi] prompt (thread=${thread.id}): ${prompt}`);

  const placeholder = await thread.post("_checking\u2026_");

  const sessionManager = existingSessionPath
    ? SessionManager.open(existingSessionPath)
    : SessionManager.create(PROJECT_DIR);

  const { session } = await createAgentSession({
    cwd: PROJECT_DIR,
    tools,
    customTools,
    sessionManager,
    model,
    resourceLoader: loader,
  });

  // Store session file path on first message in a thread
  if (!existingSessionPath && session.sessionFile) {
    await setSessionPath(thread.id, session.sessionFile);
    console.log(`[pi] new session for thread=${thread.id}: ${session.sessionFile}`);
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

  await session.prompt(prompt);

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
  response = response.replace(/^---+\s*$/gm, "").replace(/\n{3,}/g, "\n\n").trim();

  console.log(`[slack] response: ${response.length} chars`);
  await placeholder.edit(response ? { markdown: response } : "(no response)");
}

bot.onNewMention(async (thread, message) => {
  await thread.subscribe();
  await askPi(thread, message);
});

bot.onSubscribedMessage(async (thread, message) => {
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
            Object.entries(req.headers).filter(([, v]) => v !== undefined)
          ),
          body: chunks.length ? Buffer.concat(chunks) : undefined,
        }
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
server.on("error", (err) => console.error("[server] Failed to listen:", err.message));
