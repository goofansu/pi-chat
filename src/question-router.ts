import { choice, TypeSafeClient } from "@typesafe-ai/sdk";

export type QuestionRoute = "engineering" | "support" | "clarify";

const ROUTE_QUESTION = choice(
  "Select the evidence source for the current question. Explicit mentions of the configured project have already been routed to its codebase. Use project_name and previous_route as context for this remaining question; choose clarify when the evidence source is uncertain.",
  {
    engineering:
      "Requires inspecting the configured project's source code, repository artifacts, implementation, architecture, or debugging paths, including a clear follow-up to an engineering question.",
    support:
      "Concerns known product usage, documented behavior, configuration, policies, integrations, how-to guidance, or troubleshooting answerable from published support websites.",
    clarify:
      "Missing context, unknown product names, or unexplained acronyms prevent a reliable choice of evidence source. Ask what the terms mean or which product the question concerns.",
  },
);

interface RoutingRequest {
  state: {
    current_question: string;
    previous_route: QuestionRoute | "none";
    project_name: string;
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

export type QuestionRouteDecision =
  | { source: "project-name"; route: "engineering" }
  | {
      source: "jev";
      /** Route after applying the conservative confidence policy. */
      route: QuestionRoute;
      /** Jev's unmodified selected label. */
      classification: QuestionRoute;
      confidence: number;
      probabilities: Readonly<Record<QuestionRoute, number>>;
      model: string;
    };

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
    projectName?: string,
  ): Promise<QuestionRouteDecision> {
    const currentQuestion = question.trim();
    if (!currentQuestion) throw new Error("question is required for routing");

    const configuredProject = projectName?.trim();
    if (
      configuredProject &&
      currentQuestion.toLowerCase().includes(configuredProject.toLowerCase())
    ) {
      return { source: "project-name", route: "engineering" };
    }

    const result = await this.#systemOne({
      state: {
        current_question: currentQuestion,
        previous_route: previousRoute ?? "none",
        project_name: configuredProject || "unknown",
      },
      questions: { route: ROUTE_QUESTION },
    });
    const answer = result.answers.route;

    return {
      source: "jev",
      route:
        answer.choice === "clarify" || answer.confidence < 0.5
          ? "clarify"
          : answer.choice,
      classification: answer.choice,
      confidence: answer.confidence,
      probabilities: answer.probabilities,
      model: result.model,
    };
  }
}
