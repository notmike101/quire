import { parseBlob, blobAad, MAX_DECOMPRESSED_BLOB_BYTES, type BlobKind } from '@quire/protocol';
// The protocol returns ArrayBufferLike views; DOM WebCrypto wants ArrayBuffer-backed views.
type View = Uint8Array<ArrayBuffer>;

async function gunzip(data: View): Promise<View> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function openShareBlob(key: Uint8Array, blob: ArrayBuffer, shareId: string, kind: BlobKind, seq: number): Promise<unknown> {
  const { nonce, ciphertext } = parseBlob(new Uint8Array(blob));
  const aad = blobAad(shareId, kind, seq);
  const cryptoKey = await crypto.subtle.importKey('raw', key as View, { name: 'AES-GCM' }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce as View, additionalData: aad as View }, cryptoKey, ciphertext as View);
  const decompressed = await gunzip(new Uint8Array(plain));
  if (decompressed.byteLength > MAX_DECOMPRESSED_BLOB_BYTES) throw new Error('decompressed blob too large');
  return JSON.parse(new TextDecoder().decode(decompressed));
}

export function parseContentKeyFragment(fragment: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(fragment)) return null;
  const b64 = fragment.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (fragment.length % 4)) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.length === 32 ? bytes : null;
}
