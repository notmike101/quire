import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HarnessAdapter, HarnessSessionInfo, ShapedMessage, ShapedPart, ShapedSession } from './types.js';
import { truncateOutput } from '../shape.js';
import { extractSystemParts, extractReasoningParts } from '../system.js';
import { readArtifactDataUri, fileToDataUri, mimeFromExtension, isImageMime, MAX_IMAGE_BYTES } from '../image.js';

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
 * Extract image parts from a tool part's attachments (ZCode stores viewed images
 * as data-URI artifacts referenced by `state.attachments[]`). Returns image parts
 * to be emitted immediately after the tool part, or [] if none.
 */
function imagePartsFromAttachments(raw: RawPart, artifactDir: string): ShapedPart[] {
  const attachments = raw.state?.attachments;
  if (!attachments || attachments.length === 0) return [];
  const out: ShapedPart[] = [];
  for (const att of attachments) {
    if (att.type !== 'file' || !isImageMime(att.mime)) continue;
    if (!att.url) continue;
    const toolResultId = att.url.split('/').pop();
    if (!toolResultId) continue;
    const uri = readArtifactDataUri(artifactDir, toolResultId);
    const alt = att.filename && att.filename !== 'Read image' ? att.filename : 'Read image';
    if (!uri) {
      // Artifact missing (e.g. cleaned up) — emit a placeholder so the transcript
      // still shows an image was viewed here.
      out.push({ type: 'image', mime: att.mime, alt, bytes: att.metadata?.sizeBytes, tooLarge: true });
      continue;
    }
    if (uri.bytes > MAX_IMAGE_BYTES) {
      out.push({ type: 'image', mime: uri.mime, alt, bytes: uri.bytes, tooLarge: true });
    } else {
      out.push({ type: 'image', src: uri.dataUri, mime: uri.mime, alt, bytes: uri.bytes });
    }
  }
  return out;
}

/**
 * Best-effort: resolve a screenshot tool call's on-disk file (input.filename
 * relative to the session working dir) to an image part. Returns [] if the file
 * is gone or not an image — the markdown link in the tool output still renders.
 */
function imagePartFromScreenshotFile(raw: RawPart, workDir: string | undefined): ShapedPart[] {
  if (!workDir) return [];
  const input = raw.state?.input as { filename?: string } | undefined;
  const filename = input?.filename;
  if (!filename) return [];
  const mime = mimeFromExtension(filename);
  if (!mime) return [];
  const filePath = join(workDir, filename);
  const uri = fileToDataUri(filePath, mime);
  if (!uri) return [];
  if (uri.bytes > MAX_IMAGE_BYTES) {
    return [{ type: 'image', mime: uri.mime, alt: filename, bytes: uri.bytes, tooLarge: true }];
  }
  return [{ type: 'image', src: uri.dataUri, mime: uri.mime, alt: filename, bytes: uri.bytes }];
}

function isScreenshotTool(tool: string | undefined): boolean {
  return typeof tool === 'string' && /take_screenshot/i.test(tool);
}


function partToShaped(raw: RawPart, artifactDir: string, workDir: string | undefined): ShapedPart[] {
  switch (raw.type) {
    case 'text':
      return typeof raw.text === 'string' ? [{ type: 'text', text: raw.text }] : [];
    case 'reasoning':
      return typeof raw.text === 'string' ? [{ type: 'reasoning', text: raw.text }] : [];
    case 'tool': {
      const output = typeof raw.state?.output === 'string' ? truncateOutput(raw.state.output) : undefined;
      const parts: ShapedPart[] = [
        {
          type: 'tool',
          callID: raw.callID,
          tool: raw.tool,
          status: raw.state?.status,
          input: raw.state?.input,
          output,
        },
      ];
      // Images the agent viewed: from Read attachments (data-URI artifacts) and,
      // best-effort, from screenshot tool calls' on-disk files.
      parts.push(...imagePartsFromAttachments(raw, artifactDir));
      if (isScreenshotTool(raw.tool)) {
        parts.push(...imagePartFromScreenshotFile(raw, workDir));
      }
      return parts;
    }
    default:
      return []; // step-start, step-finish, compaction
  }
}

export function makeZcodeAdapter(dbPath: string = zcodeDbPath()): HarnessAdapter {
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
        const workDir = sess.directory ?? undefined;
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
