import argon2 from 'argon2';

const opts = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 } as const;

export function hashPassword(pw: string): Promise<string> {
  return argon2.hash(pw, opts);
}

export async function verifyPassword(hash: string, pw: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, pw);
  } catch {
    return false;
  }
}
