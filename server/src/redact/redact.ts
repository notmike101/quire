import { rules, type Preset } from './rules.js';

// Round 4: a numeric (or boolean) leaf in tool `input` can be a secret — e.g. a
// numeric API token stored as a JSON number. Stringify it through fn so the
// rules can see it; a clean number is unchanged (the rules never match an
// ordinary number), so round-tripping is lossless.
// Round 4: walk iteratively with an explicit depth cap. A malicious `input`
// (z.unknown() — no depth limit in the schema) could be 100k levels deep and
// stack-overflow a recursive walk mid-redaction.
// Round 5: beyond the cap the subtree is NOT skipped (the old `continue`
// persisted it verbatim — a complete redaction bypass for any secret nested
// deeper than 512). Instead the over-deep node is stringified via JSON and
// passed through fn, so its contents still run through the rules. The
// structure is collapsed to a string at that point (acceptable: a 512-deep
// tool input is not meaningful structure, and the security property — no
// secret persists unredacted — is preserved).
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
      if (depth >= MAX_WALK_DEPTH) {
        // Over-deep: collapse to a JSON string and redact it.
        (container as Record<PropertyKey, unknown>)[key] = fn(JSON.stringify(v));
        continue;
      }
      for (let i = 0; i < v.length; i++) work.push({ container: v, key: i, value: v[i], depth: depth + 1 });
    } else if (v instanceof Map) {
      // Round 5: a Map's values (and string keys) can carry secrets. Redact
      // each in place via .set() (a Map is not indexable like an object).
      if (depth >= MAX_WALK_DEPTH) {
        (container as Record<PropertyKey, unknown>)[key] = fn(JSON.stringify([...v.entries()]));
        continue;
      }
      for (const [k, val] of [...v.entries()]) {
        const newK = typeof k === 'string' ? fn(k) : k;
        const newVal = walkStrings(val, fn);
        if (newK !== k) v.delete(k); // rename: drop the old key first (set() alone would ADD)
        v.set(newK, newVal);
      }
    } else if (v instanceof Set) {
      // Round 5: a Set's elements can carry secrets. Rebuild with redacted values.
      if (depth >= MAX_WALK_DEPTH) {
        (container as Record<PropertyKey, unknown>)[key] = fn(JSON.stringify([...v]));
        continue;
      }
      for (const item of [...v]) {
        const r = walkStrings(item, fn);
        if (r !== item) { v.delete(item); v.add(r); }
      }
    } else if (v && typeof v === 'object') {
      if (depth >= MAX_WALK_DEPTH) {
        (container as Record<PropertyKey, unknown>)[key] = fn(JSON.stringify(v));
        continue;
      }
      const obj = v as Record<string, unknown>;
      for (const k of Object.keys(obj)) work.push({ container: obj, key: k, value: obj[k], depth: depth + 1 });
      // Round 5: symbol-keyed string values are also walked (Object.keys excludes symbols).
      for (const sk of Object.getOwnPropertySymbols(obj)) {
        const val = (obj as Record<PropertyKey, unknown>)[sk];
        if (typeof val === 'string') (obj as Record<PropertyKey, unknown>)[sk] = fn(val);
      }
    }
  }
  return root.value;
}

// Round 5: zero-width / invisible characters (U+200B zero-width space, U+200C
// ZWNJ, U+200D ZWJ, U+FEFF BOM/zero-width no-break space) let an attacker split
// a contiguous secret run so the bare-token fallback (24+ char alnum run) and
// the specific prefix rules both miss it. We match the rules on a zero-width-
// STRIPPED copy of the text, then map every replacement back onto the original
// so zero-width chars are preserved in non-redacted spans (they are intentional
// in CJK text and ZWJ emoji sequences) but removed inside a redacted span.
const ZERO_WIDTH_RE = /[\u200b\u200c\u200d\ufeff]/g;

export function redactText(
  text: string,
  preset: Preset,
): { text: string; counts: Record<string, number> } {
  if (preset === 'none') return { text, counts: {} };
  const counts: Record<string, number> = {};
  // Build the stripped text and a strippedIdx -> originalIdx map so a match
  // found on the stripped text can be located in the original.
  let stripped = '';
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '\u200b' || ch === '\u200c' || ch === '\u200d' || ch === '\ufeff') continue;
    map.push(i);
    stripped += ch;
  }
  // Find all matches on the stripped text, mapped to original spans. `rule`
  // carries the category so we can count only the spans that are actually
  // EMITTED (a later rule's match inside an earlier rule's span is dropped by
  // the merge and must not be counted — the old sequential-replace naturally
  // avoided this because the placeholder shielded later rules).
  type Span = { s: number; e: number; replacement: string; rule: string };
  const spans: Span[] = [];
  for (const rule of rules) {
    if (!rule.presets.includes(preset)) continue;
    rule.pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.pattern.exec(stripped)) !== null) {
      if (m[0].length === 0) { rule.pattern.lastIndex++; continue; } // guard: zero-length
      const groups = m.slice(1) as string[];
      // Round 6: a rule may decline a match (bare-token's test rejects runs that
      // are neither pure-hex nor g-z-containing, e.g. UUIDs). Declining pushes no
      // span, so the run is neither counted nor shielded from later rules.
      // lastIndex has already advanced past the match, so the scan stays linear.
      if (rule.test && !rule.test(m[0], ...groups)) continue;
      const s = m.index;
      const e = s + m[0].length;
      const replacement = rule.replace ? rule.replace(m[0], ...groups) : `[REDACTED:${rule.category}]`;
      spans.push({ s, e, replacement, rule: rule.category });
    }
  }
  // Merge overlapping spans (earlier rules claim first, as before) and count
  // only the surviving spans.
  spans.sort((a, b) => a.s - b.s || a.e - b.e);
  const merged: Span[] = [];
  for (const sp of spans) {
    const last = merged[merged.length - 1];
    if (last && sp.s < last.e) continue; // overlaps an earlier (higher-priority) span
    merged.push(sp);
    counts[sp.rule] = (counts[sp.rule] ?? 0) + 1;
  }
  // Walk the original text, emitting non-span text verbatim (zero-width chars
  // inside it survive) and each span as its replacement (zero-width chars
  // inside the span are consumed).
  let out = '';
  let pos = 0;
  for (const sp of merged) {
    const origS = map[sp.s]!;
    const origE = sp.e < map.length ? map[sp.e]! : text.length;
    out += text.slice(pos, origS);
    out += sp.replacement;
    pos = origE;
  }
  out += text.slice(pos);
  return { text: out, counts };
}
