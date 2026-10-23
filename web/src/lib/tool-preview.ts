import type { SharePart } from '../api';

/**
 * Collapse whitespace and truncate a preview to its display budget.
 *
 * @param text - Text to summarize.
 * @param limit - Maximum displayed length, including an ellipsis when truncated.
 * @returns Single-line preview.
 */
export function compactPreview(text: string, limit = 140): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/**
 * Decode JSON arguments, including tool-call wrappers, without discarding raw text.
 *
 * @param input - Tool arguments or output to decode.
 * @returns Parsed JSON when valid, otherwise the original value.
 */
function inputValue(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  try {
    // Codex custom calls can wrap their JSON arguments in tools.exec_command(…).
    const wrapped = /^[\w.]+\((\{[\s\S]*\})\)\s*;?$/.exec(input.trim());
    return JSON.parse(wrapped?.[1] ?? input) as unknown;
  } catch {
    return input;
  }
}

/**
 * Derive a compact tool title and useful argument summary.
 *
 * @param part - Tool part whose intent, command, path, or query should be shown.
 * @returns Display title and detail for the collapsed tool card.
 */
export function toolPreview(part: SharePart): { title: string; detail: string } {
  const name = (part.tool ?? 'tool').split('.').pop() ?? 'tool';
  const input = inputValue(part.input);
  const args = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  /**
   * Read the first nonempty string argument among known aliases.
   *
   * @param keys - Argument names in priority order.
   * @returns Matching string, or an empty string when no alias is populated.
   */
  const string = (...keys: string[]): string => {
    for (const key of keys) if (typeof args[key] === 'string' && args[key]) return args[key] as string;
    return '';
  };
  const path = string('path', 'file_path', 'filePath', 'filename', 'target_file');
  const command = string('command', 'cmd', 'program')
    || (Array.isArray(args.command) && args.command.every((item) => typeof item === 'string') ? args.command.join(' ') : '');
  const query = string('pattern', 'query');
  const cwd = string('cwd', 'workdir');
  const intent = string('i', 'description', 'title');
  const action = /read|view_file/i.test(name) ? 'Read file'
    : /^write_stdin$/i.test(name) ? 'Run command'
    : /edit|patch|write/i.test(name) ? 'Update files'
    : /grep|search|find/i.test(name) ? 'Search'
    : /bash|exec|shell|command/i.test(name) ? 'Run command'
    : name;
  let detail = [query, path].filter(Boolean).join(' · ');
  if (path && !query) {
    const start = args.offset ?? args.start_line;
    const end = args.end_line ?? (typeof start === 'number' && typeof args.limit === 'number' ? start + args.limit - 1 : undefined);
    if (typeof start === 'number') detail += ` · lines ${start}${typeof end === 'number' ? `–${end}` : '+'}`;
  }
  if (command) detail = [command, cwd].filter(Boolean).join(' · ');
  if (!detail) detail = string('url', 'uri', 'session_id', 'name');
  if (!detail && typeof input === 'string') {
    const files = [...input.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$|^\[([^\]\r\n]+)#[0-9A-F]{4}\]$/gm)]
      .slice(0, 3).map((match) => match[1] ?? match[2]);
    detail = files.length ? files.join(' · ') : input;
  }
  return { title: compactPreview(intent || action, 90), detail: compactPreview(detail) };
}

/**
 * Recognize the failure statuses used by supported harnesses.
 *
 * @param part - Tool part to inspect.
 * @returns Whether its status denotes a failure.
 */
export function toolFailed(part: SharePart): boolean {
  return /^(?:error|failed|failure)$/i.test(part.status ?? '');
}

/**
 * Extract a useful diagnostic from raw or structured tool output.
 *
 * @param part - Failed tool part.
 * @returns Compact diagnostic, first output line, or a missing-details message.
 */
export function toolErrorPreview(part: SharePart): string {
  /**
   * Extract text from a string or common structured result fields.
   *
   * @param value - Decoded tool result.
   * @returns Available result text, or an empty string.
   */
  const textFrom = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object') return '';
    const record = value as Record<string, unknown>;
    for (const key of ['output', 'message', 'content']) if (typeof record[key] === 'string') return record[key] as string;
    return '';
  };
  const result = inputValue(part.output);
  let text: string;
  if (Array.isArray(result)) {
    const blocks = result.map((block: unknown) => inputValue(
      block && typeof block === 'object' ? (block as Record<string, unknown>).text : undefined,
    ));
    const failed = blocks.find((value) => {
      if (!value || typeof value !== 'object') return false;
      const record = value as Record<string, unknown>;
      const metadata = record.metadata as Record<string, unknown> | undefined;
      return (typeof record.exit_code === 'number' && record.exit_code !== 0)
        || (typeof metadata?.exit_code === 'number' && metadata.exit_code !== 0);
    });
    text = textFrom(failed) || blocks.map(textFrom).filter(Boolean).join('\n');
  } else {
    text = textFrom(result);
  }
  text = (text || part.output || '').replace(/^Chunk ID: [^\r\n]+\r?\nWall time: [^\r\n]+\r?\nProcess exited with code -?\d+\r?\n(?:Final output|Output):\s*/, '');
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const diagnostic = lines.find((line) => /^\s*(?:error(?:\s+[A-Z]+\d+)?:|caused by:)/i.test(line));
  return compactPreview(diagnostic ?? lines[0] ?? 'No error details provided.');
}
