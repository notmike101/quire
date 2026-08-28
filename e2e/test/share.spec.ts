import { test, expect } from '@playwright/test';
import { createShare, createChunkedShare, createSystemNoticeShare, createReasoningShare, createImageShare, createToolImageShare, TINY_PNG_DATA_URI, OPENAI_KEY } from './helpers';

test.describe('share viewer', () => {
  test('renders the first page and redacts secrets server-side', async ({ page, request }) => {
    const { token } = await createShare(request, { secret: true });
    await page.goto(`/chats/${token}`);
    await expect(page.getByRole('heading', { name: 'E2E Session' })).toBeVisible();
    await expect(page.getByText('test-model')).toBeVisible();
    await expect(page.getByText(/redacted/)).toBeVisible();
    await expect(page.getByText('Use this key: [REDACTED:openai-key] for the API')).toBeVisible();
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
});
