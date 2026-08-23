# Quire — AI Session Sharing — Design Spec

- **Date:** 2026-08-23
- **Status:** Draft for review
- **Product name:** **Quire** (CLI binary `quire`; workspace packages `@quire/*`)
- **Feature path:** `/chats` (isolated from other future share types on the same server)
- **Host:** owner-configured. The domain/subdomain is intentionally **not** hardcoded anywhere;
  the owner points their host (e.g. a subdomain) at the server. URL examples below use
  `https://<your-host>`.

## 1. Overview & goals

Let the owner of local AI coding-harness sessions **opt-in share** individual sessions with
other people over the web, rendered in a clean, ChatGPT-share-like read-only page.

Hard requirements:

1. **Opt-in only.** A session is never shared until the owner explicitly publishes it. Nothing
   is shared by default.
2. **Password protection** (optional per share).
3. **Expiration** (optional per share). Once expired, nobody can access the content further.
4. **Revocation** (owner can kill a share at any time).
5. **Isolation.** The feature lives under `/chats` so other things can be shared on the same
   server without collision.
6. **No secrets leak to viewers.** Sensitive data (API keys, tokens, private keys, connection
   strings, local paths, private IPs) is redacted **server-side at ingestion** and never stored
   or served in raw form.
7. **Visually pleasing** read-only transcript, similar in feel to `chatgpt.com/share/…`.
8. **Dark mode.** Respect the reader's browser/OS `prefers-color-scheme`; both light and dark
   palettes are designed.
9. **Lazy loading.** Sessions can be extremely long; the viewer loads messages in pages on
   scroll (cursor-paginated), never fetching the whole transcript at once.
10. **Multi-harness plugin (v1: Claude Code + ZCode).** A single plugin, built in Claude Code
    plugin format, that works in both Claude Code and ZCode now; other harnesses later.

### Non-goals (v1)

- No multi-user / accounts / team features. Single owner (the API-key holder).
- No web admin UI. All management is via the CLI.
- No editing of shared content after publish (only password / expiry / revoke).
- No sharing of subagent sessions by default (see §10 session resolution).
- No analytics / view counting.
- No i18n. (Dark mode **is** in scope, per requirement 8.)
- No plugins for harnesses other than Claude Code and ZCode yet.

## 2. Architecture

Four components in one pnpm-workspaces monorepo.

| Component | Runs | Responsibility |
|---|---|---|
| `cli/` (`quire`) | Owner's machine | Read the **current harness's** session store (read-only) via a **harness adapter layer** (ZCode + Claude Code for v1), **shape** the session (select shareable parts, truncate oversized tool outputs), preview, upload via the owner API. Does **not** redact. |
| `plugin/` | Inside a harness | A Claude Code–format plugin exposing `/share`, which invokes `quire publish` for the current session. Harness-agnostic thin wrapper over the CLI. |
| `server/` | VPS (Docker) | Hono + Drizzle + Postgres. Owns the **redaction pipeline** (single source of truth). Owner CRUD API + public access gate + **cursor-paginated** content delivery. Serves the SPA static files. |
| `web/` | Built into server image | Vue 3 SPA. Renders the transcript with **lazy loading** (infinite scroll) and **dark mode**; handles password gate / expired / not-found states. |

**Key security boundary:** the CLI *shapes* (size/relevance); the server *redacts* (security).
Raw content crosses the wire over HTTPS to the owner's own trusted server — at preview and
again at create — where it is redacted in memory and **only the redacted result is persisted**.
The viewer's browser only ever receives redacted content, one page at a time.

**Why normalized storage:** sessions can be extremely long (thousands of messages, multi-MB).
Storing the transcript as one `jsonb` blob and slicing it per request would be inefficient.
Instead the transcript is normalized into a `share_messages` table so pagination is a natural,
indexed SQL query and the viewer can lazily fetch pages.

### Repo layout

