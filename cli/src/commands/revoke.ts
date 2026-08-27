import { QuireApi } from '../api.js';
import { confirm } from '../prompt.js';

export async function runRevoke(
  token: string | undefined,
  values: { yes?: boolean } = {},
  api: QuireApi = new QuireApi(),
): Promise<void> {
  if (!token) throw new Error('usage: quire revoke <token> [--yes]');
  const ok = await confirm(`Revoke share ${token.slice(0, 8)}…? The link will stop working immediately.`, values.yes === true);
  if (!ok) {
    console.log('Aborted.');
    return;
  }
  await api.revoke(token);
  console.log(`Revoked ${token.slice(0, 8)}… — the link is now dead.`);
}
