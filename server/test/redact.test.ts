import { describe, it, expect } from 'vitest';
import { prepareContent } from '../src/redact/prepare.js';
import type { ShapedMessage } from '../src/redact/prepare.js';

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

const fixture: ShapedMessage[] = [
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
    expect(out.command).toContain('api_key = [REDACTED:generic-secret]');
    // M10: the quoted generic-secret value must not leave a stray closing quote.
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
    expect(messages).toEqual(fixture);
    expect(summary).toEqual({});
    expect(messageCount).toBe(2);
  });

  it('ordering: a private-key block is not half-matched by generic-secret', () => {
    const tricky: ShapedMessage[] = [
      {
        role: 'user',
        parts: [{ type: 'text', text: `-----BEGIN OPENSSH PRIVATE KEY-----\napi_key: abcdefghijklmnop1234\n-----END OPENSSH PRIVATE KEY-----` }],
      },
    ];
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
    const withNul: ShapedMessage[] = [
      { role: 'user', parts: [{ type: 'text', text: 'a\u0000b\u0007c' }] },
      {
        role: 'assistant',
        parts: [
          { type: 'tool', callID: 'c1', tool: 'Bash', status: 'completed', input: { cmd: 'x\u0000y' }, output: 'out\u0000\u001Bine' },
        ],
      },
    ];
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
    const withNewlines: ShapedMessage[] = [{ role: 'user', parts: [{ type: 'text', text: 'l1\nl2\rl3\tl4' }] }];
    expect(prepareContent(withNewlines, 'none').messages[0]!.parts[0]!.text).toBe('l1\nl2\rl3\tl4');
  });

  it('passes an image part data URI through untouched (not redacted)', () => {
    // A base64 payload that trips NO rule: `+`/`/` interleave every alphanumeric
    // run under 24 chars, so bare-token's hex and g-z branches both miss, and no
    // keyword/prefix rule fires. The data URI must survive verbatim.
    const payload = 'QUJD+REVG/R0hJ+SktM/TU5O+PUFQ/SR8';
    const dataUri = `data:image/png;base64,${payload}`;
    const withImage: ShapedMessage[] = [
      {
        role: 'assistant',
        parts: [
          { type: 'image', src: dataUri, mime: 'image/png', alt: 'shot', bytes: 150 },
          { type: 'image', mime: 'image/png', alt: 'big', bytes: 9_999_999, tooLarge: true },
        ],
      },
    ];
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
    const withMeta: ShapedMessage[] = [
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
    ];
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
  it('redacts an 8-char generic secret (floor lowered to 8)', () => {
    const out = prepareContent([{ role: 'user', parts: [{ type: 'text', text: 'password=abcd1234' }] }], 'strict');
    expect(JSON.stringify(out.messages)).not.toContain('abcd1234');
    expect(out.summary['generic-secret']).toBe(1);
  });
  it('redacts a query-string DSN credential (?password=)', () => {
    const out = prepareContent([{ role: 'user', parts: [{ type: 'text', text: 'postgres://db.example.com/app?password=hunter22' }] }], 'strict');
    expect(JSON.stringify(out.messages)).not.toContain('hunter22');
  });
  it('redacts a non-eyJ JWT', () => {
    const out = prepareContent([{ role: 'user', parts: [{ type: 'text', text: 'token abcdefgh1234.ijklmnop5678.rstuvwx9012' }] }], 'strict');
    expect(JSON.stringify(out.messages)).not.toContain('abcdefgh1234.ijklmnop5678');
  });
  it('redacts a bare high-entropy token (no bearer keyword)', () => {
    // Round 2: the bare-token rule is pure-hex; a hex-encoded secret is caught.
    const out = prepareContent([{ role: 'user', parts: [{ type: 'text', text: 'use c8f5e0a1b2c3d4e5f60718293a4b5c6d here' }] }], 'strict');
    expect(JSON.stringify(out.messages)).not.toContain('c8f5e0a1b2c3d4e5f60718293a4b5c6d');
    expect(out.summary['bare-token']).toBe(1);
  });
  it('does NOT redact ordinary 24-char prose identifiers (false-positive guard)', () => {
    const out = prepareContent([{ role: 'user', parts: [{ type: 'text', text: 'the quick brown fox jumps over the lazy dog near' }] }], 'strict');
    expect(JSON.stringify(out.messages)).toContain('the quick brown fox');
  });
});

describe('Round 2 widened rules', () => {
  const one = (text: string, preset: 'strict' | 'normal' = 'strict') =>
    prepareContent([{ role: 'user', parts: [{ type: 'text', text }] }], preset);

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
      [{ role: 'assistant', parts: [{ type: 'tool', callID: 'call_1', tool: 'Bash', status: 'ok', input: { c: 'x' }, output: 'y' }] }],
      'strict',
    );
    // tool name that is itself a secret token
    const out2 = prepareContent(
      [{ role: 'assistant', parts: [{ type: 'tool', tool: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', status: 'ok', input: {}, output: 'y' }] }],
      'strict',
    );
    expect(JSON.stringify(out2.messages)).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
  });
  it('redacts a secret hidden in an image src data-URI (plaintext), clean base64 passes', () => {
    // A plaintext data-URI whose payload literally contains an OpenAI key. The
    // targeted src scan (prefix keys + private-key + connection-string) catches
    // it. (A base64-encoded secret is undetectable by pattern matching — base64
    // encodes `sk-` into `c2st…` — so the scan is only meaningful for the
    // plaintext form.)
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';
    const evil = `data:text/plain;charset=utf-8,use ${secret} now`;
    const out = prepareContent(
      [{ role: 'assistant', parts: [{ type: 'image', src: evil, mime: 'text/plain', alt: 'shot', bytes: 3 }] }],
      'strict',
    );
    const src = out.messages[0]!.parts[0]!.src!;
    expect(src).not.toContain(secret);
    expect(src).toContain('REDACTED');
    // a clean base64 payload (no targeted rule trips) passes through untouched —
    // the over-redaction guard: a real image's base64 must survive.
    const clean = 'data:image/png;base64,QUJD+REVG/R0hJ+SktM/TU5O+PUFQ/SR8';
    const out2 = prepareContent(
      [{ role: 'assistant', parts: [{ type: 'image', src: clean, mime: 'image/png', alt: 'shot', bytes: 4 }] }],
      'strict',
    );
    expect(out2.messages[0]!.parts[0]!.src).toBe(clean);
  });
});
