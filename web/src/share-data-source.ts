import { shareApi, ShareError, type PageResponse } from './api';
import { createV2DataSource } from './share-v2/data-source';
import { parseContentKeyFragment } from './share-v2/crypto';

/**
 * The data source behind useMessages. A URL whose fragment carries a 32-byte
 * content key is a sealed v2 share (blobs are fetched and decrypted in the
 * browser); anything else is a v1 share, served by the existing api.ts
 * functions with unchanged behavior.
 */
export interface ShareDataSource {
  loadFirst(): Promise<PageResponse | ShareError>;
  loadNext(cursor: string): Promise<PageResponse | ShareError>;
  unlock(password: string): Promise<void>;
}

export function createDataSource(shareId: string, fragment: string): ShareDataSource {
  const key = parseContentKeyFragment(fragment);
  if (key) return createV2DataSource(shareId, key);
  return createV1DataSource(shareId);
}

// Wraps the v1 API so the data source contract holds: loadFirst/loadNext
// never throw (network failures become the same generic errors the
// composable used to produce) and unlock rejects with a ShareError.
function createV1DataSource(token: string): ShareDataSource {
  const api = shareApi(token);
  return {
    async loadFirst(): Promise<PageResponse | ShareError> {
      try {
        return await api.page(50);
      } catch (err) {
        return err instanceof ShareError ? err : new ShareError(0, 'http', 'Something went wrong loading this share.');
      }
    },
    async loadNext(cursor: string): Promise<PageResponse | ShareError> {
      try {
        return await api.page(50, cursor);
      } catch (err) {
        return err instanceof ShareError ? err : new ShareError(0, 'http', 'Failed to load more messages.');
      }
    },
    async unlock(password: string): Promise<void> {
      await api.unlock(password);
    },
  };
}
