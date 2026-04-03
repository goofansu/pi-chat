import { createServer } from "node:http";
import { Chat } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { createSlackAdapter } from "@chat-adapter/slack";
import {
  createAgentSession,
  SessionManager,
  createReadOnlyTools,
  AuthStorage,
  ModelRegistry,
  DefaultResourceLoader,
} from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// 1. Project directory for pi sessions
// ---------------------------------------------------------------------------
const PROJECT_DIR = (process.env.PROJECT_DIR ?? "").replace(/^~/, process.env.HOME);
if (!PROJECT_DIR) throw new Error("PROJECT_DIR env variable is required");
console.log("[pi] Project dir:", PROJECT_DIR);

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const model = modelRegistry.find("github-copilot", "claude-sonnet-4.6");
if (!model) throw new Error("Model github-copilot/claude-sonnet-4.6 not found");
console.log("[pi] Model:", model.id);

// ---------------------------------------------------------------------------
// 2. Create the bot
//    Reads SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET from env automatically.
// ---------------------------------------------------------------------------
const bot = new Chat({
  userName: "pi",
  state: createMemoryState(),
  adapters: {
    slack: createSlackAdapter(),
  },
});

bot.onNewMention(async (thread, message) => {
  console.log(`[slack] mention from ${message.author.fullName}: ${message.text}`);

  // Fetch thread history for context (may fail if this is a brand-new top-level message)
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

  const prompt = history
    ? `Thread context:\n${history}\n\nQuestion: ${message.text}`
    : message.text;

  console.log(`[pi] prompt: ${prompt}`);

  const placeholder = await thread.post("_checking\u2026_");

  // Fresh session per mention — no history carried over
  const loader = new DefaultResourceLoader({
    cwd: PROJECT_DIR,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    systemPromptOverride: () =>
      `You are a support assistant that answers questions about this project's codebase.

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

  const { session } = await createAgentSession({
    cwd: PROJECT_DIR,
    tools: createReadOnlyTools(PROJECT_DIR),
    sessionManager: SessionManager.inMemory(),
    model,
    resourceLoader: loader,
  });

  let response = "";

  session.subscribe((event) => {
    switch (event.type) {
      case "agent_start":
        console.log("[pi] agent start");
        break;
      case "agent_end": {
        console.log("[pi] agent end");
        break;
      }
      case "tool_execution_start":
        console.log(`[pi] tool: ${event.toolName}`);
        break;
      case "tool_execution_end":
        console.log(`[pi] tool done: ${event.toolName} (${event.isError ? "error" : "ok"})`);
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
});

// ---------------------------------------------------------------------------
// 2. Minimal HTTP server
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

server.listen(PORT, () => {
  console.log(`Bot listening on http://localhost:${PORT}`);
  console.log(`Slack webhook URL: http://localhost:${PORT}${WEBHOOK_PATH}`);
});
