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

`/share` — share the current session (preview → confirm → URL).
`/share --password s3cret --expires 24h` — password-protected, expires in a day.
