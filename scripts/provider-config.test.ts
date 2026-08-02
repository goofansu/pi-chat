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

test("rejects a whitespace-only project provider API key", () => {
  assert.throws(
    () => createProjectProviderServices("anthropic", " \t\n"),
    /PI_PROVIDER_API_KEY env variable is required/,
  );
});

test("provider services keep every filesystem and network isolation guard", async () => {
  const source = await readFile(
    new URL("../src/provider-config.ts", import.meta.url),
    "utf8",
  );
  const runtimeOptions = source.match(
    /ModelRuntime\.create\s*\(\s*\{([\s\S]*?)\}\s*\)/,
  )?.[1];
  const runtimeApiKeyOptions = source.match(
    /setRuntimeApiKey\s*\(\s*provider\s*,\s*apiKey\s*,\s*\{([\s\S]*?)\}\s*\)/,
  )?.[1];

  assert.match(
    source,
    /const\s+credentialStore\s*=\s*new\s+InMemoryCredentialStore\s*\(\s*\)/,
    "credentials must use InMemoryCredentialStore",
  );
  assert.ok(runtimeOptions, "expected ModelRuntime.create options");
  assert.match(
    runtimeOptions,
    /\bcredentials\s*:\s*credentialStore\b/,
    "ModelRuntime must receive the in-memory credential store",
  );
  assert.match(
    runtimeOptions,
    /\bmodelsPath\s*:\s*null\b/,
    "ModelRuntime must disable the user-scoped models path",
  );
  assert.match(
    runtimeOptions,
    /\bmodelsStore\s*:\s*new\s+InMemoryModelsStore\s*\(\s*\)/,
    "models must use InMemoryModelsStore",
  );
  assert.match(
    runtimeOptions,
    /\ballowModelNetwork\s*:\s*false\b/,
    "model loading must not use the network",
  );
  assert.ok(runtimeApiKeyOptions, "expected setRuntimeApiKey options");
  assert.match(
    runtimeApiKeyOptions,
    /\ballowNetwork\s*:\s*false\b/,
    "API-key resolution must not use the network",
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
  const sessionCallStarts = [...source.matchAll(/\bcreateAgentSession\s*\(/g)];
  const sessionCalls = [
    ...source.matchAll(/\bcreateAgentSession\s*\(\s*\{[\s\S]*?\n\s*\}\s*\)/g),
  ];

  assert.match(source, /createProjectProviderServices\(/);
  assert.match(source, /process\.env\.PI_PROVIDER_API_KEY/);
  assert.match(
    source,
    /await createProjectProviderServices\([\s\S]*?modelProvider,[\s\S]*?process\.env\.PI_PROVIDER_API_KEY,[\s\S]*?\)/,
  );
  assert.ok(sessionCallStarts.length > 0, "expected a createAgentSession call");
  assert.equal(
    sessionCalls.length,
    sessionCallStarts.length,
    "every createAgentSession call must receive an options object",
  );
  for (const call of sessionCalls) {
    assert.match(
      call[0],
      /(?:^|\n)\s*modelRuntime\s*(?:,|:)/m,
      "every createAgentSession call must include modelRuntime",
    );
  }
  assert.doesNotMatch(source, /ModelRuntime\.create\(/);
});
