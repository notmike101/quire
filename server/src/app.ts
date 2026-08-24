import { Hono } from 'hono';
import type { Config } from './config.js';
import type { Db } from './db/client.js';

export function createApp(db: Db, config: Config): Hono {
  const app = new Hono();
  app.get('/healthz', (c) => c.json({ ok: true }));
  // Routes and middleware are added in later tasks.
  void db;
  void config;
  return app;
}
