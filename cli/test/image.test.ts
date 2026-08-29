import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
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

describe('fileToDataUri containment (Chain A)', () => {
  let root: string;
  let outside: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'quire-a-'));
    outside = mkdtempSync(join(tmpdir(), 'quire-a-out-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('reads a file inside the root', () => {
    const p = join(root, 'ok.png');
    writeFileSync(p, Buffer.from(PNG_1X1, 'base64'));
    const uri = fileToDataUri(p, 'image/png', MAX_IMAGE_BYTES, root);
    expect(uri).not.toBeNull();
    expect(uri!.dataUri).toBe(`data:image/png;base64,${PNG_1X1}`);
  });

  it('refuses a path that escapes the root via ../', () => {
    const p = join(root, '..', 'escape.png');
    expect(fileToDataUri(p, 'image/png', MAX_IMAGE_BYTES, root)).toBeNull();
  });

  it('refuses an absolute path outside the root', () => {
    const p = join(outside, 'secret.png');
    writeFileSync(p, Buffer.from(PNG_1X1, 'base64'));
    expect(fileToDataUri(p, 'image/png', MAX_IMAGE_BYTES, root)).toBeNull();
  });

  it('refuses a symlink pointing outside the root', () => {
    const target = join(outside, 'real.png');
    writeFileSync(target, Buffer.from(PNG_1X1, 'base64'));
    const link = join(root, 'link.png');
    symlinkSync(target, link);
    expect(fileToDataUri(link, 'image/png', MAX_IMAGE_BYTES, root)).toBeNull();
  });

  it('still reads a symlink whose target is INSIDE the root', () => {
    const target = join(root, 'real.png');
    writeFileSync(target, Buffer.from(PNG_1X1, 'base64'));
    const link = join(root, 'link.png');
    symlinkSync(target, link);
    expect(fileToDataUri(link, 'image/png', MAX_IMAGE_BYTES, root)).not.toBeNull();
  });

  it('ignores root when undefined (no containment)', () => {
    const p = join(outside, 'secret.png');
    writeFileSync(p, Buffer.from(PNG_1X1, 'base64'));
    expect(fileToDataUri(p, 'image/png', MAX_IMAGE_BYTES)).not.toBeNull();
  });
});

describe('readArtifactDataUri component match (Chain A)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'quire-art-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('matches the id as a full filename component, not a substring', () => {
    // toolResultId "abc123" must NOT match "x-abc1234-media-1-zzz.png" (substring only).
    writeFileSync(join(dir, 'x-abc1234-media-1-zzz.png'), `data:image/png;base64,${PNG_1X1}`);
    expect(readArtifactDataUri(dir, 'abc123')).toBeNull();
  });

  it('matches a full component (the stem)', () => {
    writeFileSync(join(dir, 'r-media-1-abc123.png'), `data:image/png;base64,${PNG_1X1}`);
    expect(readArtifactDataUri(dir, 'abc123')).not.toBeNull();
  });
});
