import { Hono, type Context } from 'hono';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/client.js';
import type { Config } from '../config.js';
import { patchBodySchema } from './schema.js';
import { getV2OwnerShare, listV2, revokeV2, updateV2 } from '../share-v2/store.js';

export interface OwnerDeps {
  db: Db;
  config: Config;
}

export function apiKeyOk(c: Context, config: Config): boolean {
  const [scheme, value] = (c.req.header('authorization') ?? '').split(' ');
  if (scheme !== 'Bearer' || !value) return false;
  // Round 7: compare SHA-256 DIGESTS, not raw bytes. The old
  // `a.length === b.length` gate was a length oracle: a wrong-length key
  // short-circuited before timingSafeEqual (faster) while a right-length wrong
  // key ran the full comparison (slower), so an attacker could binary-search
  // the key's length by timing 401s. Digests are always 32 bytes, so
  // timingSafeEqual is always valid (no length gate) and constant-time
  // regardless of the input length — the server-side hash of config.apiKey is
  // constant across requests, so its length is not leaked.
  const a = createHash('sha256').update(value).digest();
  const b = createHash('sha256').update(config.apiKey).digest();
  return timingSafeEqual(a, b);
}

export function ownerRoutes({ db, config }: OwnerDeps): Hono {
  const app = new Hono();

  app.use('/api/chats/*', async (c, next) => {
    if (!apiKeyOk(c, config)) {
      return c.json({ error: { code: 'unauthorized', message: 'Invalid API key' } }, 401);
    }
    await next();
  });

  app.get('/api/chats', async (c) => c.json({ shares: await listV2(db) }));

  app.get('/api/chats/:token', async (c) => {
    const s = await getV2OwnerShare(db, c.req.param('token') ?? '');
    if (!s) return c.json({ error: { code: 'not_found', message: 'Not found' } }, 404);
    return c.json(s);
  });

  app.patch('/api/chats/:token', async (c) => {
    const parsed = patchBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: 'validation', message: 'invalid body' } }, 400);
    const { title, expiresAt } = parsed.data;
    if (title === undefined && expiresAt === undefined) return c.json({ error: { code: 'validation', message: 'invalid body' } }, 400);
    const updated = await updateV2(db, c.req.param('token') ?? '', { title, expiresAt });
    if (!updated) return c.json({ error: { code: 'not_found', message: 'Not found' } }, 404);
    return c.json({ ok: true });
  });

  app.delete('/api/chats/:token', async (c) => {
    const revoked = await revokeV2(db, c.req.param('token') ?? '');
    if (!revoked) return c.json({ error: { code: 'not_found', message: 'Not found' } }, 404);
    return c.json({ ok: true });
  });

  return app;
}
