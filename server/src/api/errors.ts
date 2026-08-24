import type { ErrorHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';

export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: { code: 'http', message: err.message } }, err.status);
  }
  // Server-side log only. Never include request bodies, tokens, or secrets.
  console.error('unhandled error:', err);
  return c.json({ error: { code: 'internal', message: 'Internal server error' } }, 500);
};
