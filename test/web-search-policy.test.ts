import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  domainAllowlistGoggle,
  parseWebSearchDomains,
  webSearchPolicyExtension,
} from "../src/extensions/web-search-policy.ts";

test("parses and normalizes a configured domain allowlist", () => {
  assert.deepEqual(
    parseWebSearchDomains(
      " docs.example.com, HTTPS://Support.Example.com/ ,docs.example.com",
    ),
    ["docs.example.com", "support.example.com"],
  );
});

test("requires a configured domain allowlist", () => {
  assert.throws(
    () => parseWebSearchDomains(undefined),
    /PI_CHAT_WEB_SEARCH_DOMAINS is required/,
  );
  assert.throws(
    () => parseWebSearchDomains("  "),
    /PI_CHAT_WEB_SEARCH_DOMAINS is required/,
  );
});

test("rejects domain entries that cannot be represented as Brave site rules", () => {
  for (const value of [
    "ftp://example.com",
    "https://example.com/docs",
    "https://example.com:8443",
    "https://user:secret@example.com",
  ]) {
    assert.throws(() => parseWebSearchDomains(value), /Web search domain/);
  }
});

test("builds a Brave allowlist Goggle", () => {
  assert.equal(
    domainAllowlistGoggle(["docs.example.com", "support.example.com"]),
    "$discard%0A$boost,site=docs.example.com%0A$boost,site=support.example.com",
  );
});

test("policy overwrites model-supplied Goggles for web search", () => {
  interface WebSearchCall {
    type: "tool_call";
    toolName: string;
    input: Record<string, unknown>;
  }

  let handler: ((event: WebSearchCall) => void) | undefined;
  webSearchPolicyExtension(["docs.example.com"])({
    on(event: string, callback: (event: WebSearchCall) => void) {
      if (event === "tool_call") handler = callback;
    },
  } as unknown as ExtensionAPI);

  const event: WebSearchCall = {
    type: "tool_call",
    toolName: "web_search",
    input: { query: "release notes", goggles: "$discard,site=example.com" },
  };
  handler?.(event);
  assert.equal(event.input.goggles, "$discard%0A$boost,site=docs.example.com");
});

test("policy blocks fetches outside the allowlist", () => {
  type CallHandler = (event: Record<string, unknown>) => unknown;
  let handler: CallHandler | undefined;
  webSearchPolicyExtension(["docs.example.com"])({
    on(event: string, callback: CallHandler) {
      if (event === "tool_call") handler = callback;
    },
  } as unknown as ExtensionAPI);

  const accepted = handler?.({
    toolName: "web_fetch",
    input: { url: "https://docs.example.com/guide" },
  });
  assert.equal(accepted, undefined);

  const duplicate = handler?.({
    toolName: "web_fetch",
    input: { url: "https://docs.example.com/guide" },
  }) as { block?: boolean; reason?: string } | undefined;
  assert.equal(duplicate?.block, true);
  assert.match(duplicate?.reason ?? "", /already fetched/);

  const blocked = handler?.({
    toolName: "web_fetch",
    input: { url: "https://other.example.com/guide" },
  }) as { block?: boolean; reason?: string } | undefined;
  assert.equal(blocked?.block, true);
  assert.match(blocked?.reason ?? "", /outside.*PI_CHAT_WEB_SEARCH_DOMAINS/);
});

test("policy rejects search output from outside the allowlist", () => {
  type ResultHandler = (event: Record<string, unknown>) => unknown;
  let handler: ResultHandler | undefined;
  webSearchPolicyExtension(["docs.example.com"])({
    on(event: string, callback: ResultHandler) {
      if (event === "tool_result") handler = callback;
    },
  } as unknown as ExtensionAPI);

  const accepted = handler?.({
    toolName: "web_search",
    isError: false,
    details: { sources: [{ url: "https://docs.example.com/guide" }] },
  });
  assert.equal(accepted, undefined);

  const rejected = handler?.({
    toolName: "web_search",
    isError: false,
    details: { sources: [{ url: "https://other.example.com/guide" }] },
  }) as { isError?: boolean; content?: Array<{ text?: string }> } | undefined;
  assert.equal(rejected?.isError, true);
  assert.match(rejected?.content?.[0]?.text ?? "", /outside.*allowlist/);
});

test("policy rejects fetch output redirected outside the allowlist", () => {
  type ResultHandler = (event: Record<string, unknown>) => unknown;
  let handler: ResultHandler | undefined;
  webSearchPolicyExtension(["docs.example.com"])({
    on(event: string, callback: ResultHandler) {
      if (event === "tool_result") handler = callback;
    },
  } as unknown as ExtensionAPI);

  const rejected = handler?.({
    toolName: "web_fetch",
    isError: false,
    details: { source_url: "https://other.example.com/redirected" },
  }) as { isError?: boolean; content?: Array<{ text?: string }> } | undefined;
  assert.equal(rejected?.isError, true);
  assert.match(rejected?.content?.[0]?.text ?? "", /outside.*allowlist/);
});

test("unrestricted policy registers no tool hook", () => {
  let registered = false;
  webSearchPolicyExtension([])({
    on() {
      registered = true;
    },
  } as unknown as ExtensionAPI);
  assert.equal(registered, false);
});
