# pi-chat

Chat with [pi](https://github.com/mariozechner/pi-coding-agent) about a project over Slack, powered by the [Chat SDK](https://github.com/mariozechner/chat). The Chat SDK handles the Slack adapter, thread subscriptions, and Redis-backed state — pi handles reading and reasoning about the codebase.

Mention the bot in any channel to start a thread. Follow-up messages in that thread are handled automatically without needing to `@mention` again.

## Requirements

- A Redis server (used by the Chat SDK for thread subscriptions and conversation history)

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
| Server | `PORT` | Port to listen on | No (default: `4000`) |
| Pi | `PI_PROJECT_DIR` | Path to the codebase to query (e.g. `~/work/my-project`) | Yes |
| Pi | `PI_MODEL` | Model in `provider/model[:thinking]` format (e.g. `github-copilot/claude-sonnet-4.6:high`; thinking defaults to `medium`) | Yes |
| Pi | `PI_PROVIDER_API_KEY` | API key for the provider selected by `PI_MODEL`; held in memory and never persisted | Yes |
| Platform adapters | `SLACK_BOT_TOKEN` | Bot token from **OAuth & Permissions** (`xoxb-...`) | Yes |
| Platform adapters | `SLACK_SIGNING_SECRET` | Signing secret from **Basic Information** | Yes |
| State adapters | `REDIS_URL` | Redis connection URL | Yes |
| Extensions | `BRAVE_SEARCH_API_KEY` | Brave Search API key used by the optional web-search extension | No |

`PI_MODEL` must identify a built-in Pi model. Provider authentication and the model registry are isolated from user-scoped Pi configuration: the server uses only `PI_PROVIDER_API_KEY` and does not read `~/.pi/agent/auth.json` or `~/.pi/agent/models.json`.

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

## Security

The bot has access to read-only tools scoped to `PI_PROJECT_DIR`: **`read`, `grep`, `find`, `ls`, `git-readonly`, `web-search`**.
