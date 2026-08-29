export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

const THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

export function parsePiChatModel(value: string): {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
} {
  const lastColon = value.lastIndexOf(":");
  let modelRef = value;
  let thinkingLevel: ThinkingLevel = "medium";
  if (lastColon !== -1) {
    const suffix = value.slice(lastColon + 1);
    if (THINKING_LEVELS.has(suffix as ThinkingLevel)) {
      modelRef = value.slice(0, lastColon);
      thinkingLevel = suffix as ThinkingLevel;
    }
  }

  const slash = modelRef.indexOf("/");
  const provider = slash === -1 ? "" : modelRef.slice(0, slash);
  const modelId = slash === -1 ? "" : modelRef.slice(slash + 1);
  if (!provider || !modelId) {
    throw new Error(
      `PI_CHAT_MODEL must be in the form provider/model[:thinking], got: ${value}`,
    );
  }

  return { provider, modelId, thinkingLevel };
}
