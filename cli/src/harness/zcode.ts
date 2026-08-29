import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { HarnessAdapter, HarnessSessionInfo, ShapedImage, ShapedMessage, ShapedPart, ShapedSession } from './types.js';
import { truncateOutput } from '../shape.js';
import { extractSystemParts, extractReasoningParts } from '../system.js';
import { readArtifactDataUri, fileToDataUri, mimeFromExtension, isImageMime, MAX_IMAGE_BYTES } from '../image.js';
import { fileURLToPath } from 'node:url';

export function zcodeDbPath(): string {
  return join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
}

/** ZCode artifact store root: `~/.zcode/cli/artifacts/<sessionId>/`. */
export function zcodeArtifactsDir(sessionId: string): string {
  return join(homedir(), '.zcode', 'cli', 'artifacts', sessionId);
}

type SessionRow = { id: string; title: string | null; time_updated: number; };
interface MessageData {
  role?: string;
  modelID?: string;
  model?: string;
  providerID?: string;
  metadata?: { visibility?: string; source?: string };
  // Present ONLY on harness-injected compaction/continuation summaries (the
  // re-injected prior-conversation context). No real user message or assistant
  // message carries it — it is the authoritative "not user input" marker for
  // this class, distinct from metadata.visibility (which these lack).
  summary?: unknown;
}
type PartRow = { message_id: string; data: string; };

interface Attachment {
  type?: string;
  mime?: string;
  filename?: string;
  url?: string;
  metadata?: { sizeBytes?: number; artifactUri?: string };
}

interface RawPart {
  type?: string;
  text?: string;
  callID?: string;
  tool?: string;
  state?: { status?: string; input?: unknown; output?: unknown; attachments?: Attachment[] };
}

/**
 * Extract images from a tool part's attachments (ZCode stores viewed images
 * as data-URI artifacts referenced by `state.attachments[]`). Returns images
 * to be attached to the tool part (rendered inside its collapsible body), or
 * [] if none.
 */
function imagesFromAttachments(raw: RawPart, artifactDir: string): ShapedImage[] {
  const attachments = raw.state?.attachments;
  if (!attachments || attachments.length === 0) return [];
  const out: ShapedImage[] = [];
  for (const att of attachments) {
    if (att.type !== 'file' || !isImageMime(att.mime)) continue;
    if (!att.url) continue;
    const toolResultId = att.url.split('/').pop();
    if (!toolResultId) continue;
    const uri = readArtifactDataUri(artifactDir, toolResultId);
    const alt = att.filename && att.filename !== 'Read image' ? att.filename : 'Read image';
    if (!uri) {
      out.push({ mime: att.mime, alt, bytes: att.metadata?.sizeBytes, tooLarge: true });
      continue;
    }
    if (uri.bytes > MAX_IMAGE_BYTES) {
      out.push({ mime: uri.mime, alt, bytes: uri.bytes, tooLarge: true });
    } else {
      out.push({ src: uri.dataUri, mime: uri.mime, alt, bytes: uri.bytes });
    }
  }
  return out;
}

/**
 * Best-effort: resolve a screenshot tool call's on-disk file (input.filename
 * relative to the session working dir) to an image. Returns [] if the file
 * is gone or not an image — the markdown link in the tool output still renders.
 */
function imageFromScreenshotFile(raw: RawPart, workDir: string | undefined): ShapedImage[] {
  if (!workDir) return [];
  const input = raw.state?.input as { filename?: string } | undefined;
  const filename = input?.filename;
  if (!filename) return [];
  const mime = mimeFromExtension(filename);
  if (!mime) return [];
  const filePath = join(workDir, filename);
  const uri = fileToDataUri(filePath, mime, MAX_IMAGE_BYTES, workDir);
  if (!uri) return [];
  if (uri.bytes > MAX_IMAGE_BYTES) {
    return [{ mime: uri.mime, alt: filename, bytes: uri.bytes, tooLarge: true }];
  }
  return [{ src: uri.dataUri, mime: uri.mime, alt: filename, bytes: uri.bytes }];
}

function isScreenshotTool(tool: string | undefined): boolean {
  return typeof tool === 'string' && /take_screenshot/i.test(tool);
}

