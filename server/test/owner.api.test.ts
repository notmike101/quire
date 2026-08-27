import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeDb, migrateDb, type Db } from '../src/db/client.js';
import { createApp } from '../src/app.js';
import { shares, shareMessages } from '../src/db/schema.js';
import { eq, sql } from 'drizzle-orm';

const url = process.env.DATABASE_URL ?? 'postgres://quire:quire@localhost:54329/quire_test';
const config = { databaseUrl: url, apiKey: 'a'.repeat(64), unlockSecret: 'b'.repeat(64), port: 8787, webDist: '' };
const auth = { authorization: `Bearer ${'a'.repeat(64)}`, 'content-type': 'application/json' };

const session = {
  sessionId: 'sess_owner',
  title: 'Owner share',
  model: 'test-model',
  messages: [
    { role: 'user', parts: [{ type: 'text', text: 'use AKIAABCDEFGHIJKLMNOP please' }] },
    { role: 'assistant', parts: [{ type: 'text', text: 'done' }] },
  ],
};

let db: Db;
let app: ReturnType<typeof createApp>;
let token: string;

/** Response.json() is typed Promise<unknown> under @types/node (no DOM lib); cast to a plain object. */
const json = (r: Response): Promise<Record<string, any>> => r.json() as Promise<Record<string, any>>;

beforeAll(async () => {
  db = makeDb(url);
  // postgres.js console.logs NOTICE lines by default; migrateDb against the
  // already-migrated test container emits two ("schema/relation already
  // exists, skipping"). Silence them so this file's output stays clean.
  const origLog = console.log;
  console.log = () => {};
  try {
    await migrateDb(db);
  } finally {
    console.log = origLog;
  }
  await db.execute(sql`delete from shares`);
  app = createApp({ db, config });
});

afterAll(async () => {
  await db.execute(sql`delete from shares`);
  await (db as unknown as { $client?: { end(): Promise<void> } }).$client?.end();
});

describe('owner auth', () => {
  it('401 without an API key', async () => {
    const res = await app.request('/api/chats');
    expect(res.status).toBe(401);
    expect((await json(res)).error.code).toBe('unauthorized');
  });
  it('401 with a wrong API key', async () => {
    const res = await app.request('/api/chats', { headers: { authorization: 'Bearer wrong' } });
    expect(res.status).toBe(401);
  });
});

describe('preview', () => {
  it('redacts and reports without persisting', async () => {
    const before = await db.select().from(shares);
    const res = await app.request('/api/chats/preview', { method: 'POST', headers: auth, body: JSON.stringify({ session, preset: 'strict' }) });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(JSON.stringify(body.messages)).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(body.summary['aws-access-key']).toBe(1);
    expect(body.messageCount).toBe(2);
    const after = await db.select().from(shares);
    expect(after).toHaveLength(before.length);
  });
});

describe('create', () => {
  it('creates a share and persists only redacted content', async () => {
    const res = await app.request('/api/chats', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ session, preset: 'strict', password: 'pw12345', expiresAt: new Date(Date.now() + 3600_000).toISOString() }),
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    token = body.token;
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(body.url).toBe(`/chats/${token}`);
    const msgs = await db.select().from(shareMessages).where(eq(shareMessages.shareId, (await db.select().from(shares).where(eq(shares.token, token)))[0]!.id));
    expect(JSON.stringify(msgs)).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(JSON.stringify(msgs)).toContain('[REDACTED:aws-access-key]');
  });

  it('rejects an invalid body with 400', async () => {
    const res = await app.request('/api/chats', { method: 'POST', headers: auth, body: JSON.stringify({ session: { title: '' } }) });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe('validation');
  });

  it('stores a session whose tool output contains NUL/control chars (no 500, messages persisted)', async () => {
    // Regression: Postgres rejects NUL in jsonb; real ZCode tool output carries them.
    const nulSession = {
      sessionId: 'sess_nul',
      title: 'NUL session',
      messages: [
        { role: 'user', parts: [{ type: 'text', text: 'run it' }] },
        { role: 'assistant', parts: [{ type: 'tool', callID: 'c1', tool: 'Bash', status: 'completed', input: { cmd: 'x\u0000y' }, output: 'bin\u0000\u001Bary' }] },
      ],
    };
    const res = await app.request('/api/chats', { method: 'POST', headers: auth, body: JSON.stringify({ session: nulSession, preset: 'strict' }) });
    expect(res.status).toBe(201);
    const body = await json(res);
    const nulToken = body.token as string;
    expect(body.messageCount).toBe(2);
    const share = (await db.select().from(shares).where(eq(shares.token, nulToken)))[0]!;
    const msgs = await db.select().from(shareMessages).where(eq(shareMessages.shareId, share.id));
    expect(msgs).toHaveLength(2);
    // NUL/control chars stripped, surrounding content intact. `parts` is a jsonb array.
    const tool = (msgs.find((m) => m.seq === 2)!.parts as Array<{ input: { cmd: string }; output: string }>)[0]!;
    expect(tool.input.cmd).toBe('xy');
    expect(tool.output).toBe('binary');
    // Clean up this extra share so the list/delete tests below see only `token`.
    await db.execute(sql`delete from shares where token = ${nulToken}`);
  });
});

describe('list / get / patch / delete', () => {
  it('lists shares without content', async () => {
    const res = await app.request('/api/chats', { headers: auth });
    const body = await json(res);
    const mine = body.shares.find((s: { token: string }) => s.token === token);
    expect(mine).toBeDefined();
    expect(mine.hasPassword).toBe(true);
    expect(mine.revoked).toBe(false);
  });

  it('gets share meta', async () => {
    const res = await app.request(`/api/chats/${token}`, { headers: auth });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.title).toBe('Owner share');
    expect(body.hasPassword).toBe(true);
  });

  it('patch: change password, clear expiry, then revoke', async () => {
    let res = await app.request(`/api/chats/${token}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ password: 'newpass', expiresAt: null }) });
    expect(res.status).toBe(200);
    let share = (await db.select().from(shares).where(eq(shares.token, token)))[0]!;
    expect(share.expiresAt).toBeNull();
    expect(share.passwordHash).not.toBeNull();

    res = await app.request(`/api/chats/${token}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ revoke: true }) });
    expect(res.status).toBe(200);
    share = (await db.select().from(shares).where(eq(shares.token, token)))[0]!;
    expect(share.revokedAt).not.toBeNull();
  });

  it('delete soft-revokes; unknown token is 404', async () => {
    let res = await app.request('/api/chats/neverexisted', { method: 'DELETE', headers: auth });
    expect(res.status).toBe(404);
    res = await app.request(`/api/chats/${token}`, { method: 'DELETE', headers: auth });
    expect(res.status).toBe(200);
    // revoked share is invisible to the public API
    const pub = await app.request(`/api/public/chats/${token}`);
    expect(pub.status).toBe(404);
  });
});
