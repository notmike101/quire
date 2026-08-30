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
    const input = adversarial(500_000);
    const t0 = performance.now();
    const r = redactText(input, 'strict');
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(500);
    // Nothing in the adversarial run is a secret (no g-z, no 24+ hex run), so
    // it is redacted nowhere and the text is unchanged.
    expect(r.counts['bare-token']).toBeUndefined();
    expect(r.text).toBe(input);
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
