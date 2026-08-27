# Quire plugin

A Claude Code–format plugin (also loadable by ZCode) that adds a `/share` command.
It is a thin wrapper: all logic lives in the `quire` CLI, which the command invokes.

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

Exact install commands follow the current Claude Code plugin documentation at
implementation time (see the design spec's open items); the manifest and command
frontmatter in this repo are verified against it.

## Usage

`/share` — share the current session. The command infers the options from what you ask and publishes immediately (no confirmation prompt), then reports the link.

Examples:
- `/share` — plain share of the current session.
- `/share generate a random password, set it to expire tomorrow` — password-protected (a random password is generated and shown to you), expires at the next midnight.
- `/share no password, expire in 1 hour` — open link, expires in an hour.
- `/share password is s3cret, expire in 24h` — uses your literal password, expires in a day.

The command always runs `quire publish --current … --yes`, so it never blocks on a prompt. It maps your words to flags: "random password" → `--password random`, "expire tomorrow/today/in N hours/a week" → `--expires …`, "strict/normal/none redaction" → `--preset …`.
