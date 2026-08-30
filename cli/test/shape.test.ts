import { describe, it, expect } from 'vitest';
import { truncateOutput, truncateInput, truncatePartText, stripControlChars } from '../src/shape.js';

describe('truncateOutput', () => {
  it('passes through short output unchanged', () => {
    expect(truncateOutput('short')).toBe('short');
    expect(truncateOutput(undefined)).toBeUndefined();
  });
  it('truncates at 20 KB and says so', () => {
    const out = truncateOutput('y'.repeat(30_000))!;
    expect(out).toContain('[truncated');
    expect(Buffer.byteLength(out)).toBeLessThan(20_510);
    expect(out.startsWith('y'.repeat(20 * 1024))).toBe(true);
  });
});

describe('truncateInput', () => {
  it('passes through small input unchanged (same reference)', () => {
    const small = { command: 'ls' };
    expect(truncateInput(small)).toBe(small);
    expect(truncateInput('short')).toBe('short');
    expect(truncateInput(undefined)).toBeUndefined();
    expect(truncateInput(null)).toBeNull();
  });
  it('replaces an over-cap input with a small marker object (Round 8)', () => {
    // A Write/Edit call carries the whole file body — an uncapped input bloats
    // the share the same way an uncapped output did.
    const input = { content: 'z'.repeat(30_000) };
    const out = truncateInput(input) as { __truncated?: boolean; originalBytes?: number; preview?: string };
    expect(out.__truncated).toBe(true);
    const s = JSON.stringify(input)!;
    expect(out.originalBytes).toBe(Buffer.byteLength(s));
    // The preview is the first 20 KB of the JSON (the interesting keys lead).
    expect(out.preview).toBe(Buffer.from(s).subarray(0, 20 * 1024).toString('utf8'));
    expect(Buffer.byteLength(out.preview!)).toBe(20 * 1024);
    // The marker itself is small — the whole point is to shrink the share.
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThan(21_000);
  });
  it('keeps an input whose serialization throws as-is (Round 8)', () => {
    // JSON.stringify can throw — a throwing toJSON (or a RangeError on some
    // engines for pathologically deep structures). The cap must not crash the
    // publish; the input is kept as-is (the server's iterative walkStrings
    // still redacts it).
    const evil: unknown = { toJSON: () => { throw new Error('boom'); } };
    expect(() => JSON.stringify(evil)).toThrow();
    expect(truncateInput(evil)).toBe(evil);
  });
});

describe('truncatePartText (Round 9 C-F4)', () => {
  it('passes a short part through unchanged (same reference)', () => {
    const s = 'short';
    expect(truncatePartText(s)).toBe(s);
  });
  it('caps a >256 KB text part and says so', () => {
    const out = truncatePartText('y'.repeat(300 * 1024));
    expect(out).toContain('[truncated');
    expect(Buffer.byteLength(out)).toBeLessThan(256 * 1024 + 128);
    expect(out.startsWith('y'.repeat(256 * 1024))).toBe(true);
  });
});

describe('stripControlChars (Round 9 C-F10)', () => {
  it('removes control characters (ANSI escapes, NUL, newlines)', () => {
    expect(stripControlChars('A\x00B\x1b[31mC\x07D\nE\tF')).toBe('AB[31mCDEF');
  });
  it('leaves plain text unchanged', () => {
    expect(stripControlChars('plain')).toBe('plain');
  });
});
