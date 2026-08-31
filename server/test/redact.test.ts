import { describe, it, expect } from 'vitest';
import { prepareContent } from '../src/redact/prepare.js';
import type { ShapedMessage, ShapedSession } from '../src/redact/prepare.js';
import { redactText, walkStrings } from '../src/redact/redact.js';

const secrets = {
  privateKey: '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA7fakekeymaterial000000\n-----END RSA PRIVATE KEY-----',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgDBwYDyrpldOcE5cRjQ',
  aws: 'AKIAABCDEFGHIJKLMNOP',
  openai: 'sk-abcdefghijklmnopqrstuvwx',
  anthropic: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456',
  conn: 'postgres://admin:hunter2secret@db.internal:5432/app',
  bearer: 'Authorization: Bearer abcdef1234567890abcdef1234567890',
  generic: 'api_key = "supersecretvalue1234567890"',
  privateIp: '192.168.1.10',
  winPath: 'C:\\Users\\me\\project\\file.ts',
  unixPath: '/home/me/project/file.ts',
};

const fixtureMessages: ShapedMessage[] = [
  { role: 'user', parts: [{ type: 'text', text: `deploy now ${secrets.aws} and ${secrets.anthropic}` }] },
  {
    role: 'assistant',
    parts: [
      { type: 'text', text: `here is the token ${secrets.jwt} and ${secrets.openai}` },
      {
        type: 'tool',
        callID: 'call_1',
        tool: 'Bash',
        status: 'completed',
        input: { command: `psql ${secrets.conn} && curl -H "${secrets.bearer}" https://x && echo ${secrets.generic}` },
        output: `${secrets.privateKey}\nconnected to ${secrets.privateIp} at ${secrets.winPath} and ${secrets.unixPath}`,
      },
    ],
  },
];

// Round 3: prepareContent takes the full shaped session (so it can redact the
// session-level title/model/provider, which the per-part pass never walks).
const fixture: ShapedSession = { sessionId: 's1', title: 'test session', messages: fixtureMessages };

describe('prepareContent', () => {
  it('strict: redacts every category and counts each', () => {
    const { messages, summary } = prepareContent(fixture, 'strict');
    const all = JSON.stringify(messages);
    for (const raw of Object.values(secrets)) expect(all).not.toContain(raw);
    expect(summary['private-key']).toBe(1);
    expect(summary['jwt']).toBe(1);
    expect(summary['aws-access-key']).toBe(1);
    expect(summary['openai-key']).toBe(1);
    expect(summary['anthropic-key']).toBe(1);
    expect(summary['connection-string']).toBe(1);
    expect(summary['bearer-token']).toBe(1);
    expect(summary['generic-secret']).toBe(1);
    expect(summary['private-ip']).toBe(1);
    expect(summary['local-path']).toBe(2);
    // structure survives redaction
    expect(messages[1]!.parts[1]!.type).toBe('tool');
    expect(messages[1]!.parts[1]!.tool).toBe('Bash');
  });

  it('strict: connection-string keeps scheme and host, redacts only credentials', () => {
    const { messages } = prepareContent(fixture, 'strict');
    const out = messages[1]!.parts[1]!.input as { command: string };
    expect(out.command).toContain('postgres://[REDACTED:connection-string]@db.internal:5432/app');
    // Round 3: the value's own quotes are consumed with the value, so no stray
    // quote survives the redaction.
    expect(out.command).toContain('api_key = [REDACTED:generic-secret]');
    expect(out.command).not.toContain('[REDACTED:generic-secret]"');
  });

  it('normal: skips private-ip and local-path', () => {
    const { messages, summary } = prepareContent(fixture, 'normal');
    const all = JSON.stringify(messages);
    expect(all).toContain(secrets.privateIp);
    // Check the raw output (not JSON.stringify'd text): JSON escaping turns
    // `\` into `\\`, so the single-backslash Windows path can never appear in `all`.
    expect(messages[1]!.parts[1]!.output).toContain(secrets.winPath);
    expect(summary['private-ip']).toBeUndefined();
    expect(summary['local-path']).toBeUndefined();
    expect(all).not.toContain(secrets.aws);
  });

  it('none: changes nothing and reports empty summary', () => {
    const { messages, summary, messageCount } = prepareContent(fixture, 'none');
    expect(messages).toEqual(fixtureMessages);
    expect(summary).toEqual({});
    expect(messageCount).toBe(2);
  });

  it('ordering: a private-key block is not half-matched by generic-secret', () => {
    const tricky: ShapedSession = {
      sessionId: 's',
      title: 't',
      messages: [
        {
          role: 'user',
          parts: [{ type: 'text', text: `-----BEGIN OPENSSH PRIVATE KEY-----\napi_key: abcdefghijklmnop1234\n-----END OPENSSH PRIVATE KEY-----` }],
        },
      ],
    };
    const { summary } = prepareContent(tricky, 'strict');
    expect(summary['private-key']).toBe(1);
    expect(summary['generic-secret']).toBeUndefined();
  });

  it('computes bytes and messageCount', () => {
    const r = prepareContent(fixture, 'strict');
    expect(r.bytes).toBe(Buffer.byteLength(JSON.stringify(r.messages)));
    expect(r.messageCount).toBe(2);
  });

  it('strips NUL and C0 control chars (except \\n \\r \\t) from every string, all presets', () => {
    // Postgres rejects NUL in text/jsonb; real ZCode tool output can carry them.
    const withNul: ShapedSession = {
      sessionId: 's',
      title: 't',
      messages: [
        { role: 'user', parts: [{ type: 'text', text: 'a\u0000b\u0007c' }] },
        {
          role: 'assistant',
          parts: [
            { type: 'tool', callID: 'c1', tool: 'Bash', status: 'completed', input: { cmd: 'x\u0000y' }, output: 'out\u0000\u001Bine' },
          ],
        },
      ],
    };
    for (const preset of ['strict', 'normal', 'none'] as const) {
      const { messages } = prepareContent(withNul, preset);
      const all = JSON.stringify(messages);
      // No NUL or other stripped C0 chars survive.
      expect(all).not.toContain('\u0000');
      expect(all).not.toContain('\u0007');
      expect(all).not.toContain('\u001B');
      // Content around the stripped chars is preserved, and \n \r \t are kept.
      expect(messages[0]!.parts[0]!.text).toBe('abc');
      const tool = messages[1]!.parts[0]!;
      expect((tool.input as { cmd: string }).cmd).toBe('xy');
      expect(tool.output).toBe('outine');
    }
    // \n \r \t are deliberately preserved (they are legitimate).
    const withNewlines: ShapedSession = { sessionId: 's', title: 't', messages: [{ role: 'user', parts: [{ type: 'text', text: 'l1\nl2\rl3\tl4' }] }] };
    expect(prepareContent(withNewlines, 'none').messages[0]!.parts[0]!.text).toBe('l1\nl2\rl3\tl4');
  });

  it('passes an image part data URI through untouched (not redacted)', () => {
    // A base64 payload that trips NO rule: `+`/`/` interleave every alphanumeric
    // run under 24 chars, so bare-token's hex and g-z branches both miss, and no
    // keyword/prefix rule fires. The data URI must survive verbatim.
    const payload = 'QUJD+REVG/R0hJ+SktM/TU5O+PUFQ/SR8';
    const dataUri = `data:image/png;base64,${payload}`;
    const withImage: ShapedSession = {
      sessionId: 's',
      title: 't',
      messages: [
        {
          role: 'assistant',
          parts: [
            { type: 'image', src: dataUri, mime: 'image/png', alt: 'shot', bytes: 150 },
            { type: 'image', mime: 'image/png', alt: 'big', bytes: 9_999_999, tooLarge: true },
          ],
        },
      ],
    };
    for (const preset of ['strict', 'normal', 'none'] as const) {
      const { messages, summary } = prepareContent(withImage, preset);
      const img = messages[0]!.parts[0]!;
      expect(img.type).toBe('image');
      expect(img.src).toBe(dataUri); // not mangled by any rule
      expect(img.mime).toBe('image/png');
      expect(img.alt).toBe('shot');
      expect(img.bytes).toBe(150);
      // The tooLarge part (no src) keeps its fields.
      const big = messages[0]!.parts[1]!;
      expect(big.tooLarge).toBe(true);
      expect(big.src).toBeUndefined();
      // The data URI must NOT have produced any redaction counts.
      expect(summary).toEqual({});
    }
  });

  it('redacts image alt/mime metadata (standalone and attached) — src untouched (Chain A)', () => {
    const dataUri = 'data:image/png;base64,QUJD';
    const alt = `screenshot of ${secrets.openai} and ${secrets.conn}`;
    const withMeta: ShapedSession = {
      sessionId: 's',
      title: 't',
      messages: [
        {
          role: 'assistant',
          parts: [
            { type: 'image', src: dataUri, mime: 'image/png', alt, bytes: 3 },
            {
              type: 'tool', callID: 'c1', tool: 'Read', status: 'completed',
              input: { file_path: '/tmp/x.png' }, output: 'ok',
              images: [{ src: dataUri, mime: 'image/png', alt: `log ${secrets.aws}`, bytes: 3 }],
            },
          ],
        },
      ],
    };
    for (const preset of ['strict', 'normal'] as const) {
      const { messages } = prepareContent(withMeta, preset);
      const img = messages[0]!.parts[0]!;
      expect(img.src).toBe(dataUri); // payload untouched
      expect(img.alt).not.toContain(secrets.openai);
      expect(img.alt).not.toContain(secrets.conn);
      expect(img.mime).toBe('image/png');
      const attached = (messages[0]!.parts[1]!.images ?? [])[0]!;
      expect(attached.src).toBe(dataUri);
      expect(attached.alt).not.toContain(secrets.aws);
    }
    // 'none' changes nothing (redaction is preset-gated).
    expect(prepareContent(withMeta, 'none').messages[0]!.parts[0]!.alt).toBe(alt);
  });
});

