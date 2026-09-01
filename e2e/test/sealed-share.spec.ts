import { execSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { API_KEY, OPENAI_KEY, createV2Share } from './helpers';

// The compose server's full log history. The stack is built fresh per run
// (global-setup `up -d --build`, global-teardown `down -v`), so this is
// exactly this run's output. Used to assert the content key never reaches the
// server's logs. The base compose file interpolates the three secrets at parse
// time, so they must be exported (same values global-setup uses).
function serverLogs(): string {
  return execSync('docker compose -f ../docker-compose.yml -f ../docker-compose.e2e.yml logs server', {
    encoding: 'utf8',
    env: {
      ...process.env,
      POSTGRES_PASSWORD: 'e2e',
      QUIRE_API_KEY: API_KEY,
      UNLOCK_SECRET: 'e2e-unlock-secret-0000000000000000',
    },
  });
}

test.describe('sealed share (v2) lifecycle', () => {
  test('publishes a v2 share and the viewer renders the redacted messages', async ({ page, request }) => {
    const { url, messageCount } = await createV2Share(request, { secret: true });
    expect(messageCount).toBe(2);
    await page.goto(url);
    await expect(page.getByRole('heading', { name: 'E2E Session' })).toBeVisible();
    await expect(page.getByText('test-model')).toBeVisible();
    // Redaction happened server-side before sealing: the decrypted page carries
    // the redacted text, never the raw secret.
    await expect(page.locator('.msg-target').getByText('Use this key: [REDACTED:openai-key] for the API')).toBeVisible();
    const body = await page.locator('body').innerText();
    expect(body).not.toContain(OPENAI_KEY);
  });

  test('the raw secret is absent from the DOM and from every public-view network response', async ({ page, request }) => {
    const { url } = await createV2Share(request, { secret: true });
    // Capture every response body the viewer's browser receives (document,
    // assets, bootstrap, ciphertext blobs). The blob responses must be
    // ciphertext: the decrypted content exists only in the page's JS memory.
    const pending: Promise<{ url: string; text: string } | null>[] = [];
    page.on('response', (res) => {
      pending.push(
        res
          .body()
          .then((buf) => ({ url: res.url(), text: new TextDecoder().decode(buf) }))
          .catch(() => null),
      );
    });
    await page.goto(url);
    await expect(page.getByRole('heading', { name: 'E2E Session' })).toBeVisible();
    const responses = (await Promise.all(pending)).filter((r): r is { url: string; text: string } => r !== null);
    // Sanity: the viewer actually fetched the ciphertext blobs over the wire.
    expect(responses.some((r) => r.url.includes('/api/v2/public/shares/') && r.url.includes('/blobs/'))).toBe(true);
    for (const r of responses) {
      expect(r.text, `raw secret in response ${r.url}`).not.toContain(OPENAI_KEY);
    }
    const body = await page.locator('body').innerText();
    expect(body).not.toContain(OPENAI_KEY);
  });

  test('password-protected v2 share prompts for the password and unlocks', async ({ page, request }) => {
    const { url } = await createV2Share(request, { password: 'correct-horse' });
    await page.goto(url);
    await expect(page.getByRole('heading', { name: 'Password required' })).toBeVisible();

    await page.locator('input[type="password"]').fill('wrong');
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.getByText('Wrong password.')).toBeVisible();

    await page.locator('input[type="password"]').fill('correct-horse');
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.getByRole('heading', { name: 'E2E Session' })).toBeVisible();
  });

  test('expired v2 share shows the expired state (410)', async ({ page, request }) => {
    const { shareId, url } = await createV2Share(request, { expiresAt: '2020-01-01T00:00:00.000Z' });
    await page.goto(url);
    await expect(page.getByRole('heading', { name: 'This share has expired' })).toBeVisible();
    const res = await request.get(`/api/v2/public/shares/${shareId}/bootstrap`);
    expect(res.status()).toBe(410);
    expect(await res.json()).toEqual({ error: { code: 'expired', message: 'This share has expired' } });
  });

  test('revoking a v2 share makes the viewer 404 and the owner list drop it', async ({ page, request }) => {
    const { shareId, url } = await createV2Share(request);
    const ownerHeaders = { authorization: `Bearer ${API_KEY}` };
    // The merged owner list carries the v2 share, tagged format 'v2'.
    const before = await (await request.get('/api/chats', { headers: ownerHeaders })).json();
    expect(before.shares.some((s: { publicId?: string; format?: string }) => s.publicId === shareId && s.format === 'v2')).toBe(true);

    const revoke = await request.delete(`/api/chats/${shareId}`, { headers: ownerHeaders });
    expect(revoke.status()).toBe(200);

    const after = await (await request.get('/api/chats', { headers: ownerHeaders })).json();
    expect(after.shares.some((s: { publicId?: string }) => s.publicId === shareId)).toBe(false);

    await page.goto(url);
    await expect(page.getByRole('heading', { name: 'Share not found' })).toBeVisible();
    const res = await request.get(`/api/v2/public/shares/${shareId}/bootstrap`);
    expect(res.status()).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'Not found' } });
  });

  test('the content key never appears in public-view requests, server logs, or page source', async ({ page, request }) => {
    const { url, contentKey } = await createV2Share(request, { secret: true });
    // Every request the browser makes while viewing: the fragment is never
    // transmitted, so the key must not appear in any URL, header, or body.
    const requests: { url: string; headers: Record<string, string>; post: string | null }[] = [];
    page.on('request', (req) => {
      requests.push({ url: req.url(), headers: req.headers(), post: req.postData() });
    });
    await page.goto(url);
    await expect(page.getByRole('heading', { name: 'E2E Session' })).toBeVisible();

    for (const r of requests) {
      expect(r.url, `key in request URL ${r.url}`).not.toContain(contentKey);
      for (const [name, value] of Object.entries(r.headers)) {
        expect(value, `key in request header ${name}`).not.toContain(contentKey);
      }
      if (r.post !== null) expect(r.post, 'key in request body').not.toContain(contentKey);
    }

    // The fragment lives only in the browser's address bar: the rendered page
    // (serialized DOM) must not carry it.
    const html = await page.content();
    expect(html).not.toContain(contentKey);

    // The server never sees the fragment and never logs request material: the
    // key must not appear in the server logs. Settle briefly so any log line
    // written during the page load is flushed before the read.
    await page.waitForTimeout(500);
    expect(serverLogs()).not.toContain(contentKey);
  });
});
