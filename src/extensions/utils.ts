import os from "node:os";
import path from "node:path";

/** Resolve the codebase directory shared by every project-scoped tool. */
export function projectCwd(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PI_CHAT_PROJECT_DIR?.trim();
  if (!configured)
    throw new Error("PI_CHAT_PROJECT_DIR env variable is required");

  const expanded =
    configured === "~"
      ? env.HOME || os.homedir()
      : configured.startsWith("~/")
        ? path.join(env.HOME || os.homedir(), configured.slice(2))
        : configured;
  return path.resolve(expanded);
}
