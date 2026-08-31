import { QuireApi } from '../api.js';
import { parseExpiry } from '../expires.js';
import { resolvePassword, RANDOM_PASSWORD_WORDS } from './publish.js';

export async function runUpdate(
  token: string | undefined,
  values: { password?: string; expires?: string },
  api: QuireApi = new QuireApi(),
  out: (line: string) => void = console.log,
): Promise<void> {
  if (!token) throw new Error('usage: quire update <token> [--password <pw|random>] [--expires <dur|ISO|tomorrow|…>]');
  if (values.password === undefined && values.expires === undefined) throw new Error('nothing to update: pass --password and/or --expires');
  const body: { password?: string; expiresAt?: string } = {};
  if (values.password !== undefined) {
    // Round 11: a generated password is hashed server-side and never returned —
    // if the update doesn't print it, the owner is locked out (mirrors publish).
    const isRandomPassword = RANDOM_PASSWORD_WORDS.has(values.password.trim().toLowerCase());
    const password = resolvePassword(values.password);
    if (password === undefined) throw new Error('--password requires a value (or "random" to generate one)');
    body.password = password;
    if (isRandomPassword) out(`Password: ${password}`);
  }
  if (values.expires !== undefined) body.expiresAt = parseExpiry(values.expires);
  await api.patch(token, body);
  out(`Updated ${token.slice(0, 8)}…`);
}
