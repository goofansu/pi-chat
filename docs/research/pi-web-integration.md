# Research: integrating `@goofansu/pi-web` into `pi-chat`

_Date: 2026-09-28_

_Codebase baseline inspected: `3ba83fa939c0a015d6d652d039efdb75c85c73a2`. Relative source paths and line references describe that baseline._

## Conclusion

Integration is feasible, but it is not a drop-in `pi install` operation for this application. `pi-chat` deliberately disables discovered extensions and supplies an explicit tool allowlist, so it must load the package's TypeScript extension files through `DefaultResourceLoader.additionalExtensionPaths` and add `web_search` (and optionally `web_fetch`) to its `tools` list. A smoke test against the published tarball and this repository's Pi 0.87 dependencies successfully loaded `web_search` this way.

For configurable website/domain scope, `pi-web` already passes a per-call `goggles` value to Brave LLM Context. That is suitable for user-requested, best-effort source selection. A deployment-wide allowlist should not depend on the model choosing the right argument: add a small local policy extension that replaces `goggles` on every `web_search` tool call from a validated `PI_CHAT_*` configuration value. If `web_fetch` is enabled, the same policy must block fetch URLs outside the configured host set or search restrictions can be bypassed.

## What the package contains

The npm registry currently publishes only `@goofansu/pi-web@1.0.0`. Its metadata identifies upstream commit `19eeea4a84d5bcaba0eaceb9ad3e4ec73a7c6391`, tarball integrity `sha512-5PreY...cvYUA==`, wildcard Pi peer dependencies, and two Pi extensions: `extensions/web-fetch.ts` and `extensions/web-search.ts` ([registry metadata](https://registry.npmjs.org/%40goofansu%2Fpi-web/1.0.0); [published package manifest](https://github.com/goofansu/pi-web/blob/19eeea4a84d5bcaba0eaceb9ad3e4ec73a7c6391/package.json#L32-L54)). The tarball contains those two files, their shared exe.dev integration resolver, the README, license, and manifest; it contains TypeScript source rather than compiled JavaScript ([tarball](https://registry.npmjs.org/@goofansu/pi-web/-/pi-web-1.0.0.tgz)).

`web_search` calls Brave's LLM Context endpoint and returns extracted content plus numbered sources. It supports query/count/token/relevance/freshness controls and a `goggles` string ([published source](https://github.com/goofansu/pi-web/blob/19eeea4a84d5bcaba0eaceb9ad3e4ec73a7c6391/extensions/web-search.ts#L615-L688)). The implementation trims `goggles` and sends it unchanged in the Brave request body ([published source](https://github.com/goofansu/pi-web/blob/19eeea4a84d5bcaba0eaceb9ad3e4ec73a7c6391/extensions/web-search.ts#L477-L545)). The package's own guidance explicitly says Goggles can boost, downrank, restrict, or discard domains.

`web_fetch` sends a known URL to Firecrawl and returns sanitized Markdown and metadata ([published source](https://github.com/goofansu/pi-web/blob/19eeea4a84d5bcaba0eaceb9ad3e4ec73a7c6391/extensions/web-fetch.ts#L295-L338)). It is complementary, not necessary for basic search. Its prompt guidance says it should follow selected search results or fetch a user-supplied public URL ([published source](https://github.com/goofansu/pi-web/blob/19eeea4a84d5bcaba0eaceb9ad3e4ec73a7c6391/extensions/web-fetch.ts#L422-L441)).

Both tools treat returned web material as untrusted and include prompt-injection guidance. Search also bounds request duration and output size; fetch saves oversized full output to a temporary file. These are useful safeguards, but extension code runs with the full process permissions, as the package README warns ([upstream README](https://github.com/goofansu/pi-web/blob/eb2e8087aff54f1ec29261bbfbe849268d2660d6/README.md#L47-L49)).

## Fit with this codebase

### Loading and activation

`pi-chat` currently:

- explicitly selects only `read`, `grep`, `find`, `ls`, `git-history`, and `claude` ([`src/index.ts`](../../src/index.ts#L70-L74));
- sets `noExtensions: true` and supplies only two inline extension factories ([`src/index.ts`](../../src/index.ts#L85-L95)); and
- passes that tool allowlist into every session ([`src/index.ts`](../../src/index.ts#L289-L301)).

Therefore installing the dependency alone will not expose its tools. Pi's installed SDK declaration says that an explicit `tools` array enables only named tools (`node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.d.ts`, lines 34–47). The installed loader still resolves explicitly supplied `additionalExtensionPaths` when `noExtensions` is true (`node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.js`, lines 312–319), so this is the clean integration seam.

Do **not** statically import `@goofansu/pi-web/extensions/web-search.ts` as an inline factory from `src/index.ts`. The package ships `.ts` inside `node_modules`; under this project's `node --experimental-strip-types` startup, a direct import fails with Node's `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. In contrast, a smoke test using `additionalExtensionPaths` loaded the same tarball through Pi's extension loader with no errors and registered `web_search`. This agrees with Pi's extension loader design: file-based TypeScript extensions are loaded through its Jiti path, while this app's own source is handled by Node.

A concrete integration would therefore:

1. add an exact package dependency (initially pin `@goofansu/pi-web` to `1.0.0` rather than using a range);
2. resolve `extensions/web-search.ts` from that dependency and pass its filesystem path in `additionalExtensionPaths`;
3. add `web_search` to `tools`;
4. add `web-fetch.ts` and `web_fetch` only if full-page retrieval is required; and
5. fail startup if loader diagnostics show either extension did not load.

### Prompt/architecture changes are required

The current system prompt says all behavioral questions must be delegated to `claude`, says Claude cannot search the web, and instructs Pi to report that web-dependent facts could not be checked ([`src/index.ts`](../../src/index.ts#L97-L111)). The README likewise describes network-dependent questions as unavailable ([`README.md`](../../README.md#L72-L84)). Merely registering `web_search` would leave contradictory routing instructions.

The parent Pi agent—not the delegated Claude process—should own web search. Update the routing policy so repository behavior still goes to `claude`, while external/current facts and source discovery go to `web_search`; mixed questions can use both. Preserve the package's instruction that web results are evidence, never executable instructions.

## Configuring allowed websites/domains

### Per-question scope already works

The model can populate `goggles` when a Slack user asks for particular sources. This needs no package fork. It is, however, model-mediated behavior rather than a security boundary: the argument is optional and the model controls it.

### Persistent allowlist

Brave's primary Goggles documentation says a generic `$discard` changes the default action so unmatched results are excluded, while subsequent site boosts admit the selected hosts. Its example restricts results to two Wikipedia hostnames ([Brave Goggles guide](https://github.com/brave/goggles-quickstart/blob/e83e5c23d2c365f0708b1247e3cc598b756e987e/getting-started.md#how-can-i-exclude-any-result-not-matched-by-my-goggle)). Thus an allowlist can be represented conceptually as:

```text
$discard
$boost=1,site=docs.example.com
$boost=1,site=vendor.example
```

`pi-web` accepts either a Goggle URL or inline rules, with inline rules separated by `%0A` ([published schema](https://github.com/goofansu/pi-web/blob/19eeea4a84d5bcaba0eaceb9ad3e4ec73a7c6391/extensions/web-search.ts#L682-L686)). For a short domain list, generate the encoded inline value. For a larger or centrally maintained policy, configure a pre-registered Goggle URL; Brave documents hosting, validation, caching, and size limits ([Brave guide](https://github.com/brave/goggles-quickstart/blob/e83e5c23d2c365f0708b1247e3cc598b756e987e/getting-started.md#creating-a-goggle)). Note that a private Goggle URL can identify a small user population, which Brave calls out as a privacy consideration ([Brave README](https://github.com/brave/goggles-quickstart/blob/e83e5c23d2c365f0708b1247e3cc598b756e987e/README.md#privacy-considerations)).

Recommended policy design:

- expose a `PI_CHAT_WEB_SEARCH_GOGGLES` value (URL or complete encoded rules), or a validated `PI_CHAT_WEB_SEARCH_ALLOWED_DOMAINS` list from which rules are generated;
- register a local extension **after** `pi-web` that handles `tool_call` for `web_search` and overwrites `event.input.goggles` with the configured policy;
- reject an empty/invalid configured policy at startup rather than silently searching the whole web;
- define whether an entry permits only the exact hostname or also subdomains; use parsed/lower-cased hostnames, not string suffix checks; and
- if `web_fetch` is active, parse and gate its `url` in the same hook. Otherwise a user or model could fetch outside the search allowlist.

Pi supports this without wrapping `pi-web`: its installed event contract says `tool_call` input is mutable before execution and later handlers see the mutation; it can also block a call (`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`, lines 780–790 and 887–895). Validate the replacement value in the policy hook because Pi explicitly performs no schema re-validation after mutation.

For policy-grade enforcement, also inspect returned `details.sources` and reject/redact unexpected hostnames. Goggles is a Brave-side ranking/filter mechanism, not a network firewall, and this provides fail-closed defense if service behavior or rules change.

## Credentials and exe.dev

The package can discover attached exe.dev integrations through `reflection.int.exe.xyz/integrations`, caching either the credential-injecting Brave/Firecrawl endpoint or the public endpoint ([published resolver](https://github.com/goofansu/pi-web/blob/19eeea4a84d5bcaba0eaceb9ad3e4ec73a7c6391/extensions/exe-integration.ts#L1-L58)). The published search extension otherwise reads `BRAVE_SEARCH_API_KEY`; fetch reads `FIRECRAWL_API_KEY` ([search](https://github.com/goofansu/pi-web/blob/19eeea4a84d5bcaba0eaceb9ad3e4ec73a7c6391/extensions/web-search.ts#L505-L527), [fetch](https://github.com/goofansu/pi-web/blob/19eeea4a84d5bcaba0eaceb9ad3e4ec73a7c6391/extensions/web-fetch.ts#L307-L326)).

Prefer attached exe.dev integrations here because they avoid putting these service keys in the process environment. If direct keys are used, there is a security mismatch to fix: `pi-chat` promises that all application configuration uses the `PI_CHAT_` prefix ([`.env.example`](../../.env.example#L1-L2)), and `delegatedEnv` strips only variables with that prefix before launching Claude ([`src/extensions/claude.ts`](../../src/extensions/claude.ts#L540-L566)). Unprefixed `BRAVE_SEARCH_API_KEY` or `FIRECRAWL_API_KEY` would therefore be inherited by the attacker-influenceable delegated process. Do not ship that arrangement. Either extend the delegation filter for these exact variables and test it, or adapt/vendor the extension so credentials are supplied from `PI_CHAT_*` configuration without becoming ambient child-process environment.

## Version caveat

Upstream `main` is two commits beyond npm 1.0.0. Commit `d2a3d15` makes credential resolution lazy and gives an explicit API key precedence over exe.dev discovery; commit `eb2e808` adjusts guidance when another search tool is present. Current main now resolves credentials at first search and returns a direct configuration error if neither key nor integration exists ([current source](https://github.com/goofansu/pi-web/blob/eb2e8087aff54f1ec29261bbfbe849268d2660d6/extensions/web-search.ts#L595-L629); [current README](https://github.com/goofansu/pi-web/blob/eb2e8087aff54f1ec29261bbfbe849268d2660d6/README.md#L26-L34)).

Use the published, integrity-pinned 1.0.0 for reproducibility only if its eager session-start discovery and credential precedence are acceptable. Otherwise wait for a release containing those fixes or pin the reviewed upstream commit explicitly; do not silently consume a moving branch.

## Recommendation

Proceed in two stages:

1. **Search-only pilot:** install an exact reviewed version, load `web-search.ts` via `additionalExtensionPaths`, activate `web_search`, use the attached exe.dev Brave integration, update the parent routing prompt, and add source-domain logging/validation.
2. **Domain-policy rollout:** add a tested domain policy extension that overwrites every `goggles` argument. Enable `web_fetch` only after implementing the equivalent hostname gate and deciding whether subdomains and redirects are allowed.

The implementation now enables `web_fetch` with exact-host checks before each request and verifies Firecrawl's returned `source_url` after redirects. Both tools share the required `PI_CHAT_WEB_SEARCH_DOMAINS` policy.

This keeps the package largely upstream while making the application's domain policy deterministic and preserving `pi-chat`'s existing secret-isolation model.