```
<repo>/                          # owner names the repo (e.g. "quire")
  package.json                   # root, pnpm workspaces
  pnpm-workspace.yaml
  tsconfig.base.json
  .gitignore
  README.md
  server/
    package.json                 # @quire/server
    drizzle.config.ts
    src/
      index.ts                   # Hono app entry, mounts routes + static
      config.ts                  # env parsing (zod)
      db/
        schema.ts                # Drizzle schema (shares, share_messages)
        client.ts                # postgres client
      migrations/                # drizzle-kit generated SQL
      routes/
        public.ts                # /api/public/chats/*  (paginated)
        owner.ts                 # /api/chats/*
        spa.ts                   # serve /chats/* static + fallback
      middleware/
        apiKey.ts                # Bearer key auth for /api/chats
        ratelimit.ts             # per-IP + per-token limits
        unlockCookie.ts          # signed short-lived unlock cookie
      redact/
        rules.ts                 # ordered rule definitions (data-driven)
        pipeline.ts              # prepareContent(raw, preset) -> {messages, summary}
  web/
    package.json                 # @quire/web
    index.html
    vite.config.ts
    tailwind.config.js           # darkMode: 'media'
    src/
      main.ts
      App.vue
      api.ts                     # typed fetch client (paginated)
      types.ts
      composable/
        useMessages.ts           # cursor-paginated infinite scroll
      components/
        MessageList.vue          # renders pages + scroll sentinel
        Message.vue
        UserBubble.vue
        AssistantMessage.vue
        ToolCard.vue             # collapsible tool call
        CodeBlock.vue            # Shiki + copy button
        ReasoningBlock.vue       # collapsible "thinking"
        PasswordGate.vue
        ExpiredPage.vue
        NotFoundPage.vue
        HeaderBar.vue
  cli/
    package.json                 # @quire/cli, bin: quire
    src/
      index.ts                   # command router
      config.ts                  # server URL + API key (env / ~/.quire/config.json)
      harness/
        types.ts                 # HarnessAdapter + ShapedSession contracts
        detect.ts                # auto-detect the running/available harness
        zcode.ts                 # read ~/.zcode/cli/db/db.sqlite (session/message/part)
        claude-code.ts           # read Claude Code session JSONL store
      shape.ts                   # filter parts + truncate tool outputs (per adapter)
      api.ts                     # HTTP client (preview / publish / list / revoke / update)
      commands/
        publish.ts
        list.ts
        revoke.ts
        update.ts
        setup.ts                 # generate + print API key / unlock secret for .env
  plugin/
    .claude-plugin/
      plugin.json                # Claude Code plugin manifest
    commands/
      share.md                   # /share slash command
    README.md                    # install + usage (Claude Code + ZCode)
  docker/
    Dockerfile                   # multi-stage: build web + server, run server
    docker-compose.yml           # server + postgres
    .env.example
  docs/superpowers/specs/        # this file
```

## 3. Data model

### 3.1 Postgres — `shares`

```sql
create table shares (
  id            uuid primary key default gen_random_uuid(),
  token         text not null unique,          -- 128-bit crypto-random; ONLY thing in the URL
  session_id    text not null,                 -- original harness session id (reference only, never in URL)
  title         text not null,
  model         text,
  provider      text,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz,                   -- null = no expiry
  password_hash text,                          -- argon2id hash; null = no password
  revoked_at    timestamptz,                   -- set on revoke
  preset        text not null default 'strict',-- redaction preset used at ingestion
  message_count int  not null default 0,
  redactions    jsonb not null default '{}',   -- { "api-key": 3, "file-path": 5 }
  bytes         int  not null default 0
);
create index shares_created_at_idx on shares (created_at desc);
```

### 3.2 Postgres — `share_messages` (normalized transcript)

```sql
create table share_messages (
  share_id uuid not null references shares(id) on delete cascade,
  seq      int  not null,                      -- 0-based order within the share
  role     text not null,                      -- user | assistant | system
  time     timestamptz,
  parts    jsonb not null,                     -- array of REDACTED parts (see 3.3)
  primary key (share_id, seq)
);
create index share_messages_seq_idx on share_messages (share_id, seq);
```

