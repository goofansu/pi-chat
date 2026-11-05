import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

import { webSearchPolicyExtension } from "../src/extensions/web-search-policy.ts";
import { parsePiChatModel } from "../src/model-ref.ts";
import { createProjectProviderServices } from "../src/provider-config.ts";

test("rejects a missing project provider API key", () => {
  assert.throws(
    () => createProjectProviderServices("anthropic", undefined),
    /PI_CHAT_PROVIDER_API_KEY env variable is required/,
  );
});

test("rejects an empty project provider API key", () => {
  assert.throws(
    () => createProjectProviderServices("anthropic", ""),
    /PI_CHAT_PROVIDER_API_KEY env variable is required/,
  );
});

test("rejects a whitespace-only project provider API key", () => {
  assert.throws(
    () => createProjectProviderServices("anthropic", " \t\n"),
    /PI_CHAT_PROVIDER_API_KEY env variable is required/,
  );
});

test("provider services keep filesystem and model-network isolation guards", async () => {
  const source = await readFile(
    new URL("../src/provider-config.ts", import.meta.url),
    "utf8",
  );
  const runtimeOptions = source.match(
    /ModelRuntime\.create\s*\(\s*\{([\s\S]*?)\}\s*\)/,
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
  assert.match(
    source,
    /setRuntimeApiKey\s*\(\s*provider\s*,\s*apiKey\s*\)/,
    "the project key must be installed directly into the isolated runtime",
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
  assert.match(source, /process\.env\.PI_CHAT_PROVIDER_API_KEY/);
  assert.match(
    source,
    /await createProjectProviderServices\([\s\S]*?modelProvider,[\s\S]*?process\.env\.PI_CHAT_PROVIDER_API_KEY,[\s\S]*?\)/,
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
  assert.match(source, /settingsManager,/);
  assert.match(source, /resourceLoader: loader/);
});

test("the application prompt investigates directly without Claude delegation", async () => {
  const source = await readFile(
    new URL("../src/index.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /claudeExtension|findClaudeBinary|"claude"/);
  assert.match(source, /Investigate the codebase directly/);
  assert.match(
    source,
    /paths that enter the state, exit it, and trigger the behaviour/,
  );
  assert.match(
    source,
    /Base engineering answers only on project evidence you inspected/,
  );
  assert.match(source, /support answers only on the configured websites/);
  assert.match(source, /Preserve uncertainty in the customer-facing answer/);
  assert.match(source, /\*\*References\*\*/);
});

test("loads Claude Code models without a project key or network discovery", async (t) => {
  const previousCommand = process.env.PI_CLAUDE_CODE_COMMAND;
  // Do not use the developer's real CLI or login during tests.
  process.env.PI_CLAUDE_CODE_COMMAND = join(tmpdir(), "pi-chat-no-such-claude");
  t.after(() => {
    if (previousCommand === undefined)
      delete process.env.PI_CLAUDE_CODE_COMMAND;
    else process.env.PI_CLAUDE_CODE_COMMAND = previousCommand;
  });
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Model loading must not use the network");
  });

  for (const apiKey of [undefined, "", " \t\n", "unused-project-key"]) {
    await t.test(`project key: ${JSON.stringify(apiKey)}`, async () => {
      const { modelRuntime, credentialStore, resourceLoader } =
        await createProjectProviderServices("claude-code", apiKey);
      assert.deepEqual(modelRuntime.getRegisteredProviderIds(), [
        "claude-code",
      ]);
      assert.ok(modelRuntime.getRegisteredNativeProvider("claude-code"));
      const model = modelRuntime.getModel("claude-code", "default");
      assert.ok(model);
      assert.equal(model.provider, "claude-code");
      assert.equal(model.api, "claude-code-stream-json");
      assert.ok(modelRuntime.getModel("claude-code", "claude-sonnet-5"));
      assert.equal(
        modelRuntime.getModel("claude-code", "not-a-model"),
        undefined,
      );
      assert.ok(modelRuntime.getProvider("anthropic"));
      assert.deepEqual(resourceLoader.getExtensions().errors, []);
      assert.equal(resourceLoader.getExtensions().extensions.length, 1);
      assert.deepEqual(await credentialStore.list(), []);
      assert.equal(
        (await modelRuntime.getAuth("claude-code"))?.source,
        "Claude Code CLI",
      );
      assert.notEqual(
        modelRuntime.getProviderAuthStatus("claude-code").source,
        "runtime",
      );
    });
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("Claude Code sessions retain Pi's route-specific tool sets", async (t) => {
  const previousCommand = process.env.PI_CLAUDE_CODE_COMMAND;
  process.env.PI_CLAUDE_CODE_COMMAND = join(tmpdir(), "pi-chat-no-such-claude");
  t.after(() => {
    if (previousCommand === undefined)
      delete process.env.PI_CLAUDE_CODE_COMMAND;
    else process.env.PI_CLAUDE_CODE_COMMAND = previousCommand;
  });
  const parsed = parsePiChatModel("claude-code/default:high");
  const services = await createProjectProviderServices(
    parsed.provider,
    undefined,
    {
      cwd: process.cwd(),
      resourceLoaderOptions: {
        additionalExtensionPaths: [
          fileURLToPath(
            import.meta.resolve("@goofansu/pi-web/extensions/web-search.ts"),
          ),
          fileURLToPath(
            import.meta.resolve("@goofansu/pi-web/extensions/web-fetch.ts"),
          ),
        ],
        extensionFactories: [webSearchPolicyExtension(["docs.example.com"])],
      },
    },
  );
  const model = services.modelRuntime.getModel(parsed.provider, parsed.modelId);
  assert.ok(
    model,
    "provider models must be registered before session creation",
  );
  const engineeringTools = ["read", "grep", "find", "ls"];
  const supportTools = ["web_search", "web_fetch"];
  const { session } = await createAgentSession({
    ...services,
    model,
    thinkingLevel: parsed.thinkingLevel,
    sessionManager: SessionManager.inMemory(),
    tools: [...engineeringTools, ...supportTools],
  });
  t.after(() => session.dispose());
  assert.equal(session.model?.provider, "claude-code");
  assert.equal(session.model?.id, "default");
  assert.equal(session.thinkingLevel, "high");
  for (const tools of [engineeringTools, supportTools, []]) {
    session.setActiveToolsByName(tools);
    assert.deepEqual(session.getActiveToolNames().sort(), [...tools].sort());
  }
  assert.deepEqual(
    session
      .getAllTools()
      .map(({ name }) => name)
      .sort(),
    [...engineeringTools, ...supportTools].sort(),
  );
});

test("does not discover user or project configuration", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-chat-provider-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const agentDir = join(directory, "agent");
  const cwd = join(directory, "project");
  for (const configDir of [agentDir, join(cwd, ".pi")]) {
    await mkdir(join(configDir, "extensions"), { recursive: true });
    await writeFile(join(configDir, "auth.json"), "not valid JSON");
    await writeFile(join(configDir, "models.json"), "not valid JSON");
    await writeFile(join(configDir, "settings.json"), "not valid JSON");
    await writeFile(
      join(configDir, "extensions", "bad.ts"),
      'throw new Error("must not load");',
    );
  }
  const { resourceLoader, settingsManager, modelRuntime } =
    await createProjectProviderServices("anthropic", "project-secret", {
      cwd,
      agentDir,
    });
  assert.deepEqual(resourceLoader.getExtensions().extensions, []);
  assert.deepEqual(resourceLoader.getAgentsFiles().agentsFiles, []);
  assert.deepEqual(settingsManager.drainErrors(), []);
  assert.deepEqual(settingsManager.getGlobalSettings(), {});
  assert.deepEqual(settingsManager.getProjectSettings(), {});
  assert.equal(modelRuntime.getError(), undefined);
  assert.equal(modelRuntime.getModel("claude-code", "default"), undefined);
});

test("fails startup when an explicitly configured extension fails to load", async () => {
  await assert.rejects(
    createProjectProviderServices("anthropic", "project-secret", {
      cwd: process.cwd(),
      resourceLoaderOptions: {
        extensionFactories: [
          () => {
            throw new Error("test extension failed");
          },
        ],
      },
    }),
    /Failed to load Pi extensions: .*test extension failed/,
  );
});