describe('Chain F widened rules', () => {
  const one = (text: string, preset: 'strict' | 'normal' = 'strict') =>
    prepareContent({ sessionId: 's', title: 't', messages: [{ role: 'user', parts: [{ type: 'text', text }] }] }, preset);

  it('redacts an 8-char generic secret (floor lowered to 8)', () => {
    const out = one('password=abcd1234');
    expect(JSON.stringify(out.messages)).not.toContain('abcd1234');
    expect(out.summary['generic-secret']).toBe(1);
  });
  it('redacts the CLI-generated share password the CLI prints to stdout (Round 10 R10-CLI-2)', () => {
    // cli/src/commands/publish.ts prints a freshly generated share password to
    // stdout as `Password: <22-char base64url>`. The harness captures stdout
    // into its own session log; if that session is later published, the server
    // must redact this exact line or the password leaks into the share. This
    // test pins the cross-package coupling (CLI print format ↔ generic-secret
    // rule): if the CLI's line ever changes (e.g. `Your password is: …`), this
    // fails.
    const generated = 'aB3-dEfGhIjKlMnOpQr56s'; // 22-char base64url
    const line = `Password: ${generated}`;
    for (const preset of ['strict', 'normal'] as const) {
      const out = one(line, preset);
      expect(JSON.stringify(out.messages)).not.toContain(generated);
      expect(out.summary['generic-secret']).toBe(1);
    }
  });
  it('redacts a query-string DSN credential (?password=)', () => {
    const out = one('postgres://db.example.com/app?password=hunter22');
    expect(JSON.stringify(out.messages)).not.toContain('hunter22');
  });
  it('redacts a non-eyJ JWT', () => {
    const out = one('token abcdefgh1234.ijklmnop5678.rstuvwx9012');
    expect(JSON.stringify(out.messages)).not.toContain('abcdefgh1234.ijklmnop5678');
  });
  it('redacts a bare high-entropy token (no bearer keyword)', () => {
    // Round 2: the bare-token rule is pure-hex; a hex-encoded secret is caught.
    const out = one('use c8f5e0a1b2c3d4e5f60718293a4b5c6d here');
    expect(JSON.stringify(out.messages)).not.toContain('c8f5e0a1b2c3d4e5f60718293a4b5c6d');
    expect(out.summary['bare-token']).toBe(1);
  });
  it('does NOT redact ordinary 24-char prose identifiers (false-positive guard)', () => {
    const out = one('the quick brown fox jumps over the lazy dog near');
    expect(JSON.stringify(out.messages)).toContain('the quick brown fox');
  });
});

describe('Round 10 space-separated CLI-arg secrets (R10-PLUGIN-1)', () => {
  const one = (text: string, preset: 'strict' | 'normal' = 'strict') =>
    prepareContent({ sessionId: 's', title: 't', messages: [{ role: 'user', parts: [{ type: 'text', text }] }] }, preset);

  it('redacts a space-separated --password value (the plugin passes literal passwords as CLI args)', () => {
    // The /share plugin maps a literal user password to `--password hunter2`
    // (a space-separated CLI arg). The harness captures bash commands into its
    // session log; if that session is later published, the server must redact
    // the value. The generic-secret rule's separator requires `:` or `=`, so the
    // space-separated form needs its own rule. The `--` flag prefix is the
    // discriminator: prose never contains `--password <value>`.
    for (const preset of ['strict', 'normal'] as const) {
      const out = one('quire publish --current --password hunter2secret --yes', preset);
      expect(JSON.stringify(out.messages)).not.toContain('hunter2secret');
      expect(out.summary['generic-secret']).toBe(1);
    }
  });

  it('redacts a space-separated --api-key value', () => {
    const out = one('curl --api-key abcdef1234567890 https://x');
    expect(JSON.stringify(out.messages)).not.toContain('abcdef1234567890');
    expect(out.summary['generic-secret']).toBe(1);
  });

  it('redacts a quoted space-separated --password value', () => {
    const out = one('quire publish --current --password "hunter2secret" --yes');
    expect(JSON.stringify(out.messages)).not.toContain('hunter2secret');
  });

  it('does NOT redact prose that merely mentions a password word (false-positive guard)', () => {
    // No `--` flag prefix: the sentence must survive untouched.
    const out = one('the password hunter2secret was used to log in');
    expect(JSON.stringify(out.messages)).toContain('hunter2secret');
    expect(out.summary['generic-secret']).toBeUndefined();
  });

  it('does NOT redact a hyphenated flag with no value (e.g. --password-stdin)', () => {
    const out = one('ssh --password-stdin user@host');
    expect(out.summary['generic-secret']).toBeUndefined();
  });

  it('redacts a SHORT --password value (Round 12 F1: no floor in the unambiguous --flag form)', () => {
    // F1: the harness records the bash command line into the session store
    // BEFORE the command runs, and /share publishes the CURRENT session — so a
    // short literal password (`--password s3cret`) lands in the published
    // transcript and the reader could read it and unlock the share. The
    // `--<secret-name> <value>` form is unambiguous (prose never contains it),
    // so the 8-char floor is dropped to 1.
    for (const preset of ['strict', 'normal'] as const) {
      const out = one('quire publish --current --password s3cret --yes', preset);
      expect(JSON.stringify(out.messages)).not.toContain('s3cret');
      expect(out.summary['generic-secret']).toBe(1);
    }
  });
});

describe('Round 11 CLI-arg hardening (R11-1/2/6)', () => {
  const one = (text: string, preset: 'strict' | 'normal' = 'strict') =>
    prepareContent({ sessionId: 's', title: 't', messages: [{ role: 'user', parts: [{ type: 'text', text }] }] }, preset);

  // R11-1: a quoted value that spans a real newline. Valid bash; the value
  // charset of the original rule stopped at \n, so the closing quote never
  // matched and the whole secret survived.
  it('redacts a quoted --password value that spans a newline (R11-1)', () => {
    const out = one('run --password "hunter2secret\nmore args" --yes');
    expect(JSON.stringify(out.messages)).not.toContain('hunter2secret');
    expect(out.summary['generic-secret']).toBe(1);
  });

  // R11-1: the 20 KB output cap can truncate the part mid-value, cutting the
  // closing quote and leaving an opened-but-unterminated quoted run at the end
  // of the string. The original rule required the closing quote, so it leaked.
  it('redacts an unterminated quoted --password value truncated at end-of-string (R11-1)', () => {
    const out = one('run --password "hunter2secret');
    expect(JSON.stringify(out.messages)).not.toContain('hunter2secret');
    expect(out.summary['generic-secret']).toBe(1);
  });

  // R11-2: compound flag names. The original rule required the name to be
  // immediately followed by whitespace, so `--auth-token` (name `auth` + `-token`
  // suffix) never matched and the value leaked.
  it('redacts a compound --auth-token value (R11-2)', () => {
    const out = one('run --auth-token hunter2secret12345');
    expect(JSON.stringify(out.messages)).not.toContain('hunter2secret12345');
    expect(out.summary['generic-secret']).toBe(1);
  });
  it('redacts a compound --access-key value (R11-2)', () => {
    const out = one('run --access-key hunter2secret12345');
    expect(JSON.stringify(out.messages)).not.toContain('hunter2secret12345');
  });
  it('redacts a compound --secret-key value (R11-2)', () => {
    const out = one('run --secret-key hunter2secret12345');
    expect(JSON.stringify(out.messages)).not.toContain('hunter2secret12345');
  });

  // R11-6: false-positive guards. The space-separated form hits non-secret
  // values (ids, modes, paths) far more often than the `[:=]` form, so the name
  // list is narrowed to the high-precision subset. These must survive.
  it('does NOT redact a --session value (a session id is not a secret) (R11-6)', () => {
    const out = one('run --session abcdef1234');
    expect(JSON.stringify(out.messages)).toContain('abcdef1234');
    expect(out.summary['generic-secret']).toBeUndefined();
  });
  it('does NOT redact a bare --access value (a mode, not a secret) (R11-6)', () => {
    const out = one('run --access restricted');
    expect(JSON.stringify(out.messages)).toContain('restricted');
    expect(out.summary['generic-secret']).toBeUndefined();
  });
  it('does NOT redact a --private value (not in the narrowed name list) (R11-6)', () => {
    const out = one('run --private somevalue123');
    expect(JSON.stringify(out.messages)).toContain('somevalue123');
    expect(out.summary['generic-secret']).toBeUndefined();
  });
});

describe('Round 12 CLI-arg floor + base64 bearer (F1/F2)', () => {
  const one = (text: string, preset: 'strict' | 'normal' = 'normal') =>
    prepareContent({ sessionId: 's', title: 't', messages: [{ role: 'user', parts: [{ type: 'text', text }] }] }, preset);

  // F1: the `=`-form CLI arg (`--password=short`). The original rule's
  // separator required a space, so the equals form never matched and the
  // value leaked. The `--<secret-name>=<value>` form is unambiguous, so the
  // separator now accepts `=` as well as whitespace.
  it('redacts an equals-form --password= value (Round 12 F1)', () => {
    for (const preset of ['strict', 'normal'] as const) {
      const out = one('quire publish --password=short --yes', preset);
      expect(JSON.stringify(out.messages)).not.toContain('short');
      expect(out.summary['generic-secret']).toBe(1);
    }
  });

  // F1: a short QUOTED value (`--password "s3cret"`). The quoted branch had the
  // same 8-char floor; a 6-char quoted password leaked.
  it('redacts a short quoted --password value (Round 12 F1)', () => {
    for (const preset of ['strict', 'normal'] as const) {
      const out = one('quire publish --password "s3cret" --yes', preset);
      expect(JSON.stringify(out.messages)).not.toContain('s3cret');
      expect(out.summary['generic-secret']).toBe(1);
    }
  });

  // F1 false-positive guard: the hyphenated flag with no value is still NOT
  // matched (the separator requires whitespace or `=`, not `-`).
  it('does NOT redact --password-stdin (separator is not a hyphen) (Round 12 F1 guard)', () => {
    const out = one('ssh --password-stdin user@host');
    expect(out.summary['generic-secret']).toBeUndefined();
  });

  // F2: a standard-base64 (not base64url) Authorization: Bearer token uses `/`
  // and `+`. The header-form value charset [A-Za-z0-9._-] stopped at the first
  // `/`, so the tail after it leaked (18 chars — under the bare-token 24 floor,
  // so no other rule caught it). The header form is unambiguous
  // (`Authorization: Bearer`), so widen its charset to include `/` and `+`.
  it('redacts a base64 Authorization: Bearer token containing / and + (Round 12 F2)', () => {
    const token = 'abcdefghijklmnopqrst/uvwxyz0123456789AB+Q';
    for (const preset of ['strict', 'normal'] as const) {
      const out = one(`Authorization: Bearer ${token}`, preset);
      expect(JSON.stringify(out.messages)).not.toContain(token);
      // The tail after the first / must not leak either.
      expect(JSON.stringify(out.messages)).not.toContain('uvwxyz0123456789AB');
      expect(out.summary['bearer-token']).toBe(1);
    }
  });

  // F2 false-positive guard: the BARE-prose `bearer <token>` branch keeps the
  // narrower charset (no / +) and the 20-char floor — only the header form was
  // widened. A bare `bearer` in prose with a short token is still untouched.
  it('does NOT redact a bare prose bearer with a short token (Round 12 F2 guard)', () => {
    const out = one('the bearer of the note abc12345');
    expect(JSON.stringify(out.messages)).toContain('abc12345');
    expect(out.summary['bearer-token']).toBeUndefined();
  });
});