Notes:
- `token` is the access key: `crypto.randomBytes(16)` as 32 lowercase hex chars. Not the
  harness session id; not guessable.
- `parts` is stored **already redacted**. Read-time serving is a plain indexed range query.
- Normalization makes lazy loading a first-class, efficient feature (§6, §9).

### 3.3 `parts` JSON shape (per message, redacted)

```jsonc
[
  { "type": "text", "text": "…" },
  { "type": "tool", "tool": "Bash",
    "state": { "status": "completed", "input": { }, "output": "…", "truncated": false } },
  { "type": "reasoning", "text": "…" }
]
```

Part selection (at shaping, before upload): keep `text`, `tool`, `reasoning`; drop
`step-start`, `step-finish`, `compaction`. Tool `output` truncated to a max (default 20 KB)
with `truncated: true` when cut. Truncation happens **before** redaction so multi-MB outputs
are never processed.

## 4. API surface

All owner endpoints require `Authorization: Bearer <QUIRE_API_KEY>`. Public endpoints do not.
The SPA is same-origin with the API, so no CORS is needed.

### Public (viewer)

| Method & path | Purpose |
|---|---|
| `GET /chats/:token` | Serve the Vue SPA (static, with client-side fallback) |
| `GET /api/public/chats/:token?limit&cursor` | Status + one **page** of redacted messages |
| `POST /api/public/chats/:token/unlock` | Verify password, set unlock cookie |

`GET /api/public/chats/:token` (query: `limit` default 50, max 200; `cursor` = last `seq` seen):

| Condition | Status | Body |
|---|---|---|
| Token unknown **or** revoked | `404` | `{ error:{ code:"not_found", message:"Share not found" } }` |
| Expired (`now > expires_at`) | `410` | `{ error:{ code:"expired", message:"This share has expired" } }` |
| Active, has password, not unlocked | `401` | `{ error:{ code:"needs_password", message:"A password is required" } }` |
| Active, no password **or** valid unlock cookie | `200` | `{ meta, messages, nextCursor }` |

On `200`:
```jsonc
{
  "meta": { "title": "…", "model": "…", "provider": "…", "createdAt": "…",
            "messageCount": 420, "expiresAt": "…|null" },
  "messages": [ { "seq": 0, "role": "user", "time": "…", "parts": [ … ] } ],
  "nextCursor": 49        // last seq returned; pass back as ?cursor to fetch the next page
                          // null when there are no more messages
}
```
The page is `share_messages` rows with `seq > cursor` (or all, when no cursor), ordered by
`seq`, limited to `limit`. The unlock cookie is checked on **every** page fetch for
password-protected shares.

`POST /api/public/chats/:token/unlock` body `{ "password": "…" }`:

| Condition | Status | Effect |
|---|---|---|
| Unknown/revoked | `404` | — |
| Expired | `410` | — |
| No password set | `400` | `{ code:"no_password" }` |
| Wrong password | `401` | `{ code:"bad_password" }`; increments rate-limit counter |
| Correct | `200` | `Set-Cookie: quire_unlock_<token>=<signed>; HttpOnly; Secure; SameSite=Strict; Max-Age=1800; Path=/` |

### Owner (publisher)

| Method & path | Purpose |
|---|---|
| `POST /api/chats/preview` | Shape+redact, **do not store**. Returns `{ messages, redactions, bytes, messageCount }`. |
| `POST /api/chats` | Create. Body: `{ sessionId, title, model, provider, messages, password?, expiresAt?, preset? }`. Returns `{ token, url, redactions, bytes, messageCount }`. |
| `GET /api/chats` | List owner's shares (most recent first). |
| `GET /api/chats/:token` | Get one (metadata + redaction summary, not full content). |
| `PATCH /api/chats/:token` | Update `password?` / `expiresAt?`. |
| `DELETE /api/chats/:token` | Revoke (sets `revoked_at`). |

