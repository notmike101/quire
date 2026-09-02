import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { vi } from 'vitest';
import { blobAad, layoutBlob, type BlobKind } from '@quire/protocol';

type View = Uint8Array<ArrayBuffer>;

// Test key 0x00..0x1f — fixed, not a secret (same convention as share-v2-crypto.test.ts).
export const TEST_KEY = new Uint8Array(32).map((_, i) => i);
export const TEST_FRAGMENT = Buffer.from(TEST_KEY).toString('base64url');

export async function seal(shareId: string, key: Uint8Array, kind: BlobKind, seq: number, value: unknown): Promise<ArrayBuffer> {
  const plain = gzipSync(Buffer.from(JSON.stringify(value), 'utf8'));
  const nonce = randomBytes(12);
  const subtle = globalThis.crypto.subtle;
  const cryptoKey = await subtle.importKey('raw', key as View, { name: 'AES-GCM' }, false, ['encrypt']);
  const cipher = await subtle.encrypt(
    { name: 'AES-GCM', iv: nonce as View, additionalData: blobAad(shareId, kind, seq) as View },
    cryptoKey,
    plain,
  );
  const bytes = layoutBlob(nonce, new Uint8Array(cipher));
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

export type V2Route = { status: number; body?: unknown; blob?: ArrayBuffer };

export function mockFetch(routes: Record<string, V2Route>) {
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
