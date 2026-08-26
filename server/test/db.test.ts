import { describe, it, expect, beforeAll } from 'vitest';
import { makeDb, migrateDb } from '../src/db/client.js';
import { sql } from 'drizzle-orm';

const url = process.env.DATABASE_URL ?? 'postgres://quire:quire@localhost:54329/quire_test';

describe('schema + migrations', () => {
  beforeAll(async () => {
    const db = makeDb(url);
    await migrateDb(db);
    // Drop the tracking table then the now-empty drizzle schema so the
    // second migrateDb recreates everything without emitting NOTICEs.
    await db.execute(sql`drop table if exists share_messages; drop table if exists shares; drop table if exists drizzle.__drizzle_migrations; drop schema if exists drizzle;`);
    await migrateDb(db);
  });

  it('creates both tables with the expected columns', async () => {
    const db = makeDb(url);
    const res = await db.execute(sql`
      select table_name, column_name
      from information_schema.columns
      where table_name in ('shares','share_messages')
      order by table_name, ordinal_position
    `);
    const cols = res.map((r) => `${r.table_name}.${r.column_name}`);
    expect(cols).toContain('shares.token');
    expect(cols).toContain('shares.password_hash');
    expect(cols).toContain('shares.expires_at');
    expect(cols).toContain('share_messages.seq');
    expect(cols).toContain('share_messages.parts');
  });

  it('cascades share_messages when a share is deleted', async () => {
    const db = makeDb(url);
    const ins = await db.execute(sql`
      insert into shares (token, session_id, title) values ('t-cascade', 's1', 'T')
      returning id
    `);
    const id = (ins[0] as { id: string }).id;
    await db.execute(sql`insert into share_messages (share_id, seq, role, parts) values (${id}, 1, 'user', '[]'::jsonb)`);
    await db.execute(sql`delete from shares where id = ${id}`);
    const left = await db.execute(sql`select count(*)::int as n from share_messages where share_id = ${id}`);
    expect((left[0] as { n: number }).n).toBe(0);
  });
});
