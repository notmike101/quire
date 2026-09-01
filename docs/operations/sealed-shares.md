# Sealed shares (v2) — operations

Operator runbook for the sealed-share (v2) canary: deploy order, the metrics to
monitor, rollback, and backup/restore.

## What v2 stores

A v2 share is a set of AES-256-GCM ciphertext envelopes in three plain Postgres
tables (`shares_v2`, `share_source_chunks_v2`, `share_blobs_v2`) plus lifecycle
metadata. The content key never reaches the server's storage or logs: it rides
in the authenticated upload HTTP, then in the final share URL's fragment
(`#<key>`), and lives only in the viewer's browser. Only server-redacted
content is ever encrypted.

## Deploy order

1. **Additive migration.** Deploy the server build. At startup it runs the v2
   migration (three new tables, cascade FKs, one index) — strictly additive,
   zero v1 changes.
2. **Server dual-read, v2 writes off.** `QUIRE_V2_WRITE_ENABLED=false` (the
   default). v2 public reads work; the v2 ingestion routes
   (`POST /api/v2/shares`, chunk, finalize) return the uniform 404,
   indistinguishable from an unknown path.
3. **Web dual-read deployed.** The viewer decrypts v2 blobs in the browser when
   the URL fragment carries a content key; v1 URLs are unchanged.
4. **CLI opt-in exercised by operators.** `quire publish --format v2`
   (or the OMP `/share` handler with the flag) publishes v2 shares; verify
   they render, redact, expire, and revoke correctly.
5. **v2 writes on.** `QUIRE_V2_WRITE_ENABLED=true`.
6. **Canary.** Monitor the metrics below. When they are clean, switch the CLI
   default to v2 (the CLI's default format becomes `v2`).
7. **Retire v1 reads.** Once the canary passes and the CLI default is v2, set
   `QUIRE_V1_READS_ENABLED=false`. v1 public links stop working immediately —
   there is no grace window (accepted). v1 owner reads and the v1 table are
   untouched.

## Canary metrics

`GET /metrics` (unauthenticated, like `/healthz`) returns the in-process v2
pipeline counters. Values are counts, bytes, latency (avg/max ms), and HTTP
status only — never share IDs, titles, keys, URLs, tokens, or content.

| category                  | meaning                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `v2_create`               | `POST /api/v2/shares` outcomes (201 = created; 409 = duplicate/conflict; 413 = too large) |
| `v2_chunk`                | source-chunk uploads (200 = accepted; 400 = out-of-order/invalid; 409 = digest conflict)  |
| `v2_finalize`             | finalizations (200 = sealed; 400 = incomplete; 404 = unknown share/token)                 |
| `v2_blob_serve`           | public blob fetches (200 = served, with bytes; 404 = unknown/incomplete; 410 = expired; 401 = password; 500 = corrupt row) |
| `v2_client_decrypt_error` | a served blob whose stored digest no longer matches its ciphertext — the row is corrupt and can never decrypt (500). The only decrypt failure the server can observe; client-side failures (wrong key in the fragment) are never reported. |
| `v2_stale_cleanup`        | hourly cleanup run (status 0 = non-HTTP job; `count` = expired v2 shares hard-deleted)    |

Canary signals: `v2_blob_serve` 200s with bytes growing, `v2_create`/`v2_chunk`/
`v2_finalize` 200/201s, zero `v2_client_decrypt_error`, and `v2_stale_cleanup`
reclaiming expired shares. A non-zero `v2_client_decrypt_error` means stored
ciphertext is corrupt — treat it as a data-integrity incident.

Expired v2 shares return 410 from the moment they expire and are hard-deleted
(with their chunks and blobs) by the hourly cleanup job, so rows are reclaimed
within an hour.

## Rollback

1. Disable v2 writes: `QUIRE_V2_WRITE_ENABLED=false` (new v2 shares stop; the
   ingestion routes 404 again).
2. Re-enable v1 reads: `QUIRE_V1_READS_ENABLED=true` (v1 links work again).
3. Point the CLI back to `--format v1`.

**Never drop the v2 tables during rollback.** A v2 share already published
stays readable — v2 reads are never disabled by any flag. Rollback also
requires the v1 tables to be retained (not dropped) while v2 is in use; they
may be dropped only after v2 is verified and v1 reads are retired.

## Backup / restore

The v2 tables are plain Postgres (ciphertext + metadata); a standard
`pg_dump`/restore covers them — no special tooling:

```bash
pg_dump -Fc quire > quire.dump
pg_restore -d quire_fresh --clean quire.dump
```

Restore is byte-stable: each blob's AAD is derived from the stored `publicId`,
which survives the dump, so restored blobs decrypt identically and the share
keeps working at its existing URL. Verify after a restore by opening one v2
share and confirming it renders (the browser decrypts the restored envelopes).
