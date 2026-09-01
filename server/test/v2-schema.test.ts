import { describe, it, expect, beforeAll } from 'vitest';
import { makeDb, migrateDb } from '../src/db/client.js';
import { sql } from 'drizzle-orm';

const url = process.env.DATABASE_URL ?? 'postgres://quire:quire@localhost:54329/quire_test';

// Raw SQL on purpose: this test must compile (and fail at runtime) before the
// v2 tables exist in the schema module and in the database.
const idOf = (rows: Record<string, unknown>[]): string => {
  const row = rows[0];
  if (!row || typeof row.id !== 'string') throw new Error('insert did not return a string id');
  return row.id;
};

const countOf = (rows: Record<string, unknown>[]): number => {
  const row = rows[0];
  if (!row || typeof row.n !== 'number') throw new Error('count query did not return n');
  return row.n;
};

describe('v2 sealed share schema', () => {
  beforeAll(async () => {
    const db = makeDb(url);
    await migrateDb(db);
  });

  it('creates the three v2 tables', async () => {
    const db = makeDb(url);
    const res = await db.execute(sql`
      select table_name from information_schema.tables
      where table_schema = 'public'
        and table_name in ('shares_v2','share_source_chunks_v2','share_blobs_v2')
      order by table_name
    `);
    expect(res.map((r) => r.table_name)).toEqual([
      'share_blobs_v2',
      'share_source_chunks_v2',
      'shares_v2',
    ]);
  });

  it('cascades share_source_chunks_v2 and share_blobs_v2 when a shares_v2 row is deleted', async () => {
    const db = makeDb(url);
    const ins = await db.execute(sql`
      insert into shares_v2 (public_id, upload_request_id, upload_token_hash, source_chunk_count)
      values ('v2-cascade', 'req-cascade', 'tokhash', 1)
      returning id
    `);
    const id = idOf(ins as Record<string, unknown>[]);
    await db.execute(sql`
      insert into share_source_chunks_v2 (share_id, source_seq, request_digest)
      values (${id}, 0, 'digest')
    `);
    await db.execute(sql`
      insert into share_blobs_v2 (share_id, kind, seq, ciphertext, ciphertext_bytes, digest)
      values (${id}, 'manifest', 0, decode('00', 'hex'), 1, 'd')
    `);
    await db.execute(sql`delete from shares_v2 where id = ${id}`);
    const chunks = await db.execute(sql`
      select count(*)::int as n from share_source_chunks_v2 where share_id = ${id}
    `);
    const blobs = await db.execute(sql`
      select count(*)::int as n from share_blobs_v2 where share_id = ${id}
    `);
    expect(countOf(chunks as Record<string, unknown>[])).toBe(0);
    expect(countOf(blobs as Record<string, unknown>[])).toBe(0);
  });

  it('public_id and upload_request_id are unique', async () => {
    const db = makeDb(url);
    await db.execute(sql`
      insert into shares_v2 (public_id, upload_request_id, upload_token_hash, source_chunk_count)
      values ('v2-uniq', 'req-uniq', 'tokhash', 1)
    `);
    await expect(
      db.execute(sql`
        insert into shares_v2 (public_id, upload_request_id, upload_token_hash, source_chunk_count)
        values ('v2-uniq', 'req-uniq-2', 'tokhash', 1)
      `),
    ).rejects.toThrow(/public_id/);
    await expect(
      db.execute(sql`
        insert into shares_v2 (public_id, upload_request_id, upload_token_hash, source_chunk_count)
        values ('v2-uniq-2', 'req-uniq', 'tokhash', 1)
      `),
    ).rejects.toThrow(/upload_request_id/);
    await db.execute(sql`delete from shares_v2 where public_id in ('v2-uniq','v2-uniq-2')`);
  });
});
