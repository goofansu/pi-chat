import assert from "node:assert/strict";
import test from "node:test";
import { connectDatabase } from "../src/database-startup.ts";

test("connects immediately when the database is ready", async () => {
  let calls = 0;
  await connectDatabase(
    {
      connect: async () => {
        calls++;
      },
    },
    {
      sleep: async () => assert.fail("must not sleep"),
      warn: () => assert.fail("must not warn"),
    },
  );
  assert.equal(calls, 1);
});

test("retries an unavailable boot database and stops once connected", async () => {
  let calls = 0;
  const delays: number[] = [];
  const messages: string[] = [];
  await connectDatabase(
    {
      connect: async () => {
        if (++calls <= 6) throw new Error("integration unavailable: secret");
      },
    },
    {
      sleep: async (ms) => {
        delays.push(ms);
      },
      warn: (message) => messages.push(message),
    },
  );
  assert.equal(calls, 7);
  assert.deepEqual(delays, [2000, 4000, 8000, 16000, 30000, 30000]);
  assert.equal(messages.length, 6);
  assert.ok(messages.every((message) => message.includes("Waiting for database")));
  assert.ok(messages.every((message) => !message.includes("secret")));
});

test("propagates the last failure after ten attempts for systemd recovery", async () => {
  let calls = 0;
  const delays: number[] = [];
  const failure = new Error("database unavailable");
  await assert.rejects(
    connectDatabase(
      {
        connect: async () => {
          calls++;
          throw failure;
        },
      },
      {
        sleep: async (ms) => {
          delays.push(ms);
        },
        warn: () => {},
      },
    ),
    (error) => error === failure,
  );
  assert.equal(calls, 10);
  assert.equal(delays.length, 9);
  assert.equal(delays.at(-1), 30000);
});
