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
    await db.execute(sql`drop table if exists share_blobs_v2; drop table if exists share_source_chunks_v2; drop table if exists shares_v2; drop table if exists share_messages; drop table if exists shares; drop table if exists unlock_lockouts; drop table if exists drizzle.__drizzle_migrations; drop schema if exists drizzle;`);
    await migrateDb(db);
  });

  it('drops the v1 tables and creates the v2 tables with the expected columns', async () => {
    const db = makeDb(url);
    const v1 = await db.execute(sql`
      select table_name
      from information_schema.tables
      where table_name in ('shares','share_messages')
    `);
    expect(v1).toHaveLength(0); // migration 0008 drops the v1 tables
    const res = await db.execute(sql`
      select table_name, column_name
      from information_schema.columns
      where table_name in ('shares_v2','share_source_chunks_v2','share_blobs_v2')
      order by table_name, ordinal_position
    `);
    const cols = res.map((r) => `${r.table_name}.${r.column_name}`);
    expect(cols).toContain('shares_v2.public_id');
    expect(cols).toContain('shares_v2.upload_token_hash');
    expect(cols).toContain('shares_v2.expires_at');
    expect(cols).toContain('share_source_chunks_v2.source_seq');
    expect(cols).toContain('share_blobs_v2.ciphertext');
  });

  it('cascades v2 source chunks and blobs when a share is deleted', async () => {
    const db = makeDb(url);
    const ins = await db.execute(sql`
      insert into shares_v2 (public_id, upload_request_id, upload_token_hash, source_chunk_count)
      values ('c-cascade', 'req-cascade', 'h-cascade', 2)
      returning id
    `);
    const id = (ins[0] as { id: string }).id;
    await db.execute(sql`insert into share_source_chunks_v2 (share_id, source_seq, request_digest) values (${id}, 0, 'd0')`);
    await db.execute(sql`insert into share_blobs_v2 (share_id, kind, seq, ciphertext, ciphertext_bytes, digest) values (${id}, 'manifest', 0, decode('00','hex'), 1, 'd')`);
    await db.execute(sql`delete from shares_v2 where id = ${id}`);
    const chunks = await db.execute(sql`select count(*)::int as n from share_source_chunks_v2 where share_id = ${id}`);
    expect((chunks[0] as { n: number }).n).toBe(0);
    const blobs = await db.execute(sql`select count(*)::int as n from share_blobs_v2 where share_id = ${id}`);
    expect((blobs[0] as { n: number }).n).toBe(0);
  });

  it('shares_v2 has upload_request_id and share_source_chunks_v2 has source_seq', async () => {
    const db = makeDb(url);
    const shareCols = await db.execute(sql`
      select column_name from information_schema.columns
      where table_name = 'shares_v2' and column_name = 'upload_request_id'
    `);
    expect(shareCols.length).toBe(1);
    const chunkCols = await db.execute(sql`
      select column_name from information_schema.columns
      where table_name = 'share_source_chunks_v2' and column_name = 'source_seq'
    `);
    expect(chunkCols.length).toBe(1);
  });
});
