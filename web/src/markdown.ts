import MarkdownIt from 'markdown-it';
import { createHighlighter, type Highlighter } from 'shiki';
import { isSafeImageSrc } from './lib/imgsrc';

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
// execute it on click. Only explicit http/https/mailto URLs are allowed; local
// paths and all other schemes are stripped, preserving the label.
// Round 5: harden the guard so it no longer depends on markdown-it's normalizeLink
// to neutralize scheme-hiding. The old regex treated any href WITHOUT a matching
// `scheme:` prefix as "relative" — so a C0-control-prefixed `javascript:`
// (e.g. "\u0001javascript:…", which trim() does not strip) fell through to the
// relative branch and was allowed; only markdown-it percent-encoding the control
// char downstream stopped it, and that is third-party behavior this app neither
// controls nor tests. Reject control characters outright, then parse without a
// base so relative destinations cannot become web URLs. Exported for direct
// unit testing of the guard
// (markdown-it normalizes hrefs before the renderer sees them, so the raw
// control-char bypass can only be exercised against the function itself).
export function isSafeHref(href: string): boolean {
  const h = href.trim();
  if (h === '') return false;
  // An allowed URL never contains a control char; its presence can hide a scheme.
  if (/[\u0000-\u001f\u007f-\u009f]/.test(h)) return false;
  let u: URL;
  try {
    u = new URL(h);
  } catch {
    return false;
  }
  return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:';
}

export async function renderMarkdown(text: string): Promise<string> {
  const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
  // Round 9 (D5): markdown-it's built-in data: allowlist (GOOD_DATA_RE =
  // gif|png|jpeg|webp) lacks the `jpg` and `avif` aliases isSafeImageSrc
  // accepts, so ![x](data:image/jpg;base64,…) was parsed with an emptied src
  // and dropped to literal alt text. Accept exactly the data URIs the viewer
  // renders and local file links (so their labels survive without anchors), and
  // delegate everything else to the default. The final gates stay
  // in the renderers — isSafeImageSrc for image tokens, isSafeHref for link
  // tokens (a data: LINK is still dropped, so this opens no link vector).
  const defaultValidate = md.validateLink;
  md.validateLink = (url: string) =>
    /^(?:data:image\/(png|jpeg|jpg|webp|gif|avif);base64,|file:)/i.test(url.trim()) || defaultValidate(url);
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
  // Round 7: track dropped link_open indices so the matching link_close drops
  // too. Without this, the default renderer still emits a stray </a> (no
  // matching <a>) whenever a link is dropped. Links are flat in markdown-it
  // (no nesting), so the matching open is the nearest preceding link_open.
  const droppedLinks = new Set<number>();
  // link_open is NOT in the overridable `rules` record (it's a built-in handled
  // by renderToken), so there is no captured default to delegate to. When the
  // href is safe, delegate to slf.renderToken (the built-in renderer) which
  // emits the normal <a href> tag. When unsafe, drop the link entirely.
  md.renderer.rules.link_open = (tokens, idx, options, _env, slf) => {
    const token = tokens[idx]!;
    const href = token.attrGet('href') ?? '';
    if (typeof href !== 'string' || !isSafeHref(href)) {
      // Drop the link entirely: render the label as plain text (no <a>).
      droppedLinks.add(idx);
      return '';
    }
    return slf.renderToken(tokens, idx, options);
  };
  // link_close mirrors link_open: when the matching open was dropped, the
  // default renderer would emit a stray </a> with no opening tag — drop it too.
  md.renderer.rules.link_close = (tokens, idx, options, _env, slf) => {
    for (let i = idx - 1; i >= 0; i--) {
      if (tokens[i]!.type === 'link_open') {
        if (droppedLinks.has(i)) {
          droppedLinks.delete(i);
          return '';
        }
        break; // matched a kept link_open — emit the normal </a>
      }
    }
    return slf.renderToken(tokens, idx, options);
  };
  // Round 7: markdown image destinations were not viewer-sanitized — only the
  // CSP img-src header stopped an external ![x](https://evil/t.png) beacon.
  // Mirror isSafeImageSrc in the renderer so the viewer is safe without relying
  // on the header: only data: images (the embedded session images) and
  // same-origin /assets/ are kept; anything else is dropped, with the alt text
  // kept as plain text (mirroring the dropped-link behavior).
  const defaultImage = md.renderer.rules.image!;
  md.renderer.rules.image = (tokens, idx, options, env) => {
    const token = tokens[idx]!;
    const src = token.attrGet('src') ?? '';
    if (typeof src !== 'string' || !isSafeImageSrc(src)) {
      return md.utils.escapeHtml(token.content);
    }
    return defaultImage(tokens, idx, options, env, md.renderer);
  };
  return md.render(text);
}
