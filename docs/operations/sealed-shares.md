# Sealed shares — operations

Operator runbook for sealed shares: what the server stores, the migration that
retired v1, the metrics to monitor, rollback, and backup/restore.

## What a share stores

A share is a set of AES-256-GCM ciphertext envelopes in three plain Postgres
tables (`shares_v2`, `share_source_chunks_v2`, `share_blobs_v2`) plus lifecycle
metadata. The content key never reaches the server's storage or logs: it rides
in the authenticated upload HTTP, then in the final share URL's fragment
(`#<key>`), and lives only in the viewer's browser. Only server-redacted
content is ever encrypted.

## Migration 0008 (v1 deprecation)

Migration 0008 drops the v1 tables (`shares`, `share_messages`) — destructive
and one-way. The server runs it at startup, so at deploy every existing v1
share dies: v1 links stop resolving the moment the new build starts, and only
a pre-0008 backup restore can bring them back. This is intentional — sealed
shares are the only format, and there are no gate env vars to flip.

## Metrics

`GET /metrics` (unauthenticated, like `/healthz`) returns the in-process
pipeline counters. Values are counts, bytes, latency (avg/max ms), and HTTP
status only — never share IDs, titles, keys, URLs, tokens, or content.

| category                  | meaning                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `v2_create`               | `POST /api/v2/shares` outcomes (201 = created; 409 = duplicate/conflict; 413 = too large) |
| `v2_chunk`                | source-chunk uploads (200 = accepted; 400 = out-of-order/invalid; 409 = digest conflict)  |
| `v2_finalize`             | finalizations (200 = sealed; 400 = incomplete; 404 = unknown share/token)                 |
| `v2_blob_serve`           | public blob fetches (200 = served, with bytes; 404 = unknown/incomplete; 410 = expired; 401 = password; 500 = corrupt row) |
| `v2_client_decrypt_error` | a served blob whose stored digest no longer matches its ciphertext — the row is corrupt and can never decrypt (500). The only decrypt failure the server can observe; client-side failures (wrong key in the fragment) are never reported. |
| `v2_stale_cleanup`        | hourly cleanup run (status 0 = non-HTTP job; `count` = expired shares hard-deleted + stale uploads reclaimed) |

Healthy signals: `v2_blob_serve` 200s with bytes growing, `v2_create`/`v2_chunk`/
`v2_finalize` 200/201s, zero `v2_client_decrypt_error`, and `v2_stale_cleanup`
reclaiming rows. A non-zero `v2_client_decrypt_error` means stored
ciphertext is corrupt — treat it as a data-integrity incident.

Expired shares return 410 from the moment they expire and are hard-deleted
(with their chunks and blobs) by the hourly cleanup job, so rows are
reclaimed within an hour. The same job reclaims uploads that died mid-flight
(`state = 'uploading'`, older than 24h).

## Rollback

Redeploy the previous commit. There are no gate env vars to flip: v2 reads
were never disabled, so shares published before the rollback keep working
under the previous build. v1 links are dead either way — the v1 tables are
dropped by 0008 and stay dropped after the redeploy, so the previous
build's v1 routes error on the missing tables.

## Backup / restore

The share tables are plain Postgres (ciphertext + metadata); a standard
`pg_dump`/restore covers them — no special tooling:

```bash
pg_dump -Fc quire > quire.dump
pg_restore -d quire_fresh --clean quire.dump
```

Restore is byte-stable: each blob's AAD is derived from the stored `publicId`,
which survives the dump, so restored blobs decrypt identically and the share
keeps working at its existing URL. Verify after a restore by opening one
share and confirming it renders (the browser decrypts the restored
envelopes).
