import { QuireApi } from '../api.js';
import { confirm } from '../prompt.js';

export async function runRevoke(token: string | undefined, api: QuireApi = new QuireApi()): Promise<void> {
  if (!token) throw new Error('usage: quire revoke <token>');
  const ok = await confirm(`Revoke share ${token.slice(0, 8)}…? The link will stop working immediately.`);
  if (!ok) {
    console.log('Aborted.');
    return;
  }
  await api.revoke(token);
  console.log(`Revoked ${token.slice(0, 8)}… — the link is now dead.`);
}
