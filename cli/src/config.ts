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
  if (!serverUrl || !serverUrl.startsWith('http')) {
    throw new Error('QUIRE_SERVER_URL is not set (env or ~/.quire/config.json)');
  }
  if (!apiKey) {
    throw new Error('QUIRE_API_KEY is not set (env or ~/.quire/config.json)');
  }
  return { serverUrl: serverUrl.replace(/\/+$/, ''), apiKey };
}
