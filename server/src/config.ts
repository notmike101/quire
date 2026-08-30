import { z } from 'zod';
import { fileURLToPath } from 'node:url';

export interface Config {
  databaseUrl: string;
  apiKey: string;
  unlockSecret: string;
  port: number;
  webDist: string;
  // Optional: defaults to false (use the socket address, ignore XFF) when a
  // caller constructs a Config without it (e.g. tests). The zod schema always
  // fills it. Trusting XFF is an explicit opt-in for deployments behind a
  // fronting proxy — clientIp() takes the RIGHTMOST hop, which the immediate
  // proxy writes and the client cannot control (see clientIp()).
  trustProxy?: boolean;
}

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  QUIRE_API_KEY: z.string().min(32),
  UNLOCK_SECRET: z.string().min(32),
  PORT: z.coerce.number().int().positive().default(8787),
  WEB_DIST: z.string().default(fileURLToPath(new URL('../../web/dist', import.meta.url))),
  // Chain C / Round 9 (B-F2): when true, clientIp trusts the RIGHTMOST XFF hop
  // (the entry the immediate fronting proxy wrote — a client can only prepend
  // spoofed entries, never control the rightmost one) or a single x-real-ip;
  // when false it uses the socket address. Defaults to false (safe) because
  // trusting a client-supplied header is only correct behind a fronting proxy.
  // A deployment that fronts the server with such a proxy must set TRUST_PROXY=true.
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),
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
