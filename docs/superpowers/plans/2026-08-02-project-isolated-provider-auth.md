# Project-Isolated Provider Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require `PI_PROVIDER_API_KEY` and ensure pi-chat uses only in-memory provider authentication and built-in models rather than user-scoped Pi credentials or model configuration.

**Architecture:** A focused `provider-config` module will validate the process-provided key and construct a paired `AuthStorage.inMemory()` and `ModelRegistry.inMemory()` for one selected provider. The application entry point will construct these services once and pass the same instances to every Pi session, while documentation exposes the new required configuration.

**Tech Stack:** TypeScript, Node.js test runner, `@earendil-works/pi-coding-agent` 0.78.x, pnpm, Biome

## Global Constraints

- Provider authentication and model registry must not read `~/.pi/agent/auth.json` or `~/.pi/agent/models.json`.
- `PI_PROVIDER_API_KEY` is required and must never be logged or persisted.
- Only built-in Pi models are available.
- Existing session storage, settings, resource loading, and other Pi state retain their current behavior.
- Implementation follows strict red-green-refactor: each production behavior is preceded by a test observed failing for the expected reason.

---

## File Structure

- Create `src/provider-config.ts`: validate the required key and construct isolated in-memory authentication/model services.
- Create `scripts/provider-config.test.ts`: directly test required-key validation, provider binding, and built-in-only registry behavior without starting external services.
- Modify `src/index.ts`: consume the isolated services and inject them into all agent sessions.
- Modify `.env.example`: expose the required provider key variable.
- Modify `README.md`: document required, process-local provider authentication and built-in-model restriction.

### Task 1: Isolated Provider Services

**Files:**
- Create: `src/provider-config.ts`
- Create: `scripts/provider-config.test.ts`

**Interfaces:**
- Consumes: `AuthStorage.inMemory()`, `AuthStorage.setRuntimeApiKey(provider, key)`, and `ModelRegistry.inMemory(authStorage)` from `@earendil-works/pi-coding-agent`.
- Produces: `createProjectProviderServices(provider: string, apiKey: string | undefined): { authStorage: AuthStorage; modelRegistry: ModelRegistry }`.

- [ ] **Step 1: Write the failing tests for required-key validation**

Create `scripts/provider-config.test.ts` with:

```ts
import assert from "node:assert/strict";
import test from "node:test";

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
  const { authStorage, modelRegistry } = createProjectProviderServices(
    "anthropic",
    "project-secret",
  );

  assert.deepEqual(authStorage.getAuthStatus("anthropic"), {
    configured: true,
    source: "runtime",
  });
  assert.equal(
    await modelRegistry.getApiKeyForProvider("anthropic"),
    "project-secret",
  );
  assert.equal(modelRegistry.authStorage, authStorage);
});
```

- [ ] **Step 2: Run the validation tests and verify RED**

Run:

```bash
node --experimental-strip-types --test scripts/provider-config.test.ts
```

Expected: FAIL because `src/provider-config.ts` does not exist.

- [ ] **Step 3: Add the minimal validation implementation**

Create `src/provider-config.ts` with:

```ts
import {
  AuthStorage,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";

export function createProjectProviderServices(
  provider: string,
  apiKey: string | undefined,
): { authStorage: AuthStorage; modelRegistry: ModelRegistry } {
  if (!apiKey) {
    throw new Error("PI_PROVIDER_API_KEY env variable is required");
  }

  const authStorage = AuthStorage.inMemory();
  authStorage.setRuntimeApiKey(provider, apiKey);

  return {
    authStorage,
    modelRegistry: ModelRegistry.inMemory(authStorage),
  };
}
```

- [ ] **Step 4: Run the validation tests and verify GREEN**

Run:

```bash
node --experimental-strip-types --test scripts/provider-config.test.ts
```

Expected: 3 tests PASS. Confirm the implementation uses only `AuthStorage.inMemory()` and `ModelRegistry.inMemory(authStorage)`; no filesystem path or disk-backed factory appears in `src/provider-config.ts`.

- [ ] **Step 5: Run static checks**

Run:

```bash
pnpm typecheck
pnpm lint:check
```

Expected: both commands exit 0 with no diagnostics.