`expiresAt` is an ISO timestamp or null. `password` is a plaintext string the server hashes
with argon2id and never returns. `messages` is the shaped (not-yet-redacted) array the CLI
produced; the server redacts it and inserts one `share_messages` row per message.

## 5. Security model

### 5.1 Access control
- **Token** is the primary key to an unpassworded share: 128-bit crypto-random, unguessable.
  The harness session id is never in the URL (semi-predictable; would be an existence oracle).
- **Password** (optional): hashed with **argon2id** (mem 64 MB, iterations 3, parallelism 1).
  Only the hash stored. `argon2.verify` is constant-time.
- **Unlock cookie** (stateless, short-lived, per-share): on successful unlock, set an
  `HttpOnly; Secure; SameSite=Strict` cookie whose value is an **HMAC-SHA256** signature over
  `"<token>|<expiryEpoch>"` using a server secret (`UNLOCK_SECRET`, 256-bit random, from env).
  TTL 30 min. Bound to that one share token, so it cannot be replayed against another share.
  No server-side session store required.

### 5.2 Expiration & revocation
- Checked **server-side on every access** (content fetch *and* unlock, *and* every page fetch).
  `now > expires_at` → `410`. `revoked_at` set → `404` (indistinguishable from unknown — no oracle).

### 5.3 Rate limiting
- `…/unlock`: per `(token, IP)`. 5 failures → 15-minute lockout → `429 { code:"rate_limited" }`.
  In-memory for v1 (single container).
- Public content endpoint: per-IP request cap (e.g., 120 req/min, to allow lazy-load page
  fetches) to blunt scraping/DoS.

### 5.4 Error hygiene
Uniform body `{ error:{ code, message } }`. Codes: `not_found`, `expired`, `needs_password`,
`bad_password`, `no_password`, `rate_limited`, `unauthorized`, `validation`, `too_large`.
Unknown vs revoked tokens return byte-identical responses. No stack traces to clients.

### 5.5 Redaction (server-side, at ingestion) — see §7
The server is the **single authoritative redactor**, run at `preview` and `create`. Only the
redacted result is persisted (one row per message). The viewer never receives raw secrets.

### 5.6 Publisher auth
Single server-generated API key in env (`QUIRE_API_KEY`). All `/api/chats/*` require it.
Single-user, so one key is correct. Never logged.

### 5.7 Transport & headers
- HTTPS terminated at the reverse proxy; HSTS enabled.
- Share page: strict **CSP** (self scripts/styles; Shiki inline styles allowed; no remote
  resources), `X-Frame-Options: DENY` / `frame-ancestors 'none'` (no clickjacking),
  `Referrer-Policy: no-referrer`.
- Markdown rendered with `html: false` (no raw-HTML injection); Vue escapes by default.
- No share content, passwords, or the API key in logs. Request bodies are not logged.

### 5.8 Infrastructure
- Postgres: dedicated least-privilege user (no superuser), separate container/volume.
- Container runs **non-root**; read-only root filesystem where feasible.
- zod validation on every API input; 20 MB upload cap (`too_large` beyond that).

## 6. Redaction pipeline

Location: `server/src/redact/`. Data-driven, ordered rules; first match wins per span.

`prepareContent(shapedMessages, preset) -> { messages, summary, bytes, messageCount }`:
1. For each message, walk every string field in its `parts` (`text`, tool `input` values,
   tool `output`, `reasoning`).
2. Apply rules in order, replacing matches with `[REDACTED:<category>]`.
3. Count matches per category → `summary`.
4. Return the redacted messages (ready to insert, one row each).

### Rules (default order)

