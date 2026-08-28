# AGENTS.md for Quire — Design Spec

- **Date:** 2026-08-28
- **Status:** Approved for implementation
- **Deliverable:** a single `AGENTS.md` at the repository root

## 1. Purpose & audience

Create an `AGENTS.md` that future agent runs (ZCode, Claude Code) can reference on how to
maintain and contribute to this repository. Follow the guidance at https://agents.md/
(markdown, repo root, imperative, separate from the human-facing README) and formalize the
practices this repository has already established.

**Audience decision:** AI coding agents are the primary audience. The file is optimized for
agents — imperative, specific, no marketing prose. Humans can read it as a side benefit.

**Scope decision:** the file carries the full operational playbook (hard-won lessons),
includes the superpowers process, and includes a known-test-issues section. The
deploy → live-verify loop on `share.mikeorozco.dev` is **out of scope** (the owner's job);
the file defines "done" as *committed, pushed, gate green* — not "deployed".

**Structure decision:** single root file (~250–350 lines), no nested per-package AGENTS.md
files. Revisit splitting only if a package's conventions diverge significantly later.

## 2. Section-by-section design

### §1 Project overview

- What Quire is (one short paragraph, from the README): opt-in sharing of AI coding-harness
  sessions (ZCode, Claude Code) as read-only, password-protectable, expiring web links, with
  server-side redaction before anything is stored.
- The five packages and their roles: `server/` (Hono + Drizzle + Postgres API, redaction
  engine, security layer), `cli/` (`quire` publisher with harness adapters), `plugin/`
  (Claude Code–format `/share` plugin), `web/` (Vue 3 + Vite + Tailwind v4 viewer), `e2e/`
  (Playwright full-stack tests).
- The key security boundary: the CLI *shapes* (size/relevance), the server *redacts*
  (security). Only redacted content is persisted; the viewer never receives a secret.
- Pointers to the design specs in `docs/superpowers/specs/` for full design and threat
  reasoning.

### §2 Commands

Verified against the package files. The command table:

| Task | Command |
|---|---|
| Install | `pnpm install` (pnpm 9.15.0, Node ≥ 22, corepack) |
| Typecheck all | `pnpm typecheck` (`tsc` / `vue-tsc --noEmit` per package) |
| Test all | `pnpm test` (unit for all packages + e2e; e2e needs Docker) |
| Build all | `pnpm build` |
| Test DB up/down | `pnpm db:test:up` / `pnpm db:test:down` (Postgres on `:54329`) |
| Per-package test | `pnpm --filter @quire/<server\|cli\|web\|plugin> test` |
| E2E only | `pnpm --filter @quire/e2e test` (builds + tears down the compose stack on `:8790`) |
| Server dev | `cp .env.example .env` then `pnpm --filter @quire/server dev` |

Plus the **full green gate** as one copy-pasteable block — the repo's actual completion bar:
typecheck (4/4 packages) → unit tests (cli + server + web + plugin) → 3 builds (cli, server,
web) → e2e.

Key facts to state:

- Server integration tests default to `postgres://quire:quire@localhost:54329/quire_test` —
  run `pnpm db:test:up` first.
- E2E uses a *different* stack: `docker compose -f docker-compose.yml -f docker-compose.e2e.yml`
  on port `8790`, DB `quire:e2e@postgres:5432/quire`, and CloakBrowser at
  `D:\cloakbrowser\current\chrome.exe` (stealth Chromium — never vanilla Playwright Chromium).
- Server test files run serialized (`fileParallelism: false` in `server/vitest.config.ts`)
  because `db.test.ts` destructively drops tables in `beforeAll`.

### §3 Code style & conventions

- TypeScript strict, ESM everywhere (`"type": "module"`), tsup for builds, vitest for unit
  tests.
- Commit style: conventional commits scoped by package — `fix(cli): …`, `feat(web): …`,
  `feat(share): …` (observed across the full history).
- Test fixtures: synthetic and **byte-stable** (fixed epoch timestamps, no `Date.now()`),
  committed under `cli/test/fixtures/`. Real session stores (`*.sqlite`, `*.jsonl`) are
  gitignored and must never be committed.
- Security invariants code must preserve: redaction at ingestion only (single source of truth
  in the server), no secrets in logs, uniform error bodies `{error:{code,message}}`, no
  existence oracle (unknown and revoked tokens return byte-identical 404s).

### §4 Testing & verification

- Unit vs e2e distinction and when each applies.
- **Verification-before-completion:** evidence before claims — run the gate, show the output.
  A change touching `cli/src` is not done until `cli/dist` is rebuilt and the *rebuilt*
  binary is what was tested.
- How to read vitest output: check the "Errors" section, not just "Tests passed" — a
  post-teardown unhandled timer exits 1 after a green run.

### §5 Superpowers process

The standing process, matching how the repo was actually built (3 specs + 2 plans committed
under `docs/superpowers/`):

- **Non-trivial feature** → brainstorm → spec in
  `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` → plan in
  `docs/superpowers/plans/` → execute with checkpoints → review gates.
- **Bug fix** → systematic-debugging first: reproduce, find root cause against real data,
  then fix.
- **Before claiming done** → verification-before-completion.
- Specs and plans are committed to the repo. `.superpowers/` (scratch: task briefs, review
  diffs, progress) is untracked working material.

### §6 Operational playbook (hard-won lessons)

The highest-value section. Each entry states the trap, why it bites, and the fix:

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
   `DATABASE_URL="postgresql://quire:quire@127.0.0.1:54329/quire_test" QUIRE_API_KEY="e2e-test-key-000000000000000000000000" UNLOCK_SECRET="e2e-unlock-secret-0000000000000000000000" PORT=<free> node dist/index.js`
   (serves `web/dist`; rebuild after web changes — no HMR). Publish synthetic shares via
   `POST /api/chats` with the body **nested under `session`** (flat body → 400). A leftover
   server from a prior session has an unknown key — start your own on a free port.
7. **Viewer verification traps.** The public API cursor param is `?cursor=` (format
   `chunkSeq:seq`), not `?before=`; the viewer lazy-loads the first 50 messages — scroll or
   hit the API before concluding a part type is absent.

### §7 Known test issues

- **E2E "lazy-loads subsequent pages"** is a timing flake (Shiki slow + IntersectionObserver
  scroll race). Passes on isolated rerun / clean full-suite rerun; a single failure is not a
  regression signal unless it reproduces in isolation.
- **Vitest "Uncaught Exception" after "Tests passed"** = an unhandled timer (e.g. an
  uncancelled rAF) fired post-teardown. Exit code 1, zero failed tests. Check the "Errors"
  section; fix by tracking and cancelling every timer/rAF on unmount.

### §8 Repo hygiene

- Gitignored and why: `node_modules`, `dist`, `.env*` (except `.env.example`), real session
  stores (`*.sqlite`, `*.jsonl` — synthetic fixtures excepted), coverage, `.playwright-mcp/`.
- The root contains untracked scratch screenshots (`quire-*.png`, `rail-*.png`) from
  live-verification — working material, not repo content; do not commit them.
- No CI: there is no `.github/`; the green gate is run locally before pushing.

## 3. Non-goals

- No deploy/live-verify documentation (owner's job, per scope decision).
- No nested per-package AGENTS.md files.
- No CI setup, no linting/formatting tooling — the file documents what exists, it does not
  introduce new tooling.
- No changes to code, tests, or configuration — the deliverable is documentation only.

## 4. Open questions resolved during brainstorming

| Question | Decision |
|---|---|
| Primary audience | AI coding agents |
| Depth of operational lessons | Full operational playbook |
| Deploy/live-verify loop | Omit (owner's job) |
| Superpowers workflow | Yes, as a process section |
| Known test flakes | Dedicated known-issues section |
| Local-inspect detail | Exact values (ports, test-DB URL, creds) |
