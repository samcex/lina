// Minimal, dependency-free ANSI toolkit: truecolor with graceful degradation,
// display-width measurement, ANSI-aware wrapping and truncation.

export type ColorLevel = 0 | 1 | 2 | 3; // none | 16 | 256 | truecolor

export function detectColorLevel(env: NodeJS.ProcessEnv = process.env, isTTY = !!process.stdout?.isTTY): ColorLevel {
  if ('NO_COLOR' in env && env.NO_COLOR !== '') return 0;
  const force = env.FORCE_COLOR;
  if (force !== undefined) {
    if (force === '0' || force === 'false') return 0;
    if (force === '1' || force === '' || force === 'true') return Math.max(1, guessLevel(env)) as ColorLevel;
    const n = Number(force);
    if (n >= 1 && n <= 3) return n as ColorLevel;
  }
  if (!isTTY) return 0;
  return guessLevel(env);
}

function guessLevel(env: NodeJS.ProcessEnv): ColorLevel {
  if (env.TERM === 'dumb') return 0;
  const ct = (env.COLORTERM ?? '').toLowerCase();
  if (ct === 'truecolor' || ct === '24bit') return 3;
  const term = (env.TERM ?? '').toLowerCase();
  if (env.TERM_PROGRAM === 'iTerm.app' || env.TERM_PROGRAM === 'WezTerm' || env.TERM_PROGRAM === 'vscode') return 3;
  if (term.includes('truecolor') || term.includes('direct') || term.startsWith('xterm-kitty') || term.includes('alacritty')) return 3;
  if (term.includes('256')) return 2;
  return 1;
}

let level: ColorLevel = detectColorLevel();
export function setColorLevel(l: ColorLevel) { level = l; }
export function getColorLevel(): ColorLevel { return level; }

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbTo256(r: number, g: number, b: number): number {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  const q = (v: number) => Math.round((v / 255) * 5);
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

function rgbTo16(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  if (max < 50) return 30;
  const bright = max > 170 ? 60 : 0;
  const code = (Math.round(b / 255) << 2) | (Math.round(g / 255) << 1) | Math.round(r / 255);
  return 30 + code + bright;
}

function colorSeq(hex: string, isBg: boolean): string {
  if (level === 0) return '';
  const [r, g, b] = hexToRgb(hex);
  if (level === 3) return `\x1b[${isBg ? 48 : 38};2;${r};${g};${b}m`;
  if (level === 2) return `\x1b[${isBg ? 48 : 38};5;${rgbTo256(r, g, b)}m`;
  const c = rgbTo16(r, g, b);
  return `\x1b[${isBg ? c + 10 : c}m`;
}

const wrapSgr = (open: string, close: string) => (s: string) => (level === 0 || !open ? s : open + s + close);

export const fg = (hex: string) => (s: string) => (level === 0 ? s : colorSeq(hex, false) + s + '\x1b[39m');
export const bg = (hex: string) => (s: string) => (level === 0 ? s : colorSeq(hex, true) + s + '\x1b[49m');
export const bold = (s: string) => wrapSgr('\x1b[1m', '\x1b[22m')(s);
export const dim = (s: string) => wrapSgr('\x1b[2m', '\x1b[22m')(s);
export const italic = (s: string) => wrapSgr('\x1b[3m', '\x1b[23m')(s);
export const underline = (s: string) => wrapSgr('\x1b[4m', '\x1b[24m')(s);
export const inverse = (s: string) => wrapSgr('\x1b[7m', '\x1b[27m')(s);
export const strike = (s: string) => wrapSgr('\x1b[9m', '\x1b[29m')(s);

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;:?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
export function stripAnsi(s: string): string { return s.replace(ANSI_RE, ''); }

/** Terminal cell width of one code point. */
export function charWidth(cp: number): number {
  if (cp === 0 || cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  // combining marks, zero-width joiners, variation selectors
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0x20e3 || (cp >= 0x1ab0 && cp <= 0x1aff) || (cp >= 0x1dc0 && cp <= 0x1dff) || (cp >= 0xe0100 && cp <= 0xe01ef)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) || cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x231a && cp <= 0x231b) || (cp >= 0x23e9 && cp <= 0x23ec) || cp === 0x23f0 || cp === 0x23f3 ||
    (cp >= 0x25fd && cp <= 0x25fe) || (cp >= 0x2614 && cp <= 0x2615) || (cp >= 0x2648 && cp <= 0x2653) ||
    cp === 0x267f || cp === 0x2693 || cp === 0x26a1 || (cp >= 0x26aa && cp <= 0x26ab) || (cp >= 0x26bd && cp <= 0x26be) ||
    (cp >= 0x26c4 && cp <= 0x26c5) || cp === 0x26ce || cp === 0x26d4 || cp === 0x26ea || (cp >= 0x26f2 && cp <= 0x26f3) ||
    cp === 0x26f5 || cp === 0x26fa || cp === 0x26fd || cp === 0x2705 || (cp >= 0x270a && cp <= 0x270b) || cp === 0x2728 ||
    cp === 0x274c || cp === 0x274e || (cp >= 0x2753 && cp <= 0x2755) || cp === 0x2757 || (cp >= 0x2795 && cp <= 0x2797) ||
    cp === 0x27b0 || cp === 0x27bf || (cp >= 0x2b1b && cp <= 0x2b1c) || cp === 0x2b50 || cp === 0x2b55 ||
    (cp >= 0x2e80 && cp <= 0x303e) || (cp >= 0x3041 && cp <= 0x33ff) || (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xa000 && cp <= 0xa4cf) || (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x1f680 && cp <= 0x1f6ff) || (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x1fa70 && cp <= 0x1faff) || (cp >= 0x1f1e6 && cp <= 0x1f1ff) || (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2;
  return 1;
}

export function strWidth(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) w += charWidth(ch.codePointAt(0)!);
  return w;
}