| # | category | pattern (illustrative) | in presets |
|---|---|---|---|
| 1 | `private-key` | `-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----` | strict, normal |
| 2 | `jwt` | `eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}` | strict, normal |
| 3 | `aws-access-key` | `AKIA[0-9A-Z]{16}` | strict, normal |
| 4 | `openai-key` | `sk-[A-Za-z0-9]{20,}` | strict, normal |
| 5 | `anthropic-key` | `sk-ant-[A-Za-z0-9_-]{20,}` | strict, normal |
| 6 | `connection-string` | `\b(postgres(ql)?|mysql|mongodb(\+srv)?|redis|amqp)://[^/\s:@]+:[^@\s]+@` (redact `user:pass`) | strict, normal |
| 7 | `bearer-token` | `\b[Aa]uthorization:\s*Bearer\s+[A-Za-z0-9._-]{20,}` / `\bbearer\s+[A-Za-z0-9._-]{20,}` | strict, normal |
| 8 | `generic-secret` | `(?i)\b(api[_-]?key|secret|token|passwd|password)\b\s*[:=]\s*['"]?([A-Za-z0-9+/=_\-]{16,})` (redact value) | strict, normal |
| 9 | `private-ip` | `10.x`, `192.168.x`, `172.16–31.x` dotted quads | strict only |
| 10 | `local-path` | Windows `[A-Za-z]:\\…`; Unix `/home/…`, `/Users/…`, `/root/…` | strict only |

### Presets
- `strict` (default): all rules, including `private-ip` and `local-path`.
- `normal`: secret rules only (no `private-ip`, no `local-path`).
- `none`: no redaction. Explicit opt-in only; the CLI warns loudly and the preview shows a
  banner. Never the default.

**Honest framing:** regex redaction is a best-effort first line, not a guarantee against every
secret shape. The **mandatory dry-run preview** — where the owner sees the exact redacted
payload that will be stored — is the real safety net. The pipeline is deterministic and
golden-tested (§13) so behavior is stable and auditable.

## 7. Frontend (the "ChatGPT-like" part)

- Centered ~760 px column. **Dark mode:** Tailwind `darkMode: 'media'` — automatically follows
  the reader's `prefers-color-scheme`; both light and dark palettes designed (no manual
  toggle required, though a toggle is a trivial addition).
- **Header:** session title, model badge, date, (if set) "expires <date>" hint.
- **User message:** rounded bubble (light gray in light mode; elevated surface in dark mode).
- **Assistant message:** plain left-aligned markdown (no bubble), rendered by markdown-it.
- **Tool call:** collapsible card — tool name + status chip; expands to input and (truncated)
  output in monospace.
- **Code:** Shiki-highlighted blocks with a copy button (theme switches with dark mode).
- **Reasoning:** subtle collapsible "thinking" block, de-emphasized.
- **Lazy loading:** `useMessages` composable fetches the first page on load, then appends the
  next page when a scroll sentinel near the bottom enters the viewport (IntersectionObserver),
  passing `nextCursor` back. A loading indicator shows while fetching; it stops when
  `nextCursor` is null. This keeps the initial payload small and first paint fast even for
  very long sessions. (If profiling shows DOM bloat on extreme sessions, a virtualized list —
  e.g. `@tanstack/virtual` — is a documented follow-up; pagination already bounds the network.)
- **States:** loading skeleton; `PasswordGate` (single field + submit, inline error, respects
  rate-limit message); `ExpiredPage`; `NotFoundPage`; generic error page.
- Styling via Tailwind. No user input is ever echoed as HTML (Vue escaping + `html:false`).

## 8. Publisher (CLI) — `quire`

Config: `~/.quire/config.json` or env — `{ serverUrl, apiKey }`. `serverUrl` is the
owner-configured host (no domain baked in).

