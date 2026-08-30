import { redactText, walkStrings } from './redact.js';
import { rules, type Preset } from './rules.js';

export interface ShapedImage {
  src?: string; // data: URI — NOT redacted (it's the image, not a secret)
  mime?: string;
  alt?: string;
  bytes?: number;
  tooLarge?: boolean;
}

export interface ShapedPart {
  type: 'text' | 'tool' | 'reasoning' | 'system' | 'image';
  text?: string;
  callID?: string;
  tool?: string;
  status?: string;
  input?: unknown;
  output?: string;
  // tool parts: images the agent viewed, rendered inside the tool card's
  // collapsible body (Read attachments, screenshot tool output, etc.).
  images?: ShapedImage[];
  // standalone image parts (type: 'image'): the agent's deliberate markdown
  // screenshots in text parts — rendered expanded, outside any tool card.
  src?: string;
  mime?: string;
  alt?: string;
  bytes?: number;
  tooLarge?: boolean;
}

export interface ShapedMessage {
  role: 'user' | 'assistant';
  time?: string;
  parts: ShapedPart[];
}

// Session-level free text (title/model/provider) is served to every viewer via
// the public meta and is NOT walked by the per-part redaction pass, so it is
// redacted explicitly in prepareContent (Round 3).
export interface ShapedSession {
  sessionId: string;
  title: string;
  model?: string;
  provider?: string;
  messages: ShapedMessage[];
}

export interface PreparedContent {
  messages: ShapedMessage[];
  summary: Record<string, number>;
  bytes: number;
  messageCount: number;
}

// Postgres rejects NUL (\u0000) in text/jsonb columns, and other C0 control
// characters (except the common \n \r \t) are noise that can come from binary-ish
// tool output. Strip them in the authoritative pass so the persisted content is
// always storable. This is storage-safety, not redaction, so it applies to every
// preset (including 'none').
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

