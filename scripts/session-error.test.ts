import assert from "node:assert/strict";
import test from "node:test";

import { sessionErrorReply } from "../src/session-error.ts";

test("returns a generic Slack reply without exposing exception details", () => {
  const error = new Error(
    "No API key found for deepseek. Secret path: /tmp/key",
  );

  const reply = sessionErrorReply(error);

  assert.equal(reply, "Sorry, there was an error.");
  assert.doesNotMatch(reply, /deepseek|API key|\/tmp\/key/);
});
