# Quire

Share AI coding-harness chat sessions (ZCode, Claude Code) over the web as
read-only, password-protectable, expiring links — with secrets redacted on the
server before anything is stored or sent.

## Features

- **Opt-in publishing.** Nothing is shared until the owner runs `quire publish`.
- **Password protection** (optional per share) with argon2id hashing and a
  stateless, per-share unlock cookie (`HttpOnly`, `Secure`, `SameSite=Strict`,
  30-minute TTL).
- **Expiration.** An expired share returns `410` and can never be read again.
- **Server-side redaction.** Ten ordered rules (private keys, JWTs, cloud API
  keys, connection strings, bearer tokens, generic `key = value` secrets,
  private IPs, local paths) run at ingestion. Only redacted content is
  persisted — the viewer's browser never receives a secret.
- **Long-session friendly viewer.** Vue 3 + Tailwind CSS v4, markdown + Shiki
  syntax highlighting, infinite-scroll lazy loading (50 messages per page),
  and automatic dark mode via `prefers-color-scheme`.
- **No existence oracle.** Unknown and revoked tokens return byte-identical
  `404`s.
- **Rate limiting.** 5 failed unlocks → 15-minute lockout per token+IP;
  120 requests/minute per IP across the public API.

## Architecture

pnpm workspace monorepo:

| Package         | What it is                                                        |
| --------------- | ----------------------------------------------------------------- |
| `server/`       | Hono + Drizzle (Postgres) API, redaction engine, security layer  |
| `cli/`          | `quire` publisher CLI with harness adapters (ZCode, Claude Code) |
| `plugin/`       | Claude Code–format `/share` plugin (works in ZCode too)          |
| `web/`          | Vue 3 + Vite + Tailwind v4 read-only viewer                      |
| `e2e/`          | Playwright full-stack tests (drives the Docker stack)            |

Data flow: harness session → adapter shapes it → CLI previews the redacted
result (mandatory) → owner confirms → `POST /api/chats` persists only the
redacted content → viewer fetches pages by cursor from `/api/public/chats/:token`.

Shares live under `/chats/<token>` (viewer) and `/api/public/chats/:token`
(API). Tokens are 128-bit crypto-random; session ids never appear in URLs.

## Security model

- Single `QUIRE_API_KEY` (Bearer, constant-time compare) guards owner routes.
- Unlock cookies are HMAC-SHA256 over `<token>|<expiry>`, signed with
  `UNLOCK_SECRET` — no server-side session state.
- Strict CSP, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
  `nosniff`, HSTS. Uniform error bodies `{error:{code,message}}`.
- 20 MB request cap (`413`). No secrets in logs.
- See `docs/superpowers/specs/2026-08-23-zcode-session-sharing-design.md` for
  the full design and threat reasoning.

## Quick start (local dev)

```bash
pnpm install
pnpm db:test:up            # Postgres on :54329 for tests
pnpm typecheck
pnpm test                  # unit tests for all packages + E2E (needs Docker)
```

Run the server against a local Postgres:

```bash
cp .env.example .env       # fill in QUIRE_API_KEY / UNLOCK_SECRET
pnpm --filter @quire/server dev
```

## CLI

```bash
quire setup                # writes ~/.quire/config.json, prints server .env block
quire publish --current    # preview redacted session, confirm, publish
quire list                 # list active shares
quire revoke <token>       # soft-revoke (share becomes a 404)
quire update <token> --expires-at 2026-09-01
```

Environment: `QUIRE_SERVER_URL`, `QUIRE_API_KEY` (override the config file).
Harness detection: `--harness zcode|claude` flag, else `CLAUDECODE` /
`ZCODE_APP_VERSION` env, else the more recently modified session store.

## Plugin

Claude Code–format plugin; install it in Claude Code or ZCode and use
`/share` in a session to run the same preview-then-publish flow.

## Deployment (Docker)

```bash
cp .env.example .env       # set QUIRE_API_KEY, UNLOCK_SECRET, POSTGRES_PASSWORD
docker compose up -d --build
```

The server listens on `127.0.0.1:8787` inside the host; front it with your
reverse proxy (Caddy/Nginx/Traefik) on your chosen host. Notes:

- Serve over HTTPS — the unlock cookie is `Secure` and will not be sent over
  plain HTTP (localhost is exempt).
- Forward `X-Forwarded-For` so rate limiting sees real client IPs.
- The server runs its migrations at startup; no separate migration step.

## Testing

- Unit: `pnpm --filter @quire/<server|cli|web|plugin> test`
  (server tests need `pnpm db:test:up` first).
- E2E: `pnpm --filter @quire/e2e test` — builds and drives the compose stack
  on port 8790, then tears it down. Requires Docker.
