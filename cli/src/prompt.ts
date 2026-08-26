import { createInterface } from 'node:readline/promises';

// Thrown when stdin reaches EOF while a question is still pending (M37): a
// truncated/EOF stdin at a prompt must abort loudly, not resolve as an empty
// answer (which would look like a declined confirm and exit 0).
export class PromptAbortedError extends Error {
  constructor() {
    super('Aborted. Nothing was published.');
    this.name = 'PromptAbortedError';
  }
}

export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // Reject if stdin has already ended, or ends, while the question is pending.
  // Detected on process.stdin's own 'close', not the readline's 'close' (which
  // fires on every rl.close() in the finally below). The listener is removed
  // once the question settles so it can't leak into a later ask() and abort an
  // unrelated prompt.
  let rejectEof: (e: Error) => void = () => {};
  const eof = new Promise<never>((_, rej) => {
    rejectEof = rej;
  });
  const alreadyClosed = process.stdin.closed;
  if (alreadyClosed) {
    rejectEof(new PromptAbortedError());
  } else {
    const onStdinClose = () => rejectEof(new PromptAbortedError());
    process.stdin.once('close', onStdinClose);
    try {
      const q = rl.question(question);
      return (await Promise.race([q, eof])).trim();
    } finally {
      process.stdin.off('close', onStdinClose);
      rl.close();
    }
  }
  // stdin was already closed: the eof promise is already rejected.
  throw await eof;
}

export async function confirm(question: string, assumeYes = false): Promise<boolean> {
  if (assumeYes) return true;
  const answer = await ask(`${question} [y/N] `);
  return answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
}
