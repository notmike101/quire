// Canary (Task 15): safe in-process metrics for the v2 sealed-share pipeline.
// The counters hold counts, bytes, latency, and status only — never share
// IDs, titles, content keys, URLs, tokens, or content. /metrics (app.ts)
// exposes the snapshot so an operator can monitor the v2 pipeline. No
// observability dependency: a plain in-memory registry for the process
// lifetime (the server is single-process).
export type V2MetricCategory =
  | 'v2_create'
  | 'v2_chunk'
  | 'v2_finalize'
  | 'v2_blob_serve'
  // A served blob whose stored digest no longer matches its ciphertext: the
  // row is corrupt and the client cannot decrypt it. The only decrypt
  // failure the server can observe — client-side failures (e.g. a wrong key
  // in the URL fragment) are never reported by design.
  | 'v2_client_decrypt_error'
  // Expired v2 shares hard-deleted by the hourly cleanup job (status 0: a
  // non-HTTP job run; count carries the number of shares deleted).
  | 'v2_stale_cleanup';

interface Bucket {
  count: number;
  bytes: number;
  latencyMs: number;
  latencyCount: number;
  maxLatencyMs: number;
}

export interface V2MetricEntry {
  category: string;
  status: number;
  count: number;
  bytes: number;
  avgLatencyMs: number | null;
  maxLatencyMs: number | null;
}

/** Process-local aggregate counters that contain no share identifiers or content. */
export class V2Metrics {
  private buckets = new Map<string, Bucket>();

  /**
   * Accumulate one pipeline outcome into its category-and-status bucket.
   *
   * @param category - Pipeline operation being measured.
   * @param status - HTTP status, or zero for a background job.
   * @param opts - Numeric measurements to accumulate.
   * @param opts.count - Number of events represented, defaulting to one.
   * @param opts.bytes - Byte count to add when available.
   * @param opts.latencyMs - Elapsed operation time in milliseconds.
   */
  record(
    category: V2MetricCategory,
    status: number,
    opts: { count?: number; bytes?: number; latencyMs?: number } = {},
  ): void {
    const key = category + '|' + status;
    const b = this.buckets.get(key) ?? { count: 0, bytes: 0, latencyMs: 0, latencyCount: 0, maxLatencyMs: 0 };
    b.count += opts.count ?? 1;
    if (opts.bytes) b.bytes += opts.bytes;
    if (opts.latencyMs !== undefined) {
      b.latencyMs += opts.latencyMs;
      b.latencyCount += 1;
      if (opts.latencyMs > b.maxLatencyMs) b.maxLatencyMs = opts.latencyMs;
    }
    this.buckets.set(key, b);
  }

  /**
   * Read sorted aggregate counters with rounded latency averages.
   *
   * @returns Detached metric entries ordered by category and status.
   */
  snapshot(): V2MetricEntry[] {
    const out: V2MetricEntry[] = [];
    for (const [key, b] of this.buckets) {
      const pipe = key.indexOf('|');
      const category = key.slice(0, pipe);
      const status = key.slice(pipe + 1);
      out.push({
        category,
        status: Number(status),
        count: b.count,
        bytes: b.bytes,
        avgLatencyMs: b.latencyCount > 0 ? Math.round(b.latencyMs / b.latencyCount) : null,
        maxLatencyMs: b.latencyCount > 0 ? b.maxLatencyMs : null,
      });
    }
    return out.sort((a, z) => a.category.localeCompare(z.category) || a.status - z.status);
  }

  /** Clear all buckets, primarily to isolate metric assertions in tests. */
  reset(): void {
    this.buckets.clear();
  }
}

// One registry per process: the v2 routes, the cleanup job, and /metrics all
// share it. Tests reset() it before asserting.
export const v2Metrics = new V2Metrics();
