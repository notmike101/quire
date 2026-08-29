export type Preset = 'strict' | 'normal' | 'none';

export interface RedactRule {
  category: string;
  pattern: RegExp;
  presets: Preset[];
  /** Produce the replacement from the match (default: `[REDACTED:<category>]`). */
  replace?: (match: string, ...groups: string[]) => string;
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
    // Round 2: a keyword-less fallback. Two branches:
    //  (1) a pure-hex run of 24+ chars — a hex-encoded secret (the 40-char AWS
    //      secret, a hex API key). Pure hex is the over-redaction guard: it
    //      cannot match a UUID (dashes break the run) or ordinary prose.
    //  (2) a 24+ char run containing a non-hex letter (g-z) — catches prefixed
    //      tokens (ghp_…, sk-…) and dotted identifiers that the specific rules
    //      above missed. The lookaround requires the non-hex letter so a pure
    //      hex run is only matched by branch (1), and a UUID (no g-z letter,
    //      hex runs <24) matches neither.
    // Runs LAST so the specific prefix rules claim their spans first.
    pattern: /\b(?:[0-9a-fA-F]{24,}|(?=[A-Za-z0-9._-]*[g-zG-Z])[A-Za-z0-9._-]{24,})\b/g,
    presets: ['strict', 'normal'],
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
