# pi-chat

Chat with [Pi](https://github.com/earendil-works/pi) about a project over Slack, powered by the [Chat SDK](https://github.com/mariozechner/chat). The Chat SDK handles the Slack adapter, thread subscriptions, and PostgreSQL-backed state — Pi handles reading and reasoning about the codebase.

Mention the bot in any channel to start a thread. Follow-up messages in that thread are handled automatically without needing to `@mention` again.

## Requirements

- Node.js >=22.19.0
- A PostgreSQL database (used by the Chat SDK for thread subscriptions and conversation history)
- For `claude-code` models only: the Claude Code CLI installed separately and logged in on the host (`npm install -g @anthropic-ai/claude-code`, then `claude auth login`). Other providers do not require Claude Code.

## Install

```bash
pnpm install
```

Copy the example env file and fill in the values:

```bash
cp .env.example .env
```

| Category | Variable | Description | Required |
|---|---|---|---|
| Server | `PI_CHAT_PORT` | Port to listen on | No (default: `4000`) |
| Pi | `PI_CHAT_PROJECT_DIR` | Path to the codebase to query (e.g. `~/work/my-project`). The final directory name is the project name used for routing. | Yes |
| Pi | `PI_CHAT_MODEL` | Model in `provider/model[:thinking]` format (e.g. `claude-code/default:medium`, `github-copilot/claude-sonnet-4.6:high`, or `openrouter/openai/gpt-5.6-luna`; thinking defaults to `medium`). The model id may itself contain slashes. | Yes |
| Pi | `PI_CHAT_PROVIDER_API_KEY` | API key for the selected provider; held in memory and never persisted. Not required and ignored for `claude-code`, which uses the CLI login. | Except for `claude-code` |
| Routing | `PI_CHAT_JEV_API_KEY` | TypeSafe AI API key used by Jev to route questions that do not mention the project name | Yes |
| Web search | `PI_CHAT_BRAVE_SEARCH_API_KEY` | Brave Search API key. On exe.dev, an attached `brave` integration is discovered automatically when this is omitted | No |
| Web fetch | `PI_CHAT_FIRECRAWL_API_KEY` | Firecrawl API key. On exe.dev, an attached `firecrawl` integration is discovered automatically; otherwise Firecrawl's keyless tier is used | No |
| Web access | `PI_CHAT_WEB_SEARCH_DOMAINS` | Comma-separated hostname allowlist applied to both search and page fetching (for example, `docs.example.com,support.example.com`) | Yes |
| Platform adapters | `PI_CHAT_SLACK_BOT_TOKEN` | Bot token from **OAuth & Permissions** (`xoxb-...`) | Yes |
| Platform adapters | `PI_CHAT_SLACK_SIGNING_SECRET` | Signing secret from **Basic Information** | Yes |
| State adapters | `PI_CHAT_POSTGRES_URL` | PostgreSQL connection URL | Yes |

Application configuration uses the `PI_CHAT_` prefix, including the Slack and PostgreSQL variables the adapters would otherwise read unprefixed.

`PI_CHAT_MODEL` accepts built-in Pi models and models from [`@earendil-works/pi-claude-code`](https://github.com/earendil-works/pi-claude-code). The latter is installed from a pinned Git revision and loaded through Pi's extension loader before model selection. For example:

```dotenv
PI_CHAT_MODEL=claude-code/default:medium
PI_CHAT_PROVIDER_API_KEY=
```

`default` follows the Claude CLI's recommended model. The pinned package also exposes `claude-opus-5-5`, `claude-fable-5-1`, `claude-sonnet-5`, and `claude-haiku-4-5-20251001` under the `claude-code` provider. Startup uses the package's bundled catalog without network model discovery.

Claude Code handles its own authentication; the server does not import or persist its credentials. The package optionally reads `PI_CLAUDE_CODE_COMMAND` to select a CLI executable and `PI_CLAUDE_CODE_CONFIG_DIR` to select a Claude configuration directory. This provider is experimental and subject to Claude subscription limits and billing policies; see its README before deploying.

All other providers still require `PI_CHAT_PROVIDER_API_KEY`. Pi credentials, models, and settings remain in memory: the server does not load user-scoped `auth.json`, `models.json`, or `settings.json`, or discover project/user extensions, skills, prompts, or context files.

The former `claude` delegation tool and its `PI_CHAT_CLAUDE_*` settings have been removed. Model and reasoning selection now use `PI_CHAT_MODEL` for the whole conversation; the old delegation-specific turn, cost, and timeout limits no longer apply.

## Usage

Start the server:

```bash
pnpm start
```

Expose it to the internet (required for Slack to reach the webhook):

```bash
ngrok http 4000
```

In your [Slack app settings](https://api.slack.com/apps), set the **Event Subscriptions** request URL to:

```
https://<your-ngrok-url>/api/webhooks/slack
```

Then mention the bot in any channel with a question:

```
@pi how does the authentication flow work?
```

The bot replies in the thread. Conversation history and thread subscriptions persist in PostgreSQL across server restarts. The Chat SDK creates its `chat_state_*` tables automatically on first connection.

## Architecture

A project-name mention in the current question selects codebase investigation immediately, without calling Jev. Otherwise Jev routes the question before Pi answers it. Engineering questions use Pi's repository tools; support questions search the configured websites and can fetch current full-page content through Firecrawl. The selected model provider serves every route. With `claude-code`, the Claude CLI supplies model responses only — Pi owns the conversation and executes the tools.

```
Slack question ─> mentions project name?
                    ├─> yes ─────────────> engineering ─> read/search codebase
                    └─> no ─> Jev ──────┬─> engineering ─> read/search codebase
                                       ├─> support ─────> search/fetch allowed websites
                                       └─> clarify ─────> ask for missing context
```

Key behaviours:

- **Routing is enforced per message.** A case-insensitive literal match of the project name in the current question selects engineering, even when the previous route was support or Jev is unavailable. Thread history alone does not trigger this shortcut. Otherwise Jev uses the current question, project name, and previous route to select an evidence source. Engineering or support classifications require confidence of at least `0.50`; lower confidence or a clarification classification uses a tool-free route that asks one concise question. Jev request failures use support. The previous evidence route is preserved while clarification is pending. Every route remains written for support agents.
- **Pi investigates directly.** It retains the thread's context and traces relevant code paths itself, including state entry, exit, and trigger paths. Answers remain written for support agents, with uncertainty and behaviour-changing caveats preserved.
- **Tool execution stays in Pi.** The Claude Code provider disables Claude's native tools and returns proposed tool calls to Pi. Engineering turns have only read/search tools; support turns have only domain-allowlisted web tools.
- **Support references are prompt-guided.** Support answers are instructed to end with a bold `References` heading and a bullet list of unique Markdown links (`- [Source title](URL)`) from configured domains, without repeating links in the answer body.

## Security

The bot exposes read-only tools. Questions mentioning the project name bypass TypeSafe AI. For other questions, the current question, project name, and previous route are sent to TypeSafe AI for Jev classification. Engineering turns can use **`read`, `grep`, `find`, `ls`**, while support turns can use only **`web_search`, `web_fetch`**. No shell, write, edit, or delegation tool is exposed. Web access is provided by [`@goofansu/pi-web`](https://github.com/goofansu/pi-web) through Brave LLM Context and Firecrawl. `PI_CHAT_WEB_SEARCH_DOMAINS` is enforced for search requests, fetch requests, returned search sources, and fetch redirects; model-supplied arguments cannot override it.

Filesystem tools resolve relative paths from `PI_CHAT_PROJECT_DIR`, but Pi's built-in tools are not a filesystem sandbox: absolute paths, parent paths, and symlinks can reach files readable by the server account. The removed delegation tool's path guard does not apply to these tools. Use OS-level isolation and a minimally privileged account when repository-only access is required.

When using `claude-code`, treat the provider package and CLI as trusted server-side code. The CLI inherits the provider's environment policy, not the removed delegation tool's `PI_CHAT_*` filter. The package disables native tool execution and manages its own transport processes; Pi sessions are disposed after each Slack turn to release provider resources. Thread history remains in Pi's persisted session.
