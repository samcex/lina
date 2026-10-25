// Markdown → sanitized HTML. marked for parsing, highlight.js for code, DOMPurify for safety.
import { Marked, type Tokens } from 'marked';
import DOMPurify from 'dompurify';
import { escapeHtml, highlight, knownLang } from './highlight';

const FILE_REF = /^((?:[\w.@-]+\/)*[\w.@-]+\.[a-z0-9]{1,8})(?::(\d+))?$/i;

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }: Tokens.Code) {
      const raw = (lang ?? '').trim().split(/\s+/)[0] ?? '';
      const label = raw || 'text';
      const body = highlight(text.replace(/\n$/, ''), knownLang(raw) ? raw : undefined);
      return (
        `<div class="code-block" data-lang="${escapeHtml(label)}">` +
        `<div class="code-head"><span class="code-lang">${escapeHtml(label)}</span>` +
        `<button type="button" class="code-copy" data-copy aria-label="Copy code">Copy</button></div>` +
        `<pre><code class="hljs">${body}</code></pre></div>`
      );
    },
    codespan({ text }: Tokens.Codespan) {
      const decoded = text; // marked 18 passes codespan text raw (unescaped)
      const m = decoded.match(FILE_REF);
      if (m && m[1].includes('/')) {
        return `<code class="file-ref" data-file="${escapeHtml(m[1])}"${m[2] ? ` data-line="${m[2]}"` : ''} tabindex="0" role="link">${escapeHtml(decoded)}</code>`;
      }
      // Escape so `<!-- x -->` or `<div>` stay visible text instead of becoming markup.
      return `<code>${escapeHtml(decoded)}</code>`;
    },
  },
});

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

const cache = new Map<string, string>();

export function renderMarkdown(src: string, opts: { cache?: boolean } = {}): string {
  if (opts.cache !== false) {
    const hit = cache.get(src);
    if (hit !== undefined) return hit;
  }
  let html: string;
  try {
    html = marked.parse(src, { async: false }) as string;
  } catch {
    html = `<p>${escapeHtml(src)}</p>`;
  }
  const clean = DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'data-copy', 'data-file', 'data-line', 'data-lang'] });
  if (opts.cache !== false) {
    if (cache.size > 400) cache.clear();
    cache.set(src, clean);
  }
  return clean;
}
