import { describe, expect, it } from 'vitest';
import { computeLayout, formatElapsed, listWindow, modelLabel, visibleWindow, WIDE_MIN_COLS } from '../../src/cli/layout.js';
import { composerRows, composerView, pipelineRail, spread } from '../../src/cli/tui/chrome.js';
import * as E from '../../src/cli/tui/editor.js';
import { stripAnsi, strWidth } from '../../src/cli/ansi.js';
import { configFromFlags, findProjectForPath } from '../../src/cli/util.js';
import { planRegistration } from '../../src/cli/tui/ProjectPicker.js';
import { project } from './fixture.js';
import { DEFAULT_SETTINGS } from '../../src/shared/types.js';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('computeLayout', () => {
  it('uses a side column on wide terminals', () => {
    const l = computeLayout({ columns: 160, rows: 50, composerLines: 1, suggestionLines: 0, bannerLines: 1 });
    expect(l.wide).toBe(true);
    expect(l.sideWidth).toBeGreaterThanOrEqual(40);
    expect(l.transcriptWidth + l.sideWidth + 3).toBe(160);
    expect(l.headerHeight + l.transcriptHeight + l.composerHeight + l.footerHeight + 1).toBe(50);
  });
  it('keeps visible agent cards below the transcript on narrow terminals', () => {
    const l = computeLayout({ columns: WIDE_MIN_COLS - 1, rows: 40, composerLines: 2, suggestionLines: 3, bannerLines: 0 });
    expect(l.wide).toBe(false);
    expect(l.compactRowHeight).toBeGreaterThanOrEqual(5);
    expect(l.headerHeight + l.transcriptHeight + l.compactRowHeight + l.composerHeight + l.footerHeight + 3).toBe(40);
  });
  it('drops compact panels on very short terminals', () => {
    expect(computeLayout({ columns: 80, rows: 14, composerLines: 1, suggestionLines: 0, bannerLines: 0 }).compactRowHeight).toBe(0);
  });
});

describe('windows and formatting', () => {
  it('visibleWindow follows the bottom and clamps the offset', () => {
    expect(visibleWindow(100, 10, 0)).toEqual({ start: 90, end: 100, offset: 0 });
    expect(visibleWindow(100, 10, 5)).toEqual({ start: 85, end: 95, offset: 5 });
    expect(visibleWindow(100, 10, 500)).toEqual({ start: 0, end: 10, offset: 90 });
    expect(visibleWindow(3, 10, 2)).toEqual({ start: 0, end: 3, offset: 0 });
  });
  it('listWindow keeps the selection visible', () => {
    expect(listWindow(50, 10, 0)).toEqual({ start: 0, end: 10 });
    expect(listWindow(50, 10, 25)).toEqual({ start: 20, end: 30 });
    expect(listWindow(50, 10, 49)).toEqual({ start: 40, end: 50 });
  });
  it('formats elapsed time and models', () => {
    expect(formatElapsed(5_000)).toBe('5s');
    expect(formatElapsed(125_000)).toBe('2m 05s');
    expect(formatElapsed(3_900_000)).toBe('1h 05m');
    expect(modelLabel({ model: 'gpt-6.1-sol', effort: 'medium' })).toBe('gpt-6.1-sol·medium');
    expect(modelLabel(undefined)).toBe('—');
  });
  it('spread pads to the exact width', () => {
    expect(strWidth(spread('left', 'right', 30))).toBe(30);
    expect(strWidth(spread('a very long left side that overflows', 'R', 20))).toBeLessThanOrEqual(20);
  });
  it('pipeline rail highlights the current phase and marks earlier ones done', () => {
    const r = stripAnsi(pipelineRail('reviewing', false));
    expect(r).toContain('✓ Planning');
    expect(r).toContain(' Reviewing ');
    expect(r).not.toContain('✓ Revising');
  });
});

