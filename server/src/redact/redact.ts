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
    // Round 7: redact the KEY too. A secret in key position (e.g. a tool
    // `input` of {"sk-…": "v"}) otherwise persists and is served to the viewer —
    // the Map branch already redacts its keys; the plain-object branch was the
    // leak. Rename in place: drop the old key first (set() alone would ADD),
    // then every branch below re-attaches the value at the (possibly renamed)
    // key — required for container values, which are mutated in place and would
    // otherwise be orphaned by the delete.
    const newKey = typeof key === 'string' ? fn(key) : key;
    if (newKey !== key) delete (container as Record<PropertyKey, unknown>)[key];
    if (typeof v === 'string') {
      (container as Record<PropertyKey, unknown>)[newKey] = fn(v);
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      const s = String(v);
      const r = fn(s);
      (container as Record<PropertyKey, unknown>)[newKey] = r === s ? v : r;
    } else if (Array.isArray(v)) {
      if (depth >= MAX_WALK_DEPTH) {
        // Over-deep: collapse to a JSON string and redact it.
        (container as Record<PropertyKey, unknown>)[newKey] = fn(JSON.stringify(v));
        continue;
      }
      for (let i = 0; i < v.length; i++) work.push({ container: v, key: i, value: v[i], depth: depth + 1 });
      (container as Record<PropertyKey, unknown>)[newKey] = v;
    } else if (v instanceof Map) {
      // Round 5: a Map's values (and string keys) can carry secrets. Redact
      // each in place via .set() (a Map is not indexable like an object).
      if (depth >= MAX_WALK_DEPTH) {
        (container as Record<PropertyKey, unknown>)[newKey] = fn(JSON.stringify([...v.entries()]));
        continue;
      }
      for (const [k, val] of [...v.entries()]) {
        const newK = typeof k === 'string' ? fn(k) : k;
        const newVal = walkStrings(val, fn);
        if (newK !== k) v.delete(k); // rename: drop the old key first (set() alone would ADD)
        v.set(newK, newVal);
      }
      (container as Record<PropertyKey, unknown>)[newKey] = v;
    } else if (v instanceof Set) {
      // Round 5: a Set's elements can carry secrets. Rebuild with redacted values.
      if (depth >= MAX_WALK_DEPTH) {
        (container as Record<PropertyKey, unknown>)[newKey] = fn(JSON.stringify([...v]));
        continue;
      }
      for (const item of [...v]) {
        const r = walkStrings(item, fn);
        if (r !== item) { v.delete(item); v.add(r); }
      }
      (container as Record<PropertyKey, unknown>)[newKey] = v;
    } else if (v && typeof v === 'object') {
      if (depth >= MAX_WALK_DEPTH) {
        (container as Record<PropertyKey, unknown>)[newKey] = fn(JSON.stringify(v));
        continue;
      }
      const obj = v as Record<string, unknown>;
      for (const k of Object.keys(obj)) work.push({ container: obj, key: k, value: obj[k], depth: depth + 1 });
      (container as Record<PropertyKey, unknown>)[newKey] = v;
      // Round 5: symbol-keyed string values are also walked (Object.keys excludes symbols).
      for (const sk of Object.getOwnPropertySymbols(obj)) {
        const val = (obj as Record<PropertyKey, unknown>)[sk];
        if (typeof val === 'string') (obj as Record<PropertyKey, unknown>)[sk] = fn(val);
      }
    }
  }
  return root.value;
}

// Round 5: zero-width / invisible characters let an attacker split a
// contiguous secret run so the bare-token fallback (24+ char alnum run) and the
// specific prefix rules both miss it. We match the rules on an invisible-
// STRIPPED copy of the text, then map every replacement back onto the original
// so invisible chars are preserved in non-redacted spans (they are intentional
// in CJK text and ZWJ emoji sequences) but removed inside a redacted span.
// Round 8: widen the strip from the original 4 zero-width chars to the full
// invisible/format inventory — bidirectional overrides (U+202A–202E), word
// joiner (U+2060) and the other U+206x format chars, variation selectors
// (U+FE00–FE0F), soft hyphen (U+00AD), and the SMP tag block (U+E0001–E007F) —
// all of which can split a secret run. Stripping is on the matching copy only,
// so legitimate invisible chars (ZWJ emoji, CJK joiners) survive in the output.
const INVISIBLE_CP = new Set<number>([
  0x00ad, 0x034f, 0x061c,
  0x1100, 0x115f, 0x1160,
  0x17b4, 0x17b5, 0x17d4, 0x17d5,
  0x180e, 0x1843, 0x1844,
  0x200b, 0x200c, 0x200d, 0x200e, 0x200f,
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
  0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0x2065, 0x2066, 0x2067,
  0x2068, 0x2069, 0x206a, 0x206b, 0x206c, 0x206d, 0x206e, 0x206f,
  0xfeff,
]);
function isInvisible(cp: number): boolean {
  if (INVISIBLE_CP.has(cp)) return true;
  if (cp >= 0xfe00 && cp <= 0xfe0f) return true; // variation selectors
  if (cp >= 0xe0001 && cp <= 0xe007f) return true; // tag block (SMP)
  return false;
}

