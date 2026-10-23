import argon2 from 'argon2';

const opts = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 } as const;

/**
 * Hash a share password with the server's Argon2id parameters and a random salt.
 *
 * @param pw - Plaintext password held only for hashing.
 * @returns The encoded Argon2 password hash.
 */
export function hashPassword(pw: string): Promise<string> {
  return argon2.hash(pw, opts);
}

/**
 * Verify a share password, treating malformed hashes as failed authentication.
 *
 * @param hash - Stored encoded Argon2 hash.
 * @param pw - Candidate plaintext password.
 * @returns Whether the password verifies successfully.
 */
export async function verifyPassword(hash: string, pw: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, pw);
  } catch {
    return false;
  }
}
