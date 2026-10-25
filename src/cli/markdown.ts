// Light markdown → ANSI renderer for the terminal transcript.
// Uses marked's lexer (no HTML) and highlight.js for fenced code blocks.
import { marked, type Token, type Tokens } from 'marked';
import hljs from 'highlight.js/lib/common';
import { C } from './theme.js';
import { bg, bold, dim, fg, italic, strike, strWidth, truncateAnsi, underline, wrapAnsi, padAnsi } from './ansi.js';

// ── syntax highlighting ─────────────────────────────────────────────────────
const HL: Record<string, (s: string) => string> = {
  keyword: fg('#C084FC'), 'selector-tag': fg('#C084FC'), doctag: fg('#C084FC'),
  string: fg('#86EFAC'), 'template-tag': fg('#86EFAC'), 'template-variable': fg('#FDE68A'),
  number: fg('#FDBA74'), literal: fg('#F9A8D4'), symbol: fg('#F9A8D4'),
  comment: (s) => italic(fg('#71717A')(s)), quote: (s) => italic(fg('#71717A')(s)),
  title: fg('#67E8F9'), section: (s) => bold(fg(C.lina)(s)),
  built_in: fg('#5EEAD4'), type: fg('#5EEAD4'), class: fg('#5EEAD4'),
  attr: fg('#93C5FD'), attribute: fg('#93C5FD'), property: fg('#93C5FD'), 'selector-attr': fg('#93C5FD'),
  'selector-class': fg('#93C5FD'), 'selector-id': fg('#93C5FD'), 'selector-pseudo': fg('#93C5FD'),
  variable: fg('#FDE68A'), params: fg('#E4E4E7'), meta: fg('#A1A1AA'), 'meta-keyword': fg('#C084FC'),
  regexp: fg('#FCA5A5'), tag: fg('#F472B6'), name: fg('#F472B6'), bullet: fg('#FDBA74'),
  addition: fg(C.ok), deletion: fg(C.err), emphasis: italic, strong: bold, link: underline,
};

function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#x27|#39|#x2F);/g, (_, e: string) =>
    ({ amp: '&', lt: '<', gt: '>', quot: '"', '#x27': "'", '#39': "'", '#x2F': '/' })[e] ?? _);
}

/** Converts highlight.js HTML output to an array of ANSI lines. */
export function hljsHtmlToAnsi(html: string): string[] {
  const lines: string[] = [''];
  const stack: ((s: string) => string)[] = [];
  const re = /<span class="([^"]+)">|<\/span>|([^<]+)|(<)/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[1] !== undefined) {
      const cls = m[1].split(/\s+/).map((c) => c.replace(/^hljs-/, '')).find((c) => HL[c]);
      const style = cls ? HL[cls] : stack[stack.length - 1];
      stack.push(style ?? ((s: string) => s));
    } else if (m[0] === '</span>') stack.pop();
    else {
      const text = decodeEntities(m[2] ?? m[3] ?? '');
      const style = stack[stack.length - 1] ?? ((s: string) => s);
      const parts = text.split('\n');
      parts.forEach((p, i) => {
        if (i > 0) lines.push('');
        if (p) lines[lines.length - 1] += style(p);
      });
    }
  }
  return lines;
}

