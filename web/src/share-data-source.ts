import { ShareError, type PageResponse } from './api';
import { createV2DataSource } from './share-v2/data-source';
import { parseContentKeyFragment } from './share-v2/crypto';

/**
 * The data source behind useMessages. A URL whose fragment carries a 32-byte
 * content key is a sealed v2 share (blobs are fetched and decrypted in the
 * browser); anything else gets a local error source — the missing-key page —
 * with zero network calls.
 */
export interface ShareDataSource {
  loadFirst(): Promise<PageResponse | ShareError>;
  loadNext(cursor: string): Promise<PageResponse | ShareError>;
  unlock(password: string): Promise<void>;
}

export function createDataSource(shareId: string, fragment: string): ShareDataSource {
  const key = parseContentKeyFragment(fragment);
  if (key) return createV2DataSource(shareId, key);
  const err = new ShareError(0, 'error', 'This link is missing its content key. Ask the owner for the full share URL, including the part after the #.');
  return {
    loadFirst: async () => err,
    loadNext: async () => err,
    unlock: async () => { throw err; },
  };
}
