import { z } from 'zod';
import { fileURLToPath } from 'node:url';

export interface Config {
  databaseUrl: string;
  apiKey: string;
  unlockSecret: string;
  port: number;
  webDist: string;
}

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  QUIRE_API_KEY: z.string().min(32),
  UNLOCK_SECRET: z.string().min(32),
  PORT: z.coerce.number().int().positive().default(8787),
  WEB_DIST: z.string().default(fileURLToPath(new URL('../../web/dist', import.meta.url))),
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
  };
}
