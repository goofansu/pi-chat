import assert from "node:assert/strict";
import test from "node:test";

import { validateGitReadonlyArgs } from "../src/extensions/bash-git-readonly.ts";

test("allows only git log and show", () => {
  assert.deepEqual(validateGitReadonlyArgs(["log", "--oneline", "-5"]), [
    "log",
    "--oneline",
    "-5",
  ]);
  assert.deepEqual(validateGitReadonlyArgs(["show", "HEAD", "--stat"]), [
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
    assert.throws(() => validateGitReadonlyArgs(args), /not allowed/);
  }
});

test("rejects shell-like arguments", () => {
  assert.throws(
    () => validateGitReadonlyArgs(["log", "--oneline", ";", "rm"]),
    /Unsafe/,
  );
  assert.throws(
    () => validateGitReadonlyArgs(["log", "$(touch nope)"]),
    /Unsafe/,
  );
});

test("rejects git output-to-file options", () => {
  assert.throws(
    () => validateGitReadonlyArgs(["log", "--output=/tmp/out"]),
    /Unsafe/,
  );
  assert.throws(
    () => validateGitReadonlyArgs(["show", "-o", "/tmp/out", "HEAD"]),
    /Unsafe/,
  );
});
