import { describe, it, expect, vi, afterEach } from 'vitest';
import { useMessages } from '../src/composables/useMessages';
import type { PageResponse, ShareMessage, ShareMeta } from '../src/api';

const META: ShareMeta = {
  title: 'Test Session',
  model: 'test-model',
  provider: 'test-provider',
  createdAt: '2026-08-20T00:00:00.000Z',
  expiresAt: null,
  messageCount: 120,
  redactions: { 'api-key': 2 },
};

function makePage(count: number, start: number, nextCursor: string | null): PageResponse {
  return {
    meta: META,
    messages: Array.from({ length: count }, (_, i): ShareMessage => ({
      chunkSeq: 0,
      seq: start + i + 1,
      role: i % 2 === 0 ? 'user' : 'assistant',
      time: null,
      parts: [{ type: 'text', text: `m${start + i + 1}` }],
    })),
    nextCursor,
  };
}

function mockSequence(pages: Array<{ status: number; body: unknown }>) {
  const fetchMock = vi.fn(async () => {
    const next = pages.shift()!;
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: async () => JSON.stringify(next.body),
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('useMessages', () => {
  it('loads the first page and appends until nextCursor is null', async () => {
    const fetchMock = mockSequence([
      { status: 200, body: makePage(50, 0, '0:50') },
      { status: 200, body: makePage(50, 50, '0:100') },
      { status: 200, body: makePage(20, 100, null) },
    ]);
    const m = useMessages('tok');
    await m.loadFirst();
    expect(m.state.value).toBe('ready');
    expect(m.meta.value?.title).toBe('Test Session');
    expect(m.messages.value).toHaveLength(50);
    await m.loadMore();
    expect(m.messages.value).toHaveLength(100);
    await m.loadMore();
    expect(m.messages.value).toHaveLength(120);
    const callsBefore = fetchMock.mock.calls.length;
    await m.loadMore(); // exhausted — must not fetch again
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });

  it('surfaces needs_password without entering the error state', async () => {
    mockSequence([{ status: 401, body: { error: { code: 'needs_password', message: 'This share is password protected' } } }]);
    const m = useMessages('tok');
    await m.loadFirst();
    expect(m.state.value).toBe('needs_password');
  });

  it('surfaces expired', async () => {
    mockSequence([{ status: 410, body: { error: { code: 'expired', message: 'This share has expired' } } }]);
    const m = useMessages('tok');
    await m.loadFirst();
    expect(m.state.value).toBe('expired');
  });

  it('submitPassword: wrong password sets an error, correct password loads the share', async () => {
    mockSequence([
      { status: 401, body: { error: { code: 'needs_password', message: 'This share is password protected' } } },
      { status: 401, body: { error: { code: 'bad_password', message: 'Incorrect password' } } },
      { status: 200, body: { ok: true } },
      { status: 200, body: makePage(1, 0, null) },
    ]);
    const m = useMessages('tok');
    await m.loadFirst();
    expect(m.state.value).toBe('needs_password');
    await m.submitPassword('wrong');
    expect(m.state.value).toBe('needs_password');
    expect(m.passwordError.value).toBe('Wrong password.');
    await m.submitPassword('right');
    expect(m.state.value).toBe('ready');
    expect(m.messages.value).toHaveLength(1);
  });

  it('captures the user index from the first page', async () => {
    const body = makePage(2, 0, null);
    body.userIndex = [{ chunkSeq: 0, seq: 1, preview: 'm1' }];
    mockSequence([{ status: 200, body }]);
    const m = useMessages('tok');
    await m.loadFirst();
    expect(m.userIndex.value).toEqual([{ chunkSeq: 0, seq: 1, preview: 'm1' }]);
  });

  it('ensureLoadedThrough loads pages until the target seq is present', async () => {
    mockSequence([
      { status: 200, body: makePage(50, 0, '0:50') },
      { status: 200, body: makePage(50, 50, '0:100') },
      { status: 200, body: makePage(20, 100, null) },
    ]);
    const m = useMessages('tok');
    await m.loadFirst(); // 50 messages, seq 1..50
    // Target seq 75 is in the second page (seq 51..100).
    await m.ensureLoadedThrough({ chunkSeq: 0, seq: 75 });
    expect(m.messages.value.some((x) => x.chunkSeq === 0 && x.seq === 75)).toBe(true);
    // It stops as soon as the target is present (100 messages, not all 120).
    expect(m.messages.value).toHaveLength(100);
    // Already present -> no further fetch.
    const fetchMock = vi.mocked(fetch);
    const callsBefore2 = fetchMock.mock.calls.length;
    await m.ensureLoadedThrough({ chunkSeq: 0, seq: 75 });
    expect(fetchMock.mock.calls.length).toBe(callsBefore2);
  });

  it('ensureLoadedThrough distinguishes the same seq in different chunks', async () => {
    const first = makePage(1, 0, '0:1');
    const second = makePage(1, 0, '1:1');
    second.messages[0] = { ...second.messages[0]!, chunkSeq: 1, parts: [{ type: 'text', text: 'chunk 1' }] };
    const third = makePage(1, 1, null);
    third.messages[0] = { ...third.messages[0]!, chunkSeq: 1, parts: [{ type: 'text', text: 'after target' }] };
    mockSequence([
      { status: 200, body: first },
      { status: 200, body: second },
      { status: 200, body: third },
    ]);
    const m = useMessages('tok');
    await m.loadFirst();
    await m.ensureLoadedThrough({ chunkSeq: 1, seq: 1 });
    expect(m.messages.value).toHaveLength(2);
    expect(m.messages.value).toContainEqual(expect.objectContaining({ chunkSeq: 1, seq: 1 }));
  });
});
