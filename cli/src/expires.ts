const DURATIONS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

// Relative keywords an agent or human is likely to say, mapped to a millisecond
// offset from now. "tomorrow"/"today" are handled separately below because they
// anchor to local calendar boundaries rather than a fixed offset.
const KEYWORD_OFFSETS: Record<string, number> = {
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
  year: 365 * 86_400_000,
};

/**
 * Accepts an ISO datetime, a duration like 30m/24h/7d, or a relative keyword
 * (tomorrow, today, week, month, year, optionally prefixed with "in ").
 * Returns an ISO string.
 */
export function parseExpiry(value: string): string {
  const raw = value.trim();
  const norm = raw.toLowerCase().replace(/\s+/g, ' ');

  // "in <n><unit>" -> strip the leading "in " and fall through to the duration.
  const inMatch = /^in\s+(.+)$/.exec(norm);
  const candidate = inMatch ? inMatch[1]! : norm;

  let ms: number;
  if (candidate === 'tomorrow') {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(0, 0, 0, 0);
    ms = d.getTime();
  } else if (candidate === 'today') {
    const d = new Date();
    d.setHours(23, 59, 59, 999);
    ms = d.getTime();
  } else if (candidate in KEYWORD_OFFSETS) {
    ms = Date.now() + KEYWORD_OFFSETS[candidate]!;
  } else {
    const iso = Date.parse(raw);
    if (!Number.isNaN(iso)) {
      ms = iso;
    } else {
      const match = /^(\d+)(m|h|d)$/.exec(candidate);
      if (!match) {
        throw new Error(
          `invalid --expires "${value}" (use an ISO datetime, a duration like 30m/24h/7d, or tomorrow/today/week/month/year)`,
        );
      }
      const amount = Number(match[1]);
      const unit = DURATIONS[match[2]!]!;
      ms = Date.now() + amount * unit;
    }
  }
  // Round 9 (C-F7): a duration like 99999999999999999999d overflows the Date
  // range (|ms| > 8.64e15) and new Date() would throw a RangeError; a past
  // expiry is a dead-on-arrival share. Reject both. Number.isFinite alone is
  // not enough — the overflowed product (8.64e27) is still finite.
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) {
    throw new Error(`invalid --expires "${value}" (duration overflows the date range)`);
  }
  if (ms <= Date.now()) {
    throw new Error(`invalid --expires "${value}" (the expiry is in the past)`);
  }
  return new Date(ms).toISOString();
}
