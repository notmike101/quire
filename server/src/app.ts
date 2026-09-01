import { Hono } from 'hono';
import type { Db } from './db/client.js';
import type { Config } from './config.js';
import { publicRoutes } from './api/public.js';
import { ownerRoutes } from './api/owner.js';
import { ownerV2Routes } from './api/owner-v2.js';
import { publicV2Routes } from './api/public-v2.js';
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
  // Round 9 (B-F5): unmatched routes — and c.notFound() from the static
  // handler — return the same uniform JSON error body as the API's own 404s
  // instead of Hono's plain-text default.
  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Not found' } }, 404));
  app.use('*', securityHeaders());
  app.use('*', bodyLimit());
  app.get('/healthz', (c) => c.json({ ok: true }));
  // The unlock lockout limiters and the per-IP volume window are shared
  // between the v1 and v2 public routes: lockout keys are namespaced by share
  // identifier (v1 token / v2 publicId), so one instance means a brute-forcer's
  // failures accumulate across both APIs.
  // Chain C: back the unlock limiter with Postgres so a restart does not
  // clear a 15-minute lockout. Tests inject their own (in-memory) limiter.
  // The store carries the threshold (it is the source of truth when wired),
  // so pass it explicitly to the store, not just the limiter.
  // Round 7: keys are namespaced 'ip:' so the per-IP store's opportunistic
  // prune (scoped to its prefix) never touches the per-token store's rows.
  const unlockLimiter = deps.unlockLimiter ?? new RateLimiter(5, 15 * 60 * 1000, undefined, new PostgresLockoutStore(deps.db, 5, 15 * 60 * 1000, 'ip:', true));
  // Round 6: per-token lockout. Higher threshold (25) than the per-IP one
  // (5) so a handful of legitimate users each mistyping once does not lock
  // the share, but an IP-rotating brute-forcer (5 fails per IP) is stopped
  // after 5 distinct IPs. Same Postgres table as the per-IP limiter, but a
  // DISTINCT 'tok:' namespace and pruneSubThreshold=false: the per-token
  // rows are bounded by the number of shares (one token each, owner-created,
  // not attacker-cyclable), so its sub-threshold counters are kept (a slow
  // per-token attack accumulates to 25 instead of being reset by a prune).
  const tokenLimiter = deps.tokenLimiter ?? new RateLimiter(25, 15 * 60 * 1000, undefined, new PostgresLockoutStore(deps.db, 25, 15 * 60 * 1000, 'tok:', false));
  const ipWindow = deps.ipWindow ?? new IpWindow();
  app.route('/', publicRoutes({ db: deps.db, config: deps.config, unlockLimiter, tokenLimiter, ipWindow }));
  app.route('/api/v2/public', publicV2Routes({ db: deps.db, config: deps.config, unlockLimiter, tokenLimiter, ipWindow }));
  app.route('/', ownerRoutes({ db: deps.db, config: deps.config }));
  app.route('/api/v2', ownerV2Routes({ db: deps.db, config: deps.config }));
  mountStatic(app, deps.config.webDist);
  return app;
}
