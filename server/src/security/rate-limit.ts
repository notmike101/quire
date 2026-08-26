/** 5 failures -> 15-minute lockout, keyed per (token, IP). In-memory: fine for a single container. */
export class RateLimiter {
  private hits = new Map<string, { count: number; lockedUntil: number }>();
  constructor(
    private readonly maxFails = 5,
    private readonly lockMs = 15 * 60 * 1000,
  ) {}

  isLocked(key: string, now: number = Date.now()): boolean {
    const e = this.hits.get(key);
    return !!e && e.lockedUntil > now;
  }

  recordFailure(key: string, now: number = Date.now()): void {
    this.prune(now);
    const e = this.hits.get(key) ?? { count: 0, lockedUntil: 0 };
    e.count += 1;
    if (e.count >= this.maxFails) {
      e.lockedUntil = now + this.lockMs;
      e.count = 0;
    }
    this.hits.set(key, e);
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private prune(now: number): void {
    if (this.hits.size < 10_000) return;
    // Drop expired lockouts AND idle sub-threshold counters so an adversary
    // cycling distinct (token, IP) keys cannot exhaust memory (M12).
    for (const [k, e] of this.hits) if (e.lockedUntil < now && (e.count === 0 || e.lockedUntil === 0)) this.hits.delete(k);
  }
}

/** Fixed 60-second window, 120 requests per IP, for the public content endpoint. */
export class IpWindow {
  private windows = new Map<string, { start: number; count: number }>();
  constructor(
    private readonly maxPerWindow = 120,
    private readonly windowMs = 60 * 1000,
  ) {}

  allow(ip: string, now: number = Date.now()): boolean {
    const w = this.windows.get(ip);
    if (!w || now - w.start >= this.windowMs) {
      // Evict only stale windows instead of clearing everything (M13): a
      // self-DoS of the limiter under an IP-scan burst would momentarily reset
      // the 120 req/min limit for every IP.
      if (this.windows.size > 10_000) {
        for (const [k, e] of this.windows) if (now - e.start >= this.windowMs) this.windows.delete(k);
      }
      this.windows.set(ip, { start: now, count: 1 });
      return true;
    }
    w.count += 1;
    return w.count <= this.maxPerWindow;
  }
}
