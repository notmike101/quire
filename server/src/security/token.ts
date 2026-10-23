import { randomBytes } from 'node:crypto';

/**
 * Generate the 128-bit random identifier used in a public share URL.
 *
 * @returns A 22-character base64url token.
 */
export function generateShareToken(): string {
  return randomBytes(16).toString('base64url');
}

/**
 * Generate a separate random identifier for idempotent chunk uploads.
 *
 * @returns A 32-character hexadecimal identifier requiring no URL encoding.
 */
export function generateUploadId(): string {
  return randomBytes(16).toString('hex');
}
