# Architecture and security

## Packages

Quire is a pnpm workspace monorepo.

| Package | Role |
| --- | --- |
| `server/` | Hono + Drizzle (Postgres) API, redaction engine, and access controls; serves the built viewer |
| `cli/` | Publisher CLI with adapters for ZCode, Claude Code, Codex, and OMP |
| `plugin/` | Claude Code/ZCode `/share` command and native Codex `$share` skill |
| `web/` | Vue 3 + Vite + hand-written scoped CSS read-only viewer |
| `protocol/` | Shared sealed-share wire format and validation |
| `e2e/` | Playwright full-stack tests against the Docker stack |

## Publishing and reading

1. The harness adapter reads a local session. The CLI shapes it for size and relevance.
2. The owner confirms publishing, unless `--yes` is supplied. In-tool sharing integrations publish without a confirmation prompt.
3. The CLI generates an in-memory content key and sends the shaped content and key to the owner's server through authenticated HTTPS upload requests.
4. The server redacts the content in memory, then compresses and encrypts it into AES-256-GCM ciphertext envelopes before persisting transcript content.
5. The CLI appends the content key to the final share URL as its fragment (`#<key>`).
6. The viewer fetches ciphertext envelopes and decrypts them locally in the recipient's browser.

The ingestion server sees both raw content and the upload key. This is not end-to-end encryption against that server: use a server you trust. The key is not persisted or intentionally logged by Quire and is not sent to the public API when the share is opened. HTTP URL fragments are not transmitted to the server.

Viewer links use `/chats/<shareId>#<key>`; public API routes use `/api/v2/public/shares/:shareId/*`. Share IDs are 128-bit cryptographically random values, not harness session IDs. The entire link is sensitive: anyone holding it can decrypt an unprotected share. Password-protected shares also require unlocking. A link without its key fragment shows a missing-key error without a public-share fetch.

Postgres holds ciphertext envelopes plus lifecycle and owner-management metadata. Encryption of transcript blobs does not mean every database field is encrypted. See the [operations runbook](../operations/sealed-shares.md) for storage, migrations, metrics, and backups.

## Redaction boundary and limitations

The CLI shapes content; the server is the authoritative redaction boundary. Ordered rules cover private keys, JWTs, provider API keys, authorization credentials, connection strings, secret assignments and CLI arguments, bare tokens, private IPs, local paths, and encoded or embedded secret-bearing text. Both `strict` and `normal` presets redact at ingestion; raw publishing is not supported.

Automated rules cannot guarantee removal of every secret or sensitive fact. Review source material before publishing, including images: text redaction does not inspect image pixels. Your ingestion server receives the original shaped input, so HTTPS and trust in the operator remain necessary.

## Access controls

- A single owner `QUIRE_API_KEY` guards owner routes with Bearer authentication and constant-time comparison. Keep it private.
- Optional share passwords are hashed with argon2id. Unlock cookies are stateless and scoped to a share, signed with HMAC-SHA256 over `<token>|<expiry>` using `UNLOCK_SECRET`.
- Unlock cookies are `HttpOnly`, `Secure`, and `SameSite=Strict`, with a 30-minute TTL.
- Expired shares return `410` until cleanup removes them; cleanup hard-deletes expired shares hourly. Unknown and revoked IDs return byte-identical `404` responses to avoid an existence oracle.
- Failed unlocks are limited to 5 attempts per share+IP before a 15-minute lockout. Public API volume defaults to 120 requests/minute per IP. Correct client IP handling behind a proxy requires [proxy configuration](setup.md#make-shares-reachable).
- Security headers include a strict CSP, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `nosniff`, and HSTS. API errors use `{error:{code,message}}`.
- Each request is capped at 20 MB (`413`). This is a per-request bound, not a total share storage cap; large sessions upload in chunks.
- Logging must not contain secrets. `GET /metrics` exposes counts, bytes, latency, and status counters, not transcript content. The endpoint is unauthenticated; see the [runbook](../operations/sealed-shares.md#metrics).

Expiration and revocation stop future server access; they cannot remove screenshots, downloaded content, or other copies already held by recipients.

The [original design and threat reasoning](../superpowers/specs/2026-08-23-zcode-session-sharing-design.md) provides historical context, not a replacement for the current behavior above.

## Viewer behavior

The viewer is read-only and supports Markdown, Shiki syntax highlighting, automatic dark mode through `prefers-color-scheme`, and lazy loading in pages of 50 messages.

Consecutive tool calls form collapsible activity panels across message and page boundaries. Panels show short file/command previews and failure summaries, including explicit Claude Code tool-result errors. A single tool call has one disclosure. Opened details persist through pagination and group reopening; completed assistant Markdown is retained when later pages load.

System reminders have short previews, with full details available on demand. Empty thinking remains a plain label rather than an empty dropdown. Raw tool output retains its original whitespace without renderer-added indentation. Local file references render as text rather than navigable links; web and email links remain active.

[Technical documentation](README.md) · [Back to Quire](../../README.md)
