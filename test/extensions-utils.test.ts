import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { projectCwd } from "../src/extensions/utils.ts";

test("requires PI_CHAT_PROJECT_DIR rather than using the server cwd", () => {
  assert.throws(() => projectCwd({}), /PI_CHAT_PROJECT_DIR.*required/);
  assert.throws(
    () => projectCwd({ PI_CHAT_PROJECT_DIR: "   " }),
    /PI_CHAT_PROJECT_DIR.*required/,
  );
});

test("expands a leading ~ and resolves to an absolute path", () => {
  const env = {
    PI_CHAT_PROJECT_DIR: "~/work/example-project",
    HOME: "/home",
  };
  assert.equal(projectCwd(env), "/home/work/example-project");

  // `~name` is another user's home, not this one's.
  assert.equal(
    projectCwd({ ...env, PI_CHAT_PROJECT_DIR: "~someone/project" }),
    path.resolve("~someone/project"),
  );
  assert.equal(
    projectCwd({ ...env, PI_CHAT_PROJECT_DIR: "/tmp/project" }),
    "/tmp/project",
  );
});
