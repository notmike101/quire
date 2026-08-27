import { describe, it, expect, vi, afterEach } from 'vitest';
import { shareApi } from '../src/api';

function mockFetch(status: number, body: unknown) {
  return vi.fn(async (_url: string, _init?: RequestInit) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe('shareApi', () => {
  it('page() sends limit and cursor', async () => {
    const fetchMock = mockFetch(200, { meta: {}, messages: [], nextCursor: null });
    vi.stubGlobal('fetch', fetchMock);
    await shareApi('tok123').page(50, '0:100');
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/public/chats/tok123?limit=50&cursor=0%3A100');
  });

  it('page() omits cursor on the first page', async () => {
    const fetchMock = mockFetch(200, { meta: {}, messages: [], nextCursor: null });
    vi.stubGlobal('fetch', fetchMock);
    await shareApi('tok123').page(50);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/public/chats/tok123?limit=50');
  });

  it('maps error bodies to ShareError with the server code', async () => {
    const fetchMock = mockFetch(401, { error: { code: 'needs_password', message: 'This share is password protected' } });
    vi.stubGlobal('fetch', fetchMock);
    await expect(shareApi('tok123').page(50)).rejects.toMatchObject({ status: 401, code: 'needs_password' });
  });

  it('unlock() POSTs the password', async () => {
    const fetchMock = mockFetch(200, { ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const res = await shareApi('tok123').unlock('hunter2');
    expect(res.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/public/chats/tok123/unlock');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ password: 'hunter2' });
  });
});