interface Tok { esc?: string; ch?: string; w: number }

function tokenize(s: string): Tok[] {
  const out: Tok[] = [];
  let last = 0;
  ANSI_RE.lastIndex = 0;
  const push = (text: string) => { for (const ch of text) out.push({ ch, w: ch === '\t' ? 2 : charWidth(ch.codePointAt(0)!) }); };
  for (let m = ANSI_RE.exec(s); m; m = ANSI_RE.exec(s)) {
    if (m.index > last) push(s.slice(last, m.index));
    out.push({ esc: m[0], w: 0 });
    last = m.index + m[0].length;
  }
  if (last < s.length) push(s.slice(last));
  return out;
}

const isReset = (e: string) => e === '\x1b[0m' || e === '\x1b[m';
const isSgr = (e: string) => /^\x1b\[[0-9;:]*m$/.test(e);

function serialize(lines: Tok[][]): string[] {
  let state: string[] = [];
  return lines.map((toks) => {
    let s = state.join('');
    for (const t of toks) {
      if (t.esc) {
        s += t.esc;
        if (isSgr(t.esc)) { if (isReset(t.esc)) state = []; else { state.push(t.esc); if (state.length > 24) state = state.slice(-24); } }
      } else s += t.ch === '\t' ? '  ' : t.ch;
    }
    if (state.length) s += '\x1b[0m';
    return s;
  });
}

/** Word-wraps text (may contain ANSI SGR) to `width` cells. Preserves styles across line breaks. */
export function wrapAnsi(text: string, width: number): string[] {
  width = Math.max(1, Math.floor(width));
  const result: Tok[][] = [];
  for (const rawLine of text.split('\n')) {
    const toks = tokenize(rawLine);
    // group into units: words (non-space runs incl. escapes) and spaces
    const units: { toks: Tok[]; w: number; space: boolean }[] = [];
    for (const t of toks) {
      const space = !t.esc && t.ch === ' ';
      const last = units[units.length - 1];
      if (t.esc) { if (last) { last.toks.push(t); } else units.push({ toks: [t], w: 0, space: false }); continue; }
      if (last && last.space === space) { last.toks.push(t); last.w += t.w; } else units.push({ toks: [t], w: t.w, space });
    }
    let cur: Tok[] = [];
    let curW = 0;
    const flush = () => { result.push(cur); cur = []; curW = 0; };
    for (const u of units) {
      if (curW + u.w <= width) { cur.push(...u.toks); curW += u.w; continue; }
      if (u.space) {
        // break here; keep escapes from the space run, drop the spaces
        cur.push(...u.toks.filter((t) => t.esc));
        flush();
        continue;
      }
      if (u.w <= width && curW > 0) { flush(); cur.push(...u.toks); curW = u.w; continue; }
      // hard-split a word that's longer than the remaining line
      for (const t of u.toks) {
        if (t.w && curW + t.w > width) flush();
        cur.push(t); curW += t.w;
      }
    }
    // drop trailing spaces
    while (cur.length && cur[cur.length - 1].ch === ' ') cur.pop();
    result.push(cur);
  }
  return serialize(result);
}

/** Cuts a string (may contain ANSI) to `width` cells, appending an ellipsis if cut. */
export function truncateAnsi(s: string, width: number, ellipsis = '…'): string {
  if (width <= 0) return '';
  if (strWidth(s) <= width) return s;
  const toks = tokenize(s);
  const target = width - strWidth(ellipsis);
  let w = 0;
  let out = '';
  for (const t of toks) {
    if (t.esc) { out += t.esc; continue; }
    if (w + t.w > target) break;
    out += t.ch; w += t.w;
  }
  return out + ellipsis + (level > 0 || /\x1b\[/.test(s) ? '\x1b[0m' : '');
}

export function padAnsi(s: string, width: number): string {
  const w = strWidth(s);
  return w >= width ? s : s + ' '.repeat(width - w);
}

export function padStartAnsi(s: string, width: number): string {
  const w = strWidth(s);
  return w >= width ? s : ' '.repeat(width - w) + s;
}
