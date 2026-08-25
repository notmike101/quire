import { describe, it, expect } from 'vitest';
import { truncateOutput } from '../src/shape.js';

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