describe('Round 13 re-audit: env-var + compound names, floor, passphrase, ReDoS, over-redact', () => {
  const one = (text: string, preset: 'strict' | 'normal' = 'normal') =>
    prepareContent({ sessionId: 's', title: 't', messages: [{ role: 'user', parts: [{ type: 'text', text }] }] }, preset);
  const msg = (out: ReturnType<typeof one>) => JSON.stringify(out.messages);
  // 40 backslashes, built at runtime (no backslash literals in this source).
  const BS = String.fromCharCode(92).repeat(40);

  // F1-UNDER-1 (HIGH): prefixed/compound env-var secret names. The secret word
  // is embedded in a longer identifier (PG+PASSWORD) or carries a suffix
  // (SECRET_KEY), so the first generic-secret rule's \b anchor + immediate
  // separator requirement misses it, and a <24-char value slips past
  // bare-token. These must be redacted.
  it('redacts a prefixed env-var secret (PGPASSWORD=) (F1-UNDER-1)', () => {
    expect(msg(one('PGPASSWORD=hunter2 psql -h db -U user -d app'))).not.toContain('hunter2');
  });
  it('redacts DB_PASSWORD= / MYSQL_PWD= / REDIS_PASSWORD= (F1-UNDER-1)', () => {
    expect(msg(one('DB_PASSWORD=hunter2secret db-tool'))).not.toContain('hunter2secret');
    expect(msg(one('MYSQL_PWD=hunter2 mysql -u root app'))).not.toContain('hunter2');
    expect(msg(one('REDIS_PASSWORD=hunter2 redis-cli'))).not.toContain('hunter2');
  });
  it('redacts secret-word + suffix env-var names (SECRET_KEY= / AUTH_TOKEN=) (F1-UNDER-1)', () => {
    expect(msg(one('SECRET_KEY=hunter2 app'))).not.toContain('hunter2');
    expect(msg(one('AUTH_TOKEN=hunter2 app'))).not.toContain('hunter2');
  });
  it('redacts ACCESS_TOKEN / SESSION_TOKEN / ACCESS_KEY / PRIVATE_KEY (F1-UNDER-1)', () => {
    expect(msg(one('ACCESS_TOKEN=hunter2 app'))).not.toContain('hunter2');
    expect(msg(one('SESSION_TOKEN=hunter2 app'))).not.toContain('hunter2');
    expect(msg(one('ACCESS_KEY=hunter2 app'))).not.toContain('hunter2');
    expect(msg(one('PRIVATE_KEY=hunter2 app'))).not.toContain('hunter2');
  });
  it('redacts a prefixed env-var secret after `export` (F1-UNDER-1)', () => {
    expect(msg(one('export PGPASSWORD=hunter2 && psql -h db'))).not.toContain('hunter2');
  });
  it('redacts a compound JSON secret name (access_token:) (F1-UNDER-1)', () => {
    expect(msg(one('{"access_token": "hunter2secret"}'))).not.toContain('hunter2secret');
  });

  // F1-UNDER-1 false-positive guards: identifiers that merely CONTAIN a secret
  // word as a non-suffix, or a low-precision bare name, must survive.
  it('does NOT redact a KEYBOARD= identifier (key is not a suffix) (F1-UNDER-1 guard)', () => {
    expect(msg(one('KEYBOARD=uslayout mode'))).toContain('uslayout');
  });
  it('does NOT redact a bare session: id (low-precision name) (F1-UNDER-1 guard)', () => {
    expect(msg(one('{"session": "abc123"}'))).toContain('abc123');
  });
  it('does NOT redact a session_id: identifier (id is not a secret suffix) (F1-UNDER-1 guard)', () => {
    expect(msg(one('{"session_id": "abc123"}'))).toContain('abc123');
  });

  // F1-UNDER-2 (MEDIUM): a short (1-7 char) value after a high-precision name
  // in the := form. The first rule's floor was 8, so short values leaked.
  it('redacts a short PASSWORD= value (7 chars) (F1-UNDER-2)', () => {
    expect(msg(one('PASSWORD=abc1234 psql'))).not.toContain('abc1234');
  });
  it('redacts a short API_KEY= value (6 chars) (F1-UNDER-2)', () => {
    expect(msg(one('API_KEY=abc123 app'))).not.toContain('abc123');
  });

  // F1-UNDER-3 (MEDIUM): --passphrase was missing from the CLI name list.
  it('redacts a --passphrase value (F1-UNDER-3)', () => {
    expect(msg(one('gpg --batch --yes --passphrase mysecretpassphrase --decrypt f.gpg'))).not.toContain('mysecretpassphrase');
  });

  // F1-OVER-1 (MEDIUM): the CLI separator \s+ matched a newline, so an unquoted
  // --password at end-of-line redacted the NEXT line's first token.
  it('does NOT redact the next line after --password at end-of-line (F1-OVER-1)', () => {
    expect(msg(one('tool --password\necho hello world'))).toContain('echo');
  });

  // F1-REDOS-1 (MEDIUM): the quoted-value branch (?:(?:\\.)|[^'"]) is ambiguous
  // at a backslash (both arms match), so an unterminated quote after a long
  // backslash run forces exponential backtracking — synchronous DoS on the
  // event loop. The char class must exclude the backslash so a backslash is
  // only consumed via (?:\\.) (linear).
  it('redacts an unterminated quoted --password value with a long backslash run in linear time (F1-REDOS-1)', () => {
    const start = Date.now();
    expect(msg(one(`run --password "${BS}`))).not.toContain(BS.slice(0, 20));
    expect(Date.now() - start).toBeLessThan(500);
  });
  it('redacts an unterminated quoted password: value with a long backslash run in linear time (F1-REDOS-1)', () => {
    // The first rule's match FAILS here (no closing quote), so the backslashes
    // are not redacted — the discriminator is that the engine finishes in
    // linear time instead of exponential backtracking.
    const start = Date.now();
    one(`password: "${BS}`);
    expect(Date.now() - start).toBeLessThan(500);
  });
});

