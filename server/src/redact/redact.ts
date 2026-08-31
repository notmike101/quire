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
  // Round 9 (F3): the full non-ASCII Zs space inventory + Zl/Zp line/paragraph
  // separators — each can split a secret run (U+00A0 nbsp, U+2028/2029,
  // U+3000 ideographic space, …). Stripping is on the matching copy only, so
  // these survive in non-redacted output.
  0x00a0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
  // Round 9 (F3): additional Cf format chars (Samaritan/Arabic/Mongolian
  // joiners and separators, Hangul filler, Sundanese signs, Greek/Canadian
  // joining marks).
  0x070f, 0x08e2, 0x08e3, 0x180b, 0x180c, 0x180d, 0x3164,
  0x1bfb, 0x1bfc,
  0x1d16, 0x1d17, 0x1d18, 0x1d19, 0x1d1a, 0x1d1b, 0x1d1c, 0x1d1d, 0x1d1e,
  0x1d2c, 0x1d2d, 0x1d2e, 0x1d37,
]);
// Round 10 (R10-4): the explicit INVISIBLE_CP set above is INCOMPLETE — it
// misses many invisible chars, e.g. U+180F (Mongolian Vowel Separator, an Mn
// combining mark sitting right after the set's U+180B–180E), U+0301 (combining
// acute) and most of the Cf format inventory (U+FFF9–FFFB, U+06DD, U+0890, …).
// An attacker embedding any of those in a secret split the run on the matching
// copy so no rule matched. Catch EVERY format (Cf) AND nonspacing-mark (Mn)
// char via property escapes — future-proof, so the set can't go stale as
// Unicode grows. (U+180F is category Mn, not Cf, so a Cf-only escape misses the
// reported char.) Stripping is on the matching copy only, so legitimate
// combining marks (accents, ZWJ emoji, CJK joiners) survive verbatim in
// non-redacted output. The regular space U+0020 is Zs (neither Cf nor Mn) and
// is deliberately NOT stripped — it legitimately ends a token.
const INVISIBLE_CF_MN_RE = /[\p{Cf}\p{Mn}]/u;
function isInvisible(cp: number): boolean {
  if (INVISIBLE_CP.has(cp)) return true;
  if (cp >= 0xfe00 && cp <= 0xfe0f) return true; // variation selectors (Mn)
  if (cp >= 0xe0001 && cp <= 0xe007f) return true; // tag block (SMP, Cf)
  // Fast negative: ASCII printable (0x20–0x7e) is never Cf/Mn, so skip the
  // regex for the common case. (The regular space U+0020 is here on purpose —
  // it legitimately ends a token, so it must NOT be stripped.)
  if (cp >= 0x20 && cp <= 0x7e) return false;
  return INVISIBLE_CF_MN_RE.test(String.fromCodePoint(cp));
}

// Round 9 (D8): a base64 data URI — `data:<mediatype>[;params]*;base64,<payload>`.
// The payload is a long [A-Za-z0-9+/=] run that the bare-token fallback (and,
// in principle, any rule) reads as a secret. `![x](data:image/jpg;base64,…)`,
// a markdown image, keeps its payload in a TEXT part (the CLI only extracts
// known attachment files into image parts), so without this shield the stored
// image is corrupted into [REDACTED:…] fragments and never renders. A base64
// payload is never a secret — the viewer's isSafeImageSrc/isSafeHref already
// drop non-image data URIs at render time — so the whole URI is shielded from
// every rule. The `;base64,` marker is the discriminator: a real secret is
// never preceded by it, so no genuine redaction is lost.
const DATA_URI_RE = /data:[^,\s]*;base64,[a-z0-9+/%=]+/gi;

function findDataUriSpans(s: string): Array<{ s: number; e: number }> {
  const spans: Array<{ s: number; e: number }> = [];
  DATA_URI_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DATA_URI_RE.exec(s)) !== null) {
    spans.push({ s: m.index, e: m.index + m[0].length });
    if (m[0].length === 0) DATA_URI_RE.lastIndex++; // guard: zero-length
  }
  return spans;
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
      // Round 9 (F1): push one entry per UTF-16 UNIT, not per code point. A
      // surrogate pair (cp > 0xffff) occupies 2 units in `stripped`, so pushing
      // one entry desynced map from stripped (map.length < stripped.length) and
      // any match after a surrogate pair mapped to the wrong original offset,
      // leaking the leading chars of the secret. map[k] indexes the k-th UTF-16
      // unit of `stripped`, so map.length === stripped.length.
      if (cp > 0xffff) map.push(i, i + 1);
      else map.push(i);
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
  // Round 9 (D8): base64 data URIs are shielded from every rule (see the
  // DATA_URI_RE note). Computed on the stripped text so the spans share the
  // same coordinate space as the rule spans below.
  const dataUriSpans = findDataUriSpans(stripped);
  const inDataUri = (s: number, e: number) => {
    let lo = 0;
    let hi = dataUriSpans.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (dataUriSpans[mid]!.e <= s) lo = mid + 1;
      else hi = mid;
    }
    return lo < dataUriSpans.length && dataUriSpans[lo]!.s < e;
  };
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
      // Round 9 (D8): never redact inside a base64 data URI (a markdown image
      // payload is not a secret). Skipping the span leaves the URI intact.
      if (inDataUri(s, e)) continue;
      const replacement = rule.replace ? rule.replace(m[0], ...groups) : `[REDACTED:${rule.category}]`;
      spans.push({ s, e, replacement, rule: rule.category, pri: ri });
    }
  }
  // Merge every overlapping cluster into its full union. Dropping an enclosing
  // lower-priority span leaked the part outside an inner higher-priority match
  // (`password=sk-… remaining words`). A containing span keeps its purpose-built
  // replacement; a partial-overlap union uses the highest-priority category.
  // Sorting by start and longest-first makes containment deterministic and keeps
  // the merge O(n log n).
  spans.sort((a, b) => a.s - b.s || b.e - a.e || a.pri - b.pri);
  const kept: Span[] = [];
  for (const sp of spans) {
    const prev = kept.at(-1);
    if (!prev || sp.s >= prev.e) {
      kept.push({ ...sp });
      continue;
    }
    if (sp.e <= prev.e) {
      if (sp.pri < prev.pri) {
        prev.pri = sp.pri;
        prev.rule = sp.rule;
        prev.replacement = prev.replacement.replace(/\[REDACTED:[^\]]+\]/, `[REDACTED:${sp.rule}]`);
      }
      continue;
    }
    prev.e = sp.e;
    if (sp.pri < prev.pri) {
      prev.pri = sp.pri;
      prev.rule = sp.rule;
    }
    prev.replacement = `[REDACTED:${prev.rule}]`;
  }
  for (const sp of kept) counts[sp.rule] = (counts[sp.rule] ?? 0) + 1;
  const merged = kept;
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
