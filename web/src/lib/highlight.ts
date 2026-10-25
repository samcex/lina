// highlight.js core + a curated set of languages (keeps the bundle small).
import hljs from 'highlight.js/lib/core';
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import shell from 'highlight.js/lib/languages/shell';
import python from 'highlight.js/lib/languages/python';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import markdown from 'highlight.js/lib/languages/markdown';
import yaml from 'highlight.js/lib/languages/yaml';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import ini from 'highlight.js/lib/languages/ini';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import plaintext from 'highlight.js/lib/languages/plaintext';

const langs = { typescript, javascript, json, bash, shell, python, css, xml, markdown, yaml, diff, go, rust, sql, ini, dockerfile, plaintext };
for (const [name, fn] of Object.entries(langs)) hljs.registerLanguage(name, fn);
hljs.registerAliases(['ts', 'tsx', 'mts'], { languageName: 'typescript' });
hljs.registerAliases(['js', 'jsx', 'mjs', 'cjs'], { languageName: 'javascript' });
hljs.registerAliases(['sh', 'zsh', 'console'], { languageName: 'bash' });
hljs.registerAliases(['html', 'svg', 'vue'], { languageName: 'xml' });
hljs.registerAliases(['yml'], { languageName: 'yaml' });
hljs.registerAliases(['py'], { languageName: 'python' });
hljs.registerAliases(['rs'], { languageName: 'rust' });
hljs.registerAliases(['toml'], { languageName: 'ini' });
hljs.registerAliases(['patch'], { languageName: 'diff' });
hljs.registerAliases(['text', 'txt', 'lina-review', 'lina-response'], { languageName: 'plaintext' });

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function knownLang(lang?: string): string | undefined {
  if (!lang) return undefined;
  const l = lang.toLowerCase();
  return hljs.getLanguage(l) ? l : undefined;
}

/** Returns highlighted HTML (escaped). Falls back to plain escaping. */
export function highlight(code: string, lang?: string): string {
  const l = knownLang(lang);
  if (!l || l === 'plaintext') return escapeHtml(code);
  try { return hljs.highlight(code, { language: l, ignoreIllegals: true }).value; } catch { return escapeHtml(code); }
}

/**
 * Highlights a whole file and splits it into per-line HTML, closing/reopening
 * spans at line breaks so multi-line tokens (comments, strings) stay correct.
 */
export function highlightLines(code: string, lang?: string): string[] {
  const html = highlight(code, lang);
  const out: string[] = [];
  const open: string[] = [];
  let line = '';
  const re = /(<span[^>]*>)|(<\/span>)|(\n)|([^<\n]+|<)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[1]) { open.push(m[1]); line += m[1]; }
    else if (m[2]) { open.pop(); line += m[2]; }
    else if (m[3]) { out.push(line + '</span>'.repeat(open.length)); line = open.join(''); }
    else line += m[4];
  }
  out.push(line + '</span>'.repeat(open.length));
  return out;
}
