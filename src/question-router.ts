import { choice, TypeSafeClient } from "@typesafe-ai/sdk";

export type QuestionRoute = "engineering" | "support";

const ROUTE_QUESTION = choice(
  "Which information source should answer the user's current question? Classify the current question, using the previous route only as context for an ambiguous follow-up.",
  {
    engineering:
      "The user asks about source code, implementation details, architecture, debugging, developer workflows, code locations, or behavior that must be verified in the repository.",
    support:
      "The user asks an end-user or support question about product usage, documented behavior, configuration, policies, how-to guidance, or troubleshooting that should be answered from published support websites.",
  },
);

interface RoutingRequest {
  state: {
    current_question: string;
    previous_route: QuestionRoute | "none";
  };
  questions: { route: typeof ROUTE_QUESTION };
}

interface RoutingResult {
  model: string;
  answers: {
    route: {
      choice: QuestionRoute;
      confidence: number;
      probabilities: Readonly<Record<QuestionRoute, number>>;
    };
  };
}

type SystemOneCall = (request: RoutingRequest) => Promise<RoutingResult>;

export interface QuestionRouteDecision {
  /** Route after applying the conservative confidence policy. */
  route: QuestionRoute;
  /** Jev's unmodified selected label. */
  classification: QuestionRoute;
  confidence: number;
  probabilities: Readonly<Record<QuestionRoute, number>>;
  model: string;
}

export class JevQuestionRouter {
  readonly #systemOne: SystemOneCall;

  constructor(apiKey: string, systemOne?: SystemOneCall) {
    const normalizedKey = apiKey.trim();
    if (!normalizedKey) throw new Error("PI_CHAT_JEV_API_KEY is required");

    if (systemOne) {
      this.#systemOne = systemOne;
    } else {
      const client = new TypeSafeClient({
        apiKey: normalizedKey,
        defaultModel: "jev-latest",
        logLevel: "off",
        timeout: 10_000,
      });
      this.#systemOne = (request) => client.systemOne(request);
    }
  }

  async classify(
    question: string,
    previousRoute?: QuestionRoute,
  ): Promise<QuestionRouteDecision> {
    const currentQuestion = question.trim();
    if (!currentQuestion) throw new Error("question is required for routing");

    const result = await this.#systemOne({
      state: {
        current_question: currentQuestion,
        previous_route: previousRoute ?? "none",
      },
      questions: { route: ROUTE_QUESTION },
    });
    const answer = result.answers.route;

    return {
      // The codebase is the fallback source. Use support websites only when Jev
      // selects support with confidence strictly above the routing threshold.
      route:
        answer.choice === "support" && answer.confidence > 0.95
          ? "support"
          : "engineering",
      classification: answer.choice,
      confidence: answer.confidence,
      probabilities: answer.probabilities,
      model: result.model,
    };
  }
}
