import MarkdownIt from 'markdown-it';
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
  return md.render(text);
}
