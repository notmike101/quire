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
