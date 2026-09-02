import { execSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import {
  API_KEY,
  OPENAI_KEY,
  TINY_PNG_DATA_URI,
  createV2Share,
  createV2LongShare,
  createV2ChunkedShare,
  systemNoticeSession,
  reasoningSession,
  imageSession,
  toolImageSession,
  xssSession,
} from './helpers';

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

test.describe('sealed share (v2) viewer', () => {
  test('the rail cluster stays anchored to the viewport center while scrolling', async ({ page, request }) => {
    const { url } = await createV2LongShare(request, 60);
    await page.goto(url);
    await expect(page.getByRole('heading', { name: 'Long Session' })).toBeVisible();
    const cluster = page.locator('.rail-cluster');
    await expect(cluster).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.rail-tick')).toHaveCount(60, { timeout: 15000 });
    const centerAtTop = await cluster.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.top + r.height / 2;
    });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(300);
    const centerAtBottom = await cluster.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.top + r.height / 2;
    });
    const viewportCenter = page.viewportSize()!.height / 2;
    expect(Math.abs(centerAtTop - viewportCenter)).toBeLessThan(40);
    expect(Math.abs(centerAtBottom - viewportCenter)).toBeLessThan(40);
  });

  test('the rail cluster scrolls internally when ticks exceed the viewport', async ({ page, request }) => {
    const { url } = await createV2LongShare(request, 400);
    await page.goto(url);
    await expect(page.getByRole('heading', { name: 'Long Session' })).toBeVisible();
    const cluster = page.locator('.rail-cluster');
    await expect(cluster).toBeVisible({ timeout: 20000 });
    await expect(page.locator('.rail-tick')).toHaveCount(400, { timeout: 20000 });
    const scrollable = await cluster.evaluate((el) => el.scrollHeight > el.clientHeight);
    expect(scrollable).toBe(true);
    await expect(cluster).toHaveClass(/is-overflowing/);
  });

  test('hovering a rail tick shows a short preview of the user message', async ({ page, request }) => {
    const { url } = await createV2LongShare(request, 8);
    await page.goto(url);
    await expect(page.getByRole('heading', { name: 'Long Session' })).toBeVisible();
    const firstTick = page.locator('.rail-tick').first();
    await expect(firstTick).toBeVisible({ timeout: 15000 });
    const tip = page.locator('.rail-tip');
    expect(await tip.count()).toBe(0);
    await firstTick.hover();
    await expect(tip).toHaveCount(1);
    await expect(tip).toContainText('User turn number 1: please do something specific and detailed about topic 0.');
  });

  test('a short rail shows no scrollbar (overflow only when ticks exceed the budget)', async ({ page, request }) => {
    const { url } = await createV2LongShare(request, 8);
    await page.goto(url);
    await expect(page.getByRole('heading', { name: 'Long Session' })).toBeVisible();
    await expect(page.locator('.rail-tick')).toHaveCount(8, { timeout: 15000 });
    await page.waitForTimeout(200);
    const cluster = page.locator('.rail-cluster');
    const overflow = await cluster.evaluate((el) => ({
      scrollable: el.scrollHeight > el.clientHeight,
      cls: el.classList.contains('is-overflowing'),
      oy: getComputedStyle(el).overflowY,
    }));
    expect(overflow.scrollable).toBe(false);
    expect(overflow.cls).toBe(false);
    expect(overflow.oy).toBe('hidden');
  });

  test('clicking an unloaded tick loads the messages up to it, then scrolls', async ({ page, request }) => {
    const { url } = await createV2LongShare(request, 60);
    await page.goto(url);
    await expect(page.getByRole('heading', { name: 'Long Session' })).toBeVisible();
    const ticks = page.locator('.rail-tick');
    await expect(ticks).toHaveCount(60, { timeout: 15000 });
    // v2 message seqs are 0-based (share-v2/pages.ts): turn 40's user message is index 78.
    const target = page.locator('#msg-0-78');
    expect(await target.count()).toBe(0);
    await ticks.nth(39).click();
    await expect(target).toBeVisible({ timeout: 20000 });
    await page.waitForTimeout(1300);
    const box = await target.boundingBox();
    expect(box, 'target message not found after lazy load').not.toBeNull();
    const vh = page.viewportSize()!.height;
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeLessThan(vh / 3);
    await expect(ticks.nth(39)).toHaveClass(/active/);
  });

  test('clicking a rail tick smooth-scrolls to the matching user message', async ({ page, request }) => {
    const { url } = await createV2LongShare(request, 30);
    await page.goto(url);
    await expect(page.getByRole('heading', { name: 'Long Session' })).toBeVisible();
    const ticks = page.locator('.rail-tick');
    await expect(ticks).toHaveCount(30, { timeout: 15000 });
    await ticks.nth(4).click();
    await page.waitForTimeout(600);
    const target = page.locator('#msg-0-8'); // turn 5 = user index 8 (v2 seqs are 0-based)
    const box = await target.boundingBox();
    expect(box, 'target message not found').not.toBeNull();
    const vh = page.viewportSize()!.height;
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeLessThan(vh / 3);
    await expect(ticks.nth(4)).toHaveClass(/active/);
  });

  test('the active rail tick follows the reader as they scroll', async ({ page, request }) => {
    const { url } = await createV2LongShare(request, 40);
    await page.goto(url);
    await expect(page.getByRole('heading', { name: 'Long Session' })).toBeVisible();
    const ticks = page.locator('.rail-tick');
    await expect(ticks).toHaveCount(40, { timeout: 15000 });
    await page.waitForFunction(
      () => {
        const first = document.querySelector('.rail-tick');
        return first !== null && first.classList.contains('active');
      },
      undefined,
      { timeout: 5000 },
    );
    await expect(ticks.nth(0)).toHaveClass(/active/);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.5));
    await page.waitForTimeout(500);
    const activeIdx = await ticks.evaluateAll((els) => els.findIndex((el) => el.classList.contains('active')));
    expect(activeIdx).toBeGreaterThan(0);
  });

  test('the rail is usable on a narrow viewport with tappable hit-targets', async ({ page, request }) => {
    const { url } = await createV2LongShare(request, 12);
    await page.setViewportSize({ width: 375, height: 700 });
    await page.goto(url);
    await expect(page.getByRole('heading', { name: 'Long Session' })).toBeVisible();
    const ticks = page.locator('.rail-tick');
    await expect(ticks).toHaveCount(12, { timeout: 15000 });
    const h = await ticks.first().evaluate((el) => el.getBoundingClientRect().height);
    expect(h).toBeGreaterThanOrEqual(12);
    const railW = await page.locator('.rail-col').evaluate((el) => el.getBoundingClientRect().width);
    expect(railW).toBeLessThanOrEqual(40);
  });

  test('lazy-loads subsequent pages when scrolling', async ({ page, request }) => {
    const { url } = await createV2Share(request, { messageCount: 120 });
    await page.goto(url);
    await expect(page.getByText('Message 49', { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('Message 51', { exact: true })).toHaveCount(0);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(page.getByText('Message 99', { exact: true })).toBeVisible({ timeout: 15000 });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(page.getByText('Message 119', { exact: true })).toBeVisible({ timeout: 15000 });
  });

  test('a two-chunk v2 share renders messages from both chunks in order', async ({ page, request }) => {
    const { url } = await createV2ChunkedShare(request, { perChunk: 3 });
    await page.goto(url);
    await expect(page.getByRole('heading', { name: 'Chunked E2E' })).toBeVisible();
    await expect(page.getByText('chunk0 message 1', { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('chunk0 message 3', { exact: true })).toBeVisible();
    await expect(page.getByText('chunk1 message 1', { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('chunk1 message 3', { exact: true })).toBeVisible();
  });

  test('a system part renders as a collapsed notice, not a user bubble', async ({ page, request }) => {
    const { url } = await createV2Share(request, { session: systemNoticeSession() });
    await page.goto(url);
    await expect(page.getByRole('heading', { name: 'System Notice Session' })).toBeVisible();
    await expect(page.getByText('goal continuation', { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('hidden objective body')).toHaveCount(0);
    await page.getByRole('button', { name: /goal continuation/ }).click();
    await expect(page.getByText('hidden objective body')).toBeVisible();
  });

  test('a reasoning part renders as a collapsed thinking chip, not raw text', async ({ page, request }) => {
    const { url } = await createV2Share(request, { session: reasoningSession() });
    await page.goto(url);
    await expect(page.getByRole('heading', { name: 'Reasoning Session' })).toBeVisible();
    await expect(page.getByRole('button', { name: /thinking/ })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('let me think about this carefully step by step')).toHaveCount(0);
    await expect(page.getByText('The answer is 4.')).toBeVisible();
    await page.getByRole('button', { name: /thinking/ }).click();
    await expect(page.getByText('let me think about this carefully step by step')).toBeVisible();
  });

  test('an image part renders as an <img> with the embedded data URI', async ({ page, request }) => {
    const { url } = await createV2Share(request, { session: imageSession() });
    await page.goto(url);
    await expect(page.getByRole('heading', { name: 'Image Session' })).toBeVisible();
    await expect(page.getByText('Here it is.')).toBeVisible();
    const img = page.locator('img.image-part-img');
    await expect(img).toHaveCount(1);
    await expect(img).toHaveAttribute('src', TINY_PNG_DATA_URI);
    await expect(img).toHaveAttribute('alt', 'screenshot');
  });

  test('a tool part with an attached image renders the image inside the tool card', async ({ page, request }) => {
    const { url } = await createV2Share(request, { session: toolImageSession() });
    await page.goto(url);
    await expect(page.getByRole('heading', { name: 'Tool Image Session' })).toBeVisible();
    await expect(page.getByText('Here is what the file shows.')).toBeVisible();
    const toolCard = page.locator('div.rounded-lg.border');
    await expect(toolCard).toBeVisible({ timeout: 15000 });
    await expect(toolCard.getByText('1 image')).toBeVisible();
    await expect(page.locator('img.image-part-img')).toHaveCount(0);
    await toolCard.getByRole('button').click();
    const img = page.locator('img.image-part-img');
    await expect(img).toHaveCount(1);
    await expect(img).toHaveAttribute('src', TINY_PNG_DATA_URI);
    await expect(img).toHaveAttribute('alt', 'Read image');
  });

  test('XSS payloads in v2 session content render no executable elements', async ({ page, request }) => {
    const { url } = await createV2Share(request, { session: xssSession() });
    await page.goto(url);
    await expect(page.getByRole('heading', { name: 'XSS Session' })).toBeVisible();
    await expect(page.locator('.msg-target').getByText('render this')).toBeVisible();
    await expect(page.getByText('xss js-case')).toBeVisible({ timeout: 15000 });
    expect(await page.locator('a[href^="javascript:"]').count()).toBe(0);
    expect(await page.locator('a[href^="data:"]').count()).toBe(0);
    expect(await page.locator('a[href^="//"]').count()).toBe(0);
    expect(await page.locator('script:not([src])').count()).toBe(0);
    expect(await page.locator('img[onerror]').count()).toBe(0);
    expect(await page.locator('img[src^="javascript:"]').count()).toBe(0);
    expect(await page.locator('img[src*=".."]').count()).toBe(0);
    const backslashAnchors = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.msg-target a')).filter((a) => (a.getAttribute('href') || '').includes('\\')).length,
    );
    expect(backslashAnchors).toBe(0);
    const pctImgs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.msg-target img')).filter((i) => /%2e/i.test(i.getAttribute('src') || '')).length,
    );
    expect(pctImgs).toBe(0);
    const badAnchors = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.msg-target a')).filter((a) => {
        const href = (a.getAttribute('href') || '').trim();
        return /^(javascript|vbscript|data|file):/i.test(href) || href.startsWith('//') || href.startsWith('\\\\');
      }).length,
    );
    expect(badAnchors).toBe(0);
    const badImgs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.msg-target img')).filter((i) => {
        const src = i.getAttribute('src') || '';
        return /^(javascript|vbscript):/i.test(src) || /^data:image\/svg/i.test(src) || /^data:text/i.test(src);
      }).length,
    );
    expect(badImgs).toBe(0);
    const body = await page.locator('body').innerText();
    for (const label of ['xss link', 'xss proto-rel', 'xss backslash', 'xss js-case', 'xss js-pct', 'xss ctrl', 'xss pct', 'xss svg']) {
      expect(body, `label "${label}" should survive as text`).toContain(label);
    }
  });

  test('respects the reader dark mode preference', async ({ browser, request }) => {
    const { url } = await createV2Share(request);
    const context = await browser.newContext({ colorScheme: 'dark' });
    const page = await context.newPage();
    try {
      await page.goto(url);
      await expect(page.getByRole('heading', { name: 'E2E Session' })).toBeVisible();
      const bg = await page.evaluate(() => {
        const el = document.querySelector('div.min-h-screen');
        return el ? getComputedStyle(el).backgroundColor : null;
      });
      expect(bg, 'themed root element not found').not.toBeNull();
      const oklch = bg!.match(/oklch\(([\d.]+)\s/);
      const rgb = bg!.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      let luminance: number;
      if (oklch) {
        luminance = Number(oklch[1]);
      } else if (rgb) {
        luminance = (0.2126 * Number(rgb[1]) + 0.7152 * Number(rgb[2]) + 0.0722 * Number(rgb[3])) / 255;
      } else {
        throw new Error(`unexpected background format: ${bg}`);
      }
      expect(luminance).toBeLessThan(0.2);
    } finally {
      await context.close();
    }
  });
});

