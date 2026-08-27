---
description: Share the current session as a web link via Quire — infer password/expiration/preset from the request and publish without prompting
argument-hint: "[what to set, e.g. 'random password, expire tomorrow' or 'no password, expire in 1 hour']"
---

Share the current session using the Quire CLI. You drive this end-to-end — **do not ask the user to confirm, type anything, or answer a prompt.**

1. **Infer the flags from the user's request** (`$ARGUMENTS`). Map natural language to flags:
   - "random password" / "password-protect it" / "add a password" → `--password random`
   - a literal password the user gave (e.g. "password is hunter2") → `--password hunter2`
   - "no password" / "public" / "open" → omit `--password`
   - "expire tomorrow" → `--expires tomorrow`; "today" → `--expires today`; "in N hours/minutes/days" → `--expires Nh`/`Nm`/`Nd`; "in a week/month/year" → `--expires week`/`month`/`year`; a specific date → `--expires <ISO>`
   - "strict/normal/none redaction" → `--preset strict|normal|none` (default is `strict`)
   - If the user named a specific session id, use it as the positional argument; otherwise share the current session.
   - **Always append `--yes`** so the CLI never stops on a confirmation prompt.
   - **Never pass the user's free-text instruction as a positional argument** — only a real session id goes there.

2. **Run the publish command** (adjust flags to what you inferred; at minimum `--current --yes`):
   ```
   quire publish --current --password random --expires tomorrow --yes
   ```
   The command prints a redaction preview, then publishes and prints the share URL (and, for `--password random`, the generated `Password:` line). It does not wait for input.

3. **Report the result to the user:** the share URL, the generated password (if one was created), the expiration (if set), and the redaction summary. Do not ask for confirmation — the share is already live.

4. If the `quire` CLI is not on PATH, tell the user to install it (`npm i -g @quire/cli` after publishing, or `pnpm link --global` from the repo's `cli/` package) and stop.