describe('Round 14 re-audit: pass aliases, env-var ReDoS, multi-word values, Basic auth', () => {
  const one = (text: string, preset: 'strict' | 'normal' = 'normal') =>
    prepareContent({ sessionId: 's', title: 't', messages: [{ role: 'user', parts: [{ type: 'text', text }] }] }, preset);
  const msg = (out: ReturnType<typeof one>) => JSON.stringify(out.messages);

  it('redacts pass and pw aliases in assignment, compound, JSON, CLI, and query forms (R14-1)', () => {
    for (const input of [
      'pass: hunter2',
      'pw: hunter2',
      'dbpass=hunter2',
      'mysql_pass=hunter2',
      'POSTGRES_PASS=hunter2',
      '{"pass":"hunter2"}',
      'gpg --pass hunter2 --decrypt file.gpg',
      'https://db.example/app?pass=hunter2',
      'https://db.example/app?pw=hunter2',
    ]) {
      expect(msg(one(input)), input).not.toContain('hunter2');
    }
  });

  it('processes a long alphanumeric run before a compound secret in linear time (R14-2)', () => {
    const start = Date.now();
    expect(msg(one(`${'a'.repeat(40_000)} PGPASSWORD=hunter2`))).not.toContain('hunter2');
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it('redacts unquoted multi-word values through end-of-line (R14-3)', () => {
    expect(msg(one('passphrase: correct horse battery staple'))).not.toContain('horse battery staple');
    expect(msg(one('PGPASSWORD=correct horse battery staple'))).not.toContain('horse battery staple');
  });

  it('keeps a quoted value bounded by its closing quote (R14-3 guard)', () => {
    expect(msg(one('password: "correct horse" visible tail'))).toContain('visible tail');
  });

  it('redacts a short Basic Authorization credential and still redacts Bearer (R14-4)', () => {
    expect(msg(one('Authorization: Basic dXNlcjpwYXNz'))).not.toContain('dXNlcjpwYXNz');
    expect(msg(one('Authorization: Bearer abcdefgh'))).not.toContain('abcdefgh');
  });
});

describe('Round 2 widened rules', () => {
  const one = (text: string, preset: 'strict' | 'normal' = 'strict') =>
    prepareContent({ sessionId: 's', title: 't', messages: [{ role: 'user', parts: [{ type: 'text', text }] }] }, preset);

  it('redacts an AWS secret access key (40-char base64)', () => {
    const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    const out = one(`aws secret ${secret} here`);
    expect(JSON.stringify(out.messages)).not.toContain(secret);
    expect(out.summary['aws-secret-key']).toBe(1);
  });
  it('redacts a Google API key (AIza…)', () => {
    const key = 'AIzaSyA1234567890abcdefghijklmnopqrst';
    const out = one(`google ${key} end`);
    expect(JSON.stringify(out.messages)).not.toContain(key);
    expect(out.summary['google-api-key']).toBe(1);
  });
  it('redacts an empty-user connection string (redis://:pass@)', () => {
    const out = one(`cache redis://:secretpw@cache:6379 done`);
    expect(JSON.stringify(out.messages)).not.toContain('secretpw');
  });
  it('redacts an ODBC ;-separated connection string (Pwd=)', () => {
    const out = one(`Server=db;Database=app;Uid=user;Pwd=secretpw`);
    expect(JSON.stringify(out.messages)).not.toContain('secretpw');
  });
  it('redacts a PGP PRIVATE KEY BLOCK', () => {
    const block = '-----BEGIN PGP PRIVATE KEY BLOCK-----\nabc123def456\n-----END PGP PRIVATE KEY BLOCK-----';
    const out = one(`key: ${block}`);
    expect(JSON.stringify(out.messages)).not.toContain('abc123def456');
    expect(out.summary['private-key']).toBe(1);
  });
  it('redacts a lowercase private-key header', () => {
    const block = '-----begin rsa private key-----\nMIIBOgIBAAJBAKj34GkxF9zU\n-----end rsa private key-----';
    const out = one(`key: ${block}`);
    expect(JSON.stringify(out.messages)).not.toContain('MIIBOgIBAAJBAKj34GkxF9zU');
    expect(out.summary['private-key']).toBe(1);
  });
  it('redacts Authorization:Bearer (no space) and BEARER (uppercase)', () => {
    const t1 = 'Authorization:Bearer abcdef1234567890abcdef1234567890';
    const t2 = 'BEARER abcdef1234567890abcdef1234567890';
    const out = one(`${t1} and ${t2}`);
    expect(JSON.stringify(out.messages)).not.toContain('abcdef1234567890abcdef1234567890');
  });
  it('redacts a generic secret whose value contains special chars', () => {
    const out = one(`password=Sup3r!@Secret#2026`);
    expect(JSON.stringify(out.messages)).not.toContain('Sup3r!@Secret#2026');
    expect(out.summary['generic-secret']).toBe(1);
  });
  it('does NOT redact a UUID (false-positive guard)', () => {
    const uuid = '123e4567-e89b-12d3-a456-426614174000';
    const out = one(`id ${uuid} end`);
    expect(JSON.stringify(out.messages)).toContain(uuid);
    expect(out.summary['bare-token']).toBeUndefined();
  });
  it('redacts a 32-hex token (bare-token is now pure-hex)', () => {
    // 32 hex chars: ≥24 so bare-token's hex branch fires, but <40 so the
    // aws-secret-key rule (40-char base64) does NOT claim it first — the count
    // lands under bare-token, which is what this test asserts.
    const sha = 'c8f5e0a1b2c3d4e5f60718293a4b5c6d';
    const out = one(`commit ${sha} end`);
    expect(JSON.stringify(out.messages)).not.toContain(sha);
    expect(out.summary['bare-token']).toBe(1);
  });
  it('redacts a 40-hex token (claimed by aws-secret-key, which runs first)', () => {
    // A 40-char hex run is also a valid 40-char base64 run, so the earlier
    // aws-secret-key rule claims the span before bare-token can. Either way the
    // secret is redacted; this locks the attribution to aws-secret-key.
    const sha = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
    const out = one(`commit ${sha} end`);
    expect(JSON.stringify(out.messages)).not.toContain(sha);
    expect(out.summary['aws-secret-key']).toBe(1);
  });
  it('still redacts a prefixed token via its own rule (ghp_)', () => {
    const tok = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const out = one(`use ${tok} now`);
    expect(JSON.stringify(out.messages)).not.toContain(tok);
  });
  it('redacts a secret embedded in callID / tool / status', () => {
    const out = prepareContent(
      { sessionId: 's', title: 't', messages: [{ role: 'assistant', parts: [{ type: 'tool', callID: 'call_1', tool: 'Bash', status: 'ok', input: { c: 'x' }, output: 'y' }] }] },
      'strict',
    );
    // tool name that is itself a secret token
    const out2 = prepareContent(
      { sessionId: 's', title: 't', messages: [{ role: 'assistant', parts: [{ type: 'tool', tool: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', status: 'ok', input: {}, output: 'y' }] }] },
      'strict',
    );
    expect(JSON.stringify(out2.messages)).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
  });
  it('redacts a secret hidden in an image src data-URI (plaintext), clean base64 passes', () => {
    // A plaintext data-URI whose payload literally contains an OpenAI key. The
    // src scan catches it. (A base64-encoded secret is undetectable by pattern
    // matching — base64 encodes `sk-` into `c2st…` — so the scan is only
    // meaningful for the plaintext form.)
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';
    const evil = `data:text/plain;charset=utf-8,use ${secret} now`;
    const out = prepareContent(
      { sessionId: 's', title: 't', messages: [{ role: 'assistant', parts: [{ type: 'image', src: evil, mime: 'text/plain', alt: 'shot', bytes: 3 }] }] },
      'strict',
    );
    const src = out.messages[0]!.parts[0]!.src!;
    expect(src).not.toContain(secret);
    expect(src).toContain('REDACTED');
    // a clean base64 payload (no rule trips) passes through untouched —
    // the over-redaction guard: a real image's base64 must survive.
    const clean = 'data:image/png;base64,QUJD+REVG/R0hJ+SktM/TU5O+PUFQ/SR8';
    const out2 = prepareContent(
      { sessionId: 's', title: 't', messages: [{ role: 'assistant', parts: [{ type: 'image', src: clean, mime: 'image/png', alt: 'shot', bytes: 4 }] }] },
      'strict',
    );
    expect(out2.messages[0]!.parts[0]!.src).toBe(clean);
  });
});

describe('Round 3 fixes', () => {
  const one = (text: string, preset: 'strict' | 'normal' = 'strict') =>
    prepareContent({ sessionId: 's', title: 't', messages: [{ role: 'user', parts: [{ type: 'text', text }] }] }, preset);

  it('redacts a JSON-quoted generic secret ({"api_key":"…"})', () => {
    // H1: the dominant real-world secret format is JSON tool input/output, where
    // the key's closing quote sat between the name and the ':' so the old
    // separator never matched. Now the optional key-quote is consumed.
    const out = one(`{"api_key":"supersecretvalue1234567890"}`);
    expect(JSON.stringify(out.messages)).not.toContain('supersecretvalue1234567890');
    expect(out.summary['generic-secret']).toBe(1);
  });
  it('redacts a JSON-quoted password ({"password":"…"})', () => {
    const out = one(`{"password":"P@ssw0rd123456"}`);
    expect(JSON.stringify(out.messages)).not.toContain('P@ssw0rd123456');
    expect(out.summary['generic-secret']).toBe(1);
  });
  it('redacts a TRUNCATED private key (BEGIN present, END cut off)', () => {
    // H3: the CLI caps tool output at 20 KB, so a long key's END line is
    // routinely cut. The base64 body IS the secret and must be redacted.
    const truncated = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA7fakekeymaterial0000000000000000000000000000';
    const out = one(`key: ${truncated}`);
    expect(JSON.stringify(out.messages)).not.toContain('MIIEpAIBAAKCAQEA7fakekeymaterial0000000000000000000000000000');
    expect(out.summary['private-key']).toBe(1);
  });
  it('does NOT claim a PUBLIC key via the private-key rule (only private keys)', () => {
    // The optional-END branch must not over-match a public key header. The rule
    // only matches *PRIVATE KEY headers, so a PUBLIC KEY block is never claimed
    // by private-key. (Its base64 body may still trip the bare-token fallback —
    // that is a separate, correct rule — so we assert on the private-key count.)
    const pub = '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA7fake\n-----END PUBLIC KEY-----';
    const out = one(`pub: ${pub}`);
    expect(out.summary['private-key']).toBeUndefined();
  });
  it('redacts a base64-ENCODED secret in an image src (decoded before scan)', () => {
    // C2: scanning the base64 TEXT is a no-op (base64 encodes `sk-` into
    // `c2st…`). Decoding the payload first lets the rules see the secret in the
    // clear. A secret embedded as a "screenshot" is ASCII text, which decodes to
    // valid UTF-8, so it is scanned.
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';
    const b64 = Buffer.from(secret, 'utf8').toString('base64');
    const evil = `data:image/png;base64,${b64}`;
    const out = prepareContent(
      { sessionId: 's', title: 't', messages: [{ role: 'assistant', parts: [{ type: 'image', src: evil, mime: 'image/png', alt: 'shot', bytes: 4 }] }] },
      'strict',
    );
    const src = out.messages[0]!.parts[0]!.src!;
    expect(src).not.toContain(b64);
    expect(src).toContain('REDACTED');
    expect(out.summary['openai-key']).toBe(1);
  });
  it('does NOT redact a real binary image (decodes to invalid UTF-8, skipped)', () => {
    // Over-redaction guard: a real PNG decodes to dense binary that is NOT valid
    // UTF-8, so it is skipped (the rules are plaintext regexes and would
    // false-positive on random bytes). The data URI must survive verbatim.
    const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const dataUri = `data:image/png;base64,${pngBytes.toString('base64')}`;
    const out = prepareContent(
      { sessionId: 's', title: 't', messages: [{ role: 'assistant', parts: [{ type: 'image', src: dataUri, mime: 'image/png', alt: 'shot', bytes: 70 }] }] },
      'strict',
    );
    expect(out.messages[0]!.parts[0]!.src).toBe(dataUri);
    expect(out.summary).toEqual({});
  });
  it('redacts a secret in the session title (session-level field)', () => {
    // C3: title/model/provider are served to every viewer via the public meta
    // and are NOT walked by the per-part pass, so they are redacted explicitly.
    const out = prepareContent(
      { sessionId: 's', title: `Debugging AWS key ${secrets.aws} now`, messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }] },
      'strict',
    );
    expect(out.title).not.toContain(secrets.aws);
    expect(out.title).toContain('[REDACTED:aws-access-key]');
  });
  it('redacts a secret in the model / provider fields', () => {
    const out = prepareContent(
      { sessionId: 's', title: 't', model: `custom-${secrets.openai}`, provider: 'openai', messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }] },
      'strict',
    );
    expect(out.model).not.toContain(secrets.openai);
    expect(out.provider).toBe('openai'); // clean field passes through
  });
  it('keeps a clean session title/model/provider untouched', () => {
    const out = prepareContent(
      { sessionId: 's', title: 'Fix the login bug', model: 'claude-sonnet-4', provider: 'anthropic', messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }] },
      'strict',
    );
    expect(out.title).toBe('Fix the login bug');
    expect(out.model).toBe('claude-sonnet-4');
    expect(out.provider).toBe('anthropic');
  });
});

describe('Round 4 fixes', () => {
  it('redacts a NON-data-URI src (connection string / URL with token) — Critical', () => {
    // The API accepts any string up to 4 MB in `src`, so it can be a connection
    // string or a URL with embedded credentials — not just a data: URI. The old
    // redactSrc returned non-data-URI values untouched (a complete bypass).
    const conn = 'postgres://admin:hunter2secret@db.internal:5432/app';
    const out1 = prepareContent(
      { sessionId: 's', title: 't', messages: [{ role: 'assistant', parts: [{ type: 'image', src: conn, mime: 'image/png', alt: 'x', bytes: 1 }] }] },
      'strict',
    );
    expect(out1.messages[0]!.parts[0]!.src).not.toContain('hunter2secret');
    expect(out1.summary['connection-string']).toBe(1);

    const url = 'https://api.example.com/v1?api_key=supersecretvalue1234567890';
    const out2 = prepareContent(
      { sessionId: 's', title: 't', messages: [{ role: 'assistant', parts: [{ type: 'image', src: url, mime: 'image/png', alt: 'x', bytes: 1 }] }] },
      'strict',
    );
    expect(out2.messages[0]!.parts[0]!.src).not.toContain('supersecretvalue1234567890');
    expect(out2.summary['generic-secret']).toBe(1);

    // A clean same-origin /assets/ path is untouched.
    const out3 = prepareContent(
      { sessionId: 's', title: 't', messages: [{ role: 'assistant', parts: [{ type: 'image', src: '/assets/logo.png', mime: 'image/png', alt: 'x', bytes: 1 }] }] },
      'strict',
    );
    expect(out3.messages[0]!.parts[0]!.src).toBe('/assets/logo.png');
    expect(out3.summary).toEqual({});
  });

  it('walks numeric leaves in tool input (walkStrings now stringifies numbers)', () => {
    // A numeric leaf in tool input was never visited by walkStrings (it skipped
    // non-string leaves). Now numbers are stringified through the redaction fn.
    // A 16-hex-digit number (0xdeadbeefcafebabe) exceeds 2^53, so String(n) is a
    // 16-char decimal string — no rule matches it (the bare-token floor is 24),
    // so it round-trips unchanged. The point of the test is that the WALK
    // reached the number (no crash, value preserved as a number, not a string).
    // Before the fix, walkStrings would have left it untouched too — but the
    // "ordinary numbers" test below covers the no-mangle guarantee, and this
    // test covers the walk-reaches-numbers guarantee.
    const numericToken = 0xdeadbeefcafebabe; // 16 hex digits, > 2^53
    const out = prepareContent(
      {
        sessionId: 's', title: 't',
        messages: [{ role: 'assistant', parts: [{ type: 'tool', callID: 'c1', tool: 'Bash', status: 'ok', input: { api_token: numericToken }, output: 'x' }] }],
      },
      'strict',
    );
    const input = out.messages[0]!.parts[0]!.input as { api_token: unknown };
    // The walk stringified it, ran it through redactText, no rule matched, so
    // it round-trips as the same number (not a string, not redacted).
    expect(input.api_token).toBe(numericToken);
    expect(typeof input.api_token).toBe('number');
  });

  it('does NOT mangle ordinary numbers in tool input (lossless round-trip)', () => {
    // Clean numbers (counts, ports, ids) must survive unchanged — the rules never
    // match an ordinary number, so the stringify→redact→compare round-trip is a
    // no-op for them.
    const out = prepareContent(
      {
        sessionId: 's', title: 't',
        messages: [{ role: 'assistant', parts: [{ type: 'tool', callID: 'c1', tool: 'Bash', status: 'ok', input: { port: 5432, retries: 3, flag: true, items: [1, 2, 3] }, output: 'x' }] }],
      },
      'strict',
    );
    const input = out.messages[0]!.parts[0]!.input as { port: number; retries: number; flag: boolean; items: number[] };
    expect(input.port).toBe(5432);
    expect(input.retries).toBe(3);
    expect(input.flag).toBe(true);
    expect(input.items).toEqual([1, 2, 3]);
    expect(out.summary).toEqual({});
  });

  it('does not stack-overflow on a deeply nested input (depth cap)', () => {
    // z.unknown() input has no depth limit in the schema; a 100k-deep structure
    // would stack-overflow a recursive walk. The iterative walk with a depth cap
    // survives. Round 5: the over-deep subtree is COLLAPSED to a JSON string (and
    // redacted) at the cap, so it is no longer passed through structurally — a
    // 512-deep tool input is not meaningful structure, and collapsing preserves
    // the security property (no secret persists unredacted).
    let deep: Record<string, unknown> = { leaf: 'ok' };
    for (let i = 0; i < 100_000; i++) deep = { nested: deep };
    const out = prepareContent(
      { sessionId: 's', title: 't', messages: [{ role: 'assistant', parts: [{ type: 'tool', callID: 'c1', tool: 'Bash', status: 'ok', input: deep, output: 'x' }] }] },
      'strict',
    );
    // It completed without throwing. Walk down to the cap: the subtree is now a
    // JSON string (the collapsed form), not a 100k-deep object.
    let probe: unknown = out.messages[0]!.parts[0]!.input;
    for (let i = 0; i < 512; i++) probe = (probe as { nested: unknown }).nested;
    expect(typeof probe).toBe('string');
    // The collapsed string still contains the leaf value (structure flattened,
    // content preserved).
    expect(probe as string).toContain('ok');
  });
});

describe('Round 5 fixes', () => {
  // A 24-char token that ONLY the bare-token fallback matches (no sk-/ghp_/AKIA
  // prefix, contains a non-hex g-z letter, not pure hex).
  const BARE = 'Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2';

  it('redacts a secret split by zero-width chars (U+200B) — High', () => {
    // An attacker can split a contiguous secret run with zero-width spaces so
    // the bare-token fallback (24+ char alnum run) and the prefix rules both
    // miss it. redactText now matches on a zero-width-stripped copy of the text,
    // so the rules see the secret in the clear.
    const split = ' ' + 'Zz9Yy8Xx7Ww6\u200bVv5Uu4Tt3Ss2' + ' ';
    const r = redactText(split, 'strict');
    expect(r.text).toBe(' [REDACTED:bare-token] ');
    expect(r.counts['bare-token']).toBe(1);
  });

  it('preserves zero-width chars OUTSIDE a redacted span (no CJK/emoji over-redaction)', () => {
    // Zero-width chars are intentional in CJK text and ZWJ emoji sequences. The
    // fix matches on stripped text but maps replacements back to the original,
    // so zero-width chars that fall OUTSIDE a matched span survive; only those
    // inside a redacted span are consumed.
    const around = 'a\u200b ' + BARE + ' \u200bb';
    const r = redactText(around, 'strict');
    expect(r.text).toBe('a\u200b [REDACTED:bare-token] \u200bb');
  });

  it('leaves clean text with zero-width chars unchanged', () => {
    const r = redactText('hi\u200bthere\u200d', 'strict');
    expect(r.text).toBe('hi\u200bthere\u200d');
    expect(r.counts).toEqual({});
  });

  it('redacts a BOM (U+FEFF) before a space-bounded token, preserving the BOM', () => {
    const r = redactText('\ufeff ' + BARE + ' ', 'strict');
    expect(r.text).toBe('\ufeff [REDACTED:bare-token] ');
  });

  it('redacts Map values and string keys in tool input — Medium', () => {
    // A Map's values (and string keys) can carry secrets. walkStrings now walks
    // them in place via .set() (a Map is not indexable like an object).
    const m = new Map<string, unknown>([['api_key', BARE]]);
    walkStrings(m, (s) => redactText(s, 'strict').text);
    expect(m.get('api_key')).toBe('[REDACTED:bare-token]');

    const m2 = new Map<unknown, unknown>([[BARE, 'v']]);
    walkStrings(m2, (s) => redactText(s, 'strict').text);
    expect(m2.has('[REDACTED:bare-token]')).toBe(true);
    expect(m2.has(BARE)).toBe(false);
  });

  it('redacts Set elements in tool input — Medium', () => {
    const s = new Set<string>([BARE]);
    walkStrings(s, (x) => (typeof x === 'string' ? redactText(x, 'strict').text : x));
    expect(s.has('[REDACTED:bare-token]')).toBe(true);
    expect(s.has(BARE)).toBe(false);
  });

  it('redacts symbol-keyed string values in tool input — Medium', () => {
    // Object.keys excludes symbol keys; a secret stored under a symbol key was
    // never visited. walkStrings now iterates getOwnPropertySymbols too.
    const sym = Symbol('k');
    const obj: Record<PropertyKey, unknown> = { a: 1, [sym]: BARE };
    walkStrings(obj, (s) => redactText(s, 'strict').text);
    expect(obj[sym]).toBe('[REDACTED:bare-token]');
    expect(obj.a).toBe(1); // clean sibling untouched
  });

  it('redacts a secret nested DEEPER than the depth cap (collapse, not skip) — High', () => {
    // The old walk SKIPPED over-deep nodes (a complete redaction bypass for any
    // secret nested >512 deep). Round 5 collapses the over-deep subtree to a
    // JSON string and runs it through the rules, so the secret is still caught.
    function deep(n: number, v: unknown): unknown {
      let x = v;
      for (let i = 0; i < n; i++) x = { v: x };
      return x;
    }
    const out = prepareContent(
      { sessionId: 's', title: 't', messages: [{ role: 'assistant', parts: [{ type: 'tool', callID: 'c1', tool: 'Bash', status: 'ok', input: deep(600, BARE), output: 'x' }] }] },
      'strict',
    );
    // Walk down to the cap: the subtree is a collapsed JSON string.
    let leaf: unknown = out.messages[0]!.parts[0]!.input;
    for (let i = 0; i < 512 && typeof leaf === 'object' && leaf !== null; i++) leaf = (leaf as { v: unknown }).v;
    const ls = typeof leaf === 'string' ? leaf : JSON.stringify(leaf);
    expect(ls).toContain('[REDACTED:');
    expect(ls).not.toContain(BARE);
  });

  it('redacts a base64 payload with a secret + trailing non-UTF-8 bytes — Medium', () => {
    // The old redactSrc required the WHOLE base64 payload to decode to valid
    // UTF-8, so a secret followed by even one non-UTF-8 byte disabled the scan.
    // Round 5 finds the longest valid-UTF-8 prefix and scans it.
    const payload = Buffer.concat([Buffer.from(BARE, 'utf8'), Buffer.from([0xff, 0xfe, 0x00, 0x01])]);
    const evil = 'data:text/plain;base64,' + payload.toString('base64');
    const out = prepareContent(
      { sessionId: 's', title: 't', messages: [{ role: 'assistant', parts: [{ type: 'image', src: evil, mime: 'text/plain', alt: 'x', bytes: payload.length }] }] },
      'strict',
    );
    expect(out.messages[0]!.parts[0]!.src).toBe('data:text/plain;base64,REDACTED');
    expect(out.summary['bare-token']).toBe(1);
  });

  it('does NOT redact a real binary image (no valid-UTF-8 prefix >= 8 bytes)', () => {
    // Over-redaction guard: a real image decodes to dense binary with no
    // meaningful valid-UTF-8 prefix, so it is skipped. The data URI survives.
    const pngish = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0xfa, 0xf9, 0xf8, 0xf7, 0xf6]);
    const dataUri = 'data:image/png;base64,' + pngish.toString('base64');
    const out = prepareContent(
      { sessionId: 's', title: 't', messages: [{ role: 'assistant', parts: [{ type: 'image', src: dataUri, mime: 'image/png', alt: 'shot', bytes: pngish.length }] }] },
      'strict',
    );
    expect(out.messages[0]!.parts[0]!.src).toBe(dataUri);
    expect(out.summary).toEqual({});
  });

  it('walks a clean Map/Set/symbol structure without mangling it', () => {
    // Lossless round-trip: clean values in a Map/Set/symbol-keyed object must
    // survive unchanged (the rules never match an ordinary value).
    const sym = Symbol('k');
    const m = new Map<string, unknown>([['k', 'clean']]);
    const s = new Set<string>(['clean']);
    const obj: Record<PropertyKey, unknown> = { a: 1, [sym]: 'clean' };
    walkStrings(m, (x) => redactText(x, 'strict').text);
    walkStrings(s, (x) => (typeof x === 'string' ? redactText(x, 'strict').text : x));
    walkStrings(obj, (x) => redactText(x, 'strict').text);
    expect(m.get('k')).toBe('clean');
    expect(s.has('clean')).toBe(true);
    expect(obj[sym]).toBe('clean');
    expect(obj.a).toBe(1);
  });
});

