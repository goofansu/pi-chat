# pi-chat

Chat with [pi](https://github.com/earendil-works/pi) about a project over Slack, powered by the [Chat SDK](https://github.com/mariozechner/chat). The Chat SDK handles the Slack adapter, thread subscriptions, and Redis-backed state — pi handles reading and reasoning about the codebase.

Mention the bot in any channel to start a thread. Follow-up messages in that thread are handled automatically without needing to `@mention` again.

## Requirements

- Node.js >=22.19.0
- A Redis server (used by the Chat SDK for thread subscriptions and conversation history)
- The Claude Code CLI logged in on the host. The delegated session reuses that login, so no separate API key is needed; the CLI itself is installed automatically as a platform-specific dependency.

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
| pi | `PI_CHAT_PROJECT_DIR` | Path to the codebase to query (e.g. `~/work/my-project`) | Yes |
| pi | `PI_CHAT_MODEL` | Model in `provider/model[:thinking]` format (e.g. `github-copilot/claude-sonnet-4.6:high`; thinking defaults to `medium`) | Yes |
| pi | `PI_CHAT_PROVIDER_API_KEY` | API key for the provider selected by `PI_CHAT_MODEL`; held in memory and never persisted | Yes |
| Platform adapters | `PI_CHAT_SLACK_BOT_TOKEN` | Bot token from **OAuth & Permissions** (`xoxb-...`) | Yes |
| Platform adapters | `PI_CHAT_SLACK_SIGNING_SECRET` | Signing secret from **Basic Information** | Yes |
| State adapters | `PI_CHAT_REDIS_URL` | Redis connection URL | Yes |
| Extensions | `PI_CHAT_CLAUDE_MODEL` | Model for the `claude` tool — an alias (`sonnet`, `opus`, `haiku`) or a full model id (default: `sonnet`) | No |
| Extensions | `PI_CHAT_CLAUDE_EFFORT` | Reasoning depth for a delegation: `low`, `medium`, `high`, `xhigh`, `max` (default: `medium`) | No |
| Extensions | `PI_CHAT_CLAUDE_MAX_TURNS` | Turn ceiling for one `claude` delegation (default: `30`) | No |
| Extensions | `PI_CHAT_CLAUDE_MAX_BUDGET_USD` | Cost ceiling for one `claude` delegation, in USD; `off` removes it (default: `5`) | No |
| Extensions | `PI_CHAT_CLAUDE_TIMEOUT_MS` | Wall-clock ceiling for one `claude` delegation (default: `600000`) | No |

Every variable carries the `PI_CHAT_` prefix, including the Slack and Redis ones the adapters would otherwise read unprefixed. That is what keeps this project's configuration out of the environment handed to the delegated Claude Code session — see Security.

`PI_CHAT_MODEL` must identify a built-in pi model. Provider authentication and the model registry are isolated from user-scoped pi configuration: the server uses only `PI_CHAT_PROVIDER_API_KEY` and does not read `~/.pi/agent/auth.json` or `~/.pi/agent/models.json`.

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

The bot replies in the thread. Conversation history and thread subscriptions persist in Redis across server restarts.

## Architecture

Pi does not investigate the codebase itself. Its job is to work out what the user actually needs to know, delegate the investigation to the `claude` tool, and translate the result into a support-agent answer.

```
Slack question ─> pi (identify intent) ─> claude (investigate) ─> pi (translate) ─> reply
                        └─> read/grep/find/ls/git-history, for verification and trivial lookups only
```

Two consequences worth knowing:

- **Each delegation is one-shot.** `claude` starts a fresh session every call, with no memory of the thread or of its own previous answers. Pi holds the thread's context and must restate anything relevant in each new prompt.
- **`claude` sees only project files.** It has no shell, git history, or network. When history is needed, pi can inspect it separately through `git-history`; questions that require other commands or the network remain unavailable, and pi is instructed to say so rather than guess.

## Security

Everything the bot can do is read-only and scoped to `PI_CHAT_PROJECT_DIR`. Pi has **`read`, `grep`, `find`, `ls`, `git-history`, `claude`**; the delegated Claude Code session has `Read`, `Grep`, and `Glob` and nothing else — no shell, no writes, no network, no subagents or scheduled agents. Every filesystem path it names is resolved, symlinks included, and refused if it lands outside the project directory.

`git-history` always runs from `PI_CHAT_PROJECT_DIR` and accepts only `log` and `show`. Other subcommands, shell syntax, and output-to-file options are rejected before Git starts.

The delegated session inherits nothing it should not: no `settings.json`, `CLAUDE.md`, MCP servers, hooks, skills, or plugins from disk, and no transcript left behind. Its environment is the server's minus every `PI_CHAT_*` variable, so a configuration value added later is withheld by construction rather than by remembering to list it. Each delegation is bounded by turns, cost, and wall clock, so a runaway or stalled investigation ends on its own.

See `src/extensions/claude.ts` for how each of those is enforced and why.
