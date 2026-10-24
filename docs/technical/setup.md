# Setup and deployment

Quire is self-hosted. The server stores and serves shared conversations; the CLI on your machine publishes sessions to it. Recipients open the resulting link in a browser.

## 1. Run the server

Install Docker with Compose, then clone the repository:

```bash
git clone https://github.com/notmike101/quire.git
cd quire
cp .env.example .env
```

Edit `.env` before starting:

- Set `QUIRE_API_KEY` to a long, random secret. Your publisher CLI will use this key; do not give it to recipients.
- Set `UNLOCK_SECRET` to a separate long, random secret for signing password-unlock cookies.
- Set `POSTGRES_PASSWORD` to a strong password for the Compose-managed database.

The Compose stack sets `DATABASE_URL` for its database automatically. The template's `DATABASE_URL` is for running the server outside Docker.

```bash
docker compose up -d --build
```

The server is exposed at `http://127.0.0.1:8787` on the host. Database migrations run at startup. Postgres data persists in the `pgdata` volume.

### Make shares reachable

Put a reverse proxy such as Caddy, Nginx, or Traefik in front of the server, with a hostname recipients can reach and HTTPS enabled. Password-unlock cookies are `Secure` and are not sent over plain HTTP (localhost is exempt).

The server defaults to `TRUST_PROXY=false`, so rate limiting uses the socket address. If you deploy behind a trusted proxy, configure it to overwrite `X-Forwarded-For` with the real client IP and add `TRUST_PROXY: "true"` to the server service's `environment` in your Compose configuration. Merely putting it in `.env` does not pass it into this container. Do not enable proxy trust when clients can reach the server directly or control the trusted IP header.

Check `https://your-quire-host/healthz` after deploying. The root page is not a share: individual conversations have their own links.

## 2. Install the publisher CLI

On the machine where your coding sessions live, use Node 22.22.2+, Node 24.15.0+, or Node 26+ and the pnpm version pinned in the repository's `package.json`.

From the cloned repository root:

```bash
pnpm install
pnpm --filter @quire/cli build
pnpm add --global "link:./cli"
```

Keep the clone at that path: the global command links to it. If pnpm reports a missing global bin directory, run `pnpm setup`, reopen the terminal, and retry. See the [plugin prerequisites](../../plugin/README.md#prerequisites) for the Windows absolute-path example.

## 3. Connect the CLI

Run `quire setup` for a server environment block and CLI config example. Create `~/.quire/config.json` with your server URL and the same owner API key you set on the server:

```json
{
  "serverUrl": "https://your-quire-host",
  "apiKey": "your-server-api-key"
}
```

Alternatively, set `QUIRE_SERVER_URL` and `QUIRE_API_KEY` in your shell. Environment values override the config file. Keep the API key private; it grants owner access to shares on this server.

## 4. Publish a conversation

From an active Claude Code, Codex, or ZCode session environment:

```bash
quire publish --current
```

Review the confirmation before publishing. If the current session cannot be detected, use an explicit session ID and `--harness` as described in the [CLI guide](cli.md).

For Oh My Pi, run `quire setup omp`, restart or reload OMP, and use `/share` in an interactive, persisted session. This publishes immediately, without a confirmation prompt. For Claude Code, ZCode, and Codex in-tool commands, see [plugin installation](../../plugin/README.md#install).

Quire prints the share link. Copy the entire link, including the part after `#`, and open it in a browser. Recipients do not need the CLI or your API key. If you set a password, send it separately.

For passwords, expiration, revocation, and integration details, continue to [CLI and integrations](cli.md). Read [architecture and security](architecture-security.md) before publishing sensitive material; automated redaction is not a substitute for reviewing what you share.

## Operating an existing deployment

The [sealed-share runbook](../operations/sealed-shares.md) covers migrations, metrics, retention, rollback, and database backup/restore. For running the server without Docker during development, see [development and testing](development.md).
