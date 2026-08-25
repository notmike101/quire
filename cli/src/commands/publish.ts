import type { HarnessAdapter, HarnessSessionInfo, ShapedMessage } from '../harness/types.js';
import { detectHarness, makeAdapter, type HarnessName } from '../harness/detect.js';
import { QuireApi, type CreateResponse, type PreviewResponse } from '../api.js';
import { ask, confirm } from '../prompt.js';
import { parseExpiry } from '../expires.js';

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
      else if (p.type === 'tool') out(`[${m.role}] tool ${p.tool ?? '?'} (${p.status ?? 'pending'})`);
    }
  }
  const counts = Object.entries(summary);
  out(`\nRedactions: ${counts.length === 0 ? 'none' : counts.map(([k, v]) => `${v} ${k}`).join(', ')}`);
}

async function resolveSession(adapter: HarnessAdapter, values: PublishValues, positionals: string[], out: (l: string) => void): Promise<HarnessSessionInfo> {
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
  const sessions = await adapter.listSessions();
  if (sessions.length === 0) throw new Error('no sessions found');
  out('Recent sessions:');
  sessions.forEach((s, i) => out(`  ${i + 1}. ${s.title}  (${s.id})`));
  const answer = await ask(`Select session [1-${sessions.length}]: `);
  const n = Number(answer);
  const chosen = Number.isInteger(n) && n >= 1 && n <= sessions.length ? sessions[n - 1] : undefined;
  if (!chosen) throw new Error(`invalid selection: ${answer}`);
  return chosen;
}

export async function runPublish(values: PublishValues, positionals: string[], deps: PublishDeps = {}): Promise<void> {
  const out = deps.out ?? console.log;
  if (values.harness !== undefined && values.harness !== 'zcode' && values.harness !== 'claude-code') {
    throw new Error(`unknown --harness "${values.harness}" (use zcode or claude-code)`);
  }
  const harnessName: HarnessName = (values.harness as HarnessName | undefined) ?? detectHarness();
  const adapter = deps.adapter ?? makeAdapter(harnessName);
  const api = deps.api ?? new QuireApi();

  const session = await resolveSession(adapter, values, positionals, out);
  const shaped = await adapter.loadSession(session.id);
  out(`Sharing: ${shaped.title} (${shaped.sessionId}) — ${shaped.messages.length} messages`);

  const preset = values.preset ?? 'strict';
  if (!PRESETS.includes(preset)) throw new Error(`unknown --preset "${preset}" (use ${PRESETS.join(', ')})`);
  const expiresAt = values.expires ? parseExpiry(values.expires) : undefined;

  const preview: PreviewResponse = await api.preview(shaped, preset);
  printPreview(preview.messages as ShapedMessage[], preview.summary, preset, out);

  const ok = await confirm('Publish this session?', values.yes === true);
  if (!ok) {
    out('Aborted. Nothing was published.');
    return;
  }
  const created: CreateResponse = await api.create(shaped, { preset, password: values.password, expiresAt });
  const counts = Object.entries(created.summary);
  out(`\nPublished: ${api.baseUrl}${created.url}`);
  out(`Messages: ${created.messageCount} · Stored: ${created.bytes} bytes · Redactions: ${counts.length === 0 ? 'none' : counts.map(([k, v]) => `${v} ${k}`).join(', ')}`);
}