Commands:
- `quire publish [sessionId] [--current] [--harness zcode|claude-code] [--password <pw>] [--expires <dur|ISO>] [--preset strict|normal|none] [--yes]`
  1. Resolve the harness (`--harness`, else auto-detect) and the session (see below). Open
     that harness's session store **read-only**.
  2. Load session + messages + parts (ordered by sequence) via the harness adapter.
  3. **Shape:** keep `text`/`tool`/`reasoning`; truncate tool outputs > 20 KB.
  4. `POST /api/chats/preview` → show the redacted transcript + redaction summary.
  5. **Require confirmation** (interactive prompt, or `--yes` to skip). Never upload silently.
  6. `POST /api/chats` → print `https://<your-host>/chats/<token>` + summary.
- `quire list` — table: token (short), title, created, expires, has-password, revoked.
- `quire revoke <token>` — confirm, then `DELETE`.
- `quire update <token> [--password <pw>] [--expires <dur|ISO>]` — `PATCH`.
- `quire setup` — generate + print `QUIRE_API_KEY` and `UNLOCK_SECRET` to paste into `.env`.

**Harness adapters** (`cli/src/harness/`): each adapter implements a small contract —
`listSessions()`, `resolveCurrent()`, and `loadSession(id) -> ShapedSession` — and normalizes
its harness's on-disk format into the common `{ title, model, provider, messages:[{role, time,
parts}] }` shape (already part-selected and truncated). The rest of the CLI is harness-agnostic.
- **ZCode:** reads `~/.zcode/cli/db/db.sqlite` (`session` / `message` / `part` tables).
- **Claude Code:** reads Claude Code's per-session JSONL store and maps its events to the same
  shape. (Exact on-disk location/format verified in the plan — §13.)
Auto-detection picks the harness from the environment (e.g. which store is present / which
harness invoked the CLI); `--harness` overrides it. This is what lets the *same* `/share`
plugin work in both Claude Code and ZCode.

**Session resolution:**
- Explicit id (full or unique prefix) → use it.
- `--current` (used by the plugin) → resolve the current session. Primary mechanism: the most
  recently updated session by `time_updated`; **always print the resolved title + id and require
  confirmation** so a wrong session is caught. (Exact detection — most-recent vs a harness
  "current session" pointer — is an implementation detail to verify per-harness in the plan;
  the confirm-gate makes either safe.)
- No arg, interactive → numbered list of recent sessions to pick from.
- Subagent sessions are excluded from the default list but can be published by explicit id.

The CLI **never prints secrets** and exits non-zero on failure. On a locked DB it retries once,
then gives a clear message.

## 9. Plugin (Claude Code format, multi-harness)

`plugin/` is a standard **Claude Code plugin**, which is also loadable by ZCode (and, later,
other compatible harnesses). It is harness-agnostic: a manifest plus a slash command that tells
the agent to run the `quire` CLI. The CLI is the engine; the plugin adds no logic.

```
plugin/
  .claude-plugin/plugin.json      # { name:"quire", description, version, commands:"./commands" }
  commands/share.md               # /share slash command
  README.md                       # install + usage for Claude Code and ZCode
