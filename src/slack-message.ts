interface SlackTextMessage {
  text: string;
  raw: unknown;
}

interface SlackHistoryMessage extends SlackTextMessage {
  author: { isMe: boolean };
}

/** Remove platform user identities before text enters routing or model state. */
export function sanitizedSlackText(message: SlackTextMessage): string {
  const rawText =
    message.raw && typeof message.raw === "object"
      ? (message.raw as { text?: unknown }).text
      : undefined;
  const source = typeof rawText === "string" ? rawText : message.text;

  return source
    .replace(/<@[A-Z0-9]+(?:\|[^>]+)?>/gi, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

/** Preserve conversational roles without sending Slack profile names. */
export function threadHistoryLine(message: SlackHistoryMessage): string {
  const role = message.author.isMe ? "Assistant" : "User";
  return `${role}: ${sanitizedSlackText(message)}`;
}
