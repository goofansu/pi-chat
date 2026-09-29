import { choice, TypeSafeClient } from "@typesafe-ai/sdk";

export type QuestionRoute = "engineering" | "support" | "clarify";

const ROUTE_QUESTION = choice(
  "Which information source should answer the user's current question? The configured project name is provided in state, but do not assume unexplained product names or acronyms refer to it. Choose engineering only when the question explicitly names that project, explicitly asks about source code or repository artifacts, or is a clear follow-up to an engineering route. Choose clarify when missing context, unknown product names, or unexplained acronyms prevent a reliable choice between engineering and support.",
  {
    engineering:
      "The question explicitly concerns the named project or asks about its source code, repository, files, classes, functions, implementation, architecture, debugging, or developer workflow and therefore requires private repository inspection.",
    support:
      "The question clearly asks about known product usage, documented behavior, configuration, policies, data connections, integrations, how-to guidance, or troubleshooting that should be answered from published support websites.",
    clarify:
      "The question is ambiguous or relies on unknown product names, acronyms, or missing context. Ask the user what those terms mean and whether the question concerns the named project; do not guess or choose an evidence source yet.",
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
    projectName?: string,
  ): Promise<QuestionRouteDecision> {
    const currentQuestion = question.trim();
    if (!currentQuestion) throw new Error("question is required for routing");

    const configuredProject = projectName?.trim() || "unknown";
    const result = await this.#systemOne({
      state: {
        current_question: currentQuestion,
        previous_route: previousRoute ?? "none",
        project_name: configuredProject,
      },
      questions: { route: ROUTE_QUESTION },
    });
    const answer = result.answers.route;
    const explicitlyNamesProject =
      configuredProject !== "unknown" &&
      currentQuestion
        .toLocaleLowerCase()
        .includes(configuredProject.toLocaleLowerCase());

    return {
      // An explicit project reference breaks a low-confidence tie toward the
      // repository. Every other low-confidence result asks the user for the
      // missing context instead of guessing an evidence source.
      route:
        explicitlyNamesProject && answer.confidence < 0.5
          ? "engineering"
          : answer.choice === "clarify" || answer.confidence < 0.5
            ? "clarify"
            : answer.choice,
      classification: answer.choice,
      confidence: answer.confidence,
      probabilities: answer.probabilities,
      model: result.model,
    };
  }
}