- [ ] **Step 6: Commit the isolated service**

```bash
git add src/provider-config.ts scripts/provider-config.test.ts
git commit -m "feat(auth): add isolated provider services"
```

### Task 2: Application Integration and Configuration Documentation

**Files:**
- Modify: `src/index.ts:4-12,65-67,272-280`
- Modify: `.env.example:4-7`
- Modify: `README.md:23-35`

**Interfaces:**
- Consumes: `createProjectProviderServices(provider, apiKey)` from Task 1.
- Produces: application startup that requires `process.env.PI_PROVIDER_API_KEY` and injects the returned `authStorage` and `modelRegistry` into every `createAgentSession()` call.

- [ ] **Step 1: Write a failing source-level integration test**

Append to `scripts/provider-config.test.ts`:

```ts
import { readFile } from "node:fs/promises";

test("the application injects project provider services into Pi sessions", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");

  assert.match(source, /createProjectProviderServices\(/);
  assert.match(source, /process\.env\.PI_PROVIDER_API_KEY/);
  assert.match(source, /createAgentSession\(\{[\s\S]*?authStorage,[\s\S]*?modelRegistry,/);
  assert.doesNotMatch(source, /AuthStorage\.create\(/);
  assert.doesNotMatch(source, /ModelRegistry\.create\(/);
});
```

- [ ] **Step 2: Run the integration test and verify RED**

Run:

```bash
node --experimental-strip-types --test scripts/provider-config.test.ts
```

Expected: FAIL because `src/index.ts` still calls `AuthStorage.create()` and `ModelRegistry.create()` and does not inject the isolated services.

- [ ] **Step 3: Integrate the isolated provider services**

In `src/index.ts`, remove `AuthStorage` and `ModelRegistry` from the Pi import and add:

```ts
import { createProjectProviderServices } from "./provider-config.ts";
```

Replace:

```ts
const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
```

with:

```ts
const { authStorage, modelRegistry } = createProjectProviderServices(
  modelProvider,
  process.env.PI_PROVIDER_API_KEY,
);
```

Add both services to the existing `createAgentSession` options:

```ts
  const { session } = await createAgentSession({
    cwd: projectDir,
    tools,
    sessionManager,
    model,
    thinkingLevel,
    resourceLoader: loader,
    authStorage,
    modelRegistry,
  });
```

Do not log `PI_PROVIDER_API_KEY`.

- [ ] **Step 4: Run the integration test and verify GREEN**

Run:

```bash
node --experimental-strip-types --test scripts/provider-config.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Update environment and README documentation**

Add to `.env.example` under `PI_MODEL`:

```dotenv
PI_PROVIDER_API_KEY=
```

In the README configuration table, add:

```markdown
| Pi | `PI_PROVIDER_API_KEY` | API key for the provider selected by `PI_MODEL`; held in memory and never persisted | Yes |
```

Replace the user credential instruction with:

```markdown
`PI_MODEL` must identify a built-in Pi model. Provider authentication and the model registry are isolated from user-scoped Pi configuration: the server uses only `PI_PROVIDER_API_KEY` and does not read `~/.pi/agent/auth.json` or `~/.pi/agent/models.json`.
```

- [ ] **Step 6: Run all automated tests**

Run:

```bash
node --experimental-strip-types --test scripts/*.test.ts
```

Expected: all tests PASS with zero failures.

- [ ] **Step 7: Run final project verification**

Run:

```bash
pnpm typecheck
pnpm lint:check
git diff --check
```

Expected: all commands exit 0 with no diagnostics or whitespace errors.

- [ ] **Step 8: Review the final diff for secret safety and isolation**

Run:

```bash
git diff -- src/index.ts src/provider-config.ts scripts/provider-config.test.ts .env.example README.md
rg -n "AuthStorage\.create|ModelRegistry\.create|PI_PROVIDER_API_KEY" src scripts README.md .env.example
```

Expected: no production call to either disk-backed `create()` factory; the API key appears only as an environment-variable name or test fixture and is never logged.

- [ ] **Step 9: Commit integration and documentation**

```bash
git add src/index.ts scripts/provider-config.test.ts .env.example README.md
git commit -m "feat(auth): require project provider credentials"
```
