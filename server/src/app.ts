import { Hono } from 'hono';
import type { Db } from './db/client.js';
import type { Config } from './config.js';
import { publicRoutes } from './api/public.js';
import { RateLimiter, IpWindow } from './security/rate-limit.js';

export interface AppDeps {
  db: Db;
  config: Config;
  unlockLimiter?: RateLimiter;
  ipWindow?: IpWindow;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  app.get('/healthz', (c) => c.json({ ok: true }));
  app.route(
    '/',
    publicRoutes({
      db: deps.db,
      config: deps.config,
      unlockLimiter: deps.unlockLimiter ?? new RateLimiter(),
      ipWindow: deps.ipWindow ?? new IpWindow(),
    }),
  );
  // Owner routes (Task 7), security headers + error handler (Task 8), static SPA (Task 8).
  return app;
}
