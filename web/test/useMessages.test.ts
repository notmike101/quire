import { describe, it, expect } from 'vitest';
import { useMessages } from '../src/composables/useMessages';
import type { ShareDataSource } from '../src/share-data-source';
import { ShareError, type PageResponse, type ShareMessage, type ShareMeta } from '../src/api';

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

type Result = PageResponse | ShareError;

// The composable is the unit under test; a stub data source stands in for the
// real one (v2 blob machinery is covered by share-data-source.test.ts).
function fakeSource(firsts: Result[], nexts: Result[] = [], unlock?: (password: string) => Promise<void>) {
  const calls = { loadFirst: 0, loadNext: 0 };
  const source: ShareDataSource = {
    loadFirst: async () => {
      calls.loadFirst++;
      const r = firsts.shift();
      if (r === undefined) throw new Error('unexpected loadFirst');
      return r;
    },
    loadNext: async () => {
      calls.loadNext++;
      const r = nexts.shift();
      if (r === undefined) throw new Error('unexpected loadNext');
      return r;
    },
    unlock: unlock ?? (async () => {}),
  };
  return { source, calls };
}

describe('useMessages', () => {
  it('loads the first page and appends until nextCursor is null', async () => {
    const { source, calls } = fakeSource(
      [makePage(50, 0, '0:50')],
      [makePage(50, 50, '0:100'), makePage(20, 100, null)],
    );
    const m = useMessages(source);
    await m.loadFirst();
    expect(m.state.value).toBe('ready');
    expect(m.meta.value?.title).toBe('Test Session');
    expect(m.messages.value).toHaveLength(50);
    await m.loadMore();
    expect(m.messages.value).toHaveLength(100);
    await m.loadMore();
    expect(m.messages.value).toHaveLength(120);
    await m.loadMore(); // exhausted — must not load again
    expect(calls.loadNext).toBe(2);
  });

  it('surfaces needs_password without entering the error state', async () => {
    const { source } = fakeSource([new ShareError(401, 'needs_password', 'This share is password protected')]);
    const m = useMessages(source);
    await m.loadFirst();
    expect(m.state.value).toBe('needs_password');
  });

  it('surfaces expired', async () => {
    const { source } = fakeSource([new ShareError(410, 'expired', 'This share has expired')]);
    const m = useMessages(source);
    await m.loadFirst();
    expect(m.state.value).toBe('expired');
  });

  it('submitPassword: wrong password sets an error, correct password loads the share', async () => {
    const { source } = fakeSource(
      [new ShareError(401, 'needs_password', 'This share is password protected'), makePage(1, 0, null)],
      [],
      async (password) => {
        if (password !== 'right') throw new ShareError(401, 'bad_password', 'Incorrect password');
      },
    );
    const m = useMessages(source);
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
    const { source } = fakeSource([body]);
    const m = useMessages(source);
    await m.loadFirst();
    expect(m.userIndex.value).toEqual([{ chunkSeq: 0, seq: 1, preview: 'm1' }]);
  });

  it('ensureLoadedThrough loads pages until the target seq is present', async () => {
    const { source, calls } = fakeSource(
      [makePage(50, 0, '0:50')],
      [makePage(50, 50, '0:100'), makePage(20, 100, null)],
    );
    const m = useMessages(source);
    await m.loadFirst(); // 50 messages, seq 1..50
    // Target seq 75 is in the second page (seq 51..100).
    await m.ensureLoadedThrough({ chunkSeq: 0, seq: 75 });
    expect(m.messages.value.some((x) => x.chunkSeq === 0 && x.seq === 75)).toBe(true);
    // It stops as soon as the target is present (100 messages, not all 120).
    expect(m.messages.value).toHaveLength(100);
    // Already present -> no further load.
    const loadsBefore = calls.loadNext;
    await m.ensureLoadedThrough({ chunkSeq: 0, seq: 75 });
    expect(calls.loadNext).toBe(loadsBefore);
  });

  it('ensureLoadedThrough distinguishes the same seq in different chunks', async () => {
    const first = makePage(1, 0, '0:1');
    const second = makePage(1, 0, '1:1');
    second.messages[0] = { ...second.messages[0]!, chunkSeq: 1, parts: [{ type: 'text', text: 'chunk 1' }] };
    const third = makePage(1, 1, null);
    third.messages[0] = { ...third.messages[0]!, chunkSeq: 1, parts: [{ type: 'text', text: 'after target' }] };
    const { source } = fakeSource([first], [second, third]);
    const m = useMessages(source);
    await m.loadFirst();
    await m.ensureLoadedThrough({ chunkSeq: 1, seq: 1 });
    expect(m.messages.value).toHaveLength(2);
    expect(m.messages.value).toContainEqual(expect.objectContaining({ chunkSeq: 1, seq: 1 }));
  });
});