describe('composer editing', () => {
  it('edits, moves across lines and reports edges for history', () => {
    let e = E.insert(E.empty, 'hello');
    e = E.insert(e, '\nworld');
    expect(E.rowCol(e)).toEqual({ row: 1, col: 5, rows: 2 });
    expect(E.down(e)).toBeNull();
    const up = E.up(e)!;
    expect(E.rowCol(up)).toMatchObject({ row: 0, col: 5 });
    expect(E.up(up)).toBeNull();
    expect(E.backspace(e).value).toBe('hello\nworl');
    expect(E.deleteWordBack(e).value).toBe('hello\n');
    expect(E.killToLineStart(e).value).toBe('hello\n');
    expect(E.lineStart(e).cursor).toBe(6);
  });
  it.each(['😀', 'e\u0301', '👍🏽', '👩‍💻', '🇨🇭', '1️⃣'])('moves and deletes %s as one character', (character) => {
    const value = `a${character}b`;
    const start = { value, cursor: 1 };
    const end = { value, cursor: 1 + character.length };
    expect(E.right(start)).toEqual(end);
    expect(E.left(end)).toEqual(start);
    expect(E.backspace(end)).toEqual({ value: 'ab', cursor: 1 });
    expect(E.del(start)).toEqual({ value: 'ab', cursor: 1 });
  });
  it('moves vertically by characters without splitting emoji or accents', () => {
    const value = 'ab\n👩‍💻e\u0301x\nz';
    const first = { value, cursor: 1 };
    const second = E.down(first)!;
    expect(second.cursor).toBe(3 + '👩‍💻'.length);
    expect(E.rowCol(second)).toEqual({ row: 1, col: 1, rows: 3 });
    expect(E.up(second)).toEqual(first);
    expect(E.down(second)?.cursor).toBe(value.length);
    expect(E.down({ value, cursor: 2 })?.cursor).toBe(3 + '👩‍💻e\u0301'.length);
  });
  it('keeps Home and kill-to-start at the start of an empty first line', () => {
    const e = { value: '\nhello', cursor: 0 };
    expect(E.lineStart(e)).toEqual(e);
    expect(E.killToLineStart(e)).toEqual(e);
    expect(E.left(e)).toEqual(e);
    expect(E.backspace(e)).toEqual(e);
    expect(E.lineStart({ ...e, cursor: 1 }).cursor).toBe(1);
  });
  it.each(['e\u0301', '👩‍💻', '👍🏽', '🇨🇭', '1️⃣', '❤️'])('wraps %s without splitting the character', (character) => {
    const prefix = character === 'e\u0301' ? 'xxx' : 'xx';
    const value = prefix + character + 'z';
    const { rows, cursorRow } = composerRows({ value, cursor: prefix.length + character.length }, 4, true);
    expect(rows.map(stripAnsi)).toEqual([prefix + character, 'z']);
    expect(cursorRow).toBe(1);
    expect(composerRows({ value, cursor: prefix.length }, 4, true).cursorRow).toBe(0);
  });
  it('soft-wraps rows and keeps the cursor visible', () => {
    const e = E.insert(E.empty, 'x'.repeat(25));
    const { rows, cursorRow } = composerRows(e, 10, true);
    expect(rows.map(stripAnsi)).toEqual(['xxxxxxxxxx', 'xxxxxxxxxx', 'xxxxx ']);
    expect(cursorRow).toBe(2);
    const many = E.insert(E.empty, Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n'));
    const v = composerView(many, 20, true, 8);
    expect(v.lines.length).toBe(8);
    expect(stripAnsi(v.lines[7]).trim()).toBe('l19');
  });
});

describe('project resolution and config', () => {
  it('finds the deepest registered project containing a dir', () => {
    const root = mkdtempSync(join(tmpdir(), 'lina-proj-'));
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    const p1 = { ...project, id: 'outer', path: root };
    const p2 = { ...project, id: 'inner', path: join(root, 'a') };
    expect(findProjectForPath([p1, p2], join(root, 'a', 'b'))?.id).toBe('inner');
    expect(findProjectForPath([p1, p2], root)?.id).toBe('outer');
    expect(findProjectForPath([p2], root)).toBeUndefined();
    expect(findProjectForPath([{ ...project, path: root + 'x' }], root)).toBeUndefined();
  });
  it('plans registration with explicit consent for create / git init', () => {
    const root = mkdtempSync(join(tmpdir(), 'lina-reg-'));
    expect(planRegistration('new-dir', root, 'create')).toMatchObject({ action: 'confirm', body: { create: true, initGit: true } });
    expect(planRegistration('.', root, 'add')).toMatchObject({ action: 'confirm', body: { path: root, initGit: true } });
    mkdirSync(join(root, '.git'));
    expect(planRegistration('.', root, 'add')).toEqual({ action: 'register', body: { path: root } });
    expect(planRegistration('  ', root, 'add')).toMatchObject({ action: 'error' });
  });
  it('builds session config from flags on top of settings', () => {
    const c = configFromFlags({ claudeModel: 'sonnet', codexEffort: 'high', developer: 'claude', mock: true, mode: 'architect', maxRounds: 4 }, DEFAULT_SETTINGS);
    expect(c).toEqual({
      models: { codex: { model: 'gpt-6.1-sol', effort: 'high' }, claude: { model: 'sonnet' }, freebuff: { model: 'auto' } },
      developer: 'claude', reviewer: 'codex', mode: 'architect', maxRounds: 4, mock: true,
    });
    expect(configFromFlags({}, DEFAULT_SETTINGS)).toEqual({});
  });
});
