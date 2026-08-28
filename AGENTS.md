# AGENTS.md — Quire

Guidance for AI coding agents (ZCode, Claude Code) maintaining this repository.
The human-facing README is `README.md`; this file is for agents.

## 1. Project overview

Quire shares AI coding-harness sessions (ZCode, Claude Code) over the web as
read-only, password-protectable, expiring links. Secrets are redacted
**server-side at ingestion** — only redacted content is ever stored or served.

pnpm-workspace monorepo, five packages:

| Package | Role |
|---|---|
| `server/` | Hono + Drizzle (Postgres) API, redaction engine, security layer; serves the built viewer |
| `cli/` | `quire` publisher CLI with harness adapters (ZCode, Claude Code) |
| `plugin/` | Claude Code–format `/share` plugin (works in ZCode too) |
| `web/` | Vue 3 + Vite + Tailwind v4 read-only viewer |
| `e2e/` | Playwright full-stack tests (drives the Docker stack) |

**Key security boundary:** the CLI *shapes* (size/relevance); the server
*redacts* (security). Raw content crosses the wire over HTTPS to the owner's
own server, is redacted in memory, and only the redacted result is persisted.
The viewer's browser never receives a secret.

Full design and threat reasoning: `docs/superpowers/specs/`.

## 2. Commands

Requirements: Node ≥ 22, pnpm 9.15.0 (corepack).

| Task | Command |
|---|---|
| Install | `pnpm install` |
| Typecheck all | `pnpm typecheck` (`tsc` / `vue-tsc --noEmit` per package) |
| Test all | `pnpm test` (unit for all packages + e2e; e2e needs Docker) |
| Build all | `pnpm build` |
| Test DB up/down | `pnpm db:test:up` / `pnpm db:test:down` (Postgres on `:54329`) |
| Per-package test | `pnpm --filter @quire/<server\|cli\|web\|plugin> test` |
| E2E only | `pnpm --filter @quire/e2e test` (builds + tears down the compose stack on `:8790`) |

**The full green gate** — the repo's completion bar, run before pushing:

```bash
pnpm typecheck                                  # 4/4 packages
pnpm --filter @quire/cli test                   # unit
pnpm --filter @quire/server test                # unit (needs db:test:up)
pnpm --filter @quire/web test                   # unit
pnpm --filter @quire/plugin test                # unit
pnpm --filter @quire/cli build                  # tsup
pnpm --filter @quire/server build               # tsup
pnpm --filter @quire/web build                  # vite
pnpm --filter @quire/e2e test                   # Playwright (Docker)
```

Key facts:

- Server integration tests default to `postgres://quire:quire@localhost:54329/quire_test`
  (overridable via `DATABASE_URL`). Run `pnpm db:test:up` first.
- E2E uses a *different* stack: `docker compose -f docker-compose.yml -f docker-compose.e2e.yml`
  on port `8790`, DB `quire:e2e@postgres:5432/quire`, and CloakBrowser at
  `D:\cloakbrowser\current\chrome.exe` (stealth Chromium — never vanilla Playwright Chromium).
- Server test files run serialized (`fileParallelism: false` in `server/vitest.config.ts`)
  because `db.test.ts` destructively drops tables in `beforeAll`.
- The server has **no dev script**. To run it locally: `pnpm --filter @quire/server build`,
  then set env and start it (see §6, local-inspect workflow).

## 3. Code style & conventions

- TypeScript strict, ESM everywhere (`"type": "module"`), tsup for builds, vitest for unit tests.
- Commit style: conventional commits scoped by package — `fix(cli): …`, `feat(web): …`,
  `feat(share): …`.
- Test fixtures: synthetic and **byte-stable** (fixed epoch timestamps, no `Date.now()`),
  committed under `cli/test/fixtures/`. Real session stores (`*.sqlite`, `*.jsonl`) are
  gitignored and must never be committed.
- Security invariants code must preserve: redaction at ingestion only (single source of
  truth in the server), no secrets in logs, uniform error bodies `{error:{code,message}}`,
  no existence oracle (unknown and revoked tokens return byte-identical 404s).

## 4. Testing & verification

- **Unit** (`vitest run` per package): fast, no Docker; server tests need the `:54329` test DB.
- **E2E** (`@quire/e2e`): full-stack, builds and drives the compose stack, tears it down.
  Slow; run it as part of the gate, not on every edit.
