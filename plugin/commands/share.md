---
description: Share the current session as a password-protected, expiring web link via Quire
argument-hint: "[--password <pw>] [--expires <dur|ISO>] [--preset strict|normal|none]"
---

Share the current session using the Quire CLI.

1. Run: `quire publish --current $ARGUMENTS`
2. Show the redaction preview and redaction summary to the user.
3. The CLI asks for confirmation — relay that prompt to the user and only continue after they confirm. Never skip or assume confirmation.
4. Report the resulting share URL, message count, and redaction summary.
5. If the CLI is not on PATH, tell the user to install it (`npm i -g @quire/cli` after publishing, or `pnpm link --global` from the repo's `cli/` package) and stop.
