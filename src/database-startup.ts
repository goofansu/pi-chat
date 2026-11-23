import { setTimeout } from "node:timers/promises";

/** Wait for the database integration to become available after VM boot. */
export async function connectDatabase(
  state: { connect(): Promise<void> },
  {
    sleep = (ms: number) => setTimeout(ms),
    warn = (message: string) => console.warn(message),
  }: {
    sleep?: (ms: number) => Promise<void>;
    warn?: (message: string) => void;
  } = {},
): Promise<void> {
  const maxAttempts = 10;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await state.connect();
      return;
    } catch (error) {
      if (attempt === maxAttempts) throw error;
      const delay = Math.min(2_000 * 2 ** (attempt - 1), 30_000);
      // Do not include connection errors here: they can contain credentials.
      warn(
        `[pi] Waiting for database (attempt ${attempt}/${maxAttempts} failed); retrying in ${delay / 1_000}s`,
      );
      await sleep(delay);
    }
  }
}
