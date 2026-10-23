import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { vi } from 'vitest';
import { blobAad, layoutBlob, type BlobKind } from '@quire/protocol';

type View = Uint8Array<ArrayBuffer>;

// Test key 0x00..0x1f — fixed, not a secret (same convention as share-v2-crypto.test.ts).
export const TEST_KEY = new Uint8Array(32).map((_, i) => i);
export const TEST_FRAGMENT = Buffer.from(TEST_KEY).toString('base64url');

/**
 * Seal a JSON fixture using the same envelope and authenticated data as the server.
 *
 * @param shareId - Share identifier bound to the ciphertext.
 * @param key - Raw AES content key.
 * @param kind - Blob category bound to the ciphertext.
 * @param seq - Blob sequence bound to the ciphertext.
 * @param value - JSON payload to compress and encrypt.
 * @returns Serialized blob envelope as an exactly sized ArrayBuffer.
 */
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

/**
 * Replace fetch with a strict route table for JSON and encrypted blob responses.
 *
 * @param routes - Responses keyed by their exact requested URL.
 * @returns Installed fetch spy for request assertions.
 */
export function mockFetch(routes: Record<string, V2Route>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const route = routes[url];
    if (!route) throw new Error(`unexpected fetch: ${url}`);
    if (route.blob !== undefined) {
      return {
        ok: route.status < 300,
        status: route.status,
        /**
         * Read the encrypted response bytes supplied by this route.
         *
         * @returns Fixture blob bytes.
         */
        arrayBuffer: async () => route.blob,
      };
    }
    return {
      ok: route.status < 300,
      status: route.status,
      /**
       * Read the route's decoded JSON response.
       *
       * @returns Fixture response body.
       */
      json: async () => route.body,
      /**
       * Read the route's response as serialized JSON text.
       *
       * @returns JSON encoding of the fixture body.
       */
      text: async () => JSON.stringify(route.body),
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
