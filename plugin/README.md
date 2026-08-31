# Quire plugins

This package adds `/share` to Claude Code and ZCode and a native `$share` skill
to Codex desktop and CLI. Both are thin wrappers around the `quire` CLI.

## Prerequisites

1. Build and link the CLI so `quire` is on your PATH:
   ```sh
   pnpm --filter @quire/cli build
   pnpm --filter @quire/cli link --global   # or: npm i -g @quire/cli once published
   ```
2. Point the CLI at your Quire server:
   ```sh
   export QUIRE_SERVER_URL=https://<your-host>
   export QUIRE_API_KEY=<key from your server .env>
   ```
   (or write `~/.quire/config.json` — see `quire setup`).

## Install

- **Claude Code:** add this directory as a local plugin (marketplace add / plugin install of the local path), then use `/share`.
- **ZCode:** add this directory as a plugin; the same `/share` command appears.
- **Codex:** install this directory as a local plugin, then invoke `$share` in a task.

Exact install commands follow the current Claude Code plugin documentation at
implementation time (see the design spec's open items); the manifest and command
frontmatter in this repo are verified against it.

## Usage

`/share` (Claude Code/ZCode) or `$share` (Codex) shares the current session or
task. The wrapper infers options from what you ask, publishes without a
confirmation prompt, and reports the link.

Examples:
- `/share` — plain share of the current session.
- `/share generate a random password, set it to expire tomorrow` — password-protected (a random password is generated and shown to you), expires at the next midnight.
- `/share no password, expire in 1 hour` — open link, expires in an hour.
- `/share password is s3cret, expire in 24h` — uses your literal password, expires in a day.
- `$share random password, expire tomorrow` — the equivalent native Codex invocation.

The wrappers always run `quire publish --current … --yes`, so they never block
on a prompt. The Codex skill also forces `--harness codex`. They map your words
to flags: "random password" → `--password random`, "expire tomorrow/today/in N
hours/a week" → `--expires …`, and "strict/normal redaction" → `--preset …`.
Quire never supports raw or unredacted publishing; `normal` is the loosest
preset because redaction at server ingestion is the security boundary.

## Oh My Pi (OMP)

OMP does not use this plugin. `quire setup omp` installs Quire's bundled
custom share handler as `share.mjs` in OMP's agent directory
(`$PI_CODING_AGENT_DIR`, else `~/.omp/agent`). After restarting or reloading
OMP, `/share` in an interactive, persisted TUI session publishes the exact
active conversation through Quire with strict redaction, no password, and no
expiry — no prompt, no options.

- Advanced options: publish an OMP HTML export directly —
  `quire publish <export.html> --harness omp --password random --expires tomorrow`.
- Headless/ACP sessions and `--no-session` runs keep OMP's native behavior.
- The installer refuses to overwrite or chain an existing `share.ts`,
  `share.js`, or `share.mjs`; re-running it with matching bytes is a no-op.
  OMP does not fall back when an installed handler fails: to revert, rename
  or remove the Quire-installed `share.mjs`, then restart/reload OMP.
