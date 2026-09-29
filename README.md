# pi-chat

Chat with [Pi](https://github.com/earendil-works/pi) about a project over Slack, powered by the [Chat SDK](https://github.com/mariozechner/chat). The Chat SDK handles the Slack adapter, thread subscriptions, and PostgreSQL-backed state — Pi handles reading and reasoning about the codebase.

Mention the bot in any channel to start a thread. Follow-up messages in that thread are handled automatically without needing to `@mention` again.

## Requirements

- Node.js >=22.19.0
- A PostgreSQL database (used by the Chat SDK for thread subscriptions and conversation history)
- The Claude CLI logged in on the host. The delegated session reuses that login, so no separate API key is needed; the CLI itself is installed automatically as a platform-specific dependency.

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
| Pi | `PI_CHAT_PROJECT_DIR` | Path to the codebase to query (e.g. `~/work/my-project`) | Yes |
| Pi | `PI_CHAT_MODEL` | Model in `provider/model[:thinking]` format (e.g. `github-copilot/claude-sonnet-4.6:high` or `openrouter/openai/gpt-5.6-luna`; thinking defaults to `medium`). The model id may itself contain slashes. | Yes |
| Pi | `PI_CHAT_PROVIDER_API_KEY` | API key for the provider selected by `PI_CHAT_MODEL`; held in memory and never persisted | Yes |
| Routing | `PI_CHAT_JEV_API_KEY` | TypeSafe AI API key used by Jev to classify each question as engineering or support | Yes |
| Web search | `PI_CHAT_BRAVE_SEARCH_API_KEY` | Brave Search API key. On exe.dev, an attached `brave` integration is discovered automatically when this is omitted | No |
| Web fetch | `PI_CHAT_FIRECRAWL_API_KEY` | Firecrawl API key. On exe.dev, an attached `firecrawl` integration is discovered automatically; otherwise Firecrawl's keyless tier is used | No |
| Web access | `PI_CHAT_WEB_SEARCH_DOMAINS` | Comma-separated hostname allowlist applied to both search and page fetching (for example, `docs.example.com,support.example.com`) | Yes |
| Platform adapters | `PI_CHAT_SLACK_BOT_TOKEN` | Bot token from **OAuth & Permissions** (`xoxb-...`) | Yes |
| Platform adapters | `PI_CHAT_SLACK_SIGNING_SECRET` | Signing secret from **Basic Information** | Yes |
| State adapters | `PI_CHAT_POSTGRES_URL` | PostgreSQL connection URL | Yes |
| Extensions | `PI_CHAT_CLAUDE_MODEL` | Model for the `claude` tool — an alias (`sonnet`, `opus`, `haiku`) or a full model id (default: `sonnet`) | No |
| Extensions | `PI_CHAT_CLAUDE_EFFORT` | Reasoning depth for a delegation: `low`, `medium`, `high`, `xhigh`, `max` (default: `medium`) | No |
| Extensions | `PI_CHAT_CLAUDE_MAX_TURNS` | Turn ceiling for one Claude delegation (default: `30`) | No |
| Extensions | `PI_CHAT_CLAUDE_MAX_BUDGET_USD` | Cost ceiling for one Claude delegation, in USD; `off` removes it (default: `5`) | No |
| Extensions | `PI_CHAT_CLAUDE_TIMEOUT_MS` | Wall-clock ceiling for one Claude delegation (default: `600000`) | No |

Every variable carries the `PI_CHAT_` prefix, including the Slack and PostgreSQL ones the adapters would otherwise read unprefixed. That is what keeps this project's configuration out of the environment handed to the delegated Claude session — see Security.

`PI_CHAT_MODEL` must identify a built-in Pi model. Provider authentication and the model registry are isolated from user-scoped Pi configuration: the server uses only `PI_CHAT_PROVIDER_API_KEY` and does not read `~/.pi/agent/auth.json` or `~/.pi/agent/models.json`.

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

Jev routes each message before Pi answers it. Engineering questions are investigated against the codebase through `claude`; support questions search the configured websites and can fetch current full-page content through Firecrawl.

```
Slack question ─> Jev (classify)
                    ├─> engineering ─> Pi ─> Claude/codebase ─> reply
                    ├─> support ─────> Pi ─> search/fetch allowed websites ─> reply
                    └─> clarify ─────> Pi ─> ask for missing context
```

Three consequences worth knowing:

- **Routing is enforced per message.** Jev receives the current project name and selects the evidence source, not the answer audience: every response remains written for support agents. Engineering tools are activated when Jev selects engineering with confidence of at least `0.50`. An explicit mention of the configured project breaks a low-confidence tie toward engineering. Other low-confidence results, unknown product names, unexplained acronyms, and missing context use a tool-free clarification route; the bot asks one concise question instead of guessing. Jev request failures use the support route. The previous evidence route is preserved while clarification is pending.
- **Each engineering delegation is one-shot.** Claude starts a fresh session every call, with no memory of the thread or of its own previous answers. Pi holds the thread's context and must restate anything relevant in each new prompt.
- **Claude sees only project files.** It has no shell, git history, or network. Pi can inspect history separately through `git-history`; support answers search and fetch only the configured websites.
- **Support references are prompt-guided.** Support answers are instructed to end with a bold `References` heading and a bullet list of unique Markdown links (`- [Source title](URL)`) from configured domains, without repeating links in the answer body.

## Security

Everything the bot can do is read-only. Each user question, the current project name, and the previous route are sent to TypeSafe AI for Jev classification. Filesystem tools are scoped to `PI_CHAT_PROJECT_DIR`; engineering turns can use **`read`, `grep`, `find`, `ls`, `git-history`, `claude`**, while support turns can use only **`web_search`, `web_fetch`**. Web access is provided by [`@goofansu/pi-web`](https://github.com/goofansu/pi-web) through Brave LLM Context and Firecrawl. `PI_CHAT_WEB_SEARCH_DOMAINS` is enforced for search requests, fetch requests, returned search sources, and fetch redirects; model-supplied arguments cannot override it. The delegated Claude session has `Read`, `Grep`, and `Glob` and nothing else — no shell, no writes, no network, no subagents or scheduled agents. Every filesystem path it names is resolved, symlinks included, and refused if it lands outside the project directory.

`git-history` always runs from `PI_CHAT_PROJECT_DIR` and accepts only `log` and `show`. Other subcommands, shell syntax, and output-to-file options are rejected before Git starts.

The delegated session inherits nothing it should not: no `settings.json`, `CLAUDE.md`, MCP servers, hooks, skills, or plugins from disk, and no transcript left behind. Its environment is the server's minus every `PI_CHAT_*` variable, so a configuration value added later is withheld by construction rather than by remembering to list it. Each delegation is bounded by turns, cost, and wall clock, so a runaway or stalled investigation ends on its own.

See `src/extensions/claude.ts` for how each of those is enforced and why.
