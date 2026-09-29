import assert from "node:assert/strict";
import { test } from "node:test";

import { sanitizedSlackText, threadHistoryLine } from "../src/slack-message.ts";

test("removes Slack user mentions before model or routing state", () => {
  assert.equal(
    sanitizedSlackText({
      text: "@pi can you explain how the alumni login button works",
      raw: {
        text: "<@U012BOT> can you explain how the alumni login button works",
      },
    }),
    "can you explain how the alumni login button works",
  );
});

test("removes every Slack username while preserving the question", () => {
  assert.equal(
    sanitizedSlackText({
      text: "@pi ask @alice about retries",
      raw: { text: "<@U012BOT> ask <@U034USER> about retries" },
    }),
    "ask about retries",
  );
});

test("falls back to normalized message text when raw Slack text is unavailable", () => {
  assert.equal(
    sanitizedSlackText({ text: "  How   does this work? ", raw: {} }),
    "How does this work?",
  );
});

test("history uses generic roles rather than Slack profile names", () => {
  const message = {
    text: "@pi hello",
    raw: { text: "<@U012BOT> hello" },
    author: {
      fullName: "Private Display Name",
      isMe: false,
    },
  };

  assert.equal(threadHistoryLine(message), "User: hello");
  assert.doesNotMatch(threadHistoryLine(message), /Private Display Name/);
  assert.equal(
    threadHistoryLine({
      ...message,
      author: { ...message.author, isMe: true },
    }),
    "Assistant: hello",
  );
});
