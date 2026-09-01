// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { blobAad, layoutBlob, SHARE_PROTOCOL, type BlobKind, type ShareMessageV1 } from '@quire/protocol';
import { createDataSource } from '../src/share-data-source';
import { ShareError, type PageResponse } from '../src/api';

const SHARE_ID = 'share-abc123';
// Test key 0x00..0x1f — fixed, not a secret (same convention as share-v2-crypto.test.ts).
const KEY = new Uint8Array(32).map((_, i) => i);
const FRAGMENT = Buffer.from(KEY).toString('base64url');

type View = Uint8Array<ArrayBuffer>;

async function seal(key: Uint8Array, kind: BlobKind, seq: number, value: unknown): Promise<ArrayBuffer> {
  const plain = gzipSync(Buffer.from(JSON.stringify(value), 'utf8'));
  const nonce = randomBytes(12);
  const subtle = globalThis.crypto.subtle;
  const cryptoKey = await subtle.importKey('raw', key as View, { name: 'AES-GCM' }, false, ['encrypt']);
  const cipher = await subtle.encrypt(
    { name: 'AES-GCM', iv: nonce as View, additionalData: blobAad(SHARE_ID, kind, seq) as View },
    cryptoKey,
    plain,
  );
  const bytes = layoutBlob(nonce, new Uint8Array(cipher));
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

const msg = (seq: number, role: 'user' | 'assistant', text: string): ShareMessageV1 => ({
  chunkSeq: 0,
  seq,
  role,
  time: null,
  parts: [{ type: 'text', text }],
});

const META = {
  title: 'Sealed Session',
  model: 'test-model',
  provider: 'test-provider',
  createdAt: '2026-09-01T00:00:00.000Z',
  expiresAt: null,
  messageCount: 3,
  redactions: { 'api-key': 1 },
};
const MANIFEST = { protocol: SHARE_PROTOCOL, shareId: SHARE_ID, ...META, pageCount: 2 };
const INDEX = { protocol: SHARE_PROTOCOL, shareId: SHARE_ID, seq: 0, entries: [{ chunkSeq: 0, seq: 1, preview: 'hello' }] };
const PAGE0 = { protocol: SHARE_PROTOCOL, shareId: SHARE_ID, seq: 0, messages: [msg(1, 'user', 'hello'), msg(2, 'assistant', 'hi there')] };
const PAGE1 = { protocol: SHARE_PROTOCOL, shareId: SHARE_ID, seq: 1, messages: [msg(3, 'user', 'second page')] };
const PAGE2 = { protocol: SHARE_PROTOCOL, shareId: SHARE_ID, seq: 2, messages: [msg(4, 'assistant', 'last page')] };

type Route = { status: number; body?: unknown; blob?: ArrayBuffer };

function mockFetch(routes: Record<string, Route>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const route = routes[url];
    if (!route) throw new Error(`unexpected fetch: ${url}`);
    if (route.blob !== undefined) {
      return { ok: route.status < 300, status: route.status, arrayBuffer: async () => route.blob };
    }
    return { ok: route.status < 300, status: route.status, json: async () => route.body, text: async () => JSON.stringify(route.body) };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function v2Routes(overrides: Record<string, Route> = {}): Record<string, Route> {
  return {
    [`/api/v2/public/shares/${SHARE_ID}/bootstrap`]: {
      status: 200,
      body: { state: 'ready', expiresAt: null, expired: false, passwordRequired: false },
    },
    ...overrides,
  };
}

async function v2BlobRoutes(manifest: object = MANIFEST, pages: Record<number, object> = { 0: PAGE0, 1: PAGE1 }): Promise<Record<string, Route>> {
  const routes: Record<string, Route> = {
    [`/api/v2/public/shares/${SHARE_ID}/blobs/manifest/0`]: { status: 200, blob: await seal(KEY, 'manifest', 0, manifest) },
    [`/api/v2/public/shares/${SHARE_ID}/blobs/index/0`]: { status: 200, blob: await seal(KEY, 'index', 0, INDEX) },
  };
  for (const [seq, page] of Object.entries(pages)) {
    routes[`/api/v2/public/shares/${SHARE_ID}/blobs/page/${seq}`] = { status: 200, blob: await seal(KEY, 'page', Number(seq), page) };
  }
  return routes;
}

function ok(res: PageResponse | ShareError): PageResponse {
  if (res instanceof ShareError) throw new Error(`unexpected ShareError: ${res.code}`);
  return res;
}

afterEach(() => vi.unstubAllGlobals());

describe('createDataSource routing', () => {
  it('returns the v2 source when the fragment is a 32-byte content key', async () => {
    const fetchMock = mockFetch({ ...v2Routes(), ...(await v2BlobRoutes()) });
    const src = createDataSource(SHARE_ID, FRAGMENT);
    const res = await src.loadFirst();
    expect(res).not.toBeInstanceOf(ShareError);
    expect(fetchMock.mock.calls[0]![0]).toBe(`/api/v2/public/shares/${SHARE_ID}/bootstrap`);
  });

  it('returns the v1 source for an empty or invalid fragment', async () => {
    const v1Page: PageResponse = { meta: META, messages: [msg(1, 'user', 'v1')], nextCursor: null };
    for (const fragment of ['', 'not-a-key', FRAGMENT.slice(0, 10)]) {
      const fetchMock = mockFetch({ '/api/public/chats/tok?limit=50': { status: 200, body: v1Page } });
      const res = await createDataSource('tok', fragment).loadFirst();
      expect(res).not.toBeInstanceOf(ShareError);
      expect(fetchMock.mock.calls[0]![0]).toBe('/api/public/chats/tok?limit=50');
      vi.unstubAllGlobals();
    }
  });
});

describe('v2 data source', () => {
  it('maps the decrypted manifest/index/page into a PageResponse', async () => {
    mockFetch({ ...v2Routes(), ...(await v2BlobRoutes()) });
    const page = ok(await createDataSource(SHARE_ID, FRAGMENT).loadFirst());
    expect(page.meta).toEqual(META);
    expect(page.messages).toEqual(PAGE0.messages);
    expect(page.userIndex).toEqual(INDEX.entries);
    expect(page.nextCursor).toBe('1');
  });

  it('returns nextCursor null when pageCount is 1', async () => {
    const manifest = { ...MANIFEST, pageCount: 1, messageCount: 2 };
    mockFetch({ ...v2Routes(), ...(await v2BlobRoutes(manifest, { 0: PAGE0 })) });
    const page = ok(await createDataSource(SHARE_ID, FRAGMENT).loadFirst());
    expect(page.nextCursor).toBeNull();
  });

  it.each([
    [401, 'needs_password'],
    [404, 'not_found'],
    [410, 'expired'],
  ])('maps a bootstrap %i to a %s ShareError', async (status, code) => {
    mockFetch({
      [`/api/v2/public/shares/${SHARE_ID}/bootstrap`]: { status, body: { error: { code, message: 'nope' } } },
    });
    const res = await createDataSource(SHARE_ID, FRAGMENT).loadFirst();
    expect(res).toBeInstanceOf(ShareError);
    expect((res as ShareError).code).toBe(code);
  });

  it('loadNext advances the page cursor and stops at pageCount', async () => {
    const manifest = { ...MANIFEST, pageCount: 3, messageCount: 4 };
    mockFetch({ ...v2Routes(), ...(await v2BlobRoutes(manifest, { 0: PAGE0, 1: PAGE1, 2: PAGE2 })) });
    const src = createDataSource(SHARE_ID, FRAGMENT);
    const first = ok(await src.loadFirst());
    expect(first.nextCursor).toBe('1');
    const second = ok(await src.loadNext('1'));
    expect(second.messages).toEqual(PAGE1.messages);
    expect(second.userIndex).toEqual([]);
    expect(second.meta).toEqual(first.meta);
    expect(second.nextCursor).toBe('2');
    const third = ok(await src.loadNext('2'));
    expect(third.messages).toEqual(PAGE2.messages);
    expect(third.nextCursor).toBeNull();
  });

  it('returns a generic load error when a blob cannot be decrypted (no content, no key)', async () => {
    const wrongKey = new Uint8Array(KEY);
    wrongKey[0]! ^= 0xff;
    const routes = { ...v2Routes(), ...(await v2BlobRoutes()) };
    routes[`/api/v2/public/shares/${SHARE_ID}/blobs/page/0`] = { status: 200, blob: await seal(wrongKey, 'page', 0, PAGE0) };
    mockFetch(routes);
    const res = await createDataSource(SHARE_ID, FRAGMENT).loadFirst();
    expect(res).toBeInstanceOf(ShareError);
    const message = (res as ShareError).message;
    expect(message).not.toContain(FRAGMENT);
    expect(message).not.toContain('hello');
  });

  it('returns a generic load error when a decrypted blob fails to parse', async () => {
    const routes = { ...v2Routes(), ...(await v2BlobRoutes()) };
    routes[`/api/v2/public/shares/${SHARE_ID}/blobs/page/0`] = { status: 200, blob: await seal(KEY, 'page', 0, { junk: true }) };
    mockFetch(routes);
    const res = await createDataSource(SHARE_ID, FRAGMENT).loadFirst();
    expect(res).toBeInstanceOf(ShareError);
    expect((res as ShareError).message).not.toContain('junk');
  });

  it('unlock POSTs the password and rejects with a ShareError on failure', async () => {
    mockFetch({
      [`/api/v2/public/shares/${SHARE_ID}/unlock`]: { status: 401, body: { error: { code: 'bad_password', message: 'Incorrect password' } } },
    });
    await expect(createDataSource(SHARE_ID, FRAGMENT).unlock('wrong')).rejects.toBeInstanceOf(ShareError);
    mockFetch({ [`/api/v2/public/shares/${SHARE_ID}/unlock`]: { status: 200, body: { ok: true } } });
    await expect(createDataSource(SHARE_ID, FRAGMENT).unlock('right')).resolves.toBeUndefined();
  });
});

describe('v1 data source wrapper', () => {
  it('delegates loadFirst/loadNext to the existing v1 API', async () => {
    const first: PageResponse = { meta: META, messages: [msg(1, 'user', 'a')], nextCursor: 'c1' };
    const second: PageResponse = { meta: META, messages: [msg(2, 'assistant', 'b')], nextCursor: null };
    mockFetch({
      '/api/public/chats/tok?limit=50': { status: 200, body: first },
      '/api/public/chats/tok?limit=50&cursor=c1': { status: 200, body: second },
    });
    const src = createDataSource('tok', '');
    expect(await src.loadFirst()).toEqual(first);
    expect(await src.loadNext('c1')).toEqual(second);
  });

  it('maps a v1 401 to a needs_password ShareError', async () => {
    mockFetch({
      '/api/public/chats/tok?limit=50': { status: 401, body: { error: { code: 'needs_password', message: 'This share is password protected' } } },
    });
    const res = await createDataSource('tok', '').loadFirst();
    expect(res).toBeInstanceOf(ShareError);
    expect((res as ShareError).code).toBe('needs_password');
  });
});
