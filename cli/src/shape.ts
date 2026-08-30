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
