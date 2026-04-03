# pi-chat

A Slack bot that answers questions about a codebase using [pi](https://github.com/mariozechner/pi-coding-agent). Mention the bot in any channel and it will use the pi agent to read and analyze the project files before responding.

## Install

```bash
pnpm install
```

Copy the example env file and fill in your Slack credentials:

```bash
cp .env.example .env
```

| Variable | Description |
|---|---|
| `SLACK_BOT_TOKEN` | Bot token from **OAuth & Permissions** (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | Signing secret from **Basic Information** |
| `PROJECT_DIR` | Path to the codebase to query (e.g. `~/work/openapply`) |
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

The bot will read the codebase under `~/work/openapply` and reply in the thread. Each mention starts a fresh session with no history from previous questions.
