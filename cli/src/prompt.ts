import { createInterface } from 'node:readline/promises';

export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export async function confirm(question: string, assumeYes = false): Promise<boolean> {
  if (assumeYes) return true;
  const answer = await ask(`${question} [y/N] `);
  return answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
}
