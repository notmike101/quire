import { describe, it, expect } from 'vitest';
import { parseExpiry } from '../src/expires.js';

const DAY = 86_400_000;

describe('parseExpiry', () => {
  it('passes an ISO datetime through as ISO', () => {
    expect(parseExpiry('2026-09-01T00:00:00Z')).toBe('2026-09-01T00:00:00.000Z');
  });

  it('accepts a bare date as ISO (Date.parse)', () => {
    expect(parseExpiry('2026-09-01')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('accepts a duration in minutes/hours/days', () => {
    const now = Date.now();
    const m = Date.parse(parseExpiry('30m'));
    const h = Date.parse(parseExpiry('24h'));
    const d = Date.parse(parseExpiry('7d'));
    expect(m - now).toBeGreaterThan(29 * 60_000);
    expect(m - now).toBeLessThan(31 * 60_000);
    expect(h - now).toBeGreaterThan(23 * 3_600_000);
    expect(h - now).toBeLessThan(25 * 3_600_000);
    expect(d - now).toBeGreaterThan(6 * DAY);
    expect(d - now).toBeLessThan(8 * DAY);
  });

  it('accepts "in <duration>"', () => {
    const now = Date.now();
    const v = Date.parse(parseExpiry('in 2h'));
    expect(v - now).toBeGreaterThan(1 * 3_600_000);
    expect(v - now).toBeLessThan(3 * 3_600_000);
  });

  it('"tomorrow" is next local midnight', () => {
    const v = new Date(parseExpiry('tomorrow'));
    const now = new Date();
    const expected = new Date(now);
    expected.setDate(expected.getDate() + 1);
    expected.setHours(0, 0, 0, 0);
    expect(v.getTime()).toBe(expected.getTime());
  });

  it('"today" is end of today (local 23:59:59.999)', () => {
    const v = new Date(parseExpiry('today'));
    const now = new Date();
    const expected = new Date(now);
    expected.setHours(23, 59, 59, 999);
    expect(v.getTime()).toBe(expected.getTime());
    // Must still be in the future (today hasn't ended yet at test time).
    expect(v.getTime()).toBeGreaterThan(now.getTime());
  });

  it('accepts week/month/year keywords', () => {
    const now = Date.now();
    expect(Date.parse(parseExpiry('week')) - now).toBeCloseTo(7 * DAY, -2);
    expect(Date.parse(parseExpiry('month')) - now).toBeCloseTo(30 * DAY, -2);
    expect(Date.parse(parseExpiry('year')) - now).toBeCloseTo(365 * DAY, -2);
  });

  it('is case- and whitespace-insensitive for keywords', () => {
    expect(parseExpiry('  Tomorrow ')).toBe(parseExpiry('tomorrow'));
    expect(parseExpiry('IN 2H')).toBe(parseExpiry('in 2h'));
  });

  it('rejects an unknown value with an actionable message', () => {
    expect(() => parseExpiry('24x')).toThrow(/invalid --expires/);
    expect(() => parseExpiry('next week')).toThrow(/invalid --expires/);
  });

  it('rejects a duration that overflows the date range (C-F7)', () => {
    // 1e20 days × 86400000 ms = 8.64e27 — a FINITE number, but new Date()
    // throws RangeError past ±8.64e15 ms. Must be rejected, not crash.
    expect(() => parseExpiry('99999999999999999999d')).toThrow(/invalid --expires/);
  });

  it('rejects an ISO datetime in the past (C-F7)', () => {
    // An expiry that is already past is meaningless — reject it instead of
    // publishing a share that is dead on arrival.
    expect(() => parseExpiry('2020-01-01T00:00:00Z')).toThrow(/in the past/);
  });
});
