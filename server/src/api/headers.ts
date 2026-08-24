import type { MiddlewareHandler } from 'hono';

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.header("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self'");
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  };
}

export function bodyLimit(maxBytes: number = MAX_UPLOAD_BYTES): MiddlewareHandler {
  return async (c, next) => {
    const len = Number(c.req.header('content-length') ?? 0);
    if (Number.isFinite(len) && len > maxBytes) {
      return c.json({ error: { code: 'too_large', message: 'Request body too large' } }, 413);
    }
    await next();
  };
}
