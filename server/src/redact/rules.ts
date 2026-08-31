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
    // Round 9 (F8) boundary note: the full-block branch CONSUMES the footer —
    // the lazy match runs through `-----END … PRIVATE KEY( BLOCK)?-----`
    // inclusive, so no footer text survives in the output. Only the truncated
    // branch (no END present) reaches the end of the part, where there is no
    // footer to leave behind.
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
    // Round 10 (R10-1): the lookbehind no longer rejects a preceding `=` — the
    // canonical no-space `.env`/CI form `AWS_SECRET_ACCESS_KEY=<40char>` had its
    // 40-char run preceded by `=`, so the old lookbehind declined it and the
    // secret leaked in full (no other rule matched: `key` isn't in
    // generic-secret's name list, and the `key` rule's value charset excludes
    // `/`). A 40-char base64 run preceded by `=` and followed by a non-base64
    // char is exactly the env-assignment case to catch; a LONGER base64 run is
    // still declined (the trailing lookahead fails on the next base64 char).
    pattern: /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40}={0,2}(?![A-Za-z0-9+/=])/g,
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
    // Round 7: http(s) basic-auth URLs (https://user:pass@host) carry a
    // credential in the userinfo and leak it; the user:pass@ branch already
    // handles them once the scheme is in the alternation. A user-only URL
    // (https://user@host, no colon) has no secret and is left untouched.
    pattern: /\b(postgres(ql)?|mysql|mariadb|mongodb(\+srv)?|redis|amqps?|mssql|oracle|cockroachdb|clickhouse|kafka|valkey|etcd|https?):\/\/[^/\s:@]*:[^@\s]+@|([;&?])(password|passwd|pwd|pass|pw|token|key|secret)s?=[^&#;\s]+/gi,
    presets: ['strict', 'normal'],
    replace: (_m, scheme, _q, _s, separator, credKey) => (scheme ? `${scheme}://[REDACTED:connection-string]@` : `${separator}${credKey}=[REDACTED:connection-string]`),
  },
  {
    category: 'bearer-token',
    // Round 2: case-insensitive + whitespace-tolerant (Authorization:Bearer,
    // BEARER, AUTHORIZATION: Bearer all match now).
    // Round 7: the two forms get different floors. The `Authorization: Bearer`
    // HEADER form is unambiguously an auth credential, so even a short token
    // (floor 8) is redacted. A BARE `bearer <token>` in prose is ambiguous
    // (could be the word "bearer" + an identifier), so it keeps the higher
    // floor (20) to avoid false positives.
    // Round 12 (F2): the HEADER form's value charset now includes `/` and `+`
    // (standard base64, not base64url). The old charset [A-Za-z0-9._-] stopped
    // at the first `/`, so the tail after it leaked (e.g. 18 chars — under the
    // bare-token 24 floor, so nothing else caught it). The header form is
    // unambiguous (`Authorization: Bearer`), so widening its charset cannot
    // false-positive on prose; the BARE-prose branch keeps the narrow charset.
    // Round 14: the equally unambiguous Authorization: Basic header gets its
    // own standard-base64 branch so short user:password credentials are caught.
    pattern: /\b(?:authorization[ \t]*:[ \t]*bearer[ \t]+[A-Za-z0-9._/+-]{8,}|authorization[ \t]*:[ \t]*basic[ \t]+[A-Za-z0-9+/=]{4,}(?![A-Za-z0-9+/=])|bearer[ \t]+[A-Za-z0-9._-]{20,})/gi,
    presets: ['strict', 'normal'],
  },
  {
    category: 'generic-secret',
    // Chain F: floor lowered 16→8 and the key-name list widened so short
    // secrets and more naming conventions are caught.
    // Round 2: the value charset widened for punctuation in secret values.
    // Round 3: an optional closing quote after the key name — JSON tool
    // input/output is the dominant real-world secret format ({"api_key":"…"}),
    // and the key's closing quote sat between the name and the ':' so the
    // separator never matched. The key quote is consumed and removed.
    // Round 7: the value charset now accepts backslash-ESCAPED characters
    // ((?:\\.)|…) so a JSON-escaped quote inside a quoted value ({"password":
    // "ab\"cd…"}) is consumed as part of the value instead of truncating the
    // match at the escaped quote (which leaked the tail). `pwd` is added to the
    // name list (a common short alias for password).
    // Round 13 (re-audit F1-UNDER-1/2, F1-REDOS-1): (a) the floor is dropped
    // 8→1 so a short `NAME=value` secret (e.g. `PASSWORD=abc1234`) is caught —
    // the `[:=]` form is unambiguous enough that a 1-char floor adds no
    // meaningful false-positive risk, and under-redaction is the failure we
    // must avoid. (b) The low-precision names `access|session|conn|private`
    // are dropped: with a 1-char floor they would over-redact legitimate short
    // values (`session: <id>`, `access: <mode>`); prefixed/compound forms of
    // those words (ACCESS_TOKEN, PRIVATE_KEY, …) are caught by the dedicated
    // env-var rule below instead. (c) `passphrase` is added. (d) The value
    // charset now EXCLUDES the backslash (`[^'"\s\\]`): the old `[^'"\s]` made
    // the `(?:(?:\\.)|…)` alternation ambiguous at a backslash (both arms
    // matched it), so an unterminated quote after a long backslash run forced
    // exponential backtracking (F1-REDOS-1, a synchronous event-loop DoS).
    // Excluding the backslash makes `(?:\\.)` the only arm that consumes a
    // backslash, so the alternation is unambiguous and the match is linear.
    // Round 14: pass/pw aliases are credentials too; unquoted := values consume
    // through end-of-line so a multi-word passphrase cannot leak its tail.
    // The sequential re-audit split single/double-quoted branches so the other
    // quote is legal content, added truncated-quote handling, and bounded EOL at
    // both CR and LF.
    pattern: /(?<![?&;])\b(api[_-]?key|secret|token|passwd|password|pwd|pass|pw|auth|credential|passphrase|jwt|cookie|dsn)("|'?)([ \t]*[:=][ \t]*)(?:"(?:(?:\\.)|[^"\r\n\\]){1,}"|'(?:(?:\\.)|[^'\r\n\\]){1,}'|"(?:(?:\\.)|[^"\r\n\\]){1,}(?=\r?(?:\n|$))|'(?:(?:\\.)|[^'\r\n\\]){1,}(?=\r?(?:\n|$))|[^'"\s\\](?:(?:\\.)|[^'"\r\n\\])*)/gi,
    presets: ['strict', 'normal'],
    replace: (_m, key, _kq, sep, _q, _v) => `${key}${sep}[REDACTED:generic-secret]`,
  },
  {
    category: 'generic-secret',
    // Round 10 (R10-PLUGIN-1): the space-separated CLI-arg form. A literal
    // password/key passed as a CLI flag value (`--password hunter2secret`,
    // `--api-key abc…`) is captured verbatim in the harness's session log as a
    // bash command; if that session is later published, the generic-secret rule
    // above misses it (its separator requires `:` or `=`, not a space). The `--`
    // flag prefix is the discriminator: prose never contains `--password
    // <value>`, so this does not false-positive on "the password hunter2secret
    // was used". The value charset and 8-char floor match generic-secret; the
    // optional surrounding quotes are consumed with the value. Runs AFTER
    // generic-secret (which claims the `[:=]` forms first) and after
    // connection-string/bearer-token; overlapping matches are emitted as one
    // complete redacted union, never double-redacted or partially leaked.
    // Round 11 (R11-1/2/6): hardened. (1) The value is now a 3-branch
    // alternation: a terminated quoted run (which may span a real newline —
    // valid bash; the old `[^'"\s]` charset stopped at \n so the closing quote
    // never matched and the whole secret leaked), an opened-but-unterminated
    // quoted run at end-of-string (the 20 KB output cap can cut the closing
    // quote), and the original unquoted run. (2) The flag name accepts compound
    // secret names (`--auth-token`, `--access-key`, `--secret-key`,
    // `--api-secret`): a high-precision secret word optionally followed by a
    // `-`/`_`-joined secret suffix — the old rule required the name to be
    // immediately followed by whitespace, so `--auth-token` never matched.
    // (3) The name list is NARROWED to the high-precision subset: `access`,
    // `session`, `conn`, `private` are dropped because in the space-separated
    // form their values are usually non-secrets (ids, modes, paths) — a
    // false positive the `[:=]` form hits far less often.
    // Round 12 (F1): the floor is dropped 8→1 in all three value branches and
    // the separator now accepts `=` as well as whitespace. The harness records
    // the bash command line into the session store BEFORE the command runs, and
    // /share publishes the CURRENT session — so a short literal password
    // (`--password s3cret`, `--password=short`) lands in the published
    // transcript and the reader could read it and unlock the share. The
    // `--<secret-name> <value>` / `--<secret-name>=<value>` forms are
    // unambiguous (prose never contains them), so no floor is needed for
    // false-positive control. The separator is non-capturing
    // `(?:(?:\s+)|\=)`. A hyphenated flag with no value (`--password-stdin`) is
    // still NOT matched: the separator requires whitespace or `=`, not `-`.
    // Round 13 (re-audit F1-UNDER-3, F1-OVER-1, F1-REDOS-1): (a) `passphrase`
    // is added to the name list (`gpg --passphrase …` was leaking). (b) The
    // separator is narrowed from `\s+` to `[ \t]+` so it does NOT match a
    // newline: an unquoted `--password` at end-of-line previously redacted the
    // NEXT line's first token (`tool --password\necho` → `echo` redacted).
    // (c) Each value branch's char class now EXCLUDES the backslash
    // (`[^'"\\]` / `[^'"\n\\]` / `[^'"\s\\]`) so the `(?:(?:\\.)|…)` alternation
    // is unambiguous at a backslash — the old ambiguity forced exponential
    // backtracking on an unterminated quote after a long backslash run
    // (F1-REDOS-1), a synchronous event-loop DoS.
    pattern: /--(api[_-]?key|auth[-_]?token|access[-_]?key|secret[-_]?key|api[-_]?secret|secret|token|passwd|password|pwd|pass|pw|passphrase|auth|credential|jwt|cookie|dsn)(?:(?:[ \t]+)|\=)(?:"(?:(?:\\.)|[^"\\]){1,}"|'(?:(?:\\.)|[^'\\]){1,}'|"(?:(?:\\.)|[^"\r\n\\]){1,}(?=\r?(?:\n|$))|'(?:(?:\\.)|[^'\r\n\\]){1,}(?=\r?(?:\n|$))|[^'"\s\\](?:(?:\\.)|[^'"\s\\])*)/gi,
    presets: ['strict', 'normal'],
    replace: (_m, key) => `--${key} [REDACTED:generic-secret]`,
  },
  {
    category: 'generic-secret',
    // Round 13 (re-audit F1-UNDER-1): a dedicated rule for PREFIXED / COMPOUND
    // secret names in the `[:=]` form — env vars and JSON fields where the
    // secret word is embedded in a longer identifier (PGPASSWORD, DB_PASSWORD,
    // MYSQL_PWD, REDIS_PASSWORD) or carries a secret suffix (SECRET_KEY,
    // AUTH_TOKEN, ACCESS_TOKEN, SESSION_TOKEN, ACCESS_KEY, PRIVATE_KEY). The
    // first generic-secret rule misses these: its \b anchor requires the name
    // to START at a word boundary, so `password` inside `PGPASSWORD` (preceded
    // by `PG`) has no boundary and never matches — and a <24-char value then
    // slips past bare-token.
    //
    // The NAME is a high-precision secret word, optionally preceded by an
    // identifier prefix ([A-Za-z0-9]*[_-]?) and optionally followed by a secret
    // suffix ([_-]?(?:KEY|TOKEN|SECRET)?). `access`/`session` are deliberately
    // NOT secret words: they only work as PREFIXES via the [A-Za-z0-9]* arm, so
    // ACCESS_TOKEN / SESSION_TOKEN are caught but a bare `access:` / `session:`
    // (a mode / id, not a secret) is not. The suffix set excludes `id`, so
    // `session_id` / `access_id` are not over-redacted. `KEY` is a secret word
    // ONLY when it carries a non-empty identifier prefix (`ACCESS_KEY`,
    // `MY_KEY`, `PRIVATE_KEY`) — bare `key` is deliberately NOT matched here,
    // because the narrow `key` rule below owns the bare form (and its
    // alnum-start / no-quoted-value discipline spares JSX `key={…}` and
    // `key: "…"`). Requiring the prefix also keeps `KEYBOARD=` (key as a
    // prefix of a longer word) unmatched: the separator `[:=]` must follow the
    // word, and `BOARD` sits between `KEY` and `=`.
    //
    // The rule only matches compound names (bare KEY remains owned by the narrow
    // rule below), so unquoted values can safely consume through end-of-line.
    // A quoted value stays bounded by its closing quote.
    // Runs after the first generic-secret rule (which claims the bare
    // high-precision names first) and after connection-string/bearer — the
    // overlap union covers the full credential span. The backslash is excluded from
    // both value char classes so the `(?:(?:\\.)|…)` alternation stays
    // unambiguous (linear, no ReDoS — F1-REDOS-1).
    // Round 14: a leading word boundary prevents quadratic retries inside long
    // alphanumeric runs, and pass/pw aliases cover compound credential names.
    pattern: /\b((?:[A-Za-z0-9]+[_-]?KEY|[A-Za-z0-9]*[_-]?(?:PASSWORD|PASSWD|PWD|TOKEN|SECRET|AUTH|CREDENTIAL|APIKEY|API_KEY|JWT|COOKIE|DSN|PRIVATE|PASSPHRASE)|[A-Za-z0-9]+[_-](?:PASS|PW)|(?:DB|MYSQL|POSTGRES|PG|SMTP|ADMIN)(?:PASS|PW))[_-]?(?:KEY|TOKEN|SECRET)?)(["']?)([ \t]*[:=][ \t]*)(?:"(?:(?:\\.)|[^"\r\n\\]){1,}"|'(?:(?:\\.)|[^'\r\n\\]){1,}'|"(?:(?:\\.)|[^"\r\n\\]){1,}(?=\r?(?:\n|$))|'(?:(?:\\.)|[^'\r\n\\]){1,}(?=\r?(?:\n|$))|[^'"\s\\](?:(?:\\.)|[^'"\r\n\\])*)/gi,
    presets: ['strict', 'normal'],
    replace: (_m, name, _kq, sep) => `${name}${sep}[REDACTED:generic-secret]`,
  },
  {
    category: 'key',
    // Round 7: a NARROW standalone-`key` rule. `key=…` / `key: …` with a
    // token-like value is a credential, but a BROAD `key` rule (or adding `key`
    // to generic-secret, whose value charset is any non-quote/non-whitespace)
    // would corrupt JSX `key={…}` expressions and quoted values. So the value
    // charset here is deliberately token-like ([A-Za-z0-9._-], no quotes, no
    // braces, no spaces) AND must START alphanumeric: it catches `key:
    // <real-token>` and `key=<token>` but leaves `key={expr}`, `key: "quoted"`,
    // `key: a.b.c` (dotted member access), and — importantly — `key:
    // -----BEGIN…` (a PEM header, which starts with `-`) untouched. The
    // alnum-start guard keeps this narrow rule from claiming the start of a
    // higher-priority span (a PEM block, a `postgres://` scheme, …) that begins
    // a few chars in; the priority-based merge in redactText is the backstop
    // that drops any such overlap. Runs after generic-secret so `api_key` is
    // claimed by the specific rule first. Known limitation: a QUOTED `key:"…"`
    // value is not matched here (and `key` is not in generic-secret's name
    // list), so it is left to the bare-token fallback if the value is 24+ chars.
    // Round 10 (R10-3): the value charset now includes `/` and `+` (base64).
    // The old charset [A-Za-z0-9._-] stopped at the first slash, so
    // `key=<base64>` was only PARTIALLY redacted (the tail after the first `/`
    // leaked). Base64 values are the dominant real-world `key=` secret shape.
    // The alnum-START guard still rejects PEM headers (`key: -----BEGIN…`) and
    // JSX/quoted values, so no new false-positive class is introduced.
    pattern: /\b(key)(\s*[:=]\s*)([A-Za-z0-9][A-Za-z0-9._/+-]{7,})/gi,
    presets: ['strict', 'normal'],
    replace: (_m, key, sep, _v) => `${key}${sep}[REDACTED:key]`,
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
    // Round 7: the quantifier is capped at 10000 (was {24,} unbounded). A
    // secret is never 10000+ chars, so no real redaction is lost; the cap
    // bounds the V8 backtracker depth at the start of an abnormally long run
    // (the engine backtracks the {24,10000} quantifier when the trailing \b
    // fails mid-run) so a pathological multi-MB run cannot force a long
    // single-position backtrack. Interior positions still fail O(1) at \b.
    pattern: /\b[A-Za-z0-9._-]{24,10000}\b/g,
    presets: ['strict', 'normal'],
    // Round 9 (F8): a 24+ char run of hex digits WITH separators (._-) is a
    // secret too — a body-only PEM fragment (the header truncated away, e.g. a
    // key split across parts) is exactly this shape. The old test declined it
    // (neither pure-hex nor g-z), so the fragment leaked. Decline only the
    // exact UUID shape (8-4-4-4-12), which is an identifier, not a secret.
    test: (run) =>
      /[g-zG-Z]/.test(run) ||
      (/^[0-9a-fA-F._-]{24,}$/.test(run) &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(run)),
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
