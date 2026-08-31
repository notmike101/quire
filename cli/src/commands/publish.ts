import { randomBytes } from 'node:crypto';
import type { HarnessAdapter, HarnessSessionInfo, ShapedMessage } from '../harness/types.js';
import { detectHarness, makeAdapter, type HarnessName } from '../harness/detect.js';
import { QuireApi, QuireApiError, type PreviewResponse } from '../api.js';
import { chunkMessages, PREVIEW_MAX_BYTES } from '../chunk.js';
import { confirm } from '../prompt.js';
import { parseExpiry } from '../expires.js';
import { stripControlChars } from '../shape.js';

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
  noChunk?: boolean;
}

export interface PublishDeps {
  adapter?: HarnessAdapter;
  api?: QuireApi;
  out?: (line: string) => void;
  chunker?: (messages: ShapedMessage[]) => ShapedMessage[][];
}

const PRESETS = ['strict', 'normal'];

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

function printPreview(messages: ShapedMessage[], summary: Record<string, number>, out: (l: string) => void): void {
  out('\n--- redacted preview (exactly what will be stored) ---');
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === 'text') out(`[${m.role}] ${clip(stripControlChars(p.text ?? ''), 200)}`);
      else if (p.type === 'reasoning') out(`[${m.role}] (reasoning, ${p.text?.length ?? 0} chars)`);
      else if (p.type === 'system') out(`[${m.role}] (system notice, ${p.text?.length ?? 0} chars)`);
      else if (p.type === 'tool') out(`[${m.role}] tool ${p.tool ?? '?'} (${p.status ?? 'pending'})`);
    }
  }
  const counts = Object.entries(summary);
  out(`\nRedactions: ${counts.length === 0 ? 'none' : counts.map(([k, v]) => `${v} ${k}`).join(', ')}`);
}

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
  const chunker = deps.chunker ?? chunkMessages;

  const session = await resolveSession(adapter, values, positionals);
  const shaped = await adapter.loadSession(session.id);
  // Round 11: the title is session content the server redacts before storing
  // (a title like "Debugging AWS key AKIA…" is a leak — see prepareContent),
  // and the preview returns no redacted title to print instead. The CLI must
  // not echo the RAW title to stdout (the agent captures stdout), so the
  // Sharing line identifies the share by session id only.
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

  // E1: the preview endpoint takes the whole session in ONE request and is
  // subject to the server's 20 MB per-request cap. A session over the cap would
  // 413 at this step and the chunked upload path (1 GB per-share) would be
  // unreachable. Skip the preview above the cap and say so — redaction still
  // runs server-side on the real upload, and the final redaction counts come
  // from the create response, not the preview.
  const payloadBytes = Buffer.byteLength(JSON.stringify(shaped));
  if (payloadBytes <= PREVIEW_MAX_BYTES) {
    const preview: PreviewResponse = await api.preview(shaped, preset);
    printPreview(preview.messages as ShapedMessage[], preview.summary, out);
  } else {
    out(`\nSession is ${(payloadBytes / 1024 / 1024).toFixed(1)} MB — over the 20 MB per-request cap, so the redacted preview is skipped${values.noChunk ? '' : '; it will be uploaded in chunks'}.`);
  }

  const ok = await confirm('Publish this session?', values.yes === true);
  if (!ok) {
    out('Aborted. Nothing was published.');
    return;
  }

  const opts = { preset, password, expiresAt };

  if (values.noChunk === true) {
    // Single upload regardless of size; over the cap -> 413 with a clear hint.
    let created;
    try {
      created = await api.create(shaped, opts);
    } catch (err) {
      if (err instanceof QuireApiError && err.status === 413) {
        throw new Error(
          `session is ${(payloadBytes / 1024 / 1024).toFixed(1)} MB, over the 20 MB per-request cap; re-run without --no-chunk to chunk`,
        );
      }
      throw err;
    }
    const counts = Object.entries(created.summary);
    out(`\nPublished: ${api.origin}${created.url}`);
    out(`Messages: ${created.messageCount} · Stored: ${created.bytes} bytes · Redactions: ${counts.length === 0 ? 'none' : counts.map(([k, v]) => `${v} ${k}`).join(', ')}`);
    return;
  }

  // Ask the chunker how many groups the session packs into. With the default
  // chunkMessages (19 MB cap) this is 1 unless the session exceeds the cap, so
  // the common path is unchanged; an injected chunker can force the chunked
  // path in tests without a 19 MB fixture.
  const chunks = chunker(shaped.messages);
  if (chunks.length <= 1) {
    // Common path: one request, unchanged behavior.
    const created = await api.create(shaped, opts);
    const counts = Object.entries(created.summary);
    out(`\nPublished: ${api.origin}${created.url}`);
    out(`Messages: ${created.messageCount} · Stored: ${created.bytes} bytes · Redactions: ${counts.length === 0 ? 'none' : counts.map(([k, v]) => `${v} ${k}`).join(', ')}`);
    return;
  }

  // Chunked path: split into <=19 MB groups, create the share with chunk 0,
  // then append the rest in order.
  out(`Session is ${(payloadBytes / 1024 / 1024).toFixed(1)} MB — uploading in ${chunks.length} chunks…`);
  const head = { ...shaped, messages: chunks[0]! };
  // Chain E: tell the server how many chunks to expect so the share stays
  // hidden (404) until the upload completes. Single-request paths leave this
  // unset (server default 1).
  const created = await api.create(head, { ...opts, expectedChunks: chunks.length });
  // Round 9 (C-F9): the create response carries only chunk 0's redaction
  // summary; each chunk response carries its own. Aggregate them so the final
  // "Redactions:" line reflects the WHOLE session, not just the first chunk.
  // `?? {}` tolerates a server build that predates the chunk summary.
  const totalSummary: Record<string, number> = { ...created.summary };
  for (let i = 1; i < chunks.length; i++) {
    const chunkBytes = Buffer.byteLength(JSON.stringify(chunks[i]));
    out(`Uploading chunk ${i + 1}/${chunks.length} (${(chunkBytes / 1024 / 1024).toFixed(1)} MB)…`);
    const chunk = await api.createChunk(created.token, { uploadId: created.uploadId, chunkSeq: i, messages: chunks[i]! });
    for (const [rule, n] of Object.entries(chunk.summary ?? {})) {
      totalSummary[rule] = (totalSummary[rule] ?? 0) + n;
    }
  }
  const counts = Object.entries(totalSummary);
  out(`\nPublished: ${api.origin}${created.url}`);
  out(`Messages: ${shaped.messages.length} · Redactions: ${counts.length === 0 ? 'none' : counts.map(([k, v]) => `${v} ${k}`).join(', ')}`);
}
