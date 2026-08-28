import { test, expect } from '@playwright/test';
import { createShare, createChunkedShare, createSystemNoticeShare, createReasoningShare, createImageShare, createToolImageShare, createLongShare, TINY_PNG_DATA_URI, OPENAI_KEY } from './helpers';

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

  test('expired share shows the expired page', async ({ page, request }) => {
    const { token } = await createShare(request, { expiresAt: '2020-01-01T00:00:00.000Z' });
    await page.goto(`/chats/${token}`);
    await expect(page.getByRole('heading', { name: 'This share has expired' })).toBeVisible();
  });

  test('unknown token shows the not-found page', async ({ page }) => {
    await page.goto('/chats/does-not-exist-000000000000');
    await expect(page.getByRole('heading', { name: 'Share not found' })).toBeVisible();
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
    // 60 user turns -> 60 ticks (first page loads 50 messages = 25 user turns;
    // the rest lazy-load, but the cluster is present from the first page).
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

  test('the rail cluster scrolls internally and shows the overflow bar when ticks exceed the viewport', async ({ page, request }) => {
    const { token } = await createLongShare(request, 400);
    await page.goto(`/chats/${token}`);
    await expect(page.getByRole('heading', { name: 'Long Session' })).toBeVisible();
    const cluster = page.locator('.rail-cluster');
    await expect(cluster).toBeVisible({ timeout: 20000 });
    // The first page loads 50 messages = 25 user turns = 25 ticks. On a
    // ~720px-tall viewport the budget is calc(100vh - 120px) ≈ 600px; 25 ticks
    // × 24px = 600px, right at the edge. Scroll the page to lazy-load more
    // pages so the tick count grows well past the budget.
    for (let i = 0; i < 6; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(400);
    }
    // Now the cluster is scrollable (scrollHeight > clientHeight).
    const scrollable = await cluster.evaluate((el) => el.scrollHeight > el.clientHeight);
    expect(scrollable).toBe(true);
    // The "more below" overflow bar is visible.
    const belowBar = page.locator('.rail-overflow.bottom');
    await expect(belowBar).toBeVisible();
    // Clicking it scrolls the cluster down.
    const before = await cluster.evaluate((el) => el.scrollTop);
    await belowBar.click();
    await page.waitForTimeout(400);
    const after = await cluster.evaluate((el) => el.scrollTop);
    expect(after).toBeGreaterThan(before);
  });

  test('hovering a rail tick shows a short preview of the user message', async ({ page, request }) => {
    const { token } = await createLongShare(request, 8);
    await page.goto(`/chats/${token}`);
    await expect(page.getByRole('heading', { name: 'Long Session' })).toBeVisible();
    const firstTick = page.locator('.rail-tick').first();
    await expect(firstTick).toBeVisible({ timeout: 15000 });
    // The tooltip is hidden until hover.
    const tip = page.locator('.rail-tip').first();
    expect(await tip.evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
    await firstTick.hover();
    // On hover the tooltip becomes visible and shows the message preview.
    await expect(tip).toHaveCSS('opacity', '1');
    await expect(tip).toContainText('User turn number 1');
  });

  test('clicking a rail tick smooth-scrolls to the matching user message', async ({ page, request }) => {
    const { token } = await createLongShare(request, 30);
    await page.goto(`/chats/${token}`);
    await expect(page.getByRole('heading', { name: 'Long Session' })).toBeVisible();
    // Wait for the first page (25 user turns) to render ticks.
    const ticks = page.locator('.rail-tick');
    await expect(ticks.first()).toBeVisible({ timeout: 15000 });
    // Click the 5th tick (turn 5). The 5th user message should scroll into the
    // top third of the viewport and its tick becomes active.
    await ticks.nth(4).click();
    await page.waitForTimeout(600);
    const target = page.locator('#msg-9'); // turn 5 = user seq 9 (user msgs at odd seqs 1,3,5,7,9)
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
    await expect(ticks.first()).toBeVisible({ timeout: 15000 });
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
    await expect(ticks.first()).toBeVisible({ timeout: 15000 });
    // Each tick's hit-target is at least 24px tall (the design requirement).
    const h = await ticks.first().evaluate((el) => el.getBoundingClientRect().height);
    expect(h).toBeGreaterThanOrEqual(24);
    // The rail column is present and narrow.
    const railW = await page.locator('.rail-col').evaluate((el) => el.getBoundingClientRect().width);
    expect(railW).toBeLessThanOrEqual(40);
  });
});