- **Verification-before-completion:** evidence before claims — run the gate and show the
  output. A change touching `cli/src` is not done until `cli/dist` is rebuilt and the
  *rebuilt* binary is what was tested.
- How to read vitest output: check the "Errors" section, not just "Tests passed" — a
  post-teardown unhandled timer exits 1 after a green run (see §7).

## 5. Superpowers process

The standing process for this repo (specs and plans are committed under `docs/superpowers/`):

- **Non-trivial feature** → brainstorm → spec in `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`
  → plan in `docs/superpowers/plans/` → execute with checkpoints → review gates.
- **Bug fix** → systematic-debugging first: reproduce, find the root cause against real
  data, then fix.
- **Before claiming done** → verification-before-completion.
- `.superpowers/` (task briefs, review diffs, progress) is untracked scratch material.

## 6. Operational playbook (hard-won lessons)

1. **Stale `cli/dist`.** The global `quire` shim runs `cli/dist` (symlinked to the worktree
   cli). After any `cli/src` change, run `pnpm --filter @quire/cli build` — otherwise the
   global command silently publishes the old shape. tsup accumulates stale hashed chunks:
   `rm -rf dist` first, then verify the active `index.js → publish-* → chunk-*` chain.
2. **Commit ≠ deployed.** Deploys build from `origin/main`. A local-only commit means a
   redeploy silently builds the prior commit. Push what a deploy must pick up.
3. **Plugin cache propagation.** ZCode loads `/share` from the installed plugin cache, copied
   from the local marketplace source — not the worktree. Editing `plugin/commands/share.md`
   in the worktree does nothing until the marketplace source + installed cache are updated
   (and the plugin version bumped).
4. **Leading-vs-embedded is the discriminator.** Harness tags (`<system-reminder>`, think
   blocks) are injections only when *leading* in a text part (after whitespace); tags
   embedded mid-prose (quotes, compaction summaries, source code read by a Read tool) are
   never injections. Position beats content matching.
5. **Structural markers over substrings.** Never classify with `includes('think')` or phrase
   matching — use well-formed structure: `metadata.visibility === "model-only"` (drop the
   whole message), the `summary` field (drop continuation summaries), well-formed block
   regexes. Substring scans false-positive on prose that merely mentions the word.
6. **Local-inspect workflow.** Run a standalone built server against the test DB on a free
   port:

   ```bash
   pnpm --filter @quire/server build
   DATABASE_URL="postgresql://quire:quire@127.0.0.1:54329/quire_test" \
   QUIRE_API_KEY="e2e-test-key-0000000000000000000000" \
   UNLOCK_SECRET="e2e-unlock-secret-0000000000000000" \
   PORT=8791 node server/dist/index.js
   ```

   It serves `web/dist` (rebuild after web changes — no HMR). Publish synthetic shares via
   `POST /api/chats` with the body **nested under `session`** (flat body → 400). A leftover
   server from a prior session has an unknown key — start your own on a free port.
7. **Viewer verification traps.** The public API cursor param is `?cursor=` (format
   `chunkSeq:seq`), not `?before=`; the viewer lazy-loads the first 50 messages — scroll or
   hit the API before concluding a part type is absent.

## 7. Known test issues

- **E2E "lazy-loads subsequent pages"** is a timing flake (Shiki slow + IntersectionObserver
  scroll race). Passes on isolated rerun / clean full-suite rerun; a single failure is not a
  regression signal unless it reproduces in isolation.
- **Vitest "Uncaught Exception" after "Tests passed"** = an unhandled timer (e.g. an
  uncancelled rAF) fired post-teardown. Exit code 1, zero failed tests. Check the "Errors"
  section; fix by tracking and cancelling every timer/rAF on unmount.

## 8. Repo hygiene

- Gitignored and why: `node_modules`, `dist`, `.env*` (except `.env.example`), real session
  stores (`*.sqlite`, `*.jsonl` — synthetic fixtures excepted), coverage, `.playwright-mcp/`.
- The root contains untracked scratch screenshots (`quire-*.png`, `rail-*.png`) from
  live-verification — working material, not repo content; do not commit them.
- No CI: there is no `.github/`; the green gate is run locally before pushing.
