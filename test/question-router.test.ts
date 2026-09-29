import assert from "node:assert/strict";
import { test } from "node:test";
import {
  JevQuestionRouter,
  type QuestionRoute,
} from "../src/question-router.ts";

interface RoutingRequest {
  state: {
    current_question: string;
    previous_route: QuestionRoute | "none";
    project_name: string;
  };
  questions: Record<string, unknown>;
}

function fakeClient(
  route: QuestionRoute,
  inspect?: (request: RoutingRequest) => void,
  confidence = 0.9,
  probabilities: Readonly<Record<QuestionRoute, number>> = {
    engineering:
      route === "engineering" ? 0.95 : route === "clarify" ? 0.025 : 0.05,
    support: route === "support" ? 0.95 : route === "clarify" ? 0.025 : 0.05,
    clarify: route === "clarify" ? 0.95 : 0,
  },
) {
  return {
    async systemOne(request: RoutingRequest) {
      inspect?.(request);
      return {
        model: "jev-test",
        answers: {
          route: {
            type: "choice" as const,
            choice: route,
            confidence,
            probabilities,
          },
        },
        usage: { input_tokens: 10, output_tokens: 2 },
      };
    },
  };
}

test("requires a Jev API key", () => {
  assert.throws(() => new JevQuestionRouter("  "), /PI_CHAT_JEV_API_KEY/);
});

test("classifies a question and preserves Jev decision metadata", async () => {
  const router = new JevQuestionRouter(
    "test-key",
    fakeClient("support", undefined, 0.96).systemOne,
  );
  const decision = await router.classify("How do I reset my password?");

  assert.deepEqual(decision, {
    route: "support",
    classification: "support",
    confidence: 0.96,
    probabilities: { engineering: 0.05, support: 0.95, clarify: 0 },
    model: "jev-test",
  });
});

test("routes a confident support classification to support", async () => {
  for (const confidence of [0.5, 0.8, 0.95]) {
    const router = new JevQuestionRouter(
      "test-key",
      fakeClient("support", undefined, confidence).systemOne,
    );
    const decision = await router.classify("How does this work?");

    assert.equal(decision.classification, "support");
    assert.equal(decision.route, "support");
  }
});

test("asks for clarification on any low-confidence classification", async () => {
  for (const classification of ["engineering", "support"] as const) {
    const router = new JevQuestionRouter(
      "test-key",
      fakeClient(classification, undefined, 0.04, {
        engineering: 0.52,
        support: 0.48,
        clarify: 0,
      }).systemOne,
    );

    const decision = await router.classify(
      "sc和mb的数据如何打通",
      undefined,
      "example-project",
    );

    assert.equal(decision.route, "clarify");
  }
});

test("honors an explicit clarification classification", async () => {
  const router = new JevQuestionRouter(
    "test-key",
    fakeClient("clarify", undefined, 0.9).systemOne,
  );

  const decision = await router.classify("How do SC and MB connect?");

  assert.equal(decision.classification, "clarify");
  assert.equal(decision.route, "clarify");
});

test("routes an ambiguous engineering classification to clarification", async () => {
  const router = new JevQuestionRouter(
    "test-key",
    fakeClient("engineering", undefined, 0.04, {
      engineering: 0.52,
      support: 0.48,
      clarify: 0,
    }).systemOne,
  );

  const decision = await router.classify(
    "sc和mb的数据如何打通",
    undefined,
    "example-project",
  );

  assert.equal(decision.classification, "engineering");
  assert.equal(decision.route, "clarify");
});

test("requires at least 0.50 confidence for the engineering route", async () => {
  for (const [confidence, expected] of [
    [0.49, "clarify"],
    [0.5, "engineering"],
  ] as const) {
    const router = new JevQuestionRouter(
      "test-key",
      fakeClient("engineering", undefined, confidence).systemOne,
    );
    assert.equal(
      (await router.classify("Where is retry implemented?")).route,
      expected,
    );
  }
});

test("favors engineering for an explicit project question when confidence is low", async () => {
  for (const classification of ["engineering", "support"] as const) {
    const router = new JevQuestionRouter(
      "test-key",
      fakeClient(classification, undefined, 0.18).systemOne,
    );

    const decision = await router.classify(
      "How does pi-chat route Slack questions?",
      undefined,
      "pi-chat",
    );

    assert.equal(decision.route, "engineering");
  }
});

test("keeps a confident support classification about the project on support", async () => {
  const router = new JevQuestionRouter(
    "test-key",
    fakeClient("support", undefined, 0.8).systemOne,
  );

  const decision = await router.classify(
    "How do I reset my password in pi-chat?",
    undefined,
    "pi-chat",
  );

  assert.equal(decision.route, "support");
});

test("keeps engineering classifications on the codebase", async () => {
  const router = new JevQuestionRouter(
    "test-key",
    fakeClient("engineering").systemOne,
  );
  const decision = await router.classify("Where is retry implemented?");

  assert.equal(decision.route, "engineering");
});

test("provides the previous route as context for follow-up questions", async () => {
  let state: RoutingRequest["state"] | undefined;
  const router = new JevQuestionRouter(
    "test-key",
    fakeClient("engineering", (request) => {
      state = request.state;
    }).systemOne,
  );

  await router.classify("What happens on retry?", "engineering", "pi-chat");
  assert.deepEqual(state, {
    current_question: "What happens on retry?",
    previous_route: "engineering",
    project_name: "pi-chat",
  });
});

test("rejects an empty question", async () => {
  const router = new JevQuestionRouter(
    "test-key",
    fakeClient("support").systemOne,
  );
  await assert.rejects(() => router.classify("  "), /question is required/);
});
