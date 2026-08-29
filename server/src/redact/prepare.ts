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

// Round 2: the image `src` data-URI is base64, and a secret CAN be hidden in
// the payload (e.g. a "screenshot" whose base64 encodes a credential). But
// base64 is dense data, so the FULL rule set over-redacts it: the generic
// keyword rules false-positive on base64's `key`/`token`/`secret` substrings,
// and bare-token's g-z branch matches any 24+ char base64 run (i.e. almost every
// real image). So we scan the payload with ONLY the base64-safe rules — the
// prefix keys (sk-/AKIA/AIza/ghp), a PEM/PGP private-key block, and a
// connection string. Those are specific enough that base64 essentially never
// contains them; a hit means a real embedded secret and the whole payload is
// replaced (we cannot partially redact base64 without corrupting the image).
// Non-data-URI srcs (same-origin /assets/ paths) pass through untouched.
const SRC_SCAN_CATEGORIES = new Set(['private-key', 'aws-access-key', 'aws-secret-key', 'google-api-key', 'openai-key', 'anthropic-key', 'connection-string']);
const srcScanRules = rules.filter((r) => SRC_SCAN_CATEGORIES.has(r.category));
function redactSrc(src: string, preset: Preset, add: (counts: Record<string, number>) => void): string {
  // The payload is everything after the FIRST comma (the data: URI header ends
  // at the first comma). Base64 payloads are [A-Za-z0-9+/=]; plaintext payloads
  // (data:text/plain) can contain any char, so capture the rest verbatim.
  const m = /^data:[^,]*,(.+)$/.exec(src);
  if (!m || !m[1]) return src;
  let payload = m[1];
  const counts: Record<string, number> = {};
  for (const rule of srcScanRules) {
    if (!rule.presets.includes(preset)) continue;
    let n = 0;
    payload = payload.replace(rule.pattern, () => {
      n += 1;
      return rule.replace ? rule.replace('') : `[REDACTED:${rule.category}]`;
    });
    if (n > 0) counts[rule.category] = n;
  }
  if (Object.values(counts).some((v) => v > 0)) {
    add(counts);
    return src.slice(0, src.indexOf(',') + 1) + 'REDACTED';
  }
  return src;
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

/** The single authoritative redaction pass. Only the result of this function is persisted. */
export function prepareContent(messages: ShapedMessage[], preset: Preset): PreparedContent {
  const summary: Record<string, number> = {};
  const add = (counts: Record<string, number>): void => {
    for (const [k, v] of Object.entries(counts)) summary[k] = (summary[k] ?? 0) + v;
  };
  const redacted = messages.map((m) => ({ ...m, parts: m.parts.map((p) => redactPart(p, preset, add)) }));
  return {
    messages: redacted,
    summary,
    bytes: Buffer.byteLength(JSON.stringify(redacted)),
    messageCount: redacted.length,
  };
}
