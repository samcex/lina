// Pure multi-line text editing operations for the composer.
export interface Ed { value: string; cursor: number }

export const empty: Ed = { value: '', cursor: 0 };

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export function graphemes(value: string): Intl.Segments { return segmenter.segment(value); }

export function insert(e: Ed, text: string): Ed {
  const t = text.replace(/\r\n?/g, '\n');
  return { value: e.value.slice(0, e.cursor) + t + e.value.slice(e.cursor), cursor: e.cursor + t.length };
}

function prevCharLen(s: string, i: number): number {
  if (i <= 0) return 0;
  return i - graphemes(s).containing(i - 1)!.index;
}
function nextCharLen(s: string, i: number): number {
  if (i >= s.length) return 0;
  const part = graphemes(s).containing(i)!;
  return part.index + part.segment.length - i;
}

export function backspace(e: Ed): Ed {
  const n = prevCharLen(e.value, e.cursor);
  if (!n) return e;
  return { value: e.value.slice(0, e.cursor - n) + e.value.slice(e.cursor), cursor: e.cursor - n };
}
export function del(e: Ed): Ed {
  const n = nextCharLen(e.value, e.cursor);
  if (!n) return e;
  return { value: e.value.slice(0, e.cursor) + e.value.slice(e.cursor + n), cursor: e.cursor };
}
export function left(e: Ed): Ed { return { ...e, cursor: e.cursor - prevCharLen(e.value, e.cursor) }; }
export function right(e: Ed): Ed { return { ...e, cursor: e.cursor + nextCharLen(e.value, e.cursor) }; }

export function lineStart(e: Ed): Ed { return { ...e, cursor: e.cursor === 0 ? 0 : e.value.lastIndexOf('\n', e.cursor - 1) + 1 }; }
export function lineEnd(e: Ed): Ed {
  const i = e.value.indexOf('\n', e.cursor);
  return { ...e, cursor: i < 0 ? e.value.length : i };
}

export function rowCol(e: Ed): { row: number; col: number; rows: number } {
  const before = e.value.slice(0, e.cursor);
  const row = before.split('\n').length - 1;
  const col = [...graphemes(before.slice(before.lastIndexOf('\n') + 1))].length;
  return { row, col, rows: e.value.split('\n').length };
}

function moveRow(e: Ed, delta: number): Ed | null {
  const lines = e.value.split('\n');
  const { row, col } = rowCol(e);
  const target = row + delta;
  if (target < 0 || target >= lines.length) return null;
  let idx = 0;
  for (let i = 0; i < target; i++) idx += lines[i].length + 1;
  const chars = [...graphemes(lines[target])];
  return { ...e, cursor: idx + (chars[col]?.index ?? lines[target].length) };
}
/** Returns null when already on the first line (caller may use history). */
export function up(e: Ed): Ed | null { return moveRow(e, -1); }
/** Returns null when already on the last line. */
export function down(e: Ed): Ed | null { return moveRow(e, 1); }

export function killToLineStart(e: Ed): Ed {
  const s = lineStart(e).cursor;
  if (s === e.cursor && s > 0) return backspace(e); // join with previous line
  return { value: e.value.slice(0, s) + e.value.slice(e.cursor), cursor: s };
}
export function killToLineEnd(e: Ed): Ed {
  const end = lineEnd(e).cursor;
  if (end === e.cursor) return del(e);
  return { value: e.value.slice(0, e.cursor) + e.value.slice(end), cursor: e.cursor };
}
export function deleteWordBack(e: Ed): Ed {
  const before = e.value.slice(0, e.cursor);
  const m = /([ \t]*\S+[ \t]*|\s+)$/.exec(before);
  if (!m) return e;
  const s = e.cursor - m[0].length;
  return { value: e.value.slice(0, s) + e.value.slice(e.cursor), cursor: s };
}
export function wordLeft(e: Ed): Ed {
  const m = /\S+\s*$/.exec(e.value.slice(0, e.cursor));
  return { ...e, cursor: m ? e.cursor - m[0].length : Math.max(0, e.cursor - 1) };
}
export function wordRight(e: Ed): Ed {
  const m = /^\s*\S+/.exec(e.value.slice(e.cursor));
  return { ...e, cursor: m ? e.cursor + m[0].length : e.value.length };
}