describe('Round 6 fixes (bare-token ReDoS)', () => {
  // A maximal [A-Za-z0-9._-] run with NO g-z letter and NO 24+ contiguous hex
  // run: 'a' is hex but the dots break every hex run to length 1. This is the
  // input that made the old lookahead quadratic (the lookahead failed at every
  // position, forcing a full-run rescan each time).
  const adversarial = (n: number) => 'a.'.repeat(Math.ceil(n / 2));

  it('redacts a long no-g-z run in LINEAR time (was O(N²) — authenticated DoS)', () => {
    // Old code: ~2.7 s at 80k chars, extrapolated ~7 min for 1 MB (the event
    // loop is blocked for the whole redaction). New code is O(N): a 500k-char
    // input must complete well under the quadratic prediction (~106 s). The
    // threshold is ~50x above the expected linear cost so it is not flaky, yet
    // ~200x below the old quadratic cost so a regression is caught.
    // Round 9 (F8): the adversarial run (hex 'a' + separator '.') is now a
    // hex-with-separator run, so F8 redacts it. This test asserts the DoS
    // protection (linear time); the run is redacted, not preserved.
    const input = adversarial(500_000);
    const t0 = performance.now();
    const r = redactText(input, 'strict');
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(500);
    // F8 redacts the hex-with-separator run (24+ chars of hex + '.').
    expect(r.counts['bare-token']).toBeGreaterThan(0);
  });

  it('still redacts a pure-hex token, preserving a trailing period (span unchanged)', () => {
    // A 32-hex run (24+ but <40, so bare-token claims it, not aws-secret-key)
    // followed by '.': the old branch-1 (\b[0-9a-fA-F]{24,}\b) matched exactly
    // the 32 hex chars and preserved the dot. The new maximal-run pattern must
    // reproduce that span (not swallow the dot).
    const sha = 'c8f5e0a1b2c3d4e5f60718293a4b5c6d';
    const r = redactText(`commit ${sha}. done`, 'strict');
    expect(r.text).toBe('commit [REDACTED:bare-token]. done');
    expect(r.counts['bare-token']).toBe(1);
  });

  it('still redacts a g-z token and still spares a UUID (behavior preserved)', () => {
    const gz = 'Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2'; // 24 chars, contains g-z letters
    const uuid = '123e4567-e89b-12d3-a456-426614174000'; // 36 chars, no g-z
    const r = redactText(`tok ${gz} id ${uuid}`, 'strict');
    expect(r.text).toBe(`tok [REDACTED:bare-token] id ${uuid}`);
    expect(r.counts['bare-token']).toBe(1);
  });

  it('redacts a 32-hex token (pure-hex branch) and a 40-hex token (aws-secret-key claims it first)', () => {
    const r1 = redactText(`a ${'c8f5e0a1b2c3d4e5f60718293a4b5c6d'} b`, 'strict');
    expect(r1.counts['bare-token']).toBe(1);
    expect(r1.text).toBe('a [REDACTED:bare-token] b');
    const r2 = redactText(`a ${'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0'} b`, 'strict');
    expect(r2.counts['aws-secret-key']).toBe(1);
    expect(r2.text).toBe('a [REDACTED:aws-secret-key] b');
  });
});

