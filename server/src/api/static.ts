import { serveStatic } from '@hono/node-server/serve-static';
import type { Hono } from 'hono';

/** Serve the built SPA: /chats/:token -> index.html, /assets/* from the dist dir. */
export function mountStatic(app: Hono, webDist: string): void {
  app.get('/chats/:token', serveStatic({ path: '/index.html', root: webDist }));
  app.use('/assets/*', serveStatic({ root: webDist }));
}
