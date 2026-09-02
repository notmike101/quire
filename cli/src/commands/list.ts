import { QuireApi } from '../api.js';
import { stripControlChars } from '../shape.js';

export async function runList(api: QuireApi = new QuireApi(), out: (line: string) => void = console.log): Promise<void> {
  const { shares } = await api.list();
  if (shares.length === 0) {
    out('No shares.');
    return;
  }
  const rows = shares.map((s) => [
    s.publicId.slice(0, 8),
    stripControlChars(s.title ?? '—').slice(0, 40),
    new Date(s.createdAt).toISOString().slice(0, 10),
    s.expiresAt ? new Date(s.expiresAt).toISOString().slice(0, 10) : '—',
    s.state,
  ]);
  const widths = rows[0]!.map((_, i) => Math.max(rows[0]![i]!.length, ...rows.map((r) => r[i]!.length)));
  const line = (r: string[]) => r.map((cell, i) => cell.padEnd(widths[i]!)).join('  ');
  out(line(['ID', 'TITLE', 'CREATED', 'EXPIRES', 'STATE']));
  for (const r of rows) out(line(r));
}
