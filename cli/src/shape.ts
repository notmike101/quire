const MAX_TOOL_OUTPUT_BYTES = 20 * 1024;

/** Tool outputs can be huge; cap them so uploads stay small and pages stay fast. */
export function truncateOutput(output: string | undefined): string | undefined {
  if (output === undefined) return undefined;
  const buf = Buffer.from(output);
  if (buf.byteLength <= MAX_TOOL_OUTPUT_BYTES) return output;
  const kept = buf.subarray(0, MAX_TOOL_OUTPUT_BYTES).toString('utf8');
  return `${kept}\n… [truncated ${buf.byteLength - MAX_TOOL_OUTPUT_BYTES} bytes]`;
}
