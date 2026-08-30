import { readdirSync, readFileSync, existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';

/**
 * Per-image embed cap (raw bytes). Base64 inflates ~33%, so 2 MB raw → ~2.7 MB
 * in the stored data URI. Bounds worst-case row size in the parts jsonb.
 */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/**
 * Round 8: cumulative cap on the total raw image bytes embedded in ONE
 * published session. Each image is individually capped at MAX_IMAGE_BYTES, but
 * a session can carry many (Read attachments, screenshots, markdown links), so
 * the total was unbounded — a session with hundreds of 2 MB images would
 * balloon the upload past the per-request cap (or the 1 GB share cap) and bloat
 * the stored parts jsonb. Once the budget is exhausted, further images are
 * stored as tooLarge placeholders (metadata only, no src).
 */
export const MAX_SESSION_IMAGE_BYTES = 50 * 1024 * 1024;

/**
 * Round 8: the mutable cumulative image budget threaded through a session
 * load (see MAX_SESSION_IMAGE_BYTES). Each embedded image decrements it; an
 * image that would exceed the remainder is stored as a tooLarge placeholder.
 */
export interface ImageBudget {
  remaining: number;
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
};

export function isImageMime(mime: string | undefined): boolean {
  return typeof mime === 'string' && mime.startsWith('image/');
}

export function mimeFromExtension(filePath: string): string | undefined {
  const dot = filePath.lastIndexOf('.');
  if (dot === -1) return undefined;
  return IMAGE_MIME_BY_EXT[filePath.slice(dot).toLowerCase()];
}

export interface DataUri {
  dataUri: string;
  mime: string;
  bytes: number; // decoded (raw) byte length
}

/** Parse a `data:<mime>;base64,<payload>` string. Returns null if not a data URI. */
export function parseDataUri(content: string): DataUri | null {
  const m = content.match(/^data:([^;,]+)(?:;([a-z0-9-]+))?,([\s\S]*)$/i);
  if (!m) return null;
  const mime = m[1];
  const encoding = m[2];
  const payload = m[3];
  if (mime === undefined || payload === undefined) return null;
  // Round 8: only image/* payloads are images — a data URI of any other mime
  // (e.g. text/html) must not flow into an image part.
  if (!isImageMime(mime)) return null;
  if (encoding === 'base64') {
    const buf = Buffer.from(payload, 'base64');
    return { dataUri: content, mime, bytes: buf.length };
  }
  // Non-base64 (URL-encoded) data URI — treat the payload as raw bytes.
  return { dataUri: content, mime, bytes: Buffer.byteLength(payload, 'utf8') };
}

/**
 * Resolve a ZCode artifact data URI by its tool-result id.
 *
 * Artifacts live at `~/.zcode/cli/artifacts/<sessionId>/` with filenames of the
 * form `<random>-media-1-<toolResultId>.<ext>`. The random prefix is unknown, so
 * we readdir and match on the `toolResultId` suffix (verified: exactly one file
 * matches per id). Returns null if no artifact is found or it isn't a data URI.
 */
export function readArtifactDataUri(
  artifactDir: string,
  toolResultId: string,
): DataUri | null {
  if (!existsSync(artifactDir)) return null;
  let files: string[];
  try {
    files = readdirSync(artifactDir);
  } catch {
    return null;
  }
  // Match the toolResultId as the TRAILING filename component, extension
  // excluded: the id is `<random>-media-1-<toolResultId>.<ext>`, so the name
  // WITHOUT its extension must END with the id or `-<id>`. A plain substring
  // match would let one id read another attachment's data (e.g. id "abc"
  // matching "xyz987-media-1-tool-result-abc.txt").
  const stem = (f: string): string => {
    const dot = f.lastIndexOf('.');
    return dot > 0 ? f.slice(0, dot) : f;
  };
  const matches = files.filter(
    (f) => f === toolResultId || stem(f) === toolResultId || stem(f).endsWith(`-${toolResultId}`),
  );
  if (matches.length === 0) return null;
  const media = matches.find((f) => f.includes('-media-'));
  const file = media ?? matches[0];
  if (!file) return null;
  const filePath = join(artifactDir, file);
  // Refuse symlinks: an attacker-placed link could point the artifact read at an
  // arbitrary file. Real artifacts are regular files.
  let st;
  try {
    st = lstatSync(filePath);
  } catch {
    return null;
  }
  if (st.isSymbolicLink()) return null;
  // Round 5: cap the read BEFORE it happens. The old code read the whole file
  // into a string and only checked the DECODED length downstream, so a multi-GB
  // artifact file was fully materialized in memory before being rejected.
  // `st` is the lstat from above (the file is a regular file, not a symlink).
  if (st.size > MAX_IMAGE_BYTES) return null;
  // And the resolved target must stay inside the artifact dir.
  try {
    const canonical = realpathSync(filePath);
    const dirCanonical = realpathSync(artifactDir);
    if (canonical !== dirCanonical && !canonical.startsWith(dirCanonical + sep)) return null;
  } catch {
    return null;
  }
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  return parseDataUri(content);
}

/**
 * Read a file from disk and convert it to a data URI. Returns null if the file
 * is missing, not a regular file, or exceeds `maxBytes`.
 *
 * When `root` is given, the file's canonical path (symlinks resolved) must be
 * inside `root`'s canonical path — markdown image links and screenshot paths
 * come from model output and must not be able to escape the session working
 * dir to exfiltrate an arbitrary local file into the share.
 */
export function fileToDataUri(
  filePath: string,
  mime: string,
  maxBytes = MAX_IMAGE_BYTES,
  root?: string,
): DataUri | null {
  if (!existsSync(filePath)) return null;
  // Round 2: stat (FOLLOW symlinks) and reject non-regular files. A FIFO,
  // device, or a symlink to one would otherwise pass the size check (FIFO
  // size 0) and then block readFileSync indefinitely; isFile() is false for
  // those, so they're dropped. A symlink to a regular file resolves to a file,
  // so it still reads (the containment check below keeps it inside the root).
  let st;
  try {
    st = statSync(filePath);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  if (st.size > maxBytes) return null;
  // Resolve the real path once and read THAT, so the containment check and the
  // read operate on the same file (no check-then-read TOCTOU: a symlink swapped
  // in between the check and the read cannot point the read outside the root).
  let readPath = filePath;
  if (root !== undefined) {
    let canonical: string;
    let rootCanonical: string;
    try {
      canonical = realpathSync(filePath);
      rootCanonical = realpathSync(root);
    } catch {
      return null;
    }
    if (canonical !== rootCanonical && !canonical.startsWith(rootCanonical + sep)) return null;
    readPath = canonical;
  }
  let buf: Buffer;
  try {
    buf = readFileSync(readPath);
  } catch {
    return null;
  }
  return { dataUri: `data:${mime};base64,${buf.toString('base64')}`, mime, bytes: buf.length };
}
