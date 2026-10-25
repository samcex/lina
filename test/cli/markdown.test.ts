import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getColorLevel, setColorLevel, strWidth, stripAnsi, truncateAnsi, wrapAnsi, fg, bold } from '../../src/cli/ansi.js';
import { hljsHtmlToAnsi, highlightCode, renderMarkdown } from '../../src/cli/markdown.js';

let prev: ReturnType<typeof getColorLevel>;
beforeAll(() => { prev = getColorLevel(); setColorLevel(3); });
afterAll(() => setColorLevel(prev));

describe('ansi helpers', () => {
  it('measures width ignoring escapes and counting wide chars', () => {
    expect(strWidth(fg('#ff0000')('abc'))).toBe(3);
    expect(strWidth('日本')).toBe(4);
    expect(strWidth('é')).toBe(1);
  });
  it('wraps words, hard-splits long words, and carries styles across lines', () => {
    const lines = wrapAnsi(bold('hello world foo'), 11);
    expect(lines.map(stripAnsi)).toEqual(['hello world', 'foo']);
    expect(lines[1].startsWith('\x1b[1m')).toBe(true); // bold re-opened
    expect(wrapAnsi('abcdefghij', 4).map(stripAnsi)).toEqual(['abcd', 'efgh', 'ij']);
    expect(wrapAnsi('a\n\nb', 10)).toEqual(['a', '', 'b']);
    for (const l of wrapAnsi('The quick brown fox jumps over the lazy dog '.repeat(5), 17)) expect(strWidth(l)).toBeLessThanOrEqual(17);
  });
  it('truncates with an ellipsis', () => {
    expect(stripAnsi(truncateAnsi(fg('#00ff00')('abcdefgh'), 5))).toBe('abcd…');
    expect(truncateAnsi('abc', 5)).toBe('abc');
  });
  it('degrades to plain text with no color support', () => {
    setColorLevel(0);
    expect(fg('#ff0000')('x')).toBe('x');
    setColorLevel(2);
    expect(fg('#ff0000')('x')).toContain('38;5;');
    setColorLevel(1);
    expect(fg('#ff0000')('x')).toMatch(/\x1b\[9\dm/);
    setColorLevel(3);
  });
});

describe('renderMarkdown', () => {
  it('renders headings, emphasis, inline code, lists and links', () => {
    const out = renderMarkdown('# Title\n\nSome **bold** and `code` and [link](http://x.dev).\n\n- one\n- two\n  1. nested\n- [x] done', 60);
    const plain = out.map(stripAnsi);
    expect(plain[0]).toBe('Title');
    expect(plain).toContain('Some bold and code and link (http://x.dev).');
    expect(plain).toContain('• one');
    expect(plain).toContain('  1. nested');
    expect(plain.some((l) => l.includes('☑ done'))).toBe(true);
    expect(out.join('\n')).toContain('\x1b[1m'); // bold
  });
  it('renders fenced code with a gutter and syntax colors', () => {
    const out = renderMarkdown('```ts\nconst x: number = 1; // hi\n```', 60);
    const plain = out.map(stripAnsi);
    expect(plain[0]).toBe('╭─ ts');
    expect(plain[1]).toBe('│ const x: number = 1; // hi');
    expect(plain[2]).toBe('╰─');
    expect(out[1]).toMatch(/\x1b\[38;2;/);
  });
  it('wraps to width and never throws on odd input', () => {
    for (const l of renderMarkdown('word '.repeat(80), 30)) expect(strWidth(l)).toBeLessThanOrEqual(30);
    expect(() => renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n\n> quote\n\n---\n\n<div>x</div>', 40)).not.toThrow();
    expect(renderMarkdown('', 40)).toEqual([]);
  });
  it('maps hljs html (multi-line spans, entities) to ANSI lines', () => {
    const lines = hljsHtmlToAnsi('<span class="hljs-comment">/* a\nb */</span> x &lt; y &amp;&amp; z');
    expect(lines.map(stripAnsi)).toEqual(['/* a', 'b */ x < y && z']);
    expect(highlightCode('plain', 'nolang').map(stripAnsi)).toEqual(['plain']);
  });
});
