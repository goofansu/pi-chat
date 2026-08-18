import assert from "node:assert/strict";
import test from "node:test";

import { validateGitHistoryArgs } from "../src/extensions/git-history.ts";

test("allows only git log and show", () => {
  assert.deepEqual(validateGitHistoryArgs(["log", "--oneline", "-5"]), [
    "log",
    "--oneline",
    "-5",
  ]);
  assert.deepEqual(validateGitHistoryArgs(["show", "HEAD", "--stat"]), [
    "show",
    "HEAD",
    "--stat",
  ]);
});

test("rejects every other git subcommand", () => {
  for (const args of [
    ["status"],
    ["diff", "HEAD~1"],
    ["blame", "README.md"],
    ["checkout", "main"],
  ]) {
    assert.throws(() => validateGitHistoryArgs(args), /not allowed/);
  }
});

test("rejects shell-like arguments", () => {
  assert.throws(
    () => validateGitHistoryArgs(["log", "--oneline", ";", "rm"]),
    /Unsafe/,
  );
  assert.throws(
    () => validateGitHistoryArgs(["log", "$(touch nope)"]),
    /Unsafe/,
  );
});

test("rejects git output-to-file options", () => {
  assert.throws(
    () => validateGitHistoryArgs(["log", "--output=/tmp/out"]),
    /Unsafe/,
  );
  assert.throws(
    () => validateGitHistoryArgs(["show", "-o", "/tmp/out", "HEAD"]),
    /Unsafe/,
  );
});
