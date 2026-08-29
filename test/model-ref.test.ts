import assert from "node:assert/strict";
import test from "node:test";
import { parsePiChatModel } from "../src/model-ref.ts";
import { createProjectProviderServices } from "../src/provider-config.ts";

test("parses provider/model and defaults thinking to medium", () => {
  assert.deepEqual(parsePiChatModel("anthropic/claude-sonnet-4.6"), {
    provider: "anthropic",
    modelId: "claude-sonnet-4.6",
    thinkingLevel: "medium",
  });
});

test("parses an explicit thinking suffix", () => {
  assert.deepEqual(parsePiChatModel("github-copilot/claude-sonnet-4.6:high"), {
    provider: "github-copilot",
    modelId: "claude-sonnet-4.6",
    thinkingLevel: "high",
  });
});

test("keeps slashes inside the model id, as OpenRouter requires", () => {
  assert.deepEqual(parsePiChatModel("openrouter/openai/gpt-5.6-luna"), {
    provider: "openrouter",
    modelId: "openai/gpt-5.6-luna",
    thinkingLevel: "medium",
  });
});

test("does not treat a colon in the model id as a thinking level", () => {
  assert.deepEqual(parsePiChatModel("openrouter/openai/gpt-5-mini:batch"), {
    provider: "openrouter",
    modelId: "openai/gpt-5-mini:batch",
    thinkingLevel: "medium",
  });
});

test("rejects a missing provider or model id", () => {
  assert.throws(
    () => parsePiChatModel("openrouter"),
    /PI_CHAT_MODEL must be in the form provider\/model\[:thinking\]/,
  );
});

test("resolves OpenRouter model ids that contain slashes", async () => {
  const parsed = parsePiChatModel("openrouter/openai/gpt-5.6-luna");
  const { modelRuntime } = await createProjectProviderServices(
    parsed.provider,
    "project-secret",
  );
  const model = modelRuntime.getModel(parsed.provider, parsed.modelId);
  assert.ok(model);
  assert.equal(model.id, "openai/gpt-5.6-luna");
});
