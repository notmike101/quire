# CLI and integrations

Complete [setup](setup.md) first. The CLI reads local coding sessions and publishes them to your Quire server. Sharing is opt-in: installing Quire does not publish anything.

## Publish and manage shares

```bash
quire setup                # print server .env and CLI config examples
quire publish --current    # shape the active session, confirm, publish
quire publish --current --password auto --expires tomorrow --yes
                           # generate a password, expire at next midnight,
                           # publish immediately without confirmation
quire list                 # list IDs, titles, creation/expiry times, and state
quire revoke <token> --yes  # hard-delete the share and its rows without a prompt
quire update <token> --expires 7d
quire setup omp            # install the OMP /share handler
```

`publish` requires `--current` or a session ID; there is no interactive session picker. Use `--yes` only when you intend to skip confirmation, such as in an agent or script.

### Passwords and expiration

`--password random` (also `generate` or `auto`) generates a random password and prints it once. A literal password is also accepted, but placing secrets in command arguments can expose them through shell history or process inspection. Share passwords separately from links.

`--expires` accepts:

- An ISO datetime, such as `2027-01-01T00:00:00Z`.
- A duration, such as `30m`, `24h`, or `7d`.
- A keyword: `tomorrow`, `today`, `week`, `month`, `year`, or `in <duration>`.

`update` only changes expiration. A share's password is fixed when published; there is no `update --password`. Revoking a link prevents future retrieval from the server, but cannot erase copies recipients already saved.

### Configuration and harness selection

`QUIRE_SERVER_URL` and `QUIRE_API_KEY` override `~/.quire/config.json`. See [setup](setup.md#3-connect-the-cli).

Select a source with `--harness zcode|claude-code|codex|omp`. Without that flag, detection checks the active Codex, Claude Code, or ZCode environment, then the most recently updated supported session store. OMP is never auto-detected.

Codex reads `~/.codex/state_5.sqlite` for task metadata and the selected task's rollout JSONL for content, both read-only. Normal discovery includes top-level tasks; a subagent task can be published by passing its explicit task ID.

```bash
quire publish <session-id> --harness codex
quire publish <export.html> --harness omp --password auto --expires tomorrow
```

`--preset strict|normal` selects server-side redaction rules. There is no raw/unredacted publishing mode.

## Claude Code, ZCode, and Codex

Install the [plugin](../../plugin/README.md#install) after building and configuring the CLI.

- Claude Code and ZCode use `/share`.
- Codex uses the native `$share` skill.

These commands infer password, expiration, and preset options from your request and publish immediately with `--yes`, without a confirmation prompt. For example, `$share random password, expire tomorrow` returns the link and generated password.

## Oh My Pi (OMP)

```bash
quire setup omp
```

The installer writes Quire's custom handler as `share.mjs` in OMP's agent directory (`$PI_CODING_AGENT_DIR`, otherwise `~/.omp/agent`). After restarting or reloading OMP, `/share` in an interactive, persisted TUI session publishes the exact active conversation with strict redaction, no password, and no expiry. It publishes immediately, without a prompt.

The installer never overwrites or chains an existing handler. If `share.ts`, `share.js`, or a different `share.mjs` exists, it refuses and tells you what to rename or remove. Re-running the installer with matching bytes is a no-op.

OMP does not fall back to native sharing when an installed handler fails. To revert, rename or remove the Quire-installed `share.mjs` and restart or reload OMP.

OMP's argumentless `/share` does not accept password, expiry, or preset options. For those, publish an HTML export by path with `--harness omp` and the desired flags. Headless and ACP sessions, and `--no-session` runs, keep OMP's native behavior.

[Technical documentation](README.md) · [Back to Quire](../../README.md)
