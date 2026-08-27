import { randomBytes } from 'node:crypto';
import type { HarnessAdapter, HarnessSessionInfo, ShapedMessage } from '../harness/types.js';
import { detectHarness, makeAdapter, type HarnessName } from '../harness/detect.js';
import { QuireApi, QuireApiError, type PreviewResponse } from '../api.js';
import { chunkMessages } from '../chunk.js';
import { confirm } from '../prompt.js';
import { parseExpiry } from '../expires.js';

// --password values that mean "generate one for me" rather than a literal secret.
const RANDOM_PASSWORD_WORDS = new Set(['random', 'generate', 'auto']);

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

const PRESETS = ['strict', 'normal', 'none'];

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

function printPreview(messages: ShapedMessage[], summary: Record<string, number>, preset: string, out: (l: string) => void): void {
  if (preset === 'none') out('\n⚠  preset "none": NO redaction applied — the raw transcript will be published.');
  out('\n--- redacted preview (exactly what will be stored) ---');
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === 'text') out(`[${m.role}] ${clip(p.text ?? '', 200)}`);
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
      const shaped = await adapter.loadSession(id);
      return { id: shaped.sessionId, title: shaped.title, updatedAt: '', isSubagent: false };
    } catch {
      throw new Error(`session not found: ${id}`);
    }
  }
  // No --current and no id: there is no interactive picker (an agent must not be
  // blocked on a numbered prompt). Fail with an actionable message instead.
  throw new Error('no session selected — pass --current (this session) or a session id');
}

export async function runPublish(values: PublishValues, positionals: string[], deps: PublishDeps = {}): Promise<void> {
  const out = deps.out ?? console.log;
  if (values.harness !== undefined && values.harness !== 'zcode' && values.harness !== 'claude-code') {
    throw new Error(`unknown --harness "${values.harness}" (use zcode or claude-code)`);
  }
  const adapter = deps.adapter ?? makeAdapter((values.harness as HarnessName | undefined) ?? detectHarness());
  const api = deps.api ?? new QuireApi();
  const chunker = deps.chunker ?? chunkMessages;

  const session = await resolveSession(adapter, values, positionals);
  const shaped = await adapter.loadSession(session.id);
  out(`Sharing: ${shaped.title} (${shaped.sessionId}) — ${shaped.messages.length} messages`);

  const preset = values.preset ?? 'strict';
  if (!PRESETS.includes(preset)) throw new Error(`unknown --preset "${preset}" (use ${PRESETS.join(', ')})`);
  const expiresAt = values.expires ? parseExpiry(values.expires) : undefined;

  // Resolve --password: a "random"/"generate"/"auto" keyword becomes a fresh
  // random secret; anything else is used literally. The generated value is
  // printed once here — the server hashes it and never returns it.
  const isRandomPassword = values.password !== undefined && RANDOM_PASSWORD_WORDS.has(values.password.trim().toLowerCase());
  const password = resolvePassword(values.password);
  if (isRandomPassword) out(`Password: ${password}`);

  const preview: PreviewResponse = await api.preview(shaped, preset);
  printPreview(preview.messages as ShapedMessage[], preview.summary, preset, out);

  const ok = await confirm('Publish this session?', values.yes === true);
  if (!ok) {
    out('Aborted. Nothing was published.');
    return;
  }

  const payloadBytes = Buffer.byteLength(JSON.stringify(shaped));
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
    out(`\nPublished: ${api.baseUrl}${created.url}`);
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
    out(`\nPublished: ${api.baseUrl}${created.url}`);
    out(`Messages: ${created.messageCount} · Stored: ${created.bytes} bytes · Redactions: ${counts.length === 0 ? 'none' : counts.map(([k, v]) => `${v} ${k}`).join(', ')}`);
    return;
  }

  // Chunked path: split into <=19 MB groups, create the share with chunk 0,
  // then append the rest in order.
  out(`Session is ${(payloadBytes / 1024 / 1024).toFixed(1)} MB — uploading in ${chunks.length} chunks…`);
  const head = { ...shaped, messages: chunks[0]! };
  const created = await api.create(head, opts);
  for (let i = 1; i < chunks.length; i++) {
    const chunkBytes = Buffer.byteLength(JSON.stringify(chunks[i]));
    out(`Uploading chunk ${i + 1}/${chunks.length} (${(chunkBytes / 1024 / 1024).toFixed(1)} MB)…`);
    await api.createChunk(created.token, { uploadId: created.uploadId, chunkSeq: i, messages: chunks[i]! });
  }
  const counts = Object.entries(created.summary);
  out(`\nPublished: ${api.baseUrl}${created.url}`);
  out(`Messages: ${shaped.messages.length} · Redactions: ${counts.length === 0 ? 'none' : counts.map(([k, v]) => `${v} ${k}`).join(', ')}`);
}
