import { describe, it, expect } from 'vitest';
import { isSafeHref, renderMarkdown } from '../src/markdown';

describe('Markdown file links', () => {
  it.each([
    'src/main.ts', './src/main.ts', '../README.md', '/src/main.ts',
    '/a//b', '#section', '?file=README.md', '~/README.md',
    'C:/repo/main.ts', 'C:\\repo\\main.ts', 'C:main.ts',
    '\\\\server\\share\\main.ts', '//example.com/main.ts',
    'file:///C:/repo/main.ts', 'vscode://file/C:/repo/main.ts',
    'vscode-insiders://file/C:/repo/main.ts', 'cursor://file/C:/repo/main.ts',
    'javascript:alert(1)', 'data:text/html,hello', 'ftp://example.com/main.ts',
    '', 'https://',
  ])('rejects non-web destination %j', (href) => {
    expect(isSafeHref(href)).toBe(false);
  });

  it.each([
    '\u0001https://example.com', 'https://exam\tple.com',
    'https://example.com/\u007fsource', 'mailto:x@exam\u0085ple.com',
  ])('rejects control characters in %j', (href) => {
    expect(isSafeHref(href)).toBe(false);
  });

  it.each([
    'http://example.com/source', 'https://example.com/source#section',
    'HTTPS://example.com/source', 'mailto:reader@example.com',
  ])('keeps explicit web/email destination %j', (href) => {
    expect(isSafeHref(href)).toBe(true);
  });

  it.each([
    'src/main.ts', './src/main.ts', '../README.md', '/src/main.ts',
    '#section', 'C:/repo/main.ts', 'file:///C:/repo/main.ts',
    'vscode://file/C:/repo/main.ts', '//example.com/main.ts',
  ])('renders local destination %j as its label without anchor tags', async (href) => {
    expect(await renderMarkdown(`[source](${href})`)).toBe('<p>source</p>\n');
    expect(await renderMarkdown(`[\`source.ts\`](${href})`)).toBe('<p><code>source.ts</code></p>\n');
  });

  it('keeps complete web/email anchors alongside dropped local links', async () => {
    const html = await renderMarkdown(
      '[source](src/main.ts) [web](https://example.com) [email](mailto:reader@example.com) [local](/README.md)',
    );
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('href="mailto:reader@example.com"');
    expect(html.match(/<a /g) ?? []).toHaveLength(2);
    expect(html.match(/<\/a>/g) ?? []).toHaveLength(2);
    expect(html).toContain('source');
    expect(html).toContain('local');
  });
});
