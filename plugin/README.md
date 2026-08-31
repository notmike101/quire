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
