import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface CliConfig {
  serverUrl: string;
  apiKey: string;
}

export function loadCliConfig(env: NodeJS.ProcessEnv = process.env): CliConfig {
  let file: Partial<CliConfig> = {};
  const path = join(homedir(), '.quire', 'config.json');
  if (existsSync(path)) {
    try {
      file = JSON.parse(readFileSync(path, 'utf8')) as Partial<CliConfig>;
    } catch {
      // corrupt config: fall through to env-only
    }
  }
  const serverUrl = env.QUIRE_SERVER_URL || file.serverUrl;
  const apiKey = env.QUIRE_API_KEY || file.apiKey;
  if (!serverUrl) {
    throw new Error('QUIRE_SERVER_URL is not set (env or ~/.quire/config.json)');
  }
  // Round 3: require https:// (or a localhost http:// for local dev). The CLI
  // sends the full unredacted session AND the Bearer API key to this URL, so
  // plain http:// to a remote host would exfiltrate both in cleartext (e.g. via
  // a poisoned QUIRE_SERVER_URL env var). Localhost http:// is allowed because
  // the local-inspect workflow runs a standalone server on 127.0.0.1.
  const u = new URL(serverUrl);
  const isLocalhost = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLocalhost)) {
    throw new Error(
      `QUIRE_SERVER_URL must be https:// (or http:// on localhost for local dev) — the session and API key are sent to it (got "${serverUrl}")`,
    );
  }
  if (!apiKey) {
    throw new Error('QUIRE_API_KEY is not set (env or ~/.quire/config.json)');
  }
  return { serverUrl: serverUrl.replace(/\/+$/, ''), apiKey };
}
