import { rules, type Preset } from './rules.js';

// Round 4: a numeric (or boolean) leaf in tool `input` can be a secret — e.g. a
// numeric API token stored as a JSON number. Stringify it through fn so the
// rules can see it; a clean number is unchanged (the rules never match an
// ordinary number), so round-tripping is lossless.
// Round 4: walk iteratively with an explicit depth cap. A malicious `input`
// (z.unknown() — no depth limit in the schema) could be 100k levels deep and
// stack-overflow a recursive walk mid-redaction. Beyond the cap the subtree is
// passed through unchanged (it is still persisted, but the walk cannot crash).
const MAX_WALK_DEPTH = 512;

/** Map every string/number/boolean leaf of a JSON value through fn (structure preserved). */
export function walkStrings(value: unknown, fn: (s: string) => string): unknown {
  const work: Array<{ container: Record<string, unknown> | unknown[]; key: PropertyKey; value: unknown; depth: number }> = [];
  const root: Record<string, unknown> = { value };
  work.push({ container: root, key: 'value', value, depth: 0 });
  while (work.length > 0) {
    const { container, key, value: v, depth } = work.pop()!;
    if (typeof v === 'string') {
      (container as Record<PropertyKey, unknown>)[key] = fn(v);
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      const s = String(v);
      const r = fn(s);
      (container as Record<PropertyKey, unknown>)[key] = r === s ? v : r;
    } else if (Array.isArray(v)) {
      if (depth >= MAX_WALK_DEPTH) continue;
      for (let i = 0; i < v.length; i++) work.push({ container: v, key: i, value: v[i], depth: depth + 1 });
    } else if (v && typeof v === 'object') {
      if (depth >= MAX_WALK_DEPTH) continue;
      const obj = v as Record<string, unknown>;
      for (const k of Object.keys(obj)) work.push({ container: obj, key: k, value: obj[k], depth: depth + 1 });
    }
  }
  return root.value;
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