describe('Round 7 fixes', () => {
  const one = (text: string, preset: 'strict' | 'normal' = 'strict') =>
    prepareContent({ sessionId: 's', title: 't', messages: [{ role: 'user', parts: [{ type: 'text', text }] }] }, preset);
  // A 24-char run that only the bare-token fallback matches (contains g-z letters).
  const BARE = 'Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2';

  it('redacts a secret in a plain-object KEY and re-attaches its value (M1)', () => {
    // A tool `input` of {"<secret>": …} carried the secret in KEY position. The
    // plain-object branch of walkStrings now redacts the key (the Map branch
    // already did) and re-attaches the value under the renamed key — a container
    // value is mutated in place, so a bare set() after the delete would orphan it.
    const obj: Record<string, unknown> = { [BARE]: { nested: BARE }, clean: 'x' };
    walkStrings(obj, (s) => redactText(s, 'strict').text);
    expect(obj[BARE]).toBeUndefined(); // old key removed
    const renamed = obj['[REDACTED:bare-token]'] as { nested: string };
    expect(renamed).toBeDefined(); // container value re-attached, not orphaned
    expect(renamed.nested).toBe('[REDACTED:bare-token]'); // nested value redacted in place
    expect(obj.clean).toBe('x'); // clean sibling untouched
  });

  it('redacts a secret in a tool-input object key end-to-end (M1)', () => {
    const out = prepareContent(
      {
        sessionId: 's',
        title: 't',
        messages: [{ role: 'assistant', parts: [{ type: 'tool', callID: 'c1', tool: 'Bash', status: 'ok', input: { [secrets.openai]: 'value-here' }, output: 'x' }] }],
      },
      'strict',
    );
    const all = JSON.stringify(out.messages);
    expect(all).not.toContain(secrets.openai);
    expect(all).toContain('[REDACTED:openai-key]');
  });

  it('redacts an https://user:pass@ basic-auth URL (M2)', () => {
    const out = one('fetch https://admin:hunter2secret@api.example.com/v1 done');
    expect(JSON.stringify(out.messages)).not.toContain('hunter2secret');
    expect(out.summary['connection-string']).toBe(1);
  });
  it('leaves a user-only https URL (no password) untouched (M2)', () => {
    const out = one('fetch https://admin@api.example.com/v1 done');
    expect(JSON.stringify(out.messages)).toContain('https://admin@api.example.com/v1');
    expect(out.summary['connection-string']).toBeUndefined();
  });

  it('still redacts a run up to the 10000-char bare-token cap (L3)', () => {
    // A 5000-char pure-hex run is within {24,10000} and is redacted.
    const run = '0'.repeat(5000);
    const r = redactText(`x ${run} y`, 'strict');
    expect(r.counts['bare-token']).toBe(1);
    expect(r.text).toBe('x [REDACTED:bare-token] y');
  });
  it('leaves a run longer than the 10000-char cap untouched (L3)', () => {
    // A 12000-char run exceeds the {24,10000} cap: the trailing \b fails at every
    // interior position, so the pattern cannot match it. No real secret is
    // 10000+ chars, so nothing is lost — and the backtracker depth is bounded.
    const run = '0'.repeat(12_000);
    const r = redactText(`x ${run} y`, 'strict');
    expect(r.counts['bare-token']).toBeUndefined();
    expect(r.text).toBe(`x ${run} y`);
  });

  it('redacts a short Authorization: Bearer token (floor 8) (L4b)', () => {
    const out = one('Authorization: Bearer abcdef12');
    expect(JSON.stringify(out.messages)).not.toContain('abcdef12');
    expect(out.summary['bearer-token']).toBe(1);
  });
  it('spares a short bare bearer in prose (floor 20) (L4b)', () => {
    const out = one('the bearer abcdef12 was here');
    expect(JSON.stringify(out.messages)).toContain('bearer abcdef12');
    expect(out.summary['bearer-token']).toBeUndefined();
  });
  it('redacts a generic secret whose quoted value has an escaped quote (L4c)', () => {
    // {"password":"abcd1234\"ef567890"} — the value is abcd1234"ef567890 (a
    // JSON-escaped quote mid-value). The old charset [^'"\s] stopped at the
    // escaped quote and leaked the tail (ef567890); the new charset (?:\\.)
    // consumes the escaped quote as part of the value.
    const out = one('{"password":"abcd1234\\"ef567890"}');
    expect(JSON.stringify(out.messages)).not.toContain('ef567890');
    expect(out.summary['generic-secret']).toBe(1);
  });
  it('redacts a pwd= credential (L4e)', () => {
    const out = one('pwd=supersecret123456');
    expect(JSON.stringify(out.messages)).not.toContain('supersecret123456');
    expect(out.summary['generic-secret']).toBe(1);
  });
  it('redacts a token-like key: value (L4d)', () => {
    const out = one('key: abcdef1234567890');
    expect(JSON.stringify(out.messages)).not.toContain('abcdef1234567890');
    expect(out.summary['key']).toBe(1);
  });
  it('spares JSX key={expr} and a quoted key value (L4d)', () => {
    const out = one('key={someExpr} and key: "someValue"');
    // Assert on the raw part text, not JSON.stringify (which escapes the
    // double quotes to \"), so the quoted value is checked verbatim.
    const text = (out.messages[0]!.parts[0] as { text?: string }).text ?? '';
    expect(text).toContain('key={someExpr}');
    expect(text).toContain('key: "someValue"');
    expect(out.summary['key']).toBeUndefined();
  });
});

