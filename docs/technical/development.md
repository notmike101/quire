# Development and testing

For a deployed instance and first share, use [setup and deployment](setup.md).

## Requirements

Use Node 22.22.2+, Node 24.15.0+, or Node 26+ and the pnpm version pinned in `package.json`. pnpm settings, including dependency overrides and native-build approvals, live in `pnpm-workspace.yaml`.

The pinned pnpm 12 writes a [two-document lockfile](https://pnpm.io/lockfile): package-manager metadata first, project dependencies last. Keep both documents and use the pinned package manager rather than an older global pnpm.

The viewer uses TypeScript 6.0.3: `vue-tsc` 3.3.13 imports `typescript/lib/tsc`, which TypeScript 7 no longer exports. Other TypeScript packages use TypeScript 7; upgrade the viewer when `vue-tsc` supports it.

## Install and check

Run from the repository root:

```bash
pnpm install
pnpm db:test:up            # Postgres on :54329 for server tests
pnpm lint                  # zero errors or warnings allowed
pnpm typecheck
pnpm test                  # package tests and E2E; requires Docker
```

Before E2E, install standard Playwright Chromium:

```bash
pnpm --filter @quire/e2e exec playwright install chromium
```

No CloakBrowser installation or custom browser executable is required.

Documentation-comment lint uses `eslint-plugin-jsdoc` across JavaScript, TypeScript, and Vue script blocks. `eslint.config.mjs` adapts the syntax and coverage rules from `@notmike101/eslint-config-jsdoc`. TypeScript comments describe behavior without repeating parameter or return types. `pnpm lint` enforces `--max-warnings 0`, including warning-level rules; it is not a Markdown link checker.

## Run a local server

Create a Postgres database, then configure `.env` from `.env.example`. Set `DATABASE_URL`, `QUIRE_API_KEY`, and `UNLOCK_SECRET`; `PORT` defaults to `8787`.

```bash
cp .env.example .env
# Edit .env with your database URL and secrets before continuing.
pnpm --filter @quire/web build
pnpm --filter @quire/server build
cd server
node --env-file=../.env dist/index.js
```

There is no server `dev` script. Run the built server from `server/` so its `./drizzle` migrations directory resolves correctly. It serves `web/dist`; rebuild the viewer after web changes. `WEB_DIST` can override the viewer directory.

For the test database created by `pnpm db:test:up`, use `postgres://quire:quire@127.0.0.1:54329/quire_test`. Do not run destructive server tests against a database whose shares you need to retain.

## Tests and builds

- Unit tests: `pnpm --filter @quire/<server|cli|web|plugin|protocol> test` (substitute one package name).
- Server tests require the test database; stop it with `pnpm db:test:down` when finished. Test files run serially because database tests destructively reset tables.
- E2E: `pnpm --filter @quire/e2e test` builds and drives `docker-compose.yml` plus `docker-compose.e2e.yml` on port `8790`, then tears the stack down. It uses a separate database from the server unit tests.
- Builds: `pnpm build`, or select `@quire/cli`, `@quire/server`, or `@quire/web` with `--filter`.

After CLI source changes, rebuild `cli/dist` before testing the globally linked `quire` command. The link runs the built files, not TypeScript source. See [plugin prerequisites](../../plugin/README.md#prerequisites).

The full pre-push gate is:

```bash
pnpm lint
pnpm typecheck
pnpm --filter @quire/cli test
pnpm --filter @quire/server test
pnpm --filter @quire/web test
pnpm --filter @quire/plugin test
pnpm --filter @quire/protocol test
pnpm --filter @quire/cli build
pnpm --filter @quire/server build
pnpm --filter @quire/web build
pnpm --filter @quire/e2e test
```

Read the entire Vitest result, including its Errors section and exit status. An unhandled timer after teardown can exit with an error even when individual tests pass. The E2E lazy-load scenario has a known timing flake involving syntax highlighting and the intersection observer; investigate failures in context rather than assuming every retry masks a regression.

[Technical documentation](README.md) · [Back to Quire](../../README.md)
