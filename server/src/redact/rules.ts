export type Preset = 'strict' | 'normal' | 'none';

export interface RedactRule {
  category: string;
  pattern: RegExp;
  presets: Preset[];
  /** Produce the replacement from the match (default: `[REDACTED:<category>]`). */
  replace?: (match: string, ...groups: string[]) => string;
  /**
   * Round 6: decline a match (no span is pushed, so the run is neither counted
   * nor shielded from later rules). Lets a rule match a broad span in the
   * pattern — where it stays linear — and apply a semantic accept/reject in JS
   * instead of an unbounded regex lookahead (which was a quadratic ReDoS).
   */
  test?: (match: string, ...groups: string[]) => boolean;
}

// Order matters: earlier rules claim their span first, and their placeholder
// shields that span from later rules.
export const rules: RedactRule[] = [
  {
    category: 'private-key',
    // Round 2: case-insensitive header (lowercase PEM) + optional trailing
    // "BLOCK" (PGP: "-----BEGIN PGP PRIVATE KEY BLOCK-----").
    // Round 3: the END line is OPTIONAL — a TRUNCATED key (the CLI caps tool
    // output at 20 KB, so a long key's END line is routinely cut) still leaks
    // the base64 body, which IS the secret. The optional-END branch claims the
    // whole remainder of the part; the full-block branch (with END) runs first
    // and wins when the key is complete.
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY( BLOCK)?-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY( BLOCK)?-----|-----BEGIN [A-Z ]*PRIVATE KEY( BLOCK)?-----[\s\S]*$/gi,
    presets: ['strict', 'normal'],
  },
  {
    category: 'jwt',
    // Chain F: the eyJ branch is preferred (real JWTs start with the base64 of
    // '{"'); the generic branch also catches non-eyJ three-segment dot tokens.
    pattern: /\b(?:eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}|[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,})\b/g,
    presets: ['strict', 'normal'],
  },
  {
    category: 'aws-access-key',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    presets: ['strict', 'normal'],
  },
  {
    category: 'aws-secret-key',
    // Round 2: the 40-char base64 secret access key (the half of the credential
    // pair that grants access). Distinct from the AKIA… access key ID above.
    // Bounded by non-alphanumeric chars so it can't over-match a longer run.
    pattern: /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{40}={0,2}(?![A-Za-z0-9+/=])/g,
    presets: ['strict', 'normal'],
  },
  {
    category: 'google-api-key',
    // Round 2: Google API keys (AIza + 33 base64url chars = 37 total).
    pattern: /\bAIza[0-9A-Za-z_\-]{33}\b/g,
    presets: ['strict', 'normal'],
  },
  {
    category: 'openai-key',
    pattern: /\bsk-[A-Za-z0-9]{20,}\b/g,
    presets: ['strict', 'normal'],
  },
  {
    category: 'anthropic-key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    presets: ['strict', 'normal'],
  },
  {
    category: 'connection-string',
    // Chain F: the first branch is the user:pass@host form; the second catches
    // query-string credentials (?password=… / &token=…) that carry no user@host.
    // Round 2: more schemes (mariadb/amqps/mssql/oracle/cockroachdb/clickhouse/
    // kafka/valkey/etcd), an OPTIONAL user (redis://:pass@), and `;` as a
    // separator for ODBC-style strings (Server=…;Pwd=…).
    pattern: /\b(postgres(ql)?|mysql|mariadb|mongodb(\+srv)?|redis|amqps?|mssql|oracle|cockroachdb|clickhouse|kafka|valkey|etcd):\/\/[^/\s:@]*:[^@\s]+@|(?:[;&?])(password|passwd|pwd|token|key|secret)s?=[^&\s]+/gi,
    presets: ['strict', 'normal'],
    replace: (m, scheme, _q, _s, credKey) => (scheme ? `${scheme}://[REDACTED:connection-string]@` : `${credKey}=[REDACTED:connection-string]`),
  },
  {
    category: 'bearer-token',
    // Round 2: case-insensitive + whitespace-tolerant (Authorization:Bearer,
    // BEARER, AUTHORIZATION: Bearer all match now).
    pattern: /\b(?:authorization\s*:\s*bearer\s+|bearer\s+)[A-Za-z0-9._-]{20,}/gi,
    presets: ['strict', 'normal'],
  },
  {
    category: 'generic-secret',
    // Chain F: floor lowered 16→8 and the key-name list widened so short
    // secrets and more naming conventions are caught.
    // Round 2: the value charset widened to any non-quote/non-whitespace run
    // (secret values routinely contain @ . ! # % , ; : etc.), still bounded by
    // the closing quote backreference so a quoted value stops at its quote.
    // Round 3: an optional closing quote after the key name — JSON tool
    // input/output is the dominant real-world secret format ({"api_key":"…"}),
    // and the key's closing quote sat between the name and the ':' so the
    // separator never matched. The quote is consumed (not backreferenced) so it
    // is removed from the output; a value that is itself quoted still stops at
    // its own quote via the backreference.
    pattern: /\b(api[_-]?key|secret|token|passwd|password|auth|credential|access|jwt|session|cookie|dsn|conn|private)("|'?)(\s*[:=]\s*)(['"]?)([^'"\s]{8,})\4/gi,
    presets: ['strict', 'normal'],
    replace: (_m, key, _kq, sep, _q, _v) => `${key}${sep}[REDACTED:generic-secret]`,
  },
  {
    category: 'bare-token',
    // Round 2: a keyword-less fallback. A 24+ char run is a secret when it is
    //  (1) a contiguous pure-hex run (a hex-encoded secret: the 40-char AWS
    //      secret, a hex API key), or
    //  (2) it contains a non-hex letter (g-z) — catching prefixed tokens
    //      (ghp_…, sk-…) and dotted identifiers the specific rules above missed.
    // A run that is NEITHER — e.g. a UUID (hex runs <24, no g-z letter) — is not
    // a secret and is left untouched.
    // Round 6 (ReDoS fix): the g-z decision moved OUT of the pattern. The old
    // lookahead (?=[A-Za-z0-9._-]*[g-zG-Z]) scanned the whole run and, when it
    // failed (no g-z letter), forced the engine to retry at every position —
    // O(N²) on a long no-g-z run. A 1 MB input hung the event loop ~7 min: an
    // authenticated DoS via the owner API (redaction runs synchronously). The
    // pattern now matches the maximal run plainly (O(N)); `test` applies the
    // same pure-hex / g-z decision in JS after the match. A declined match still
    // advances lastIndex past the run, so the engine never retries per position.
    // Runs LAST so the specific prefix rules claim their spans first.
    pattern: /\b[A-Za-z0-9._-]{24,}\b/g,
    presets: ['strict', 'normal'],
    test: (run) => /^[0-9a-fA-F]{24,}$/.test(run) || /[g-zG-Z]/.test(run),
  },
  {
    category: 'private-ip',
    pattern: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g,
    presets: ['strict'],
  },
  {
    category: 'local-path',
    pattern: /\b[A-Za-z]:\\[^\s"'<>|*?]+|(?<!\w)(?:\/home|\/Users|\/root)\/[^\s"'<>|*?]+/g,
    presets: ['strict'],
  },
];
