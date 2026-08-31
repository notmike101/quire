---
name: share
description: Use when the user asks to share or publish a Codex task through Quire, including password-protected or expiring links.
---

# Share with Quire

Publish the requested Codex task end-to-end. The Quire server always redacts at ingestion; if the user requests raw, unredacted, or no redaction, explain this hard security boundary and offer `normal` as the loosest preset. Do not pass `--preset none`.

Infer only these flags from the request:

- Password protection without a supplied password: `--password random`.
- A supplied literal password: `--password <value>`.
- Public or no password: omit `--password`.
- Expiration: `--expires tomorrow|today|Nh|Nm|Nd|week|month|year|<ISO>`.
- Redaction: `--preset strict|normal`; default to `strict`.

For the current task, run:

```text
quire publish --current --harness codex <inferred flags> --yes
```

If the user supplies a real task ID, replace `--current` with that ID. Never pass the user's free-text request as a positional argument. Always include `--harness codex` and `--yes`; do not ask the user to relay or answer a CLI prompt.

Report the published URL, generated password when present, expiration when set, and redaction summary. If `quire` is unavailable, tell the user to install it with `npm i -g @quire/cli` (or link this repository's CLI package) and stop.
