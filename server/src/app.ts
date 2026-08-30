import { Hono } from 'hono';
import type { Db } from './db/client.js';
import type { Config } from './config.js';
import { publicRoutes } from './api/public.js';
import { ownerRoutes } from './api/owner.js';
import { securityHeaders, bodyLimit } from './api/headers.js';
import { errorHandler } from './api/errors.js';
import { mountStatic } from './api/static.js';
import { RateLimiter, IpWindow, PostgresLockoutStore } from './security/rate-limit.js';

export interface AppDeps {
  db: Db;
  config: Config;
  unlockLimiter?: RateLimiter;
  // Round 6: per-token (IP-independent) unlock lockout — see PublicDeps.
  tokenLimiter?: RateLimiter;
  ipWindow?: IpWindow;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  app.onError(errorHandler);
  app.use('*', securityHeaders());
  app.use('*', bodyLimit());
  app.get('/healthz', (c) => c.json({ ok: true }));
  app.route(
    '/',
    publicRoutes({
      db: deps.db,
      config: deps.config,
      // Chain C: back the unlock limiter with Postgres so a restart does not
      // clear a 15-minute lockout. Tests inject their own (in-memory) limiter.
      // The store carries the threshold (it is the source of truth when wired),
      // so pass it explicitly to the store, not just the limiter.
      unlockLimiter: deps.unlockLimiter ?? new RateLimiter(5, 15 * 60 * 1000, undefined, new PostgresLockoutStore(deps.db, 5)),
      // Round 6: per-token lockout. Higher threshold (25) than the per-IP one
      // (5) so a handful of legitimate users each mistyping once does not lock
      // the share, but an IP-rotating brute-forcer (5 fails per IP) is stopped
      // after 5 distinct IPs. Same Postgres store as the per-IP limiter; the
      // token-only key coexists with the (token, IP) keys in the same table.
      tokenLimiter: deps.tokenLimiter ?? new RateLimiter(25, 15 * 60 * 1000, undefined, new PostgresLockoutStore(deps.db, 25)),
      ipWindow: deps.ipWindow ?? new IpWindow(),
    }),
  );
  app.route('/', ownerRoutes({ db: deps.db, config: deps.config }));
  mountStatic(app, deps.config.webDist);
  return app;
}
