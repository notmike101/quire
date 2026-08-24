import { rules, type Preset } from './rules.js';

/** Map every string leaf of a JSON value through fn (structure preserved). */
export function walkStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((v) => walkStrings(v, fn));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = walkStrings(v, fn);
    return out;
  }
  return value;
}

export function redactText(
  text: string,
  preset: Preset,
): { text: string; counts: Record<string, number> } {
  if (preset === 'none') return { text, counts: {} };
  const counts: Record<string, number> = {};
  let out = text;
  for (const rule of rules) {
    if (!rule.presets.includes(preset)) continue;
    out = out.replace(rule.pattern, (...args: (string | number)[]) => {
      counts[rule.category] = (counts[rule.category] ?? 0) + 1;
      const match = args[0] as string;
      const groups = args.slice(1, args.length - 2) as string[];
      return rule.replace ? rule.replace(match, ...groups) : `[REDACTED:${rule.category}]`;
    });
  }
  return { text: out, counts };
}
