import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { InMemoryCredentialStore } from "@earendil-works/pi-ai";

import { createProjectProviderServices } from "../src/provider-config.ts";

test("rejects a missing project provider API key", () => {
  assert.throws(
    () => createProjectProviderServices("anthropic", undefined),
    /PI_PROVIDER_API_KEY env variable is required/,
  );
});

test("rejects an empty project provider API key", () => {
  assert.throws(
    () => createProjectProviderServices("anthropic", ""),
    /PI_PROVIDER_API_KEY env variable is required/,
  );
});

test("binds the project API key to the selected provider in memory", async () => {
  const { credentialStore, modelRuntime } = await createProjectProviderServices(
    "anthropic",
    "project-secret",
  );

  const authStatus = modelRuntime.getProviderAuthStatus("anthropic");
  assert.equal(authStatus.configured, true);
  assert.equal(authStatus.source, "runtime");
  assert.equal(
    (await modelRuntime.getAuth("anthropic"))?.auth.apiKey,
    "project-secret",
  );
  assert.ok(credentialStore instanceof InMemoryCredentialStore);
  assert.deepEqual(await credentialStore.list(), []);
  assert.deepEqual(modelRuntime.getRegisteredProviderIds(), []);
  assert.ok(modelRuntime.getProvider("anthropic"));
});

test("does not bind the project key to another provider", async () => {
  const { modelRuntime } = await createProjectProviderServices(
    "anthropic",
    "project-secret",
  );

  assert.notEqual(
    (await modelRuntime.getAuth("openai"))?.auth.apiKey,
    "project-secret",
  );
});

test("the application injects project provider services into Pi sessions", async () => {
  const source = await readFile(
    new URL("../src/index.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /createProjectProviderServices\(/);
  assert.match(source, /process\.env\.PI_PROVIDER_API_KEY/);
  assert.match(
    source,
    /await createProjectProviderServices\([\s\S]*?modelProvider,[\s\S]*?process\.env\.PI_PROVIDER_API_KEY,[\s\S]*?\)/,
  );
  assert.match(
    source,
    /createAgentSession\(\{[\s\S]*?modelRuntime,[\s\S]*?\}\)/,
  );
  assert.doesNotMatch(source, /ModelRuntime\.create\(/);
});