const LANG_ALIAS: Record<string, string> = { sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', rb: 'ruby', yml: 'yaml', html: 'xml', md: 'markdown', rs: 'rust', golang: 'go', patch: 'diff' };

export function highlightCode(code: string, lang?: string): string[] {
  const l = (lang ?? '').trim().toLowerCase().split(/\s/)[0];
  const name = LANG_ALIAS[l] ?? l;
  if (name && hljs.getLanguage(name)) {
    try { return hljsHtmlToAnsi(hljs.highlight(code, { language: name, ignoreIllegals: true }).value); } catch { /* fall through */ }
  }
  return code.split('\n').map((x) => fg('#D4D4D8')(x));
}

// ── inline ──────────────────────────────────────────────────────────────────
const codeSpan = (s: string) => bg('#2A2733')(fg(C.codeFg)(s));

function inline(tokens: Token[] | undefined): string {
  if (!tokens) return '';
  let out = '';
  for (const t of tokens) {
    switch (t.type) {
      case 'text': out += (t as Tokens.Text).tokens ? inline((t as Tokens.Text).tokens) : (t as Tokens.Text).text; break;
      case 'strong': out += bold(inline((t as Tokens.Strong).tokens)); break;
      case 'em': out += italic(inline((t as Tokens.Em).tokens)); break;
      case 'del': out += strike(inline((t as Tokens.Del).tokens)); break;
      case 'codespan': out += codeSpan((t as Tokens.Codespan).text); break;
      case 'br': out += '\n'; break;
      case 'link': {
        const l = t as Tokens.Link;
        const label = inline(l.tokens) || l.href;
        out += underline(fg(C.info)(label)) + (l.href && l.href !== l.text && !l.href.startsWith('mailto:') ? dim(` (${l.href})`) : '');
        break;
      }
      case 'image': out += dim(`[image: ${(t as Tokens.Image).text || (t as Tokens.Image).href}]`); break;
      case 'escape': out += (t as Tokens.Escape).text; break;
      case 'html': out += dim((t as Tokens.HTML).text); break;
      case 'checkbox': break;
      default: out += 'text' in t && typeof t.text === 'string' ? t.text : (t.raw ?? '');
    }
  }
  return out;
}

// ── blocks ──────────────────────────────────────────────────────────────────
function prefixLines(lines: string[], first: string, rest: string): string[] {
  return lines.map((l, i) => (i === 0 ? first : rest) + l);
}

function codeBlock(text: string, lang: string | undefined, width: number): string[] {
  const gutter = fg(C.faint)('│ ');
  const inner = Math.max(8, width - 2);
  const out: string[] = [fg(C.faint)('╭─') + (lang ? ' ' + dim(lang) : '')];
  for (const line of highlightCode(text.replace(/\n$/, ''), lang)) {
    const wrapped = strWidth(line) <= inner ? [line] : wrapAnsi(line, inner);
    for (const w of wrapped) out.push(gutter + w);
  }
  out.push(fg(C.faint)('╰─'));
  return out;
}

function table(t: Tokens.Table, width: number): string[] {
  const head = t.header.map((c) => inline(c.tokens));
  const rows = t.rows.map((r) => r.map((c) => inline(c.tokens)));
  const n = head.length;
  const widths = head.map((h, i) => Math.max(strWidth(h), ...rows.map((r) => strWidth(r[i] ?? ''))));
  const sep = 3;
  const budget = Math.max(n * 4, width - sep * (n - 1));
  let total = widths.reduce((a, b) => a + b, 0);
  while (total > budget) {
    const i = widths.indexOf(Math.max(...widths));
    widths[i]--; total--;
  }
  const fmt = (cells: string[]) => cells.map((c, i) => padAnsi(truncateAnsi(c ?? '', widths[i]), widths[i])).join(fg(C.faint)(' │ '));
  return [bold(fmt(head)), fg(C.faint)(widths.map((w) => '─'.repeat(w)).join('─┼─')), ...rows.map(fmt)];
}

function blocks(tokens: Token[], width: number, depth = 0): string[] {
  const out: string[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case 'space': if (out.length && out[out.length - 1] !== '') out.push(''); break;
      case 'heading': {
        const h = t as Tokens.Heading;
        const text = inline(h.tokens);
        const styled = h.depth === 1 ? bold(fg(C.lina)(text)) : h.depth === 2 ? bold(fg(C.linaSoft)(text)) : bold(text);
        out.push(...wrapAnsi(styled, width));
        break;
      }
      case 'paragraph': out.push(...wrapAnsi(inline((t as Tokens.Paragraph).tokens), width)); break;
      case 'text': {
        const tt = t as Tokens.Text;
        out.push(...wrapAnsi(tt.tokens ? inline(tt.tokens) : tt.text, width));
        break;
      }
      case 'code': out.push(...codeBlock((t as Tokens.Code).text, (t as Tokens.Code).lang, width)); break;
      case 'blockquote':
        out.push(...blocks((t as Tokens.Blockquote).tokens, width - 2, depth).map((l) => fg(C.faint)('▎ ') + italic(l)));
        break;
      case 'hr': out.push(fg(C.faint)('─'.repeat(Math.min(width, 48)))); break;
      case 'list': {
        const l = t as Tokens.List;
        const start = typeof l.start === 'number' ? l.start : 1;
        l.items.forEach((item, i) => {
          let bullet = l.ordered ? `${start + i}.` : depth % 2 === 0 ? '•' : '◦';
          if (item.task) bullet = item.checked ? fg(C.ok)('☑') : fg(C.muted)('☐');
          else bullet = l.ordered ? fg(C.muted)(bullet) : fg(C.lina)(bullet);
          const bw = strWidth(bullet) + 1;
          const body = blocks(item.tokens.filter((x) => x.type !== 'checkbox'), width - bw, depth + 1);
          if (!body.length) body.push('');
          out.push(...prefixLines(body, bullet + ' ', ' '.repeat(bw)));
        });
        break;
      }
      case 'table': out.push(...table(t as Tokens.Table, width)); break;
      case 'html': out.push(...wrapAnsi(dim((t as Tokens.HTML).text.trimEnd()), width)); break;
      case 'def': break;
      default: if (t.raw) out.push(...wrapAnsi(t.raw.trimEnd(), width));
    }
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

/** Renders markdown to an array of ANSI lines no wider than `width` cells. Never throws. */
export function renderMarkdown(src: string, width: number): string[] {
  width = Math.max(10, width);
  try {
    return blocks(marked.lexer(src ?? ''), width);
  } catch {
    return wrapAnsi(src ?? '', width);
  }
}