// Round 2: the image `src` data-URI can hide a secret in its payload (a
// "screenshot" whose bytes encode a credential). Round 3: we DECODE the base64
// payload and scan the DECODED bytes — scanning the base64 text is a no-op for
// base64 payloads (base64 encodes `sk-` into `c2st`, so no plaintext rule can
// match), which left every base64-embedded secret stored raw. Decoding means
// the rules see the secret in the clear.
//
// Over-redaction guard: a real image decodes to dense binary that is NOT
// valid UTF-8, so we only scan payloads that decode to valid UTF-8 (a secret
// embedded in an image is ASCII/UTF-8 text, which decodes cleanly). Binary
// image payloads are skipped — the rules are plaintext regexes and would
// false-positive on random bytes. A plaintext data-URI (data:text/plain) or a
// base64 payload that decodes to text is scanned with the FULL rule set.
// A hit replaces the whole payload (we cannot partially redact a data-URI
// without corrupting it). Non-data-URI srcs (same-origin /assets/ paths) pass
// through untouched.
// Round 5: find the longest prefix of buf that is valid UTF-8. A real image
// decodes to dense binary (no valid-UTF-8 prefix of any meaningful length), but
// a secret embedded at the START of the payload followed by a few non-UTF-8
// bytes (the old exploit) has a long valid-UTF-8 prefix. We scan that prefix.
// A prefix shorter than 8 bytes is treated as binary (noise, not a secret).
function longestValidUtf8Prefix(buf: Buffer): string | null {
  // Round 8: the Round-5 binary search assumed "prefix of length m is valid
  // UTF-8" is monotonic, but it is NOT — a valid 2-byte char (e.g. 0xC3 0xA9 =
  // é) has an INVALID length-1 prefix (a truncated lead byte 0xC3). The search
  // therefore converged early on a crafted payload (a multi-byte char placed at
  // the first probe position) and UNDER-scanned, leaving a secret after it
  // unscanned. Walk forward instead: a single O(n) pass that includes every
  // complete, well-formed code point up to the first invalid byte. A secret is
  // ASCII/UTF-8 text, so it always sits inside the longest valid prefix and is
  // always scanned.
  let i = 0;
  let end = 0; // end (exclusive) of the last complete, well-formed code point
  while (i < buf.length) {
    const b = buf[i]!;
    let len: number;
    let min: number;
    let max: number;
    if (b < 0x80) { len = 1; min = 0x0; max = 0x7f; }
    else if (b >= 0xc2 && b <= 0xdf) { len = 2; min = 0x80; max = 0x7ff; }
    else if (b >= 0xe0 && b <= 0xef) { len = 3; min = 0x800; max = 0xffff; }
    else if (b >= 0xf0 && b <= 0xf4) { len = 4; min = 0x10000; max = 0x10ffff; }
    else break; // invalid lead byte (0x80–0xc1, 0xf5–0xff)
    if (i + len > buf.length) break; // truncated sequence at the end
    let cp = b & (len === 1 ? 0xff : len === 2 ? 0x1f : len === 3 ? 0x0f : 0x07);
    let ok = true;
    for (let j = 1; j < len; j++) {
      const cb = buf[i + j]!;
      if ((cb & 0xc0) !== 0x80) { ok = false; break; } // not a continuation byte
      cp = (cp << 6) | (cb & 0x3f);
    }
    if (!ok || cp < min || cp > max) break; // overlong / out of range
    if (cp >= 0xd800 && cp <= 0xdfff) break; // surrogate half (invalid UTF-8)
    i += len;
    end = i;
  }
  if (end < 8) return null; // too short to be a meaningful secret
  return buf.subarray(0, end).toString('utf8');
}
function redactSrc(src: string, preset: Preset, add: (counts: Record<string, number>) => void): string {
  const m = /^data:([^,]*),(.+)$/.exec(src);
  if (!m || !m[1] || !m[2]) {
    // Round 4: a NON-data-URI src is a free URL — the API accepts any string up
    // to 4 MB, so it can be a connection string (postgres://user:pass@host), a
    // URL with a query-string token (?api_key=…), a JWT in the path, etc. The
    // old code returned it untouched, a complete redaction bypass. Run the full
    // rule set over the whole URL so embedded credentials are redacted; a clean
    // same-origin /assets/ path or ordinary URL is unchanged.
    const r = redactText(src, preset);
    if (Object.values(r.counts).some((v) => v > 0)) {
      add(r.counts);
      return r.text.replace(CONTROL_CHARS_RE, '');
    }
    return src.replace(CONTROL_CHARS_RE, '');
  }
  const header = m[1];
  const payload = m[2];
  let text: string | null = null;
  if (/;base64/i.test(header)) {
    // base64 payload: decode and scan the longest valid-UTF-8 prefix (Round 5:
    // the old code required the WHOLE payload to be valid UTF-8, so a secret
    // followed by even one non-UTF-8 byte disabled the scan entirely).
    let buf: Buffer;
    try {
      buf = Buffer.from(payload, 'base64');
    } catch {
      return src.replace(CONTROL_CHARS_RE, '');
    }
    if (buf.length > 0) text = longestValidUtf8Prefix(buf);
  } else {
    // plaintext payload (data:text/plain, etc.): scan verbatim.
    text = payload;
  }
  if (text === null) return src.replace(CONTROL_CHARS_RE, '');
  const r = redactText(text, preset);
  if (Object.values(r.counts).some((v) => v > 0)) {
    add(r.counts);
    return `data:${header},REDACTED`.replace(CONTROL_CHARS_RE, '');
  }
  return src.replace(CONTROL_CHARS_RE, '');
}

