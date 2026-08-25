import { describe, it, expect, vi, afterEach } from 'vitest';
import { QuireApi, QuireApiError } from '../src/api.js';

const config = { serverUrl: 'https://srv.example.com', apiKey: 'k'.repeat(64) };

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('QuireApi', () => {
  it('sends the bearer key and parses JSON', async () => {
    const fn = mockFetch(200, { shares: [] });
    await new QuireApi(config).list();
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('https://srv.example.com/api/chats');
    expect((init as RequestInit).headers).toMatchObject({ authorization: `Bearer ${'k'.repeat(64)}` });
  });

  it('maps error bodies to QuireApiError', async () => {
    mockFetch(401, { error: { code: 'unauthorized', message: 'Invalid API key' } });
    await expect(new QuireApi(config).list()).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
    await expect(new QuireApi(config).list()).rejects.toBeInstanceOf(QuireApiError);
  });

  it('posts the preview body shape', async () => {
    const fn = mockFetch(200, { messages: [], summary: {}, bytes: 0, messageCount: 0 });
    await new QuireApi(config).preview({ sessionId: 's', title: 't', messages: [] }, 'strict');
    const [, init] = fn.mock.calls[0]!;
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      session: { sessionId: 's', title: 't', messages: [] },
      preset: 'strict',
    });
  });

  it('posts create with optional password/expiresAt, omitting undefined', async () => {
    const fn = mockFetch(201, { token: 't', url: '/chats/t' });
    await new QuireApi(config).create({ sessionId: 's', title: 't', messages: [] }, { preset: 'normal' });
    const [, init] = fn.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ session: { sessionId: 's', title: 't', messages: [] }, preset: 'normal' });
    expect('password' in body).toBe(false);
    expect('expiresAt' in body).toBe(false);
  });
});