describe('Round 8 fixes', () => {
  const one = (text: string, preset: 'strict' | 'normal' = 'strict') =>
    prepareContent({ sessionId: 's', title: 't', messages: [{ role: 'user', parts: [{ type: 'text', text }] }] }, preset);
  const img = (src: string) =>
    prepareContent(
      { sessionId: 's', title: 't', messages: [{ role: 'assistant', parts: [{ type: 'image', src, mime: 'image/png', alt: 'shot', bytes: 4 }] }] },
      'strict',
    );

  it('A1: redacts a secret split by a bidirectional override (U+202A)', () => {
    // U+202A was NOT in the original 4-char strip set, so it split the run and
    // the openai rule missed it. The widened set strips it for matching.
    const out = one('token sk-abcdefghijkl\u202Amnopqrstuvwx');
    expect(JSON.stringify(out.messages)).not.toContain('sk-abcdefghijkl');
    expect(out.summary['openai-key']).toBe(1);
  });
  it('A1: redacts a secret split by a word joiner (U+2060)', () => {
    const out = one('token sk-abcdefghijkl\u2060mnopqrstuvwx');
    expect(out.summary['openai-key']).toBe(1);
  });
  it('A1: redacts a secret split by an SMP tag character (U+E0001)', () => {
    // The tag block is in the SMP (a surrogate pair in UTF-16), so the strip
    // must iterate by code point, not UTF-16 unit.
    const out = one('token sk-abcdefghijkl\u{e0001}mnopqrstuvwx');
    expect(out.summary['openai-key']).toBe(1);
  });
  it('A1: preserves a bidirectional mark in clean (non-secret) text', () => {
    // Stripping is on the matching copy only — a clean string with a now-stripped
    // invisible char is emitted verbatim (the char survives in the output).
    const out = one('hello \u202a world');
    expect(out.messages[0]!.parts[0]!.text).toBe('hello \u202a world');
    expect(out.summary).toEqual({});
  });
  it('A1: preserves a ZWJ emoji sequence in clean text', () => {
    const fam = '\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}'; // 👨‍👩‍👧‍👦
    const out = one('me and ' + fam);
    expect(out.messages[0]!.parts[0]!.text).toBe('me and ' + fam);
    expect(out.summary).toEqual({});
  });

  it('A2: scans a secret that follows a multi-byte char at the old probe position', () => {
    // The Round-5 binary search assumed "prefix of length m is valid UTF-8" is
    // monotonic; it is not (a valid 2-byte char has an invalid 1-byte prefix).
    // Geometry: 28 ASCII + é (0xC3 0xA9) + 27-byte secret = 57 bytes, all valid
    // UTF-8. The old search's first probe (mid=29) cut the é in half and
    // converged to 28, never scanning the secret. The forward walk scans all 57.
    const secret = secrets.openai; // 27 bytes
    const buf = Buffer.concat([
      Buffer.from('A'.repeat(28), 'utf8'),
      Buffer.from([0xc3, 0xa9]), // é
      Buffer.from(secret, 'utf8'),
    ]);
    const b64 = buf.toString('base64');
    const out = img(`data:image/png;base64,${b64}`);
    const src = out.messages[0]!.parts[0]!.src!;
    expect(src).not.toContain(b64);
    expect(src).toContain('REDACTED');
    expect(out.summary['openai-key']).toBe(1);
  });
  it('A2: still skips a real binary image (no valid-UTF-8 prefix)', () => {
    // Over-redaction guard must survive the rewrite: dense binary has no valid
    // prefix, so the data URI passes through untouched.
    const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const dataUri = `data:image/png;base64,${pngBytes.toString('base64')}`;
    const out = img(dataUri);
    expect(out.messages[0]!.parts[0]!.src).toBe(dataUri);
    expect(out.summary).toEqual({});
  });

  it('A3: strips a NUL from a non-data-URI src on the no-match path', () => {
    // Postgres rejects NUL in jsonb; a clean URL with a NUL (no rule trips) must
    // be stripped so it is storable.
    const out = img('https://example.com/page\u0000');
    expect(out.messages[0]!.parts[0]!.src).toBe('https://example.com/page');
    expect(out.summary).toEqual({});
  });
  it('A3: strips a NUL from a plaintext data-URI payload on the no-match path', () => {
    const out = img('data:text/plain,hello\u0000world');
    expect(out.messages[0]!.parts[0]!.src).toBe('data:text/plain,helloworld');
    expect(out.summary).toEqual({});
  });
});

describe('Round 9 fixes', () => {
  const one = (text: string, preset: 'strict' | 'normal' = 'strict') =>
    prepareContent({ sessionId: 's', title: 't', messages: [{ role: 'user', parts: [{ type: 'text', text }] }] }, preset);
  const img = (src: string) =>
    prepareContent(
      { sessionId: 's', title: 't', messages: [{ role: 'assistant', parts: [{ type: 'image', src, mime: 'image/png', alt: 'shot', bytes: 4 }] }] },
      'strict',
    );

  it('F1: redacts a secret that follows a surrogate-pair char (map is UTF-16-aligned)', () => {
    // 😀 (U+1F600) is a surrogate pair (2 UTF-16 units). The old map pushed one
    // entry per CODE POINT, so after a surrogate pair map.length < stripped.length
    // and a match after it mapped to the wrong original offset, leaking the
    // leading chars of the secret. The map must push one entry per UTF-16 unit.
    const out = one('\u{1f600}' + secrets.openai);
    const text = out.messages[0]!.parts[0]!.text!;
    expect(text).toBe('\u{1f600}[REDACTED:openai-key]');
    expect(out.summary['openai-key']).toBe(1);
  });

  it('F2: redacts a secret split by a C0 control char (strip before redact)', () => {
    // A BEL (\u0007) embedded in a bare token used to break the run (the rule
    // matched on the raw text, which the control char split into two <24 runs),
    // then the control char was stripped AFTER redaction, leaving a clean
    // unredacted secret. Strip control chars BEFORE redaction so the rules see
    // the secret in the clear.
    const token = 'Zz9Yy8Xx7Ww6\u0007Vv5Uu4Tt3Ss2'; // 24 g-z chars split by BEL
    const out = one('tok ' + token + ' end');
    const text = out.messages[0]!.parts[0]!.text!;
    expect(text).not.toContain('Zz9Yy8Xx7Ww6');
    expect(text).not.toContain('Vv5Uu4Tt3Ss2');
    expect(text).not.toContain('\u0007');
    expect(text).toContain('[REDACTED:bare-token]');
    expect(out.summary['bare-token']).toBe(1);
  });

  it('F2: strips DEL (\\u007F) and C1 controls (\\u0080-\\u009F)', () => {
    const out = one('a\u007Fb\u0085c\u009Fd');
    const text = out.messages[0]!.parts[0]!.text!;
    expect(text).toBe('abcd');
  });

  it('F5: redacts a base64-encoded secret in a data URI embedded in a TEXT part', () => {
    // The viewer renders data:image/* from text parts (markdown). A base64-
    // encoded secret in such a data URI was stored unredacted (redactText on the
    // base64 text is a no-op — base64 encodes sk- into c2st). Decode and scan.
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';
    const b64 = Buffer.from(secret, 'utf8').toString('base64');
    const out = one(`see ![shot](data:image/png;base64,${b64}) ok`);
    const text = out.messages[0]!.parts[0]!.text!;
    expect(text).not.toContain(b64);
    expect(text).toContain('REDACTED');
    expect(out.summary['openai-key']).toBe(1);
  });

  it('F6: redacts a secret in the MIDDLE of a data-URI payload (after binary bytes)', () => {
    // The old longestValidUtf8Prefix only scanned the LEADING prefix, so a secret
    // after an invalid byte (binary noise before it) was missed. Scan the longest
    // valid-UTF-8 run anywhere.
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00]), Buffer.from(secret, 'utf8')]);
    const b64 = buf.toString('base64');
    const out = img(`data:image/png;base64,${b64}`);
    const src = out.messages[0]!.parts[0]!.src!;
    expect(src).not.toContain(b64);
    expect(src).toContain('REDACTED');
    expect(out.summary['openai-key']).toBe(1);
  });

  it('F6: still skips a real binary image (longest valid-UTF-8 run < 8 bytes)', () => {
    // Over-redaction guard must survive the rewrite: dense binary has only short
    // valid-UTF-8 runs, so the data URI passes through untouched.
    const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const dataUri = `data:image/png;base64,${pngBytes.toString('base64')}`;
    const out = img(dataUri);
    expect(out.messages[0]!.parts[0]!.src).toBe(dataUri);
    expect(out.summary).toEqual({});
  });

  it('F3: redacts a secret split by U+2028 (line separator)', () => {
    // The Round 8 inventory missed the Zs/Zl/Zp spaces and several Cf format
    // chars; each splits a secret run on the matching copy and evades the rules.
    const mid = Math.floor(secrets.openai.length / 2);
    const split = secrets.openai.slice(0, mid) + '\u2028' + secrets.openai.slice(mid);
    const out = one(split);
    const text = out.messages[0]!.parts[0]!.text!;
    expect(text).toBe('[REDACTED:openai-key]');
    expect(out.summary['openai-key']).toBe(1);
  });

  it('F3: redacts a bare token split by the missing Zs/Cf inventory', () => {
    // U+2029, U+200A, U+070F, U+08E2, U+1680, U+205F, U+3000 — each verified to
    // split a secret run on the Round 8 inventory.
    const seps = ['\u2029', '\u200a', '\u070f', '\u08e2', '\u1680', '\u205f', '\u3000'];
    const body = 'Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2'; // 24 g-z chars
    const split = body.split('').map((c, i) => (i % 2 === 1 ? c + seps[Math.floor(i / 2) % seps.length]! : c)).join('');
    const out = one('tok ' + split + ' end');
    const text = out.messages[0]!.parts[0]!.text!;
    expect(text).toContain('[REDACTED:bare-token]');
    expect(text).not.toContain('Zz9Yy8Xx7Ww6');
    expect(out.summary['bare-token']).toBe(1);
  });

  it('F3: preserves Zs/Cf chars in non-redacted output (strip is match-copy only)', () => {
    const out = one('hello\u00a0world\u3000\u2028foo');
    expect(out.messages[0]!.parts[0]!.text).toBe('hello\u00a0world\u3000\u2028foo');
  });

  it('F8: redacts a body-only PEM fragment (dashed-hex body, header truncated away)', () => {
    // A key split across parts leaves a body-only fragment: no -----BEGIN
    // header, so the private-key rule cannot match. The dashed-hex body is one
    // 24+ char run the old bare-token test declined (neither pure-hex nor
    // g-z) — it is now accepted (it is not the exact UUID shape).
    const body = '0123456789abcdef-0123456789abcdef-0123456789abcdef-0123456789abcdef';
    const out = one('fragment ' + body);
    const text = out.messages[0]!.parts[0]!.text!;
    expect(text).not.toContain('0123456789abcdef-0123456789abcdef');
    expect(text).toContain('[REDACTED:bare-token]');
    expect(out.summary['bare-token']).toBe(1);
  });

  it('F8: still leaves an exact UUID (8-4-4-4-12) untouched', () => {
    const out = one('id 123e4567-e89b-12d3-a456-426614174000 end');
    expect(out.messages[0]!.parts[0]!.text).toBe('id 123e4567-e89b-12d3-a456-426614174000 end');
    expect(out.summary['bare-token']).toBeUndefined();
  });
});

