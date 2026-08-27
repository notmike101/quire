import { serveStatic } from '@hono/node-server/serve-static';
import type { Hono } from 'hono';

/** Serve the built SPA: /chats/:token -> index.html, /assets/* from the dist dir. */
export function mountStatic(app: Hono, webDist: string): void {
  // Disallow crawling of the whole site. Shared sessions are opt-in,
  // password-gated, expiring transcripts and must never be indexed. (The
  // X-Robots-Tag header in securityHeaders() is the authoritative signal;
  // this is the conventional file for crawlers that only read robots.txt.)
  app.get('/robots.txt', (c) => c.text('User-agent: *\nDisallow: /\n', 200, {
    'content-type': 'text/plain; charset=utf-8',
  }));
  app.get('/chats/:token', serveStatic({ path: '/index.html', root: webDist }));
  app.use('/assets/*', serveStatic({ root: webDist }));
}