function redactPart(part: ShapedPart, preset: Preset, add: (counts: Record<string, number>) => void): ShapedPart {
  const red = (s: string): string => {
    const r = redactText(s, preset);
    add(r.counts);
    return r.text.replace(CONTROL_CHARS_RE, '');
  };
  const out: ShapedPart = { ...part };
  if (part.text !== undefined) out.text = red(part.text);
  if (part.output !== undefined) out.output = red(part.output);
  if (part.input !== undefined) out.input = walkStrings(part.input, red);
  // Round 2: callID / tool / status are free strings served publicly — a tool
  // name or call ID can embed a secret, so they are redacted like the others.
  if (part.callID !== undefined) out.callID = red(part.callID);
  if (part.tool !== undefined) out.tool = red(part.tool);
  if (part.status !== undefined) out.status = red(part.status);
  // Image metadata (alt text, mime) is free text the model wrote — a filename
  // like `~/.aws/credentials` or a path in alt text is a leak. `src` is the
  // image payload: its base64 is scanned for secrets (redactSrc) but a clean
  // payload passes through untouched.
  if (part.alt !== undefined) out.alt = red(part.alt);
  if (part.mime !== undefined) out.mime = red(part.mime);
  if (part.src !== undefined) out.src = redactSrc(part.src, preset, add);
  if (part.images !== undefined) {
    out.images = part.images.map((img) => ({
      ...img,
      ...(img.alt !== undefined ? { alt: red(img.alt) } : {}),
      ...(img.mime !== undefined ? { mime: red(img.mime) } : {}),
      ...(img.src !== undefined ? { src: redactSrc(img.src, preset, add) } : {}),
    }));
  }
  return out;
}

/** Redact a session-level free-text field (title/model/provider) into `out`. */
function redactMetaField(
  field: string | undefined,
  preset: Preset,
  add: (counts: Record<string, number>) => void,
  out: Record<string, unknown>,
  key: string,
): void {
  if (field === undefined) return;
  const r = redactText(field, preset);
  if (Object.values(r.counts).some((v) => v > 0)) add(r.counts);
  out[key] = r.text.replace(CONTROL_CHARS_RE, '');
}

/**
 * The single authoritative redaction pass. Only the result of this function is
 * persisted. Accepts the full shaped session so that session-level free text
 * (title/model/provider) — which the per-part pass never walks — is redacted
 * too (Round 3). Returns the redacted messages plus the redacted meta fields.
 *
 * Round 7 (INFO-5, conscious decision to document rather than refactor): this
 * pass is SYNCHRONOUS — it runs the full rule set over every string on the
 * event loop, with no await. That means a single large publish blocks the
 * event loop for the duration of the redaction. This is acceptable and is
 * deliberately NOT moved to worker_threads because:
 *   (a) it is OWNER-ONLY — every caller (create/chunk/preview) is behind the
 *       Bearer API key, so an unauthenticated attacker cannot trigger it;
 *   (b) it is BOUNDED — the body is capped at 20 MB per request (bodyLimit),
 *       so the worst case is a bounded number of regex passes over a bounded
 *       byte budget (a few seconds of event-loop latency, not unbounded);
 *   (c) the rules are linear-time (Round 5 fixed the ReDoS), so the cost scales
 *       with input size, not combinatorially.
 * The shipped compose stack has no fronting proxy, so the event loop is the
 * only thing serving concurrent requests; a multi-second stall would briefly
 * delay other in-flight requests. That is a low-severity, owner-only, bounded
 * latency issue — a worker_threads pool would add unbounded worker memory and
 * cross-thread marshalling of the (potentially multi-MB) session for a
 * disproportionate risk/complexity cost. Revisit only if the request cap or the
 * rule set grows enough that a single publish measurably stalls the loop.
 */
export function prepareContent(session: ShapedSession, preset: Preset): PreparedContent & { title: string; model?: string; provider?: string } {
  const summary: Record<string, number> = {};
  const add = (counts: Record<string, number>): void => {
    for (const [k, v] of Object.entries(counts)) summary[k] = (summary[k] ?? 0) + v;
  };
  const redacted = session.messages.map((m) => ({ ...m, parts: m.parts.map((p) => redactPart(p, preset, add)) }));
  const meta: Record<string, unknown> = { title: session.title };
  redactMetaField(session.title, preset, add, meta, 'title');
  redactMetaField(session.model, preset, add, meta, 'model');
  redactMetaField(session.provider, preset, add, meta, 'provider');
  return {
    messages: redacted,
    summary,
    bytes: Buffer.byteLength(JSON.stringify(redacted)),
    messageCount: redacted.length,
    title: meta.title as string,
    ...(meta.model !== undefined ? { model: meta.model as string } : {}),
    ...(meta.provider !== undefined ? { provider: meta.provider as string } : {}),
  };
}
