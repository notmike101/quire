import { randomBytes } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { blobAad, layoutBlob, parseBlob, type BlobKind } from '@quire/protocol';
type BufferSource = NodeJS.BufferSource;
const subtle = globalThis.crypto.subtle;
/**
 * Import raw content-key bytes as a non-extractable AES-GCM key.
 *
 * @param key - Raw AES content key.
 * @returns A key usable for encryption and decryption.
 */
async function importKey(key: Uint8Array) {
  return subtle.importKey('raw', key as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
/**
 * Compress JSON and encrypt it with a fresh nonce and share-bound authentication data.
 *
 * @param key - Raw AES content key.
 * @param shareId - Public share identifier authenticated with the blob.
 * @param kind - Blob family included in the authentication data.
 * @param seq - Blob sequence included in the authentication data.
 * @param value - JSON-serializable plaintext payload.
 * @returns The protocol envelope containing nonce and authenticated ciphertext.
 */
export async function sealBlob(key: Uint8Array, shareId: string, kind: BlobKind, seq: number, value: unknown): Promise<Uint8Array> {
  const plain = gzipSync(Buffer.from(JSON.stringify(value), 'utf8'));
  const nonce = randomBytes(12);
  const cipher = await subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource, additionalData: blobAad(shareId, kind, seq) as BufferSource }, await importKey(key), plain as BufferSource);
  return layoutBlob(nonce, new Uint8Array(cipher));
}
/**
 * Authenticate, decrypt, and decompress a sealed JSON payload.
 *
 * @param key - Raw AES content key.
 * @param blob - Protocol envelope containing nonce and ciphertext.
 * @param shareId - Expected public share identifier.
 * @param kind - Expected blob family.
 * @param seq - Expected blob sequence.
 * @returns The decoded JSON value.
 */
export async function openBlob(key: Uint8Array, blob: Uint8Array, shareId: string, kind: BlobKind, seq: number): Promise<unknown> {
  const { nonce, ciphertext } = parseBlob(blob);
  const plain = await subtle.decrypt({ name: 'AES-GCM', iv: nonce as BufferSource, additionalData: blobAad(shareId, kind, seq) as BufferSource }, await importKey(key), ciphertext as BufferSource);
  return JSON.parse(gunzipSync(Buffer.from(plain)).toString('utf8'));
}
