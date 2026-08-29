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
  app.use('/assets/*', async (c) => {
    // Serve only files under the /assets/ subtree of webDist. Reject any
    // traversal segment so a crafted URL cannot read files outside the built
    // SPA, then pin the resolved path to the validated wildcard remainder.
    // No next() is chained: this is the terminal handler for /assets/*, so if
    // the file is missing we finalize with 404 ourselves.
    const assetPath = c.req.path.replace(/^\/assets\//, '');
    if (!assetPath || assetPath.split('/').some((seg) => seg === '..' || seg === '')) {
      return c.notFound();
    }
    const result = await serveStatic({
      root: webDist,
      rewriteRequestPath: () => `/assets/${assetPath}`,
    })(c, async () => {});
    return result ?? c.notFound();
  });
}
