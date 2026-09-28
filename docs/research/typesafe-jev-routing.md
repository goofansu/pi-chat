# Research: TypeSafe AI Jev routing for `pi-chat`

_Date: 2026-09-28_

_Codebase baseline: `3ba83fa939c0a015d6d652d039efdb75c85c73a2`, including the current uncommitted working tree. No application code was changed for this research._

## Recommendation

Use the official `@typesafe-ai/sdk` server-side and one **Choice** question with two well-described labels, `engineering` and `support`. Initialize one `TypeSafeClient` at startup with an explicitly supplied, project-prefixed secret (`PI_CHAT_JEV_API_KEY`), call it once per accepted Slack message before creating/prompting a Pi session, and route only when the returned Choice confidence clears a threshold calibrated on representative messages.

Log the chosen label, both probabilities, confidence, resolved model, and latency (never message text or the key), and review labeled production samples when tuning the threshold. The implemented product policy checks the codebase by default and selects support websites only when Jev chooses support with confidence strictly above `0.95`; TypeSafe explicitly says thresholds depend on domain and risk ([confidence guide](https://docs.typesafe.ai/confidence), [intent-routing pattern](https://docs.typesafe.ai/patterns/intent-routing)).

## Official HTTP contract

- **Endpoint:** `POST https://api.typesafe.ai/v1/systemone`.
- **Authentication:** `Authorization: Bearer <API_KEY>` and `Content-Type: application/json`. Keys are created in the TypeSafe dashboard. The official direct SDK reads `TYPESAFE_API_KEY` by default ([quick start](https://docs.typesafe.ai/introduction/quickstart), [API reference](https://docs.typesafe.ai/api)).
- **Model:** use `jev-latest` initially. It is the stable alias and SDK default; currently it resolves to `jev-1.13.0`. Because aliases can move, record the response's versioned `model`. Pin `jev-1.13.0` after threshold calibration if routing must remain stable until an explicit re-evaluation ([models](https://docs.typesafe.ai/models)).
- **Input limitation:** Jev is text-only. `state` may be a string or JSON object/array of text values, but images/audio/video must first be converted to text ([models](https://docs.typesafe.ai/models)).

Recommended request shape:

```json
{
  "model": "jev-latest",
  "state": {
    "current_message": "Where is the retry logic implemented?",
    "thread_context": "...bounded prior user/assistant turns when needed..."
  },
  "questions": {
    "route": {
      "type": "choice",
      "instructions": "Classify the primary response the user is requesting.",
      "criteria": {
        "engineering": "Requests source locations, code, implementation details, architecture, debugging, or changes for an engineer.",
        "support": "Requests user-visible behavior, product guidance, troubleshooting steps, or an answer suitable for a support agent or customer."
      }
    }
  }
}
```

`state`, `model`, and a non-empty named `questions` map form the request. A Choice has `type: "choice"`, instructions, and a criteria map (up to 255 options). Answer keys match question keys; the key itself is not used for inference ([API reference](https://docs.typesafe.ai/api), [Choice guide](https://docs.typesafe.ai/primitives/choice)).

Relevant response shape:

```json
{
  "model": "jev-1.13.0",
  "answers": {
    "route": {
      "type": "choice",
      "choice": "engineering",
      "probabilities": { "engineering": 0.91, "support": 0.09 },
      "confidence": 0.82
    }
  },
  "usage": { "input_tokens": 123, "output_tokens": 17 }
}
```

For Choice, `choice` is the highest-probability option, `probabilities` contains every option, and `confidence` is a 0–1 statistic derived from the distribution. Confidence is not the selected option's probability. A flat distribution means ambiguity; TypeSafe recommends high/medium/low behavior bands rather than always acting ([API reference](https://docs.typesafe.ai/api), [confidence guide](https://docs.typesafe.ai/confidence)).

The API documents `401` for bad auth, `422` for invalid requests, `429` for rate limiting, and `529` for overload. Official SDKs retry transient failures with backoff ([API reference](https://docs.typesafe.ai/api)).

## TypeScript SDKs

### Preferred: official TypeSafe SDK

`@typesafe-ai/sdk@0.6.0` is TypeSafe's official JavaScript/TypeScript SDK, requires Node 20+, ships ESM/CommonJS declarations, and infers answer labels from the Choice criteria ([JavaScript SDK docs](https://docs.typesafe.ai/sdk/javascript), [official source at `v0.6.0`](https://github.com/typesafe-ai/typesafe-sdk-js/tree/v0.6.0)). Its API is:

```ts
import { choice, TypeSafeClient } from "@typesafe-ai/sdk";

const client = new TypeSafeClient({
  apiKey: process.env.PI_CHAT_JEV_API_KEY,
  defaultModel: "jev-latest",
});

const result = await client.systemOne({
  state,
  questions: {
    route: choice("Classify the primary response the user is requesting.", {
      engineering: "...",
      support: "...",
    }),
  },
});

const { choice: route, probabilities, confidence } = result.answers.route;
```

The client defaults to `https://api.typesafe.ai`, sends `/v1/systemone` with Bearer auth, defaults to `jev-latest`, has a 10-second per-attempt timeout, and retries twice by default. It supports cancellation, custom timeout/retry/fetch, and `GET /v1/models` ([client source](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/client.ts), [types](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/types.ts), [model resource](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/resources/models.ts)). Version `0.6.0` is pinned in this working tree's `package.json` and lockfile. `src/question-router.ts` wraps it, and `src/index.ts` calls the router before creating each Pi session.

Use an explicit `apiKey` rather than exposing the SDK's canonical `TYPESAFE_API_KEY` variable. This repository promises all application secrets use `PI_CHAT_` so `delegatedEnv` removes them before launching Claude (`.env.example`; `src/extensions/claude.ts`). The draft router's `PI_CHAT_JEV_API_KEY` preserves that boundary without copying the secret into an unprefixed process variable.

### Also available: Vercel AI SDK provider

Vercel publishes `@ai-sdk/typesafe-ai`, which maps TypeSafe Choice/Score/Noul into AI SDK's experimental evaluation API. It uses `TYPESAFE_AI_API_KEY`, defaults to base URL `https://api.typesafe.ai/v1`, and exposes Choice confidence under `result.providerMetadata.typesafe.confidence[questionId]` ([official provider docs/source](https://github.com/vercel/ai/tree/main/packages/typesafe-ai)). It is valid, but is unnecessary here: `pi-chat` does not use Vercel AI SDK, while the direct SDK has fewer dependencies and exposes native Choice confidence directly.

## Codebase routing point

Both Slack entry handlers converge on `askPi(thread, message)` (`src/index.ts:292`, called at `src/index.ts:436-452`). Inside `askPi`, the app:

1. resolves an existing thread session;
2. downloads image attachments;
3. creates `prompt` from the current message, adding fetched Slack history only for a new thread;
4. rejects empty text/image-less input;
5. adds the eyes reaction; then
6. opens/creates the Pi session and calls `session.prompt` (`src/index.ts:297-352`).

The clean routing seam is **after the empty-input check and before session creation**. Classification should therefore happen once for new mentions and subscribed follow-ups, before expensive Pi/Claude work. The implementation now uses this seam and keeps the router independently unit-tested.

Do not blindly classify only the assembled `prompt`: for new threads it embeds names and all fetched history, while follow-ups contain only the current text. Build a bounded, explicit state object with `current_message` and only the prior context needed to interpret terse follow-ups. The draft router currently supplies only `current_question` plus `previous_route`; validate that against terse follow-ups because a prior label cannot supply missing subject matter. Define and test privacy/retention expectations before sending Slack content to this external API. Image-only messages need a declared fallback because Jev cannot inspect the existing `ImageContent` payload.

Also settle what the labels mean before rollout. The draft criteria classify by **information source** (repository versus published support sites), while the requested names suggest **audience/answer style** (engineer versus support agent). Those differ for questions about user-visible behavior that still require repository verification. Encode one meaning in mutually exclusive criteria and make downstream routing match it.

The implementation now selects disjoint active tool sets per turn: engineering exposes repository/Claude tools, while support exposes only web search. The system prompt also gives engineering and support answers distinct response policies.

## Rollout decisions

1. Write mutually exclusive route definitions and a labeled evaluation set, including terse follow-ups, mixed product/code questions, pasted logs, non-English text, empty text, and image-only messages.
2. Apply the chosen tie-break policy: low confidence, API errors, and unsupported input fall back to engineering/codebase verification; support requires confidence strictly above `0.95`.
3. Tune thresholds against that set. Do not treat the documentation's example `0.5` as a production guarantee.
4. Decide whether to pin `jev-1.13.0`; if retaining `jev-latest`, alert on a changed resolved model and rerun calibration.
5. Keep TypeSafe initialization at process startup so a missing key fails clearly, but contain per-message network failures so Slack's queued message processing does not lose the existing response path.
