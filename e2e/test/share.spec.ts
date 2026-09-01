import { test, expect } from '@playwright/test';
import { createShare, createChunkedShare, createSystemNoticeShare, createReasoningShare, createImageShare, createToolImageShare, createLongShare, createRuleShare, createXssShare, RULE_SECRETS, TINY_PNG_DATA_URI, OPENAI_KEY, API_KEY } from './helpers';

test.describe('share viewer', () => {
  test('renders the first page and redacts secrets server-side', async ({ page, request }) => {
    const { token } = await createShare(request, { secret: true });
    await page.goto(`/chats/${token}`);
    await expect(page.getByRole('heading', { name: 'E2E Session' })).toBeVisible();
    await expect(page.getByText('test-model')).toBeVisible();
    await expect(page.getByText(/redacted/)).toBeVisible();
    // Scope to the message bubble: the rail tooltip duplicates the text (it is
    // aria-hidden), so an unscoped getByText would match both.
    await expect(page.locator('.msg-target').getByText('Use this key: [REDACTED:openai-key] for the API')).toBeVisible();
    // The hard security property: the raw secret never reaches the viewer's DOM.
    const body = await page.locator('body').innerText();
    expect(body).not.toContain(OPENAI_KEY);
  });

  test('each redaction rule redacts its secret before it reaches the DOM (Chain F)', async ({ page, request }) => {
    for (const entry of RULE_SECRETS) {
      const { token } = await createRuleShare(request, entry);
      await page.goto(`/chats/${token}`);
      await expect(page.getByRole('heading', { name: `Rule ${entry.label}` })).toBeVisible({ timeout: 15000 });
      const body = await page.locator('body').innerText();
      // For connection-string the scheme+host legitimately survive (only the
      // credential is redacted), so assert on the credential, not the full raw.
      const needle = entry.needle ?? entry.raw;
      expect(body, `${entry.label}: raw secret leaked to DOM`).not.toContain(needle);
    }
  });

  test('XSS payloads in session content render no executable elements (Round 8 + Round 9 D1-D3)', async ({ page, request }) => {
    const { token } = await createXssShare(request);
    await page.goto(`/chats/${token}`);
    await expect(page.getByRole('heading', { name: 'XSS Session' })).toBeVisible();
    // The content itself renders (escaped) — the drop is of the executable
    // elements, not the text. The assistant payload goes through Shiki (slow in
    // the E2E env), so wait for one of its labels to land before asserting.
    await expect(page.locator('.msg-target').getByText('render this')).toBeVisible();
    await expect(page.getByText('xss js-case')).toBeVisible({ timeout: 15000 });
    // No executable-scheme, data:, or protocol-relative links.
    expect(await page.locator('a[href^="javascript:"]').count()).toBe(0);
    expect(await page.locator('a[href^="data:"]').count()).toBe(0);
    expect(await page.locator('a[href^="//"]').count()).toBe(0);
    // No inline <script> (the SPA's own scripts are all src'd modules).
    expect(await page.locator('script:not([src])').count()).toBe(0);
    // No event-handler attributes or traversal image srcs.
    expect(await page.locator('img[onerror]').count()).toBe(0);
    expect(await page.locator('img[src^="javascript:"]').count()).toBe(0);
    expect(await page.locator('img[src*=".."]').count()).toBe(0);
    // D1: the backslash-authority link is dropped — no anchor whose href carries
    // a backslash (WHATWG treats a leading \\ as an authority, so a lowercase
    // a[href^="javascript:"] check would never catch it).
    const backslashAnchors = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.msg-target a')).filter(
        (a) => (a.getAttribute('href') || '').includes('\\'),
      ).length,
    );
    expect(backslashAnchors).toBe(0);
    // D2: the percent-encoded traversal image is dropped — no img whose src
    // carries a percent-encoded dot (img[src*=".."] cannot catch %2e%2e).
    const pctImgs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.msg-target img')).filter(
        (i) => /%2e/i.test(i.getAttribute('src') || ''),
      ).length,
    );
    expect(pctImgs).toBe(0);
    // D3: no anchor carries an executable scheme in ANY casing (the mixed-case
    // JaVaScRiPt: variant), and no image carries an executable or svg data src.
    // The percent-encoded (javascript%3a) and control-prefixed variants may
    // resolve as harmless relative URLs, but they must never carry a literal
    // executable scheme.
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
    // Dropped link/image labels survive as plain text (the drop is of the
    // executable element, not the text).
    const body = await page.locator('body').innerText();
    for (const label of ['xss link', 'xss proto-rel', 'xss backslash', 'xss js-case', 'xss js-pct', 'xss ctrl', 'xss pct', 'xss svg']) {
      expect(body, `label "${label}" should survive as text`).toContain(label);
    }
  });

  test('lazy-loads subsequent pages when scrolling', async ({ page, request }) => {
    const { token } = await createShare(request, { messageCount: 120 });
    await page.goto(`/chats/${token}`);
    // The first page renders 50 messages (25 user + 25 assistant).
    // User messages render synchronously; assistant messages render
    // asynchronously (via Shiki, which is slow in the E2E environment).
    // Assert on user messages (which render synchronously) to verify
    // lazy loading without depending on the assistant-message render.
    // Message 49 is the last user message on the first page (i=48, even).
    await expect(page.getByText('Message 49', { exact: true })).toBeVisible({ timeout: 15000 });
    // Message 51 is the first user message on the second page (i=50, even).
    // It should NOT be in the DOM yet (lazy loading).
    await expect(page.getByText('Message 51', { exact: true })).toHaveCount(0);

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    // Message 99 is a user message on the second page (i=98, even).
    await expect(page.getByText('Message 99', { exact: true })).toBeVisible({ timeout: 15000 });

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    // Message 119 is a user message on the third page (i=118, even).
    await expect(page.getByText('Message 119', { exact: true })).toBeVisible({ timeout: 15000 });
  });

  test('chunked messages with duplicate seq values keep distinct rail targets', async ({ page, request }) => {
    const { token } = await createChunkedShare(request);
    await page.goto(`/chats/${token}`);
    const earlier = page.locator('#msg-0-1');
    const later = page.locator('#msg-1-1');
    await expect(earlier).toHaveCount(1);
    await expect(later).toHaveCount(1);
    const ticks = page.locator('.rail-tick');
    await expect(ticks).toHaveCount(4);
    await ticks.nth(2).click();
    await expect(later).toHaveClass(/msg-flash/);
    await expect(earlier).not.toHaveClass(/msg-flash/);
  });

  test('password gate: wrong password is rejected, correct one unlocks', async ({ page, request }) => {
    const { token } = await createShare(request, { password: 'correct-horse' });
    await page.goto(`/chats/${token}`);
    await expect(page.getByRole('heading', { name: 'Password required' })).toBeVisible();

    await page.locator('input[type="password"]').fill('wrong');
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.getByText('Wrong password.')).toBeVisible();

    await page.locator('input[type="password"]').fill('correct-horse');
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.getByRole('heading', { name: 'E2E Session' })).toBeVisible();
  });

  test('password unlock lockout: 5 wrong attempts lock the token, even the correct password 429s (Round 9 D4)', async ({ request }) => {
    // A FRESH token so the per-(token, IP) lockout counter starts at zero and
    // no other test's failures bleed in. The per-IP dimension has threshold 5,
    // so the 5th wrong attempt trips the 15-minute lock; the 6th request — even
    // with the CORRECT password — is gated by isLocked() before verifyPassword
    // and returns 429.
    const { token } = await createShare(request, { password: 'correct-horse' });
    for (let i = 0; i < 5; i++) {
      const res = await request.post(`/api/public/chats/${token}/unlock`, {
        data: { password: 'wrong' },
      });
      expect(res.status(), `attempt ${i + 1} should be 401`).toBe(401);
    }
    const locked = await request.post(`/api/public/chats/${token}/unlock`, {
      data: { password: 'correct-horse' },
    });
    expect(locked.status()).toBe(429);
    expect(await locked.json()).toEqual({
      error: { code: 'rate_limited', message: 'Too many failed attempts. Try again in 15 minutes.' },
    });
  });

  test('expired share shows the expired page', async ({ page, request }) => {
    const { token } = await createShare(request, { expiresAt: '2020-01-01T00:00:00.000Z' });
    await page.goto(`/chats/${token}`);
    await expect(page.getByRole('heading', { name: 'This share has expired' })).toBeVisible();
  });

  test('unknown token shows the not-found page', async ({ page }) => {
    await page.goto('/chats/does-not-exist-000000000000');
    await expect(page.getByRole('heading', { name: 'Share not found' })).toBeVisible();
  });

  test('no existence oracle: unknown, revoked, and no-password tokens are byte-identical 404s', async ({ request }) => {
    // The security invariant: an attacker must not be able to distinguish a
    // live-but-passwordless share from a dead (unknown/revoked) one. All three
    // must return the EXACT same status + body on the unlock endpoint.
    const canonical = { status: 404, body: '{"error":{"code":"not_found","message":"Not found"}}' };

    // (a) unknown token
    const unknown = await request.post('/api/public/chats/does-not-exist-000000000000/unlock', {
      data: { password: 'whatever' },
    });
    expect(unknown.status()).toBe(canonical.status);
    expect(await unknown.text()).toBe(canonical.body);

    // (b) revoked token: create then revoke via the owner route.
    const { token: liveToken } = await createShare(request);
    const revoke = await request.delete(`/api/chats/${liveToken}`, {
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(revoke.status()).toBe(200);
    const revoked = await request.post(`/api/public/chats/${liveToken}/unlock`, {
      data: { password: 'whatever' },
    });
    expect(revoked.status()).toBe(canonical.status);
    expect(await revoked.text()).toBe(canonical.body);

    // (c) live share with NO password: unlock must 404 identically (a distinct
    // no_password response would be a liveness oracle).
    const { token: noPwToken } = await createShare(request);
    const noPw = await request.post(`/api/public/chats/${noPwToken}/unlock`, {
      data: { password: 'whatever' },
    });
    expect(noPw.status()).toBe(canonical.status);
    expect(await noPw.text()).toBe(canonical.body);
  });

  test('oversized request body is rejected with a uniform 413 too_large', async ({ request }) => {
    // The 20 MB per-request cap (bodyLimit middleware) fires before any handler.
    // A body just over 20 MB must be rejected with the uniform error body —
    // not a 500, not a partial parse, not a connection reset.
    const over20MB = 'x'.repeat(20 * 1024 * 1024 + 1);
    const res = await request.post('/api/chats', {
      headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
      data: JSON.stringify({ session: { sessionId: 's', title: 't', model: 'm', messages: [{ role: 'user', time: new Date(Date.UTC(2026, 0, 1)).toISOString(), parts: [{ type: 'text', text: over20MB }] }] } }),
    });
    expect(res.status()).toBe(413);
    expect(await res.json()).toEqual({ error: { code: 'too_large', message: 'Request body too large' } });
    // The over-cap 413 leaves the body unconsumed on the socket; the response
    // MUST advertise Connection: close so a pooling client (Playwright's driver
    // shares one keep-alive agent across all APIRequestContexts) never reuses
    // the dirty socket — the reuse is what caused the "socket hang up" flake.
    expect((await res.headers())['connection']).toBe('close');
  });

  test('respects the reader dark mode preference', async ({ browser, request }) => {
    const { token } = await createShare(request);
    const context = await browser.newContext({ colorScheme: 'dark' });
    const page = await context.newPage();
    try {
      await page.goto(`/chats/${token}`);
      await expect(page.getByRole('heading', { name: 'E2E Session' })).toBeVisible();
      // Tailwind v4 emits oklch; the resolved rgb of neutral-950 is near-black.
      // Assert luminance rather than an exact color so the test survives palette tweaks.
      const bg = await page.evaluate(() => {
        const el = document.querySelector('div.min-h-screen');
        return el ? getComputedStyle(el).backgroundColor : null;
      });
      expect(bg, 'themed root element not found').not.toBeNull();
      // Tailwind v4 emits oklch; the resolved color of neutral-950 is near-black.
      // oklch(L C H) where L is lightness (0-1). Assert L < 0.2 (near-black).
      const oklch = bg!.match(/oklch\(([\d.]+)\s/);
      const rgb = bg!.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      let luminance: number;
      if (oklch) {
        luminance = Number(oklch[1]); // oklch lightness (0-1)
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

  test('a two-chunk share renders messages from both chunks in order', async ({ page, request }) => {
    const { token } = await createChunkedShare(request, { perChunk: 3 });
    await page.goto(`/chats/${token}`);
    await expect(page.getByRole('heading', { name: 'Chunked E2E' })).toBeVisible();
    // chunk0 messages render first
    await expect(page.getByText('chunk0 message 1', { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('chunk0 message 3', { exact: true })).toBeVisible();
    // chunk1 messages render after (user messages are even-indexed: chunk1 i=0,2 -> "chunk1 message 1", "chunk1 message 3")
    await expect(page.getByText('chunk1 message 1', { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('chunk1 message 3', { exact: true })).toBeVisible();
  });

  test('a system part renders as a collapsed notice, not a user bubble', async ({ page, request }) => {
    const { token } = await createSystemNoticeShare(request);
    await page.goto(`/chats/${token}`);
    await expect(page.getByRole('heading', { name: 'System Notice Session' })).toBeVisible();
    // The collapsed chip shows the label…
    await expect(page.getByText('goal continuation', { exact: true })).toBeVisible({ timeout: 15000 });
    // …but the block body is hidden until expanded.
    await expect(page.getByText('hidden objective body')).toHaveCount(0);
    // Expanding reveals the body.
    await page.getByRole('button', { name: /goal continuation/ }).click();
    await expect(page.getByText('hidden objective body')).toBeVisible();
  });

  test('a reasoning part renders as a collapsed thinking chip, not raw text', async ({ page, request }) => {
    const { token } = await createReasoningShare(request);
    await page.goto(`/chats/${token}`);
    await expect(page.getByRole('heading', { name: 'Reasoning Session' })).toBeVisible();
    // The collapsed chip shows the "thinking…" label…
    await expect(page.getByRole('button', { name: /thinking/ })).toBeVisible({ timeout: 15000 });
    // …but the reasoning body is hidden until expanded.
    await expect(page.getByText('let me think about this carefully step by step')).toHaveCount(0);
    // The visible text part renders normally.
    await expect(page.getByText('The answer is 4.')).toBeVisible();
    // Expanding reveals the reasoning body.
    await page.getByRole('button', { name: /thinking/ }).click();
    await expect(page.getByText('let me think about this carefully step by step')).toBeVisible();
  });

  test('an image part renders as an <img> with the embedded data URI', async ({ page, request }) => {
    const { token } = await createImageShare(request);
    await page.goto(`/chats/${token}`);
    await expect(page.getByRole('heading', { name: 'Image Session' })).toBeVisible();
    await expect(page.getByText('Here it is.')).toBeVisible();
    const img = page.locator('img.image-part-img');
    await expect(img).toHaveCount(1);
    await expect(img).toHaveAttribute('src', TINY_PNG_DATA_URI);
    await expect(img).toHaveAttribute('alt', 'screenshot');
  });

  test('a tool part with an attached image renders the image inside the tool card', async ({ page, request }) => {
    const { token } = await createToolImageShare(request);
    await page.goto(`/chats/${token}`);
    await expect(page.getByRole('heading', { name: 'Tool Image Session' })).toBeVisible();
    await expect(page.getByText('Here is what the file shows.')).toBeVisible();
    // The tool card is collapsed by default: the image count badge shows, the <img> does not.
    const toolCard = page.locator('div.rounded-lg.border');
    await expect(toolCard).toBeVisible({ timeout: 15000 });
    await expect(toolCard.getByText('1 image')).toBeVisible();
    await expect(page.locator('img.image-part-img')).toHaveCount(0);
    // Expanding the tool card reveals the embedded image.
    await toolCard.getByRole('button').click();
    const img = page.locator('img.image-part-img');
    await expect(img).toHaveCount(1);
    await expect(img).toHaveAttribute('src', TINY_PNG_DATA_URI);
    await expect(img).toHaveAttribute('alt', 'Read image');
  });

  test('the rail cluster stays anchored to the viewport center while scrolling', async ({ page, request }) => {
    const { token } = await createLongShare(request, 60);
    await page.goto(`/chats/${token}`);
    await expect(page.getByRole('heading', { name: 'Long Session' })).toBeVisible();
    const cluster = page.locator('.rail-cluster');
    await expect(cluster).toBeVisible({ timeout: 15000 });
    // The server returns the full user index on the first page, so all 60 ticks
    // render immediately (the messages lazy-load, but the rail is complete).
    await expect(page.locator('.rail-tick')).toHaveCount(60, { timeout: 15000 });
    // Measure the cluster's center relative to the viewport at the top…
    const centerAtTop = await cluster.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.top + r.height / 2;
    });
    // …scroll to the bottom, and the cluster center should still be near the
    // viewport center (sticky anchoring), not scrolled away with the content.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(300);
    const centerAtBottom = await cluster.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.top + r.height / 2;
    });
    const viewportCenter = page.viewportSize()!.height / 2;
    // Tolerance: the cluster is pinned to 50% via top:50% + translateY(-50%),
    // so its center should be within ~40px of the viewport center in both cases.
    expect(Math.abs(centerAtTop - viewportCenter)).toBeLessThan(40);
    expect(Math.abs(centerAtBottom - viewportCenter)).toBeLessThan(40);
  });

  test('the rail cluster scrolls internally when ticks exceed the viewport', async ({ page, request }) => {
    const { token } = await createLongShare(request, 400);
    await page.goto(`/chats/${token}`);
    await expect(page.getByRole('heading', { name: 'Long Session' })).toBeVisible();
    const cluster = page.locator('.rail-cluster');
    await expect(cluster).toBeVisible({ timeout: 20000 });
    // All 400 ticks render immediately from the user index (no lazy-loading of
    // ticks). On a ~720px-tall viewport the budget is calc(100vh - 120px) ≈
    // 600px; 400 × 12px = 4800px, far past the budget, so the cluster is
    // internally scrollable.
    await expect(page.locator('.rail-tick')).toHaveCount(400, { timeout: 20000 });
    const scrollable = await cluster.evaluate((el) => el.scrollHeight > el.clientHeight);
    expect(scrollable).toBe(true);
    // The cluster has the overflow class (scrollbar visible).
    await expect(cluster).toHaveClass(/is-overflowing/);
  });

  test('hovering a rail tick shows a short preview of the user message', async ({ page, request }) => {
    const { token } = await createLongShare(request, 8);
    await page.goto(`/chats/${token}`);
    await expect(page.getByRole('heading', { name: 'Long Session' })).toBeVisible();
    const firstTick = page.locator('.rail-tick').first();
    await expect(firstTick).toBeVisible({ timeout: 15000 });
    // The tooltip is not in the DOM until hover (rendered on mouseenter).
    const tip = page.locator('.rail-tip');
    expect(await tip.count()).toBe(0);
    await firstTick.hover();
    // On hover the tooltip appears and shows the server-provided preview of the
    // first user message.
    await expect(tip).toHaveCount(1);
    await expect(tip).toContainText('User turn number 1: please do something specific and detailed about topic 0.');
  });

  test('a short rail shows no scrollbar (overflow only when ticks exceed the budget)', async ({ page, request }) => {
    const { token } = await createLongShare(request, 8);
    await page.goto(`/chats/${token}`);
    await expect(page.getByRole('heading', { name: 'Long Session' })).toBeVisible();
    await expect(page.locator('.rail-tick')).toHaveCount(8, { timeout: 15000 });
    // The rail toggles the overflow class on a nextTick after the ticks render,
    // so wait for that pass to land before asserting on the class.
    await page.waitForTimeout(200);
    // 8 ticks × 24px = 192px, well under the ~600px budget, so the cluster must
    // NOT be internally scrollable and must not carry the overflow class (which
    // is what turns the scrollbar on).
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
    // 60 user turns = 120 messages. The first page loads 50 messages = 25 user
    // turns, so ticks 26..60 point at messages that are NOT loaded yet.
    const { token } = await createLongShare(request, 60);
    await page.goto(`/chats/${token}`);
    await expect(page.getByRole('heading', { name: 'Long Session' })).toBeVisible();
    const ticks = page.locator('.rail-tick');
    await expect(ticks).toHaveCount(60, { timeout: 15000 });
    // Tick 40 = turn 40 = user seq 79, which is past the first 50 messages.
    const target = page.locator('#msg-0-79');
    expect(await target.count()).toBe(0);
    await ticks.nth(39).click();
    // The click must load pages until seq 79 exists, then scroll it into view.
    await expect(target).toBeVisible({ timeout: 20000 });
    // The jump uses a smooth scroll, and the rail re-targets it once after the
    // lazy-loaded document settles. Give it time to finish before measuring
    // (toBeVisible resolves as soon as the element enters the viewport,
    // mid-scroll).
    await page.waitForTimeout(1300);
    const box = await target.boundingBox();
    expect(box, 'target message not found after lazy load').not.toBeNull();
    const vh = page.viewportSize()!.height;
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeLessThan(vh / 3);
    // The clicked tick is now active.
    await expect(ticks.nth(39)).toHaveClass(/active/);
  });

  test('clicking a rail tick smooth-scrolls to the matching user message', async ({ page, request }) => {
    const { token } = await createLongShare(request, 30);
    await page.goto(`/chats/${token}`);
    await expect(page.getByRole('heading', { name: 'Long Session' })).toBeVisible();
    // All 30 ticks render immediately from the user index.
    const ticks = page.locator('.rail-tick');
    await expect(ticks).toHaveCount(30, { timeout: 15000 });
    // Click the 5th tick (turn 5). The 5th user message should scroll into the
    // top third of the viewport and its tick becomes active.
    await ticks.nth(4).click();
    await page.waitForTimeout(600);
    const target = page.locator('#msg-0-9'); // turn 5 = user seq 9 (user msgs at odd seqs 1,3,5,7,9)
    const box = await target.boundingBox();
    expect(box, 'target message not found').not.toBeNull();
    const vh = page.viewportSize()!.height;
    // The message should be near the top (scroll-margin-top 24px), within the
    // top third of the viewport.
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeLessThan(vh / 3);
    // The 5th tick is now active.
    await expect(ticks.nth(4)).toHaveClass(/active/);
  });

  test('the active rail tick follows the reader as they scroll', async ({ page, request }) => {
    const { token } = await createLongShare(request, 40);
    await page.goto(`/chats/${token}`);
    await expect(page.getByRole('heading', { name: 'Long Session' })).toBeVisible();
    const ticks = page.locator('.rail-tick');
    await expect(ticks).toHaveCount(40, { timeout: 15000 });
    // Wait for the active tick to settle (the rail pins the first tick while the
    // page layout settles after load), then assert it's the first tick.
    await page.waitForFunction(
      () => {
        const first = document.querySelector('.rail-tick');
        return first !== null && first.classList.contains('active');
      },
      undefined,
      { timeout: 5000 },
    );
    // Initially the first tick is active (we're at the top).
    await expect(ticks.nth(0)).toHaveClass(/active/);
    // Scroll down substantially; a later tick should become active.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.5));
    await page.waitForTimeout(500);
    const activeIdx = await ticks.evaluateAll((els) => els.findIndex((el) => el.classList.contains('active')));
    expect(activeIdx).toBeGreaterThan(0);
  });

  test('the rail is usable on a narrow viewport with tappable hit-targets', async ({ page, request }) => {
    const { token } = await createLongShare(request, 12);
    await page.setViewportSize({ width: 375, height: 700 });
    await page.goto(`/chats/${token}`);
    await expect(page.getByRole('heading', { name: 'Long Session' })).toBeVisible();
    const ticks = page.locator('.rail-tick');
    await expect(ticks).toHaveCount(12, { timeout: 15000 });
    // Each tick's hit-target is at least 12px tall (the design requirement).
    const h = await ticks.first().evaluate((el) => el.getBoundingClientRect().height);
    expect(h).toBeGreaterThanOrEqual(12);
    // The rail column is present and narrow.
    const railW = await page.locator('.rail-col').evaluate((el) => el.getBoundingClientRect().width);
    expect(railW).toBeLessThanOrEqual(40);
  });
});
