import { QuireApi } from '../api.js';
import { parseExpiry } from '../expires.js';

/**
 * Update an owned share's expiration.
 *
 * @param token - Share identifier, required by the command.
 * @param values - Expiry expression to parse.
 * @param values.expires - Required future date, duration, or relative expiry keyword.
 * @param api - Authenticated owner API client.
 * @param out - Destination for the success message.
 */
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
