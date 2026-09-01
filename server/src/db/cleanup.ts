import { sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { deleteExpiredV2 } from '../share-v2/store.js';
import { v2Metrics } from '../metrics.js';

// Round 9 (B-F6): a chunked upload that dies mid-flight (the publisher is
// killed after create but before the last chunk) leaves a shares row + its
// partial messages forever — the public endpoint 404s it (Chain E) but the
// owner's list still shows it and the rows are never reclaimed. Expired and
// REVOKED shares are deliberately left alone: they are owner-visible and the
// owner may still want them. Only INCOMPLETE uploads older than 24 hours are
// hard-deleted (the FK cascade removes their partial messages).
export async function cleanupStaleUploads(db: Db): Promise<number> {
  // A bare DELETE returns no result set (postgres.js yields [] — no count),
  // so wrap it in a data-modifying CTE and count the deleted rows.
  const res = await db.execute(
    sql`with del as (
        delete from shares s
        where s."expected_chunks" > 1
          and s."created_at" < now() - interval '24 hours'
          and (select count(distinct m."chunk_seq") from share_messages m where m."share_id" = s.id) < s."expected_chunks"
        returning 1
      ) select count(*)::int as n from del`,
  );
  const first = (res as Array<{ n?: number }>)[0];
  return first?.n ?? 0;
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
