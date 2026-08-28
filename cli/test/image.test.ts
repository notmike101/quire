import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isImageMime,
  mimeFromExtension,
  parseDataUri,
  readArtifactDataUri,
  fileToDataUri,
  MAX_IMAGE_BYTES,
} from '../src/image.js';

// A 1×1 red PNG, base64. Small enough to be byte-stable in tests.
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==';
const PNG_1X1_BYTES = Buffer.byteLength(PNG_1X1, 'base64');

describe('isImageMime', () => {
  it('accepts image/* mimes, rejects others', () => {
    expect(isImageMime('image/png')).toBe(true);
    expect(isImageMime('image/jpeg')).toBe(true);
    expect(isImageMime('image/svg+xml')).toBe(true);
    expect(isImageMime('text/plain')).toBe(false);
    expect(isImageMime('application/json')).toBe(false);
    expect(isImageMime(undefined)).toBe(false);
  });
});

describe('mimeFromExtension', () => {
  it('maps known image extensions', () => {
    expect(mimeFromExtension('a.png')).toBe('image/png');
    expect(mimeFromExtension('a.JPG')).toBe('image/jpeg');
    expect(mimeFromExtension('a.webp')).toBe('image/webp');
    expect(mimeFromExtension('a.svg')).toBe('image/svg+xml');
  });
  it('returns undefined for non-image or extensionless', () => {
    expect(mimeFromExtension('a.txt')).toBeUndefined();
    expect(mimeFromExtension('a')).toBeUndefined();
  });
});

describe('parseDataUri', () => {
  it('parses a base64 data URI', () => {
    const uri = `data:image/png;base64,${PNG_1X1}`;
    const r = parseDataUri(uri);
    expect(r).not.toBeNull();
    expect(r!.mime).toBe('image/png');
    expect(r!.bytes).toBe(PNG_1X1_BYTES);
    expect(r!.dataUri).toBe(uri);
  });
  it('returns null for non-data-URI content', () => {
    expect(parseDataUri('hello world')).toBeNull();
    expect(parseDataUri('')).toBeNull();
  });
});

describe('readArtifactDataUri', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'quire-artifacts-'));
    // Simulate the ZCode artifact store: <random>-media-1-<toolResultId>.txt
    const toolResultId = 'tool-result-abc123';
    writeFileSync(
      join(dir, `xyz987-media-1-${toolResultId}.txt`),
      `data:image/png;base64,${PNG_1X1}`,
    );
    // A non-media artifact with the same id suffix (should be deprioritized).
    writeFileSync(join(dir, `abc123-tool-result-abc123.json`), '{"not":"an image"}');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('resolves a media artifact by toolResultId suffix', () => {
    const r = readArtifactDataUri(dir, 'tool-result-abc123');
    expect(r).not.toBeNull();
    expect(r!.mime).toBe('image/png');
    expect(r!.bytes).toBe(PNG_1X1_BYTES);
  });
  it('returns null when no artifact matches', () => {
    expect(readArtifactDataUri(dir, 'tool-result-missing')).toBeNull();
  });
  it('returns null for a missing dir', () => {
    expect(readArtifactDataUri(join(dir, 'nope'), 'tool-result-abc123')).toBeNull();
  });
});

describe('fileToDataUri', () => {
  let dir: string;
  let pngPath: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'quire-imgfile-'));
    pngPath = join(dir, 'test.png');
    writeFileSync(pngPath, Buffer.from(PNG_1X1, 'base64'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads a file and returns a data URI', () => {
    const r = fileToDataUri(pngPath, 'image/png');
    expect(r).not.toBeNull();
    expect(r!.dataUri).toBe(`data:image/png;base64,${PNG_1X1}`);
    expect(r!.bytes).toBe(PNG_1X1_BYTES);
  });
  it('returns null for a missing file', () => {
    expect(fileToDataUri(join(dir, 'missing.png'), 'image/png')).toBeNull();
  });
  it('returns null when the file exceeds the cap', () => {
    const bigPath = join(dir, 'big.png');
    writeFileSync(bigPath, Buffer.alloc(MAX_IMAGE_BYTES + 1, 0));
    expect(fileToDataUri(bigPath, 'image/png')).toBeNull();
  });
});