```

`commands/share.md` (illustrative):
```markdown
---
description: Share the current session as a password-protected, expiring web link via Quire
argument-hint: "[--password <pw>] [--expires <dur|ISO>] [--preset strict|normal|none]"
---
Share the current session using the Quire CLI.
1. Run: `quire publish --current $ARGUMENTS`
2. Show the redaction preview and summary to the user.
3. After the user confirms, report the resulting share URL.
```

- Works in **Claude Code** and **ZCode** now (both support markdown slash commands + a shell
  tool). Other harnesses that follow the same convention work later with no CLI changes.
- Assumes `quire` is installed and on `PATH` (e.g. `npm i -g @quire/cli`); the README documents
  this dependency.
- Exact manifest fields / frontmatter keys are confirmed against current Claude Code plugin
  docs during implementation (§13).

## 10. Error handling

- **API:** uniform `{ error:{ code, message } }` (§5.4). Validation errors name the field. No
  internals leaked.
- **CLI:** clear human messages, non-zero exit codes, no secret output, graceful DB-locked
  handling, and a final summary line (URL + redaction counts) on success.
- **Frontend:** friendly full-page states for expired / not-found / error; a loading skeleton;
  inline password errors including the rate-limit notice; a "loading more…" indicator for
  lazy-loaded pages.

## 11. Testing strategy

- **Unit**
  - Redaction: golden tests — a fixture transcript with embedded secrets of each category →
    assert exact redacted output + summary counts; assert `none` preset changes nothing; assert
    ordering (e.g. a `private-key` block isn't half-matched by `generic-secret`).
  - Token generation: length/charset/uniqueness.
  - argon2 verify: correct/wrong path.
  - Expiry + revocation decision logic (pure function of a share row + now).
  - Rate limiter: threshold + lockout + reset.
  - Pagination: cursor slicing returns correct pages, respects `limit`, `nextCursor` null at end.
- **Integration** (against a test Postgres)
  - Full lifecycle: create → public first page 200 → next page → (passworded) 401 → unlock →
    200 → expire → 410 → revoke → 404.
  - Pagination across a multi-page share (e.g. 120 messages, limit 50 → 3 pages).
  - Owner CRUD: list/get/patch(revoke)/delete.
  - Auth: missing/bad API key → 401 on owner routes; public routes need no key.
  - Upload cap: >20 MB → `too_large`.
- **CLI** (against a fixture session DB with a known session)
  - Shape: correct part selection + truncation.
  - Publish happy path (mock server) + confirmation required.
  - `--current` resolution picks the most-recent session.
- **E2E (light, Playwright)**
  - Load a published share → first page renders (user bubble, assistant text, code block).
  - Scroll → next page lazy-loads and appends.
  - Passworded share → gate → wrong pw error → correct pw → renders.
  - Expired share → expired page. Unknown token → not-found page.
  - Dark mode: with `prefers-color-scheme: dark` emulated, dark palette renders.

## 12. Deployment

- `docker/Dockerfile`: multi-stage — build `web/` (Vite) and `server/` (tsup/esbuild); final
  image runs the server with the built SPA served as static files. Non-root user.
- `docker/docker-compose.yml`: `server` + `postgres` (volume-backed), healthchecks,
  `QUIRE_API_KEY` + `UNLOCK_SECRET` + `DATABASE_URL` from `.env`.
- Reverse proxy (owner's Caddy/Nginx/Traefik) routes the owner's host → server, terminates TLS;
  HSTS at the proxy. **The host is the owner's to configure — nothing in the repo hardcodes a
  domain.**
- **GitHub:** the repo is published to GitHub by the owner (name/org owner's choice). This build
  initializes a **local** git repo and commits locally; **nothing is pushed** and no remote is
  configured.
- **Out of scope for this build:** actually deploying to a VPS. The repo is built and tested
  locally (`docker compose up`) but not deployed.

## 13. Open details to resolve in the implementation plan

1. Exact `--current` session detection per harness (most-recent `time_updated` vs a harness
   "current session" pointer) — verify against each harness's on-disk behavior; the confirm-gate
   makes either safe.
2. Exact Claude Code plugin manifest fields + command frontmatter keys — confirm against current
   Claude Code plugin docs; verify ZCode loads the same plugin directory.
3. Final argon2 parameter set + `quire setup` key-generation behavior.
4. Whether to render a `compaction` divider (default: drop).
5. Lazy-loading tuning: default page size, and whether to add a virtualized list for extreme
   sessions (default: infinite-scroll append; virtualization as a follow-up if needed).
6. Reverse-proxy specifics (which proxy the owner runs) — only needed at deploy time, not now.
7. **Claude Code session storage:** exact on-disk location + JSONL event format for the Claude
   Code harness adapter (verify the `~/.claude/projects/…` layout and its message/event schema on
   a real install before writing the adapter).
8. **Harness auto-detection:** which signals to use when `--harness` is absent (harness env vars,
   presence of each store, which harness invoked the CLI) and the fallback order when none match.
