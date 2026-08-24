import { Hono } from 'hono';
import type { Config } from './config.js';

export function createApp(_db: unknown, config: Config): Hono {
  const app = new Hono();
  app.get('/healthz', (c) => c.json({ ok: true }));
  // Routes and middleware are added in later tasks.
  void config;
  return app;
}
