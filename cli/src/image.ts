import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Per-image embed cap (raw bytes). Base64 inflates ~33%, so 2 MB raw → ~2.7 MB
 * in the stored data URI. Bounds worst-case row size in the parts jsonb.
 */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

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
  // Match files whose name contains the toolResultId. Prefer the `-media-`
  // variant (image attachments); fall back to any match.
  const matches = files.filter((f) => f.includes(toolResultId));
  if (matches.length === 0) return null;
  const media = matches.find((f) => f.includes('-media-'));
  const file = media ?? matches[0];
  if (!file) return null;
  let content: string;
  try {
    content = readFileSync(join(artifactDir, file), 'utf8');
  } catch {
    return null;
  }
  return parseDataUri(content);
}

/**
 * Read a file from disk and convert it to a data URI. Returns null if the file
 * is missing, not a regular file, or exceeds `maxBytes`.
 */
export function fileToDataUri(filePath: string, mime: string, maxBytes = MAX_IMAGE_BYTES): DataUri | null {
  if (!existsSync(filePath)) return null;
  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    return null;
  }
  if (size > maxBytes) return null;
  let buf: Buffer;
  try {
    buf = readFileSync(filePath);
  } catch {
    return null;
  }
  return { dataUri: `data:${mime};base64,${buf.toString('base64')}`, mime, bytes: buf.length };
}
