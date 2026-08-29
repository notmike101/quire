import MarkdownIt from 'markdown-it';
import type { Token, RendererRule } from 'markdown-it';
import { createHighlighter, type Highlighter } from 'shiki';

const LANGS = [
  'typescript', 'javascript', 'python', 'bash', 'json', 'yaml', 'sql',
  'rust', 'go', 'java', 'c', 'cpp', 'html', 'css', 'markdown', 'diff', 'plaintext',
] as const;

let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= createHighlighter({ themes: ['github-light', 'github-dark'], langs: [...LANGS] });
  return highlighterPromise;
}

/**
 * Render session markdown. Raw HTML in the source is never rendered
 * (html: false); fenced code blocks are highlighted with Shiki's dual
 * theme — the output uses CSS variables that style.css switches on
 * prefers-color-scheme.
 */
// Round 4: markdown-it emits an explicit `[x](javascript:…)` link as a clickable
// <a href> (html:false only blocks raw HTML, not markdown links). A malicious
// session owner could craft a transcript with such a link and the reader would
// execute it on click. Only http/https/mailto/relative URLs are allowed; any
// other scheme (javascript:, data:, vbscript:, file:) is stripped.
function isSafeHref(href: string): boolean {
  const h = href.trim().toLowerCase();
  if (h === '') return false;
  if (/^(https?:|mailto:)/.test(h)) return true;
  // Relative URLs (no scheme): /path, ./path, ../path, ?query, #fragment.
  if (!/^[a-z][a-z0-9+.-]*:/.test(h)) return true;
  return false;
}

export async function renderMarkdown(text: string): Promise<string> {
  const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
  const defaultFence = md.renderer.rules.fence!;
  const hl = await getHighlighter();
  const loaded = hl.getLoadedLanguages();
  md.renderer.rules.fence = (tokens, idx, options, env) => {
    const token = tokens[idx]!;
    const lang = token.info.trim().split(/\s+/)[0] || 'plaintext';
    const safeLang = loaded.includes(lang) ? lang : 'plaintext';
    try {
      return hl.codeToHtml(token.content, {
        lang: safeLang,
        themes: { light: 'github-light', dark: 'github-dark' },
      });
    } catch {
      return defaultFence(tokens, idx, options, env, md.renderer);
    }
  };
  // link_open is NOT in the overridable `rules` record (it's a built-in handled
  // by renderToken), so there is no captured default to delegate to. When the
  // href is safe, delegate to slf.renderToken (the built-in renderer) which
  // emits the normal <a href> tag. When unsafe, drop the link entirely.
  md.renderer.rules.link_open = (
    tokens: Token[],
    idx: number,
    options: object,
    _env: unknown,
    slf: { renderToken: (tokens: Token[], idx: number, options: object) => string },
  ): string => {
    const token = tokens[idx]!;
    const href = token.attrGet('href') ?? '';
    if (!isSafeHref(href)) {
      // Drop the link entirely: render the label as plain text (no <a>).
      return '';
    }
    return slf.renderToken(tokens, idx, options);
  };
  return md.render(text);
}
