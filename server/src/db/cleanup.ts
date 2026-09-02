import { sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { deleteExpiredV2 } from '../share-v2/store.js';
import { v2Metrics } from '../metrics.js';

/** Hourly: hard-delete v2 uploads abandoned before finalize (state 'uploading', >24h old). */
export async function cleanupStaleV2Uploads(db: Db): Promise<number> {
  const rows = await db.execute(sql`delete from shares_v2 where state = 'uploading' and created_at < now() - interval '24 hours' returning 1`);
  const n = rows.count ?? 0;
  v2Metrics.record('v2_stale_cleanup', 0, { count: n });
  return n;
}

// Canary (Task 15): expired v2 shares are hard-deleted — the FK cascade
// reclaims their source chunks and ciphertext blobs. The public route 410s
// an expired share from the moment it expires; this reclaims the rows within
// an hour. Recorded under v2_stale_cleanup (status 0 = non-HTTP job run; the
// deleted share count rides in `count`).
export async function cleanupExpiredV2(db: Db): Promise<number> {
  const t0 = Date.now();
  const n = await deleteExpiredV2(db);
  v2Metrics.record('v2_stale_cleanup', 0, { count: n, latencyMs: Date.now() - t0 });
  return n;
}
