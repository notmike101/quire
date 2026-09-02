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
  // Canary (Task 14): v2 write gate. Optional: defaults to false (writes OFF)
  // when a caller constructs a Config without it (e.g. tests); the zod schema
  // always fills it. v2 writes are off during the canary window; flipping
  // QUIRE_V2_WRITE_ENABLED=true enables the v2 ingestion routes. It never
  // disables v2 reads.
  v2WriteEnabled?: boolean;
  // Canary (Task 14): v1 public read retirement. Optional: defaults to true
  // (reads ON) when a caller constructs a Config without it; the zod schema
  // always fills it. Flipping QUIRE_V1_READS_ENABLED=false makes the v1
  // public read routes return 404; v1 owner reads and the v1 table are
  // untouched.
  v1ReadsEnabled?: boolean;
  // Public per-IP volume window: max public requests per IP per fixed 60s
  // window. Defaults to 120 (the production security bound, see IpWindow);
  // the E2E stack raises it because the single test client IP exceeds 120
  // public requests/minute across the v1+v2 suites.
  publicRateLimit?: number;
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
  // Canary (Task 14): v2 write gate. OFF by default during the canary window;
  // flipping to true enables the v2 ingestion routes. Never disables v2 reads.
  QUIRE_V2_WRITE_ENABLED: z.enum(['true', 'false']).default('false'),
  // Canary (Task 14): v1 public read retirement. ON by default; flipping to
  // false makes the v1 public read routes return 404 (v1 owner reads and the
  // v1 table are untouched). Flipped immediately once v2 is verified.
  QUIRE_V1_READS_ENABLED: z.enum(['true', 'false']).default('true'),
  // Public per-IP volume window limit (requests per fixed 60s window). 120
  // is the production bound; the E2E stack raises it (single test client IP,
  // v1+v2 suite volume). The 429 path itself stays unit-tested.
  QUIRE_PUBLIC_RATE_LIMIT: z.coerce.number().int().positive().default(120),
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
    v2WriteEnabled: parsed.data.QUIRE_V2_WRITE_ENABLED === 'true',
    v1ReadsEnabled: parsed.data.QUIRE_V1_READS_ENABLED === 'true',
    publicRateLimit: parsed.data.QUIRE_PUBLIC_RATE_LIMIT,
  };
}