describe('Round 9 (D8): base64 data URIs are not secrets', () => {
  // A markdown image ![x](data:image/jpg;base64,…) keeps its payload in a TEXT
  // part (the CLI only extracts known attachment files into image parts). The
  // base64 payload is a long [A-Za-z0-9+/=] run that the bare-token fallback
  // (and, in principle, any rule) reads as a secret and corrupts. A base64
  // payload is never a secret — the viewer's isSafeImageSrc/isSafeHref already
  // drop non-image data URIs at render time — so redaction must leave the URI
  // intact.
  const jpgB64 =
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
  const avifB64 = 'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=';

  it('leaves a base64 image data URI in text untouched (markdown image)', () => {
    const text = `![cactus](data:image/jpg;base64,${jpgB64})`;
    const out = redactText(text, 'normal');
    expect(out.text).toBe(text);
    expect(out.counts['bare-token']).toBeUndefined();
  });

  it('leaves avif and other image data URIs untouched', () => {
    const text = `![a](data:image/avif;base64,${avifB64})`;
    const out = redactText(text, 'normal');
    expect(out.text).toBe(text);
  });

  it('still redacts a real secret that FOLLOWS a data URI', () => {
    const text = `img data:image/jpg;base64,${jpgB64} then key ${secrets.aws}`;
    const out = redactText(text, 'normal');
    expect(out.text).toContain(jpgB64); // data URI intact
    expect(out.text).not.toContain(secrets.aws); // secret redacted
    expect(out.text).toContain('[REDACTED:');
  });

  it('still redacts a real secret that PRECEDES a data URI', () => {
    const text = `key ${secrets.aws} img data:image/jpg;base64,${jpgB64}`;
    const out = redactText(text, 'normal');
    expect(out.text).toContain(jpgB64);
    expect(out.text).not.toContain(secrets.aws);
  });

  it('does not shield a data:text/html URI (a vector, not a secret — viewer drops it)', () => {
    // data:text/html is not a secret; redaction leaves it and the viewer's
    // isSafeHref/isSafeImageSrc drop it at render time. Its base64 payload
    // (36 chars, g-z letters) would otherwise trip bare-token.
    const text = 'see data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==';
    const out = redactText(text, 'normal');
    expect(out.text).toBe(text);
    expect(out.counts['bare-token']).toBeUndefined();
  });
});

describe('Round 10 fixes', () => {
  const one = (text: string, preset: 'strict' | 'normal' = 'normal') =>
    prepareContent({ sessionId: 's', title: 't', messages: [{ role: 'user', parts: [{ type: 'text', text }] }] }, preset);

  it('R10-1: redacts an AWS secret access key in the no-space .env form (KEY=<40char>)', () => {
    // The aws-secret-key lookbehind (?<![A-Za-z0-9+/=]) rejected a preceding `=`,
    // so the canonical `AWS_SECRET_ACCESS_KEY=<40char base64>` (no space) leaked
    // in full — no rule fired. The spaced form was already caught.
    const awsSecret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'; // 40-char base64
    const out = redactText(`AWS_SECRET_ACCESS_KEY=${awsSecret}`, 'normal');
    expect(out.text).not.toContain(awsSecret);
    expect(out.text).toContain('[REDACTED:aws-secret-key]');
    expect(out.counts['aws-secret-key']).toBe(1);
  });

  it('R10-2: redacts a base64-encoded secret in a BARE-prose data URI (not markdown-wrapped)', () => {
    // A data URI written as bare prose (not ![…](…) / <img src=…>) is shielded
    // from every rule by the D8 shield in redactText AND never decoded (prepare
    // only decoded markdown-wrapped URIs), so a base64-encoded secret survived.
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';
    const b64 = Buffer.from(secret, 'utf8').toString('base64');
    const out = one(`the image is data:image/png;base64,${b64} end`);
    const text = out.messages[0]!.parts[0]!.text!;
    expect(text).not.toContain(b64);
    expect(text).toContain('REDACTED');
    expect(out.summary['openai-key']).toBe(1);
  });

  it('R10-3: redacts key=<base64 value with / or +> in full (not partially)', () => {
    // The `key` rule's value charset [A-Za-z0-9._-] excluded `/` and `+`, so
    // `key=<base64>` stopped at the first slash and leaked the tail. 35 chars
    // (not 40) so aws-secret-key cannot claim it — only the `key` rule applies.
    const value = 'abcd1234/efgh5678/ijkl9012/mnop3456';
    const out = redactText(`key=${value}`, 'normal');
    expect(out.text).toBe('key=[REDACTED:key]');
    expect(out.text).not.toContain(value);
  });

  it('R10-3: redacts the reported key=<40-char AWS secret> in full', () => {
    // The exact reported repro: after the R10-1 fix, aws-secret-key (higher
    // priority) claims the whole 40-char span, so no partial `key` leak survives.
    const value = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    const out = redactText(`key=${value}`, 'normal');
    expect(out.text).toBe('key=[REDACTED:aws-secret-key]');
    expect(out.text).not.toContain(value);
  });

  it('R10-4: redacts a secret split by U+180F (Mongolian Vowel Separator, a missing Mn char)', () => {
    // The INVISIBLE_CP set missed U+180F (right after the included U+180B–180E)
    // and most of the Cf/Mn inventory; each splits a secret run on the matching
    // copy. U+180F is category Mn (nonspacing mark), NOT Cf — the fix catches
    // both, so a Cf-only escape would have missed the reported char.
    const out = redactText(`token sk-abcdefghijkl\u180Fmnopqrstuvwx ok`, 'normal');
    expect(out.text).not.toContain('sk-abcdefghijkl');
    expect(out.text).toContain('[REDACTED:openai-key]');
    expect(out.counts['openai-key']).toBe(1);
  });

  it('R10-4: redacts a secret split by other missing invisible chars (Cf + Mn)', () => {
    // The property-escape fallback catches EVERY Cf (format) and Mn (nonspacing
    // mark) char, not just U+180F. (All of these are Cf or Mn and absent from
    // the explicit set — U+0301 is a combining accent, the rest are format
    // chars. Visible letters like U+1343/U+1AA3 are deliberately NOT stripped.)
    for (const sep of ['\u06dd', '\ufff9', '\ufffa', '\u0890', '\u0891', '\u{110bd}', '\u0301']) {
      const out = redactText(`tok sk-abcdefghijkl${sep}mnopqrstuvwx ok`, 'normal');
      expect(out.text, `sep ${JSON.stringify(sep)}`).toContain('[REDACTED:openai-key]');
    }
  });

  it('R10-4: a regular space (U+0020) still ends a token (the Cf fallback does not over-strip)', () => {
    // The Cf fallback must NOT treat the regular space as invisible — a real
    // space legitimately ends a token, so a 12-char prefix + space + 10-char
    // suffix is two runs, not one secret.
    const out = redactText(`token sk-abcdefghijkl mnopqrstuvwx ok`, 'normal');
    expect(out.text).toBe(`token sk-abcdefghijkl mnopqrstuvwx ok`);
    expect(out.counts).toEqual({});
  });
});
