import { randomBytes } from 'node:crypto';
import type { HarnessAdapter, HarnessSessionInfo } from '../harness/types.js';
import { detectHarness, makeAdapter, type HarnessName } from '../harness/detect.js';
import { QuireApi } from '../api.js';
import { confirm } from '../prompt.js';
import { parseExpiry } from '../expires.js';
import { publishV2 } from '../share-v2/upload.js';

// --password values that mean "generate one for me" rather than a literal secret.
export const RANDOM_PASSWORD_WORDS = new Set(['random', 'generate', 'auto']);

/** Returns a generated password when `value` is a "random" keyword, else the literal value. */
export function resolvePassword(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (RANDOM_PASSWORD_WORDS.has(value.trim().toLowerCase())) {
    return randomBytes(16).toString('base64url');
  }
  return value;
}

export interface PublishValues {
  current?: boolean;
  harness?: string;
  password?: string;
  expires?: string;
  preset?: string;
  yes?: boolean;
}

export interface PublishDeps {
  adapter?: HarnessAdapter;
  api?: QuireApi;
  out?: (line: string) => void;
}

const PRESETS = ['strict', 'normal'];

async function resolveSession(adapter: HarnessAdapter, values: PublishValues, positionals: string[]): Promise<HarnessSessionInfo> {
  if (values.current) return adapter.resolveCurrent();
  const id = positionals[0];
  if (id) {
    const sessions = await adapter.listSessions();
    const exact = sessions.find((s) => s.id === id);
    if (exact) return exact;
    const prefix = sessions.filter((s) => s.id.startsWith(id));
    if (prefix.length === 1) return prefix[0]!;
    if (prefix.length > 1) throw new Error(`session id prefix "${id}" is ambiguous: ${prefix.map((s) => s.id).join(', ')}`);
    try {
      // Not in the recent list (older than 50, or a subagent): try the full id directly.
      // Return the ORIGINAL id, not shaped.sessionId: the caller reloads by this
      // id, and for path-based adapters (OMP) shaped.sessionId is not loadable.
      const shaped = await adapter.loadSession(id);
      return { id, title: shaped.title, updatedAt: '', isSubagent: false };
    } catch (err) {
      if (adapter.preserveDirectLoadError === true && err instanceof Error) throw err;
      throw new Error(`session not found: ${id}`);
    }
  }
  // No --current and no id: there is no interactive picker (an agent must not be
  // blocked on a numbered prompt). Fail with an actionable message instead.
  throw new Error('no session selected — pass --current (this session) or a session id');
}

export async function runPublish(values: PublishValues, positionals: string[], deps: PublishDeps = {}): Promise<void> {
  const out = deps.out ?? console.log;
  if (values.harness !== undefined && values.harness !== 'zcode' && values.harness !== 'claude-code' && values.harness !== 'codex' && values.harness !== 'omp') {
    throw new Error(`unknown --harness "${values.harness}" (use zcode, claude-code, codex, or omp)`);
  }
  const adapter = deps.adapter ?? makeAdapter((values.harness as HarnessName | undefined) ?? detectHarness());
  const api = deps.api ?? new QuireApi();

  const session = await resolveSession(adapter, values, positionals);
  const shaped = await adapter.loadSession(session.id);
  // Round 11: the title is session content the server redacts before storing
  // (a title like "Debugging AWS key AKIA…" is a leak — see prepareContent).
  // The CLI must not echo the RAW title to stdout (the agent captures stdout),
  // so the Sharing line identifies the share by session id only.
  out(`Sharing: ${shaped.sessionId} — ${shaped.messages.length} messages`);

  const preset = values.preset ?? 'strict';
  // Round 9 (F7): 'none' (no redaction) is rejected at the API boundary — the
  // server never stores unredacted content ("only redacted content is ever
  // stored or served" is the core invariant). The old --confirm-raw escape
  // hatch was dead: it passed the client gate, then the server 400'd. Reject
  // client-side with an actionable message instead.
  if (preset === 'none') {
    throw new Error('preset "none" (no redaction) is not supported — the server rejects unredacted shares. Use "normal" (loosest) or "strict".');
  }
  if (!PRESETS.includes(preset)) throw new Error(`unknown --preset "${preset}" (use ${PRESETS.join(', ')})`);
  const expiresAt = values.expires ? parseExpiry(values.expires) : undefined;

  // Resolve --password: a "random"/"generate"/"auto" keyword becomes a fresh
  // random secret; anything else is used literally. The generated value is
  // printed once here — the server hashes it and never returns it.
  const isRandomPassword = values.password !== undefined && RANDOM_PASSWORD_WORDS.has(values.password.trim().toLowerCase());
  const password = resolvePassword(values.password);
  if (isRandomPassword) out(`Password: ${password}`);

  // v2 sealed shares: the server redacts and seals each chunk on ingest, so
  // there is no preview step — the redaction summary comes from finalize.
  // The content key is generated inside publishV2 and held in memory only;
  // it travels in the authenticated request bodies and is appended to the
  // returned URL as a fragment locally. Nothing key-shaped is ever written
  // to stderr or any log: on failure the error carries the server's message
  // (or a generic one), and the fragment URL is printed only on success.
  const ok = await confirm('Publish this session?', values.yes === true);
  if (!ok) {
    out('Aborted. Nothing was published.');
    return;
  }
  const result = await publishV2(api, shaped, { preset, password, expiresAt, baseUrl: api.origin });
  const counts = Object.entries(result.redactions);
  out(`\nPublished: ${result.url}`);
  out(`Messages: ${result.messageCount} · Stored: ${result.bytes} bytes · Redactions: ${counts.length === 0 ? 'none' : counts.map(([k, v]) => `${v} ${k}`).join(', ')}`);
}
