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
  };
  questions: Record<string, unknown>;
}

function fakeClient(
  route: QuestionRoute,
  inspect?: (request: RoutingRequest) => void,
  confidence = 0.9,
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
            probabilities: {
              engineering: route === "engineering" ? 0.95 : 0.05,
              support: route === "support" ? 0.95 : 0.05,
            },
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
    probabilities: { engineering: 0.05, support: 0.95 },
    model: "jev-test",
  });
});

test("routes support to the codebase unless confidence is above 0.95", async () => {
  for (const confidence of [0.2, 0.8, 0.95]) {
    const router = new JevQuestionRouter(
      "test-key",
      fakeClient("support", undefined, confidence).systemOne,
    );
    const decision = await router.classify("How does this work?");

    assert.equal(decision.classification, "support");
    assert.equal(decision.route, "engineering");
  }
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

  await router.classify("What happens on retry?", "engineering");
  assert.deepEqual(state, {
    current_question: "What happens on retry?",
    previous_route: "engineering",
  });
});

test("rejects an empty question", async () => {
  const router = new JevQuestionRouter(
    "test-key",
    fakeClient("support").systemOne,
  );
  await assert.rejects(() => router.classify("  "), /question is required/);
});