/**
 * A markdown image link: `![alt](target)`. Captures [1]=alt, [2]=target. The
 * target is matched loosely (anything up to the closing paren, no whitespace or
 * nested parens); `markdownImagePart` then validates it is a local image file
 * (file:// URL, Windows drive path, or a path with an image extension) and
 * returns null for anything else (e.g. a remote https URL), leaving the link
 * untouched.
 */
const MD_IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;

/**
 * Resolve a markdown image link's local file to an image part. Returns null if
 * the target is not a local image file (e.g. a remote https URL), the file is
 * missing, or it exceeds the embed cap (the link is then left in the text and
 * redacted on the server).
 */
function markdownImagePart(alt: string, target: string, workDir: string | undefined): ShapedPart | null {
  // Only local files are embeddable: file:// URLs, Windows drive paths
  // (C:\…), or bare relative/POSIX paths. Remote URLs (http/https) are left
  // alone — they render as ordinary markdown links.
  const isLocal =
    target.startsWith('file://') ||
    /^[A-Za-z]:[\\/]/.test(target) ||
    !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target); // no scheme → bare path
  if (!isLocal) return null;
  let filePath: string;
  try {
    if (target.startsWith('file://')) filePath = fileURLToPath(target);
    else if (isAbsolute(target)) filePath = target;
    else filePath = workDir ? join(workDir, target) : target;
  } catch {
    return null;
  }
  const mime = mimeFromExtension(filePath);
  if (!mime) return null;
  // Contain the read under the session working dir: a model-emitted link must
  // not be able to point at an arbitrary local file and exfiltrate it.
  const uri = fileToDataUri(filePath, mime, MAX_IMAGE_BYTES, workDir);
  if (!uri) return null;
  if (uri.bytes > MAX_IMAGE_BYTES) {
    return { type: 'image', mime: uri.mime, alt: alt || filePath, bytes: uri.bytes, tooLarge: true };
  }
  return { type: 'image', src: uri.dataUri, mime: uri.mime, alt: alt || filePath, bytes: uri.bytes };
}

/**
 * Embed markdown image links (`![alt](file:///…)`) in a text part as `image`
 * parts. Each link is replaced by a short placeholder in the text and an image
 * part is emitted immediately after it, so the transcript shows the actual image
 * instead of a redacted `file:///…` path. Links whose file is gone or too large
 * are left untouched (they get redacted server-side as before).
 */
function embedMarkdownImages(text: string, workDir: string | undefined): { text: string; images: ShapedPart[] } {
  const images: ShapedPart[] = [];
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  MD_IMAGE_RE.lastIndex = 0;
  while ((m = MD_IMAGE_RE.exec(text)) !== null) {
    const part = markdownImagePart(m[1] ?? '', m[2] ?? '', workDir);
    if (!part) continue; // not a local image file — leave the link in place
    out += text.slice(last, m.index) + `![${m[1] ?? ''}]`;
    images.push(part);
    last = m.index + m[0].length;
  }
  out += text.slice(last);
  return { text: out, images };
}


function partToShaped(raw: RawPart, artifactDir: string, workDir: string | undefined): ShapedPart[] {
  switch (raw.type) {
    case 'text': {
      if (typeof raw.text !== 'string') return [];
      // Embed local markdown image links as image parts (the agent's "here's the
      // screenshot" messages reference on-disk files via ![alt](file:///…)).
      const { text, images } = embedMarkdownImages(raw.text, workDir);
      return [{ type: 'text', text }, ...images];
    }
    case 'reasoning':
      return typeof raw.text === 'string' ? [{ type: 'reasoning', text: raw.text }] : [];
    case 'tool': {
      const output = typeof raw.state?.output === 'string' ? truncateOutput(raw.state.output) : undefined;
      // Images the agent viewed: from Read attachments (data-URI artifacts) and,
      // best-effort, from screenshot tool calls' on-disk files. Attached to the
      // tool part so the viewer renders them inside its collapsible body.
      const images: ShapedImage[] = [...imagesFromAttachments(raw, artifactDir)];
      if (isScreenshotTool(raw.tool)) {
        images.push(...imageFromScreenshotFile(raw, workDir));
      }
      const toolPart: ShapedPart = {
        type: 'tool',
        callID: raw.callID,
        tool: raw.tool,
        status: raw.state?.status,
        input: raw.state?.input,
        output,
      };
      if (images.length > 0) toolPart.images = images;
      return [toolPart];
    }
    default:
      return []; // step-start, step-finish, compaction
  }
}

