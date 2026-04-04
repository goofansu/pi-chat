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

| Variable | Description | Required |
|---|---|---|
| `SLACK_BOT_TOKEN` | Bot token from **OAuth & Permissions** (`xoxb-...`) | Yes |
| `SLACK_SIGNING_SECRET` | Signing secret from **Basic Information** | Yes |
| `PI_PROJECT_DIR` | Path to the codebase to query (e.g. `~/work/my-project`) | Yes |
| `PI_MODEL_ID` | Model in `provider/model` format (e.g. `github-copilot/claude-sonnet-4.6`) | Yes |
| `REDIS_URL` | Redis connection URL | No (default: `redis://localhost:6379`) |
| `PORT` | Port to listen on | No (default: `4000`) |

Make sure your pi credentials include a valid auth token for the model's provider (`~/.pi/agent/auth.json`).

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

The bot has access to two sets of tools:

- **`read`, `grep`, `find`, `ls`** — built-in read-only tools scoped to `PI_PROJECT_DIR`; they cannot write or execute anything in the project.
- **`curl`** — a custom tool for outbound HTTP requests, used to power search skills such as [web-search](https://skills.sh/brave/brave-search-skills/web-search).
