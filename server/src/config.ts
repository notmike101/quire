import { z } from 'zod';
import { fileURLToPath } from 'node:url';

export interface Config {
  databaseUrl: string;
  apiKey: string;
  unlockSecret: string;
  port: number;
  webDist: string;
  // Optional: defaults to true (trust the leftmost XFF hop) when a caller
  // constructs a Config without it (e.g. tests). The zod schema always fills it.
  trustProxy?: boolean;
}

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  QUIRE_API_KEY: z.string().min(32),
  UNLOCK_SECRET: z.string().min(32),
  PORT: z.coerce.number().int().positive().default(8787),
  WEB_DIST: z.string().default(fileURLToPath(new URL('../../web/dist', import.meta.url))),
  // Chain C: when false, clientIp ignores XFF/x-real-ip and uses the socket
  // address — for a direct-exposure deployment with no fronting proxy.
  TRUST_PROXY: z.enum(['true', 'false']).default('true'),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid environment: ${fields}`);
  }
  return {
    databaseUrl: parsed.data.DATABASE_URL,
    apiKey: parsed.data.QUIRE_API_KEY,
    unlockSecret: parsed.data.UNLOCK_SECRET,
    port: parsed.data.PORT,
    webDist: parsed.data.WEB_DIST,
    trustProxy: parsed.data.TRUST_PROXY === 'true',
  };
}