export function makeZcodeAdapter(dbPath: string = zcodeDbPath(), workDirOverride?: string): HarnessAdapter {
  const open = (): DatabaseSync => new DatabaseSync(dbPath, { readOnly: true });

  return {
    name: 'zcode',

    async listSessions(): Promise<HarnessSessionInfo[]> {
      const db = open();
      try {
        const rows = db
          .prepare(
            `select id, title, time_updated from session
             where coalesce(task_type, 'interactive') != 'subagent_child'
             order by time_updated desc limit 50`,
          )
          .all() as SessionRow[];
        return rows.map((r) => ({
          id: r.id,
          title: r.title ?? r.id,
          updatedAt: new Date(r.time_updated).toISOString(),
          isSubagent: false,
        }));
      } finally {
        db.close();
      }
    },

    async resolveCurrent(): Promise<HarnessSessionInfo> {
      const all = await this.listSessions();
      if (all.length === 0) throw new Error('no ZCode sessions found');
      return all[0]!;
    },

    async loadSession(id: string): Promise<ShapedSession> {
      const db = open();
      try {
        const sess = db.prepare('select id, title, directory from session where id = ?').get(id) as
          | { id: string; title: string | null; directory: string | null }
          | undefined;
        if (!sess) throw new Error(`ZCode session not found: ${id}`);
        const artifactDir = zcodeArtifactsDir(id);
        const workDir = workDirOverride ?? sess.directory ?? undefined;
        const rows = db
          .prepare('select id, data from message where session_id = ? order by sequence')
          .all(id) as { id: string; data: string }[];
        const messages = rows.map((r) => ({ id: r.id, data: JSON.parse(r.data) as MessageData }));
        const parts = db
          .prepare('select message_id, data from part where session_id = ? order by sequence')
          .all(id) as PartRow[];
        const byMessage = new Map<string, ShapedPart[]>();
        for (const p of parts) {
          const shaped = partToShaped(JSON.parse(p.data) as RawPart, artifactDir, workDir);
          if (shaped.length === 0) continue;
          const list = byMessage.get(p.message_id) ?? [];
          for (const s of shaped) list.push(s);
          byMessage.set(p.message_id, list);
        }
        const out: ShapedMessage[] = [];
        for (const m of messages) {
          const role = m.data.role;
          if (role !== 'user' && role !== 'assistant') continue;
          // The harness injects context the model sees but the user never typed
          // (todo nudges, re-injected tool results, goal/plan notes) as user
          // messages marked visibility: "model-only". Drop them — they are not
          // part of the conversation the user actually had.
          if (m.data.metadata?.visibility === 'model-only') continue;
          // On context compaction the harness re-injects the prior conversation as
          // a USER message tagged with a top-level `summary` field. Unlike
          // model-only context it carries NO visibility/synthetic marker, so the
          // check above misses it and it would render as a giant fake user bubble.
          // The `summary` field is exclusive to these (verified across the full
          // DB: 494/494 continuation summaries, 0 real user or assistant msgs) —
          // a structural signal, not a text match. Drop it.
          if (role === 'user' && m.data.summary !== undefined) continue;
          const kept = byMessage.get(m.id) ?? [];
          if (kept.length === 0) continue;
          out.push({ role, parts: extractReasoningParts(extractSystemParts(kept)) });
        }
        return {
          sessionId: id,
          title: sess.title ?? id,
          model: messages.find((m) => m.data.modelID !== undefined)?.data.modelID
            ?? messages.find((m) => m.data.model !== undefined)?.data.model
            ?? undefined,
          provider: messages.find((m) => m.data.providerID !== undefined)?.data.providerID ?? undefined,
          messages: out,
        };
      } finally {
        db.close();
      }
    },
  };
}
