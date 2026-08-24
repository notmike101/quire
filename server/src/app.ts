import { Hono } from 'hono';
import type { Db } from './db/client.js';
import type { Config } from './config.js';
import { publicRoutes } from './api/public.js';
import { ownerRoutes } from './api/owner.js';
import { securityHeaders, bodyLimit } from './api/headers.js';
import { errorHandler } from './api/errors.js';
import { mountStatic } from './api/static.js';
import { RateLimiter, IpWindow } from './security/rate-limit.js';

export interface AppDeps {
  db: Db;
  config: Config;
  unlockLimiter?: RateLimiter;
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
      unlockLimiter: deps.unlockLimiter ?? new RateLimiter(),
      ipWindow: deps.ipWindow ?? new IpWindow(),
    }),
  );
  app.route('/', ownerRoutes({ db: deps.db, config: deps.config }));
  mountStatic(app, deps.config.webDist);
  return app;
}
