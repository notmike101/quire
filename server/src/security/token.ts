import { randomBytes } from 'node:crypto';

/** 128-bit crypto-random token, base64url (22 chars). The only identifier in a share URL. */
export function generateShareToken(): string {
  return randomBytes(16).toString('base64url');
}

/** 128-bit crypto-random id, hex (32 chars). Keyed on chunk appends; hex so it
 *  never needs URL-encoding in the chunk request body. Distinct from the
 *  viewer-facing share token. */
export function generateUploadId(): string {
  return randomBytes(16).toString('hex');
}
