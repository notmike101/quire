const DURATIONS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Accepts an ISO datetime or a duration like 30m, 24h, 7d. Returns an ISO string. */
export function parseExpiry(value: string): string {
  const iso = Date.parse(value);
  if (!Number.isNaN(iso)) return new Date(iso).toISOString();
  const match = /^(\d+)(m|h|d)$/.exec(value.trim());
  if (!match) throw new Error(`invalid --expires "${value}" (use an ISO datetime or a duration like 30m, 24h, 7d)`);
  const amount = Number(match[1]);
  const unit = DURATIONS[match[2]!]!;
  return new Date(Date.now() + amount * unit).toISOString();
}
