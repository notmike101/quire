import { randomBytes } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { blobAad, layoutBlob, parseBlob, type BlobKind } from '@quire/protocol';
// @types/node 22 keeps BufferSource inside the webcrypto namespace; alias the standard definition.
type BufferSource = ArrayBufferView | ArrayBuffer;
const subtle = globalThis.crypto.subtle;
async function importKey(key: Uint8Array) {
  return subtle.importKey('raw', key as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
export async function sealBlob(key: Uint8Array, shareId: string, kind: BlobKind, seq: number, value: unknown): Promise<Uint8Array> {
  const plain = gzipSync(Buffer.from(JSON.stringify(value), 'utf8'));
  const nonce = randomBytes(12);
  const cipher = await subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource, additionalData: blobAad(shareId, kind, seq) as BufferSource }, await importKey(key), plain as BufferSource);
  return layoutBlob(nonce, new Uint8Array(cipher));
}
export async function openBlob(key: Uint8Array, blob: Uint8Array, shareId: string, kind: BlobKind, seq: number): Promise<unknown> {
  const { nonce, ciphertext } = parseBlob(blob);
  const plain = await subtle.decrypt({ name: 'AES-GCM', iv: nonce as BufferSource, additionalData: blobAad(shareId, kind, seq) as BufferSource }, await importKey(key), ciphertext as BufferSource);
  return JSON.parse(gunzipSync(Buffer.from(plain)).toString('utf8'));
}
