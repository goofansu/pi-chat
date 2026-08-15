import assert from "node:assert/strict";
import test from "node:test";

import {
  handleSessionPrompt,
  recoverSessionError,
  sessionErrorReply,
  sessionPathKey,
} from "../src/session-error.ts";

test("returns a generic Slack reply without exposing exception details", () => {
  const error = new Error(
    "No API key found for deepseek. Secret path: /tmp/key",
  );

  const reply = sessionErrorReply(error);

  assert.equal(reply, "Sorry, there was an error.");
  assert.doesNotMatch(reply, /deepseek|API key|\/tmp\/key/);
});

test("builds the Redis key for a thread session", () => {
  assert.equal(
    sessionPathKey("slack:C0123:1234.5678"),
    "pi:session:slack:C0123:1234.5678",
  );
});

test("invalidates the session before updating Slack after an error", async () => {
  const calls: string[] = [];
  const error = new Error("provider secret");

  await recoverSessionError(error, {
    invalidateSession: async () => {
      calls.push("invalidate");
    },
    removeProgressReaction: async () => {
      calls.push("remove-progress");
    },
    addFailureReaction: async () => {
      calls.push("add-failure");
    },
    postReply: async (reply) => {
      calls.push(`post:${reply}`);
    },
  });

  assert.deepEqual(calls, [
    "invalidate",
    "remove-progress",
    "add-failure",
    "post:Sorry, there was an error.",
  ]);
});

test("stops recovery when session invalidation fails", async () => {
  const calls: string[] = [];

  await assert.rejects(
    recoverSessionError(new Error("prompt failed"), {
      invalidateSession: async () => {
        calls.push("invalidate");
        throw new Error("redis unavailable");
      },
      removeProgressReaction: async () => {
        calls.push("remove-progress");
      },
      addFailureReaction: async () => {
        calls.push("add-failure");
      },
      postReply: async () => {
        calls.push("post");
      },
    }),
    /redis unavailable/,
  );

  assert.deepEqual(calls, ["invalidate"]);
});

test("recovers prompt failures by invalidating the session", async () => {
  const calls: string[] = [];

  await handleSessionPrompt({
    prompt: async () => {
      calls.push("prompt");
      throw new Error("provider secret");
    },
    recoverPromptError: async () => {
      calls.push("recover");
    },
    continueAfterPrompt: async () => {
      calls.push("continue");
    },
    reportPostPromptError: async () => {
      calls.push("report");
    },
  });

  assert.deepEqual(calls, ["prompt", "recover"]);
});

test("reports post-prompt failures without invalidating the session", async () => {
  const calls: string[] = [];

  await handleSessionPrompt({
    prompt: async () => {
      calls.push("prompt");
    },
    recoverPromptError: async () => {
      calls.push("recover");
    },
    continueAfterPrompt: async () => {
      calls.push("continue");
      throw new Error("slack unavailable");
    },
    reportPostPromptError: async () => {
      calls.push("report");
    },
  });

  assert.deepEqual(calls, ["prompt", "continue", "report"]);
});
