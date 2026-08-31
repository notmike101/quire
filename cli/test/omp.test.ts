import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activeOmpBranch,
  extractOmpSessionData,
  makeOmpAdapter,
} from '../src/harness/omp.js';

interface TestEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  [key: string]: unknown;
}

const tempDirs: string[] = [];

function ompHtml(data: unknown, attrs = 'id="session-data" type="application/json"'): string {
  const encoded = Buffer.from(JSON.stringify(data), 'utf8').toString('base64');
  return `<!doctype html><script ${attrs}>${encoded}</script>`;
}

function writeExport(data: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'quire-omp-'));
  tempDirs.push(dir);
  const path = join(dir, 'current session.html');
  writeFileSync(path, ompHtml(data));
  return path;
}

function message(id: string, parentId: string | null, text: string): TestEntry {
  return {
    type: 'message', id, parentId, timestamp: '2026-08-31T12:00:01.000Z',
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
}

const header = {
  type: 'session' as const,
  version: 3,
  id: 'omp-session-1',
  timestamp: '2026-08-31T12:00:00.000Z',
  cwd: 'D:/workspace',
  title: 'OMP fixture',
};

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('OMP export parsing', () => {
  it('extracts one base64 session-data script regardless of attribute order', () => {
    const data = { header, entries: [], leafId: null };
    const parsed = extractOmpSessionData(ompHtml(data, ' type="application/json"  id="session-data" '));

    expect(parsed).toMatchObject(data);
  });

  it.each([
    ['missing script', '<html></html>', /OMP export.*session-data/i],
    ['invalid base64', '<script id="session-data" type="application/json">%%%bad%%%</script>', /OMP export.*base64/i],
    ['invalid JSON', `<script id="session-data" type="application/json">${Buffer.from('{').toString('base64')}</script>`, /OMP export.*JSON/i],
  ])('rejects %s without echoing content', (_name, html, pattern) => {
    expect(() => extractOmpSessionData(html)).toThrow(pattern);
  });

  it('rejects duplicate session-data scripts', () => {
    const one = ompHtml({ header, entries: [], leafId: null });
    expect(() => extractOmpSessionData(one + one)).toThrow(/OMP export.*exactly one/i);
  });

  it('enforces encoded and decoded limits before shaping', () => {
    const html = ompHtml({ header, entries: [], leafId: null });
    expect(() => extractOmpSessionData(html, { maxHtmlBytes: 10 })).toThrow(/OMP export.*HTML.*large/i);
    expect(() => extractOmpSessionData(html, { maxSessionDataBytes: 10 })).toThrow(/OMP export.*session data.*large/i);
  });

  it.each([
    [{ header: null, entries: [], leafId: null }, /OMP export.*header/i],
    [{ header: { type: 'session', id: '' }, entries: [], leafId: null }, /OMP export.*header/i],
    [{ header, entries: {}, leafId: null }, /OMP export.*entries/i],
  ])('rejects an invalid payload schema', (data, pattern) => {
    expect(() => extractOmpSessionData(ompHtml(data))).toThrow(pattern);
  });
});

describe('OMP active branch', () => {
  it('walks leaf parents and excludes abandoned sibling branches', () => {
    const root = message('root0001', null, 'root');
    const selected = message('keep0001', 'root0001', 'selected');
    const abandoned = message('drop0001', 'root0001', 'abandoned');

    const branch = activeOmpBranch({ header, entries: [root, abandoned, selected], leafId: 'keep0001' });

    expect(branch.map((entry) => entry.id)).toEqual(['root0001', 'keep0001']);
  });

  it('accepts an empty session with a null leaf', () => {
    expect(activeOmpBranch({ header, entries: [], leafId: null })).toEqual([]);
  });

  it.each([
    ['missing leaf', [message('root0001', null, 'root')], 'missing00', /OMP export.*leaf/i],
    ['missing parent', [message('leaf0001', 'missing00', 'leaf')], 'leaf0001', /OMP export.*parent/i],
    ['duplicate id', [message('same0001', null, 'one'), message('same0001', null, 'two')], 'same0001', /OMP export.*duplicate/i],
    ['cycle', [message('one00001', 'two00002', 'one'), message('two00002', 'one00001', 'two')], 'one00001', /OMP export.*cycle/i],
  ])('rejects %s graphs', (_name, entries, leafId, pattern) => {
    expect(() => activeOmpBranch({ header, entries, leafId })).toThrow(pattern);
  });
});

describe('OMP adapter shell', () => {
  it('loads exact export metadata and exposes no guessed current session', async () => {
    const path = writeExport({ header, entries: [], leafId: null });
    const adapter = makeOmpAdapter();

    expect(adapter.name).toBe('omp');
    expect(await adapter.listSessions()).toEqual([]);
    await expect(adapter.resolveCurrent()).rejects.toThrow(/OMP --current is unsupported/);
    await expect(adapter.loadSession(path)).resolves.toEqual({
      sessionId: header.id,
      title: header.title,
      messages: [],
    });
  });
});
