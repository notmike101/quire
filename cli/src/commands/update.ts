import { QuireApi } from '../api.js';
import { parseExpiry } from '../expires.js';
import { resolvePassword } from './publish.js';

export async function runUpdate(
  token: string | undefined,
  values: { password?: string; expires?: string },
  api: QuireApi = new QuireApi(),
): Promise<void> {
  if (!token) throw new Error('usage: quire update <token> [--password <pw|random>] [--expires <dur|ISO|tomorrow|…>]');
  if (values.password === undefined && values.expires === undefined) throw new Error('nothing to update: pass --password and/or --expires');
  const body: { password?: string; expiresAt?: string } = {};
  if (values.password !== undefined) {
    const password = resolvePassword(values.password);
    if (password === undefined) throw new Error('--password requires a value (or "random" to generate one)');
    body.password = password;
  }
  if (values.expires !== undefined) body.expiresAt = parseExpiry(values.expires);
  await api.patch(token, body);
  console.log(`Updated ${token.slice(0, 8)}…`);
}
