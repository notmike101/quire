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
    expect(String(url)).toBe('https://srv.example.com/api/chats');
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

  it('sends expectedChunks on create when provided (Chain E), omits it otherwise', async () => {
    const fn = mockFetch(201, { token: 't', url: '/chats/t' });
    await new QuireApi(config).create({ sessionId: 's', title: 't', messages: [] }, { preset: 'strict', expectedChunks: 3 });
    const [, init] = fn.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.expectedChunks).toBe(3);
    // single-request path: no expectedChunks -> omitted (server default 1)
    await new QuireApi(config).create({ sessionId: 's', title: 't', messages: [] }, { preset: 'strict' });
    const [, init2] = fn.mock.calls[1]!;
    const body2 = JSON.parse((init2 as RequestInit).body as string);
    expect('expectedChunks' in body2).toBe(false);
  });

  it('posts a chunk append to /api/chats/:token/chunks', async () => {
    const fn = mockFetch(200, { ok: true, messageCount: 3, bytes: 42 });
    await new QuireApi(config).createChunk('tok123', { uploadId: 'a'.repeat(32), chunkSeq: 1, messages: [] });
    const [url, init] = fn.mock.calls[0]!;
    expect(String(url)).toBe('https://srv.example.com/api/chats/tok123/chunks');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ uploadId: 'a'.repeat(32), chunkSeq: 1, messages: [] });
  });
});

describe('QuireApi hardening (Round 9 C-F1/C-F6/C-F8)', () => {
  it('fetches with redirect:manual and a timeout signal', async () => {
    const fn = mockFetch(200, { shares: [] });
    await new QuireApi(config).list();
    const [, init] = fn.mock.calls[0]!;
    const i = init as RequestInit;
    expect(i.redirect).toBe('manual');
    expect(i.signal).toBeInstanceOf(AbortSignal);
  });

  it('refuses to follow a server redirect (C-F1)', async () => {
    // A 3xx must not be followed: the API key would be replayed to the
    // redirect target. With redirect:manual the 3xx comes back unfollowed.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://evil.example.com/steal' } })));
    await expect(new QuireApi(config).list()).rejects.toMatchObject({ status: 302, code: 'redirect' });
    await expect(new QuireApi(config).list()).rejects.toBeInstanceOf(QuireApiError);
  });

  it('maps a fetch timeout to a QuireApiError (C-F8)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    }));
    await expect(new QuireApi(config).list()).rejects.toMatchObject({ status: 0, code: 'timeout' });
    await expect(new QuireApi(config).list()).rejects.toBeInstanceOf(QuireApiError);
  });

  it('origin strips userinfo from the configured server URL (C-F6)', () => {
    // Credentials in the server URL must not leak into printed output.
    expect(new QuireApi({ serverUrl: 'https://user:pass@srv.example.com:8443/base', apiKey: 'k'.repeat(64) }).origin).toBe('https://srv.example.com:8443');
    expect(new QuireApi(config).origin).toBe('https://srv.example.com');
  });

  it('strips userinfo from the REQUEST url (C-F6b: Node fetch throws on credential URLs)', async () => {
    // Node's fetch() throws "Request cannot be constructed from a URL that
    // includes credentials" for a baseUrl like http://user:pass@host — a
    // pattern that is valid in curl/browsers. The request URL must be
    // credential-free and the Bearer key stays the sole auth header.
    const fn = mockFetch(200, { shares: [] });
    await new QuireApi({ serverUrl: 'http://user:secret@127.0.0.1:8791', apiKey: 'k'.repeat(64) }).list();
    const [url, init] = fn.mock.calls[0]!;
    expect(String(url)).toBe('http://127.0.0.1:8791/api/chats');
    expect((init as RequestInit).headers).toMatchObject({ authorization: `Bearer ${'k'.repeat(64)}` });
  });

  it('maps a malformed server URL to a QuireApiError (C-F6b)', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await expect(new QuireApi({ serverUrl: 'not a url', apiKey: 'k' }).list()).rejects.toMatchObject({ status: 0, code: 'invalid_url' });
    await expect(new QuireApi({ serverUrl: 'not a url', apiKey: 'k' }).list()).rejects.toBeInstanceOf(QuireApiError);
  });
});
