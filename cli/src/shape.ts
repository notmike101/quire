const MAX_TOOL_OUTPUT_BYTES = 20 * 1024;

/**
 * Round 5: cap on the number of messages a harness session load will shape.
 * A single session's rows are read into memory in full, so a pathological
 * (corrupt, adversarial, or runaway) session must not be able to OOM the
 * publish CLI. The server's 1 GB per-share cap bounds what is STORED; this
 * bounds what is LOADED. 50k short messages is well past any real session.
 */
export const MAX_SESSION_MESSAGES = 50_000;

/** Tool outputs can be huge; cap them so uploads stay small and pages stay fast. */
export function truncateOutput(output: string | undefined): string | undefined {
  if (output === undefined) return undefined;
  const buf = Buffer.from(output);
  if (buf.byteLength <= MAX_TOOL_OUTPUT_BYTES) return output;
  const kept = buf.subarray(0, MAX_TOOL_OUTPUT_BYTES).toString('utf8');
  return `${kept}\n… [truncated ${buf.byteLength - MAX_TOOL_OUTPUT_BYTES} bytes]`;
}

const MAX_TOOL_INPUT_BYTES = 20 * 1024;

/**
 * Round 8: tool `input` is capped the same way `output` is. A tool call's
 * input can be huge (a Write/Edit call carries the whole file body), and an
 * uncapped input bloats the share the same way an uncapped output did. Cap the
 * SERIALIZED size; an over-cap input is replaced by a small marker object —
 * `preview` keeps the first 20 KB of the JSON (the interesting keys lead), so
 * the viewer still renders it (ToolCard stringifies non-string inputs) and the
 * server still redacts the preview string. JSON.stringify can throw (a
 * throwing toJSON, or a RangeError on some engines for pathologically deep
 * structures) — caught, and the input is kept as-is (the server's iterative
 * walkStrings still redacts it).
 */
export function truncateInput(input: unknown): unknown {
  if (input === undefined || input === null) return input;
  let s: string | undefined;
  try {
    s = JSON.stringify(input);
  } catch {
    return input;
  }
  if (s === undefined) return input;
  const buf = Buffer.from(s);
  if (buf.byteLength <= MAX_TOOL_INPUT_BYTES) return input;
  return {
    __truncated: true,
    originalBytes: buf.byteLength,
    preview: buf.subarray(0, MAX_TOOL_INPUT_BYTES).toString('utf8'),
  };
}

/**
 * Round 9 (C-F4): cap on a single text/reasoning/system part's text. Tool
 * outputs are capped at 20 KB, but a plain text part (a huge paste, a giant
 * tool result that arrived as text, a long reasoning stream) was uncapped —
 * one multi-MB part bloats the stored parts jsonb and every public-API
 * response page. Cap at 256 KB; under the cap the SAME reference is returned
 * so callers can cheaply detect "unchanged".
 */
const MAX_PART_TEXT_BYTES = 256 * 1024;

export function truncatePartText(text: string): string {
  const buf = Buffer.from(text);
  if (buf.byteLength <= MAX_PART_TEXT_BYTES) return text;
  const kept = buf.subarray(0, MAX_PART_TEXT_BYTES).toString('utf8');
  return `${kept}\n… [truncated ${buf.byteLength - MAX_PART_TEXT_BYTES} bytes]`;
}

/**
 * Round 9 (C-F10): strip control characters from strings that are printed to
 * the terminal (preview lines). A session message comes from a session file an
 * attacker could have shaped, and control bytes there would forge terminal
 * output (fake "Published:" lines, cursor tricks). \n and \t are in the class
 * too — fine, these are single-line display values.
 * Round 11: extend to C1 (0x80-0x9F, incl. the C1 form of ESC 0x9B) and the
 * bidi override/isolate controls (0x202A-0x202E, 0x2066-0x2069), which can
 * spoof text direction — aligning with the server's C1 set (CONTROL_CHARS_RE).
 */
export function stripControlChars(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '');
}
