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
//
// Round 9 (F2): extended to also strip DEL (\u007F) and the C1 controls
// (\u0080-\u009F). Two reasons: (a) Postgres rejects NUL and C1 controls are
// storable-but-noise; (b) a control char EMBEDDED in a secret (e.g. a BEL
// between two halves of a token) breaks the plaintext rule's match during
// redaction, then gets stripped — leaving a clean, unredacted secret in the
// output. Stripping BEFORE redaction (see the `red` helper) means the rules see
// the secret contiguous. \t \n \r are deliberately preserved.
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0080-\u009F]/g;

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
//
// Round 9 (F6): a secret is not guaranteed to sit at the START of the payload —
// an attacker can prepend a few binary bytes (e.g. a PNG header fragment) and
// place the credential in the MIDDLE of the buffer. A prefix-only scan then
// stops at the first binary byte and never reaches the secret. So instead of the
// longest valid-UTF-8 PREFIX, we scan the longest maximal valid-UTF-8 RUN
// ANYWHERE in the buffer. A real image is dense binary with only short valid
// runs (isolated ASCII-ish bytes, < 8), so it is still skipped; a secret is a
// long run of clean UTF-8 text and is always found.
function longestValidUtf8Run(buf: Buffer): string | null {
  // Round 8: the Round-5 binary search assumed "prefix of length m is valid
  // UTF-8" is monotonic, but it is NOT — a valid 2-byte char (e.g. 0xC3 0xA9 =
  // é) has an INVALID length-1 prefix (a truncated lead byte 0xC3). Walk forward
  // instead: a single O(n) pass over every complete, well-formed code point,
  // tracking the longest contiguous run of valid code points.
  let bestStart = 0;
  let bestLen = 0;
  let runStart = 0;
  let i = 0;
  const endRun = (at: number): void => {
    if (at - runStart > bestLen) { bestStart = runStart; bestLen = at - runStart; }
    runStart = at + 1; // next run starts after the offending byte
  };
  while (i < buf.length) {
    const b = buf[i]!;
    let len: number;
    let min: number;
    let max: number;
    if (b < 0x80) { len = 1; min = 0x0; max = 0x7f; }
    else if (b >= 0xc2 && b <= 0xdf) { len = 2; min = 0x80; max = 0x7ff; }
    else if (b >= 0xe0 && b <= 0xef) { len = 3; min = 0x800; max = 0xffff; }
    else if (b >= 0xf0 && b <= 0xf4) { len = 4; min = 0x10000; max = 0x10ffff; }
    else { endRun(i); i += 1; continue; } // invalid lead byte (0x80–0xc1, 0xf5–0xff)
    if (i + len > buf.length) { endRun(i); break; } // truncated sequence at the end
    let cp = b & (len === 1 ? 0xff : len === 2 ? 0x1f : len === 3 ? 0x0f : 0x07);
    let ok = true;
    for (let j = 1; j < len; j++) {
      const cb = buf[i + j]!;
      if ((cb & 0xc0) !== 0x80) { ok = false; break; } // not a continuation byte
      cp = (cp << 6) | (cb & 0x3f);
    }
    if (!ok || cp < min || cp > max) { endRun(i); i += 1; continue; } // overlong / out of range
    if (cp >= 0xd800 && cp <= 0xdfff) { endRun(i); i += 1; continue; } // surrogate half (invalid UTF-8)
    i += len; // valid, extend the current run
  }
  if (buf.length - runStart > bestLen) { bestStart = runStart; bestLen = buf.length - runStart; }
  if (bestLen < 8) return null; // too short to be a meaningful secret
  return buf.subarray(bestStart, bestStart + bestLen).toString('utf8');
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
    // Round 9 (F2): strip control chars BEFORE the rules run so a control char
    // embedded in a secret cannot break the match (strip-after would leave the
    // secret clean and unredacted).
    const clean = src.replace(CONTROL_CHARS_RE, '');
    const r = redactText(clean, preset);
    if (Object.values(r.counts).some((v) => v > 0)) {
      add(r.counts);
      return r.text;
    }
    return clean;
  }
  const header = m[1];
  const payload = m[2];
  let text: string | null = null;
  if (/;base64/i.test(header)) {
    // base64 payload: decode and scan the longest valid-UTF-8 RUN anywhere in
    // the buffer (Round 9 F6: a secret can sit after a few binary bytes, so a
    // prefix-only scan would stop before reaching it; the run is control-char
    // stripped before the rules see it so an embedded control char cannot
    // break a match — F2).
    let buf: Buffer;
    try {
      buf = Buffer.from(payload, 'base64');
    } catch {
      return src.replace(CONTROL_CHARS_RE, '');
    }
    if (buf.length > 0) {
      const run = longestValidUtf8Run(buf);
      if (run !== null) text = run.replace(CONTROL_CHARS_RE, '');
    }
  } else {
    // plaintext payload (data:text/plain, etc.): scan verbatim, control chars
    // stripped first (F2: an embedded control char would otherwise break a
    // rule match, then get stripped — leaving the secret clean).
    text = payload.replace(CONTROL_CHARS_RE, '');
  }
  if (text === null) return src.replace(CONTROL_CHARS_RE, '');
  const r = redactText(text, preset);
  if (Object.values(r.counts).some((v) => v > 0)) {
    add(r.counts);
    return `data:${header},REDACTED`.replace(CONTROL_CHARS_RE, '');
  }
  return src.replace(CONTROL_CHARS_RE, '');
}

// Round 9 (F5): markdown image syntax in free text — `![alt](data:image/...)`
// or `<img src="data:...">` — carries the same data-URI payloads as image part
// `src` fields, but the plain text pass (redactText) only runs plaintext rules
// over the raw string, where a base64 payload is invisible to them (base64
// encodes `sk-` into `c2st`). Decode + scan each data-URI found in the text
// (reusing redactSrc, i.e. the same longestValidUtf8Run logic); a hit replaces
// the whole URI, a clean image passes through untouched.
const MD_IMG_URI_RE =
  /!\[[^\]]*\]\(\s*(data:[^)\s]+)\s*\)|<img\s[^>]*\bsrc\s*=\s*["']?(data:[^"'\s>]+)["']?/gi;

function redTextWithDataUris(
  s: string,
  preset: Preset,
  add: (counts: Record<string, number>) => void,
): string {
  // Round 9 (F2): strip control chars BEFORE the rules run so a control char
  // embedded in a secret cannot break a match (strip-after would leave the
  // secret clean and unredacted).
  const clean = s.replace(CONTROL_CHARS_RE, '');
  const withUris = clean.replace(MD_IMG_URI_RE, (whole, p1: string | undefined, p2: string | undefined) => {
    const uri = p1 ?? p2;
    if (!uri) return whole;
    return whole.replace(uri, redactSrc(uri, preset, add));
  });
  const r = redactText(withUris, preset);
  add(r.counts);
  return r.text;
}

function redactPart(part: ShapedPart, preset: Preset, add: (counts: Record<string, number>) => void): ShapedPart {
  // Round 9 (F5): free-text fields also carry markdown image data-URIs, so
  // they go through the data-URI-aware pass (which strips control chars
  // before the rules run — F2).
  const red = (s: string): string => redTextWithDataUris(s, preset, add);
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
  // Round 9 (F5): meta fields are free text too — a title can embed a
  // markdown image data-URI, so use the data-URI-aware pass.
  out[key] = redTextWithDataUris(field, preset, add);
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
