import { QuireApi } from '../api.js';
import { parseExpiry } from '../expires.js';

export async function runUpdate(
  token: string | undefined,
  values: { expires?: string },
  api: QuireApi = new QuireApi(),
  out: (line: string) => void = console.log,
): Promise<void> {
  if (!token) throw new Error('usage: quire update <token> [--expires <dur|ISO|tomorrow|…>]');
  if (values.expires === undefined) throw new Error('nothing to update: pass --expires');
  await api.patch(token, { expiresAt: parseExpiry(values.expires) });
  out(`Updated ${token.slice(0, 8)}…`);
}
