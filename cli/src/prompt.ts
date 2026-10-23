import { createInterface } from 'node:readline/promises';

// Thrown when stdin reaches EOF while a question is still pending (M37): a
// truncated/EOF stdin at a prompt must abort loudly, not resolve as an empty
// answer (which would look like a declined confirm and exit 0).
/** Signals that confirmation could not complete before EOF or a pipe timeout. */
export class PromptAbortedError extends Error {
  /** Create the safe abort message used when no prompt answer is available. */
  constructor() {
    super('Aborted. Nothing was published.');
    this.name = 'PromptAbortedError';
  }
}

// Round 9 (C-F2): a non-TTY stdin that neither answers nor EOFs (a pipe left
// open by a harness) must not hang the CLI forever — an agent would block on
// the prompt indefinitely. Bound the wait; TTY prompts wait indefinitely.
// Overridable for tests via QUIRE_PROMPT_TIMEOUT_MS.
/**
 * Read the positive non-TTY prompt timeout override.
 *
 * @returns Timeout in milliseconds, defaulting to ten seconds.
 */
function nonTtyPromptTimeoutMs(): number {
  const v = Number(process.env.QUIRE_PROMPT_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 10_000;
}

/**
 * Ask for one trimmed answer, rejecting EOF and idle non-TTY input.
 *
 * @param question - Prompt written to standard output.
 * @returns Trimmed answer supplied on standard input.
 */
export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // Reject if stdin has already ended, or ends, while the question is pending.
  // Detected on process.stdin's own 'close', not the readline's 'close' (which
  // fires on every rl.close() in the finally below). The listener is removed
  // once the question settles so it can't leak into a later ask() and abort an
  // unrelated prompt.
  /**
   * Initialize the EOF rejection callback until the promise executor replaces it.
   */
  let rejectEof: (e: Error) => void = () => {};
  const eof = new Promise<never>((_, rej) => {
    rejectEof = rej;
  });
  const alreadyClosed = process.stdin.closed;
  if (alreadyClosed) {
    rejectEof(new PromptAbortedError());
  } else {
    /**
     * Abort the active question when standard input closes.
     *
     * @returns Undefined after rejecting the pending EOF promise.
     */
    const onStdinClose = () => rejectEof(new PromptAbortedError());
    process.stdin.once('close', onStdinClose);
    let timer: NodeJS.Timeout | undefined;
    try {
      const q = rl.question(question);
      // Round 9 (C-F2): an open-but-silent non-TTY stdin (a pipe that is
      // neither written to nor closed) would otherwise block forever. Time it
      // out; a real terminal waits indefinitely.
      const idle = process.stdin.isTTY
        ? new Promise<never>(() => {})
        : new Promise<never>((_, rej) => {
            timer = setTimeout(() => rej(new PromptAbortedError()), nonTtyPromptTimeoutMs());
          });
      // rl.question() rejects if the interface is closed first (the timeout
      // racing a late stdin close); swallow it so it cannot become an
      // unhandled rejection — the race decides the outcome.
      void q.catch(() => {});
      return (await Promise.race([q, eof, idle])).trim();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      process.stdin.off('close', onStdinClose);
      rl.close();
    }
  }
  // stdin was already closed: the eof promise is already rejected.
  throw await eof;
}

/**
 * Accept an explicit yes answer or a caller-authorized confirmation bypass.
 *
 * @param question - Confirmation text without the answer hint.
 * @param assumeYes - Whether to accept without reading standard input.
 * @returns Whether publication or another requested operation was confirmed.
 */
export async function confirm(question: string, assumeYes = false): Promise<boolean> {
  if (assumeYes) return true;
  const answer = await ask(`${question} [y/N] `);
  return answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
}
