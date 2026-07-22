const SESSION_KEY_PREFIX = "pi:session:";

interface SessionErrorActions {
  invalidateSession(): Promise<void>;
  removeProgressReaction(): Promise<void>;
  addFailureReaction(): Promise<void>;
  postReply(reply: string): Promise<void>;
}

interface SessionPromptActions {
  prompt(): Promise<void>;
  recoverPromptError(error: unknown): Promise<void>;
  continueAfterPrompt(): Promise<void>;
  reportPostPromptError(error: unknown): Promise<void>;
}

export function sessionPathKey(threadId: string): string {
  return `${SESSION_KEY_PREFIX}${threadId}`;
}

export function sessionErrorReply(_error: unknown): string {
  return "Sorry, there was an error.";
}

export async function recoverSessionError(
  error: unknown,
  actions: SessionErrorActions,
): Promise<void> {
  await actions.invalidateSession();
  await actions.removeProgressReaction();
  await actions.addFailureReaction();
  await actions.postReply(sessionErrorReply(error));
}

export async function handleSessionPrompt(
  actions: SessionPromptActions,
): Promise<void> {
  try {
    await actions.prompt();
  } catch (err) {
    await actions.recoverPromptError(err);
    return;
  }

  try {
    await actions.continueAfterPrompt();
  } catch (err) {
    await actions.reportPostPromptError(err);
  }
}