export function redactText(
  text: string,
  preset: Preset,
): { text: string; counts: Record<string, number> } {
  if (preset === 'none') return { text, counts: {} };
  const counts: Record<string, number> = {};
  // Build the stripped text and a strippedIdx -> originalIdx map so a match
  // found on the stripped text can be located in the original. Iterate by code
  // point (not UTF-16 unit) so the SMP tag block is stripped as a unit.
  let stripped = '';
  const map: number[] = [];
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    if (!isInvisible(cp)) {
      map.push(i);
      stripped += String.fromCodePoint(cp);
    }
    i += cp > 0xffff ? 2 : 1;
  }
  // Find all matches on the stripped text, mapped to original spans. `rule`
  // carries the category so we can count only the spans that are actually
  // EMITTED (a later rule's match inside an earlier rule's span is dropped by
  // the merge and must not be counted — the old sequential-replace naturally
  // avoided this because the placeholder shielded later rules).
  type Span = { s: number; e: number; replacement: string; rule: string; pri: number };
  const spans: Span[] = [];
  for (let ri = 0; ri < rules.length; ri++) {
    const rule = rules[ri]!;
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
      spans.push({ s, e, replacement, rule: rule.category, pri: ri });
    }
  }
  // Merge overlapping spans by RULE PRIORITY (a higher-priority rule's span
  // claims its region before a lower-priority one, so a lower-priority span
  // that overlaps it is dropped regardless of where it starts). This
  // reproduces the old sequential-replace semantics ("earlier rules claim
  // first"). The previous position-only sort let an earlier-starting
  // low-priority span shadow a higher-priority span that began a few chars in
  // — e.g. the narrow `key` rule matching `key: -----BEGIN…` (at the `key`)
  // would drop the private-key span that starts at the `-----BEGIN`, leaking
  // the key body; likewise `key: postgres://user:pass@…` would shadow the
  // connection-string span and leak the credential.
  // O(n log n): coordinate-compress the start positions, process spans in
  // priority order, and use a Fenwick prefix-max tree to test whether a span
  // overlaps any already-kept (higher-priority) span. A span [s,e] overlaps a
  // kept span iff some kept span has start < e and end > s; the prefix-max
  // over starts < e answers that in O(log n).
  spans.sort((a, b) => a.pri - b.pri || a.s - b.s || a.e - b.e);
  const coords = Array.from(new Set(spans.map((sp) => sp.s))).sort((a, b) => a - b);
  const coordIdx = new Map<number, number>();
  coords.forEach((c, i) => coordIdx.set(c, i));
  const size = coords.length;
  const tree = new Array<number>(size + 1).fill(-1);
  const fwUpdate = (idx: number, v: number) => {
    for (let x = idx + 1; x <= size; x += x & -x) if (v > tree[x]!) tree[x] = v;
  };
  const fwQuery = (idx: number) => {
    let res = -1;
    for (let x = idx + 1; x > 0; x -= x & -x) if (tree[x]! > res) res = tree[x]!;
    return res;
  };
  const firstGE = (e: number) => {
    let lo = 0, hi = size;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (coords[mid]! >= e) hi = mid; else lo = mid + 1; }
    return lo;
  };
  const kept: Span[] = [];
  for (const sp of spans) {
    const i = firstGE(sp.e) - 1; // rightmost kept start < sp.e
    if (i >= 0 && fwQuery(i) > sp.s) continue; // overlaps a higher-priority kept span
    kept.push(sp);
    counts[sp.rule] = (counts[sp.rule] ?? 0) + 1;
    fwUpdate(coordIdx.get(sp.s)!, sp.e);
  }
  // The output walk below needs spans in positional order.
  const merged = kept.sort((a, b) => a.s - b.s || a.e - b.e);
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
