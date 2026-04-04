# pi-chat

A Slack bot that answers questions about a codebase using [pi](https://github.com/mariozechner/pi-coding-agent). Mention the bot in a channel to start a thread — follow-up messages in that thread are handled automatically without needing to @mention again.

## Requirements

- A Redis server for persisting thread subscriptions and conversation history across restarts

## Install

```bash
pnpm install
```

Copy the example env file and fill in your credentials:

```bash
cp .env.example .env
```

| Variable | Description |
|---|---|
| `SLACK_BOT_TOKEN` | Bot token from **OAuth & Permissions** (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | Signing secret from **Basic Information** |
| `PROJECT_DIR` | Path to the codebase to query (e.g. `~/work/openapply`) |
| `REDIS_URL` | Redis connection URL (e.g. `redis://localhost:6379`) |
| `PORT` | Port to listen on (default: `4000`) |

The bot uses the `github-copilot/claude-sonnet-4.6` model via pi's model registry. Make sure the model is configured in your pi credentials (`~/.pi/agent/auth.json`).

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
@pi what does the CrmEmailCampaignWorker do?
```

The bot subscribes to the thread and replies. You can continue the conversation with follow-up messages — no need to @mention again. Conversation history and thread subscriptions persist in Redis, so they survive server restarts.