test.describe('sealed share (v2) security', () => {
  test('no existence oracle: unknown, revoked, and no-password v2 shares are byte-identical 404s', async ({ request }) => {
    const canonical = { status: 404, body: '{"error":{"code":"not_found","message":"Not found"}}' };
    // (a) Unknown shareId.
    const unknown = await request.post('/api/v2/public/shares/does-not-exist-000000000000/unlock', {
      data: { password: 'whatever' },
    });
    expect(unknown.status()).toBe(canonical.status);
    expect(await unknown.text()).toBe(canonical.body);
    // (b) Revoked shareId.
    const { shareId: liveId } = await createV2Share(request);
    const revoke = await request.delete(`/api/chats/${liveId}`, { headers: { authorization: `Bearer ${API_KEY}` } });
    expect(revoke.status()).toBe(200);
    const revoked = await request.post(`/api/v2/public/shares/${liveId}/unlock`, { data: { password: 'whatever' } });
    expect(revoked.status()).toBe(canonical.status);
    expect(await revoked.text()).toBe(canonical.body);
    // (c) No-password shareId (a distinct needs_password response would be a liveness oracle).
    const { shareId: noPwId } = await createV2Share(request);
    const noPw = await request.post(`/api/v2/public/shares/${noPwId}/unlock`, { data: { password: 'whatever' } });
    expect(noPw.status()).toBe(canonical.status);
    expect(await noPw.text()).toBe(canonical.body);
  });

  test('password unlock lockout: 5 wrong attempts lock the v2 share, even the correct password 429s', async ({ request }) => {
    const { shareId } = await createV2Share(request, { password: 'correct-horse' });
    for (let i = 0; i < 5; i++) {
      const res = await request.post(`/api/v2/public/shares/${shareId}/unlock`, { data: { password: 'wrong' } });
      expect(res.status(), `attempt ${i + 1} should be 401`).toBe(401);
    }
    const locked = await request.post(`/api/v2/public/shares/${shareId}/unlock`, { data: { password: 'correct-horse' } });
    expect(locked.status()).toBe(429);
    expect(await locked.json()).toEqual({
      error: { code: 'rate_limited', message: 'Too many failed attempts. Try again in 15 minutes.' },
    });
  });

  test('oversized v2 request body is rejected with a uniform 413 too_large', async ({ request }) => {
    const over20MB = 'x'.repeat(20 * 1024 * 1024 + 1);
    const res = await request.post('/api/v2/shares', {
      headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
      data: JSON.stringify({
        protocol: 'quire-share-v1',
        uploadRequestId: crypto.randomUUID(),
        preset: 'strict',
        sourceChunkCount: 1,
        contentKey: 'a'.repeat(43),
        session: {
          sessionId: 's',
          title: 't',
          model: 'm',
          messages: [{ role: 'user', time: new Date(Date.UTC(2026, 0, 1)).toISOString(), parts: [{ type: 'text', text: over20MB }] }],
        },
      }),
    });
    expect(res.status()).toBe(413);
    expect(await res.json()).toEqual({ error: { code: 'too_large', message: 'Request body too large' } });
    expect((await res.headers())['connection']).toBe('close');
  });
});
