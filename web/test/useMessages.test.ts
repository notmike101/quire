import { describe, it, expect, vi, afterEach } from 'vitest';
import { useMessages } from '../src/composables/useMessages';
import type { ShareMessage, ShareMeta } from '../src/api';

const META: ShareMeta = {
  title: 'Test Session',
  model: 'test-model',
  provider: 'test-provider',
  createdAt: '2026-08-20T00:00:00.000Z',
  expiresAt: null,
  messageCount: 120,
  redactions: 2,
};

function makePage(count: number, start: number, nextCursor: number | null) {
  return {
    meta: META,
    messages: Array.from({ length: count }, (_, i): ShareMessage => ({
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
      { status: 200, body: makePage(50, 0, 50) },
      { status: 200, body: makePage(50, 50, 100) },
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
});
