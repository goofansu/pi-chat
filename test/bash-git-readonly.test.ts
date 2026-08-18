import assert from "node:assert/strict";
import test from "node:test";

import { validateGitReadonlyArgs } from "../src/extensions/bash-git-readonly.ts";

test("allows git log relevant readonly commands", () => {
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

test("rejects mutating git commands", () => {
  assert.throws(
    () => validateGitReadonlyArgs(["checkout", "main"]),
    /not allowed/,
  );
  assert.throws(
    () => validateGitReadonlyArgs(["reset", "--hard"]),
    /not allowed/,
  );
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

test("rejects git output-to-file and arbitrary-file options", () => {
  assert.throws(
    () => validateGitReadonlyArgs(["log", "--output=/tmp/out"]),
    /Unsafe/,
  );
  assert.throws(
    () =>
      validateGitReadonlyArgs([
        "diff",
        "--no-index",
        "/etc/passwd",
        "/dev/null",
      ]),
    /Unsafe/,
  );
});
