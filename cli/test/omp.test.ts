import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activeOmpBranch,
  extractOmpSessionData,
  makeOmpAdapter,
} from '../src/harness/omp.js';
import { MAX_IMAGE_BYTES } from '../src/image.js';

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

function entry(type: string, id: string, parentId: string | null, extra: Record<string, unknown> = {}): TestEntry {
  return { type, id, parentId, timestamp: '2026-08-31T12:00:01.000Z', ...extra };
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

  it('rejects malformed base64 edge cases', () => {
    const bad = [
      ['unpadded tail', 'abc'],
      ['padding in the middle', 'ab=c'],
      ['lone early padding', 'a==='],
      ['padding past the end', 'abcd==ef'],
      ['non-alphabet char', 'ab!d'],
    ] as const;
    for (const [_name, body] of bad) {
      const html = `<script id="session-data" type="application/json">${body}</script>`;
      expect(() => extractOmpSessionData(html)).toThrow(/OMP export.*base64/i);
    }
  });

  it('accepts unpadded base64 (byte length a multiple of four)', () => {
    let text = 'x';
    const data = { header, entries: [message('u1', null, text)], leafId: 'u1' };
    for (let i = 0; i < 4 && Buffer.from(JSON.stringify(data), 'utf8').toString('base64').includes('='); i++) {
      text += 'x';
    }
    expect(() => extractOmpSessionData(ompHtml(data))).not.toThrow(/base64/i);
  });

  it('accepts multi-megabyte base64 payloads without a regex stack overflow', () => {
    // The old backtracking BASE64_RE threw RangeError: Maximum call stack
    // size exceeded in Node above ~4.5M encoded chars, crashing publish
    // (exit 1) for every session whose export exceeded ~3.4MB.
    const data = { header, entries: [message('u1', null, 'x'.repeat(4_000_000))], leafId: 'u1' };
    const parsed = extractOmpSessionData(ompHtml(data));
    expect(parsed.leafId).toBe('u1');
  });

  it('accepts exports larger than the legacy 32MB cap (sub-sessions inflate the export)', () => {
    // OMP embeds sub-agent sessions in the export for its own viewer; the
    // adapter never publishes them, but they count against the size caps.
    // 2000 x 16KB entries -> ~32MB JSON -> ~43MB base64 HTML.
    const filler = 'x'.repeat(16_000);
    const entries = Array.from({ length: 2_000 }, (_, i) => message(`u${i}`, i === 0 ? null : `u${i - 1}`, filler));
    const parsed = extractOmpSessionData(ompHtml({ header, entries, leafId: 'u1999' }));
    expect(parsed.entries.length).toBe(2_000);
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

describe('OMP transcript shaping', () => {
  it('keeps visible content in order and pairs tool results', async () => {
    const entries = [
      entry('message', 'u1', null, { message: { role: 'user', timestamp: 1, content: [{ type: 'text', text: 'hello' }] } }),
      entry('message', 'a1', 'u1', { message: { role: 'assistant', provider: 'anthropic', model: 'claude-test', timestamp: 2, content: [
        { type: 'thinking', thinking: 'considered options' },
        { type: 'text', text: 'checking' },
        { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'README.md' } },
      ] } }),
      entry('message', 't1', 'a1', { message: { role: 'toolResult', toolCallId: 'call-1', toolName: 'read', isError: false, timestamp: 3, content: [{ type: 'text', text: 'file contents' }] } }),
      entry('custom_message', 'c1', 't1', { display: true, customType: 'notice', content: 'Visible notice' }),
      entry('reset_boundary', 'r1', 'c1'),
      entry('message', 'a2', 'r1', { message: { role: 'assistant', timestamp: 4, content: [{ type: 'text', text: 'done' }] } }),
    ];
    const path = writeExport({ header, entries, leafId: 'a2' });

    const shaped = await makeOmpAdapter().loadSession(path);

    expect(shaped.model).toBe('claude-test');
    expect(shaped.provider).toBe('anthropic');
    expect(shaped.messages.map((m) => [m.role, m.parts.map((p) => p.type)])).toEqual([
      ['user', ['text']],
      ['assistant', ['reasoning', 'text', 'tool']],
      ['assistant', ['system']],
      ['assistant', ['system']],
      ['assistant', ['text']],
    ]);
    expect(shaped.messages[1]!.parts[2]).toMatchObject({
      type: 'tool', callID: 'call-1', tool: 'read', input: { path: 'README.md' }, output: 'file contents',
    });
    expect(shaped.messages[2]!.parts[0]!.text).toBe('Visible notice');
    expect(shaped.messages[3]!.parts[0]!.text).toBe('Conversation cleared');
  });

  it('omits internal entry types, hidden custom messages, and exported internals', async () => {
    const internalTypes = [
      'session_init', 'custom', 'credential_pin', 'model_change', 'thinking_level_change',
      'service_tier_change', 'mode_change', 'label', 'title_change', 'ttsr_injection',
      'compaction', 'branch_summary',
    ];
    let parentId: string | null = null;
    const entries: TestEntry[] = [];
    for (const [index, type] of internalTypes.entries()) {
      const id = `internal${index}`;
      entries.push(entry(type, id, parentId, { data: `SECRET_${type}`, summary: `SECRET_${type}` }));
      parentId = id;
    }
    entries.push(entry('custom_message', 'hidden01', parentId, { display: false, content: 'SECRET_hidden' }));
    entries.push(entry('message', 'visible1', 'hidden01', { message: { role: 'user', timestamp: 1, content: 'visible' } }));
    const path = writeExport({
      header,
      entries,
      leafId: 'visible1',
      systemPrompt: 'SECRET_system',
      tools: [{ name: 'SECRET_tool', description: 'SECRET_description' }],
      subSessions: { child: { entries: [{ secret: 'SECRET_subagent' }] } },
    });

    const shaped = await makeOmpAdapter().loadSession(path);
    const serialized = JSON.stringify(shaped);

    expect(shaped.messages).toEqual([{ role: 'user', time: new Date(1).toISOString(), parts: [{ type: 'text', text: 'visible' }] }]);
    expect(serialized).not.toContain('SECRET_');
  });

  it('keeps incomplete calls, drops orphan results, and skips malformed content parts', async () => {
    const entries = [
      entry('message', 'a1', null, { message: { role: 'assistant', timestamp: 1, content: [
        { type: 'toolCall', id: 'incomplete', name: 'write', arguments: { value: 'x' } },
        { type: 'text', text: 42 },
        null,
      ] } }),
      entry('message', 't1', 'a1', { message: { role: 'toolResult', toolCallId: 'orphan', toolName: 'read', isError: false, timestamp: 2, content: [{ type: 'text', text: 'hidden orphan' }] } }),
    ];
    const path = writeExport({ header, entries, leafId: 't1' });

    const shaped = await makeOmpAdapter().loadSession(path);

    expect(shaped.messages).toHaveLength(1);
    expect(shaped.messages[0]!.parts).toEqual([{
      type: 'tool', callID: 'incomplete', tool: 'write', input: { value: 'x' },
    }]);
    expect(JSON.stringify(shaped)).not.toContain('hidden orphan');
  });

  it('enforces the message cap and emits one content-free warning', async () => {
    const entries = [
      message('m1', null, 'first'),
      message('m2', 'm1', 'second'),
      message('m3', 'm2', 'SECRET_tail'),
    ];
    const path = writeExport({ header, entries, leafId: 'm3' });
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const shaped = await makeOmpAdapter({ maxMessages: 2 }).loadSession(path);
      expect(shaped.messages).toHaveLength(2);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0]![0])).not.toContain('SECRET_tail');
    } finally {
      spy.mockRestore();
    }
  });

  it('embeds bounded OMP and workspace images without fetching remote URLs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'quire-omp-images-'));
    tempDirs.push(dir);
    const root = join(dir, 'root');
    const additional = join(dir, 'additional');
    mkdirSync(root);
    mkdirSync(additional);
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    writeFileSync(join(additional, 'local.png'), png);
    const imageHeader = { ...header, cwd: root, additionalDirectories: [additional] };
    const entries = [entry('message', 'u1', null, { message: { role: 'user', timestamp: 1, content: [
      { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
      { type: 'text', text: 'local ![safe](local.png) remote ![no](https://example.test/x.png)' },
    ] } })];
    const path = writeExport({ header: imageHeader, entries, leafId: 'u1' });

    const shaped = await makeOmpAdapter({ maxImageBytes: png.length * 2 }).loadSession(path);
    const parts = shaped.messages[0]!.parts;

    expect(parts.filter((part) => part.type === 'image')).toHaveLength(2);
    expect(parts.every((part) => !part.src?.includes('https://'))).toBe(true);
    expect(parts.find((part) => part.type === 'text')!.text).toContain('https://example.test/x.png');
  });

  it('truncates oversized tool inputs, outputs, and text parts', async () => {
    const bigInput = { value: 'x'.repeat(30 * 1024) };
    const bigOutput = 'y'.repeat(30 * 1024);
    const entries = [
      entry('message', 'a1', null, { message: { role: 'assistant', timestamp: 1, content: [
        { type: 'toolCall', id: 'call-big', name: 'write', arguments: bigInput },
      ] } }),
      entry('message', 't1', 'a1', { message: { role: 'toolResult', toolCallId: 'call-big', toolName: 'write', isError: false, timestamp: 2, content: [{ type: 'text', text: bigOutput }] } }),
    ];
    const path = writeExport({ header, entries, leafId: 't1' });

    const shaped = await makeOmpAdapter().loadSession(path);
    const tool = shaped.messages[0]!.parts[0]! as { type: 'tool'; input: unknown; output?: string };

    expect(tool.input).toMatchObject({ __truncated: true });
    expect(tool.output).toContain('… [truncated');
    expect(Buffer.byteLength(tool.output ?? '')).toBeLessThan(bigOutput.length);
  });

  it('marks over-budget images as tooLarge placeholders', async () => {
    const small = Buffer.from('89504e470d0a1a0a', 'hex');
    const huge = Buffer.alloc(MAX_IMAGE_BYTES + 1, 1);
    const entries = [entry('message', 'u1', null, { message: { role: 'user', timestamp: 1, content: [
      { type: 'image', data: huge.toString('base64'), mimeType: 'image/png' },
      { type: 'image', data: small.toString('base64'), mimeType: 'image/png' },
      { type: 'image', data: small.toString('base64'), mimeType: 'image/png' },
    ] } })];
    const path = writeExport({ header, entries, leafId: 'u1' });

    const shaped = await makeOmpAdapter({ maxImageBytes: small.length }).loadSession(path);
    const images = shaped.messages[0]!.parts.filter((part) => part.type === 'image');

    expect(images).toHaveLength(3);
    expect(images[0]).toMatchObject({ type: 'image', tooLarge: true });
    expect(images[0]!.src).toBeUndefined();
    expect(images[1]!.tooLarge).toBeUndefined();
    expect(images[1]!.src).toBe(`data:image/png;base64,${small.toString('base64')}`);
    expect(images[2]).toMatchObject({ type: 'image', tooLarge: true });
    expect(images[2]!.src).toBeUndefined();
  });

  it('does not open markdown image paths that traverse, symlink, or escape the roots', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'quire-omp-contain-'));
    tempDirs.push(dir);
    const root = join(dir, 'root');
    const outside = join(dir, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    writeFileSync(join(outside, 'secret.png'), png);
    symlinkSync(join(outside, 'secret.png'), join(root, 'link.png'));
    const imageHeader = { ...header, cwd: root };
    const entries = [entry('message', 'u1', null, { message: { role: 'user', timestamp: 1, content: [
      { type: 'text', text: 'a ![t1](../outside/secret.png) b ![t2](link.png) c' },
    ] } })];
    const path = writeExport({ header: imageHeader, entries, leafId: 'u1' });

    const shaped = await makeOmpAdapter().loadSession(path);
    const parts = shaped.messages[0]!.parts;

    expect(parts.filter((part) => part.type === 'image')).toHaveLength(0);
    expect(JSON.stringify(shaped)).not.toContain(png.toString('base64'));
  });
});
