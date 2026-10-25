// Mouse-wheel scrolling for the full-screen TUI. The alternate screen has no terminal scrollback, and
// many terminals turn the wheel into ↑/↓ there (which the composer uses for history). We enable SGR
// mouse reports and take them out of stdin before Ink parses it; Ink would discard them anyway.
// Selecting text then needs Shift+drag in most terminals. LINA_MOUSE=0 turns this off.
import { useEffect, useRef } from 'react';

export const MOUSE_ON = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';
export const MOUSE_OFF = '\x1b[?1006l\x1b[?1002l\x1b[?1000l';

// eslint-disable-next-line no-control-regex
const REPORT = /\x1b\[(?:<(\d+);(\d+);(\d+)([Mm])|(\d+);(\d+);(\d+)M|M([\s\S])([\s\S])([\s\S]))/g;
// eslint-disable-next-line no-control-regex
const PARTIAL = /\x1b\[(?:<[\d;]*|M[\s\S]{0,2}|\d+(?:;\d*){0,2})$/;

/** Removes SGR mouse reports. `wheel` lists -1 (up) / +1 (down) per notch; `pending` is a split report's start. */
export interface MouseReport { button: number; x: number; y: number; released: boolean; motion: boolean }
export function extractMouse(chunk: string, onReport?: (report: MouseReport) => void): { text: string; wheel: number[]; pending: string } {
  const wheel: number[] = [];
  let text = chunk.replace(REPORT, (_m, sgr: string | undefined, sx: string, sy: string, end: string | undefined, urxvt: string | undefined, ux: string, uy: string, x10: string | undefined, xx: string, xy: string) => {
    const b = sgr !== undefined ? Number(sgr) : urxvt !== undefined ? Number(urxvt) - 32 : x10!.charCodeAt(0) - 32;
    const x = sgr !== undefined ? Number(sx) : urxvt !== undefined ? Number(ux) : xx.charCodeAt(0) - 32;
    const y = sgr !== undefined ? Number(sy) : urxvt !== undefined ? Number(uy) : xy.charCodeAt(0) - 32;
    if (end !== 'm' && (b & 64) && (b & 3) < 2) wheel.push((b & 3) === 0 ? -1 : 1); // 64/65 (+ shift/meta/ctrl bits)
    else if (!(b & 64)) onReport?.({ button: b, x, y, released: end === 'm' || (b & 3) === 3, motion: !!(b & 32) });
    return '';
  });
  const tail = PARTIAL.exec(text);
  const pending = tail ? tail[0] : '';
  if (pending) text = text.slice(0, -pending.length);
  return { text, wheel, pending };
}

type Listener = (delta: number) => void;
const listeners = new Set<Listener>();
const pointerListeners = new Set<(report: MouseReport) => void>();

/**
 * Filters mouse reports out of `stdin.read()` (Ink reads utf8 strings with 'readable' + read()) and turns
 * reporting on. Returns a function that restores both.
 */
export function installMouse(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream): () => void {
  if (process.env.LINA_MOUSE === '0') return () => {};
  const read = stdin.read.bind(stdin);
  let carry = '';
  stdin.read = ((size?: number) => {
    const chunk: unknown = read(size);
    if (chunk === null && !carry) return null;
    const { text, wheel, pending } = extractMouse(carry + (chunk === null ? '' : String(chunk)), (report) => {
      for (const listener of pointerListeners) listener(report);
    });
    carry = pending;
    for (const d of wheel) for (const l of listeners) l(d);
    return chunk === null && !text ? null : text;
  }) as typeof stdin.read;
  stdout.write(MOUSE_ON);
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    process.removeListener('exit', restore);
    stdin.read = read as typeof stdin.read;
    try { stdout.write(MOUSE_OFF); } catch { /* closed */ }
  };
  process.once('exit', restore);
  return restore;
}

/** Calls `handler(delta)` per wheel notch (-1 up, +1 down) while active. */
export function useWheel(handler: Listener, active = true): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!active) return;
    const l: Listener = (d) => ref.current(d);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, [active]);
}

/** Test hook: delivers a wheel notch as if it had been read from stdin. */
export function emitWheel(delta: number): void {
  for (const l of listeners) l(delta);
}

/** Pointer reports are used only for explicit controls and held-button transcript drags. */
export function useMouse(handler: (report: MouseReport) => void, active = true): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!active) return;
    const listener = (report: MouseReport) => ref.current(report);
    pointerListeners.add(listener);
    return () => { pointerListeners.delete(listener); };
  }, [active]);
}

/** Scroll a bounded line view; clamp the displayed position before moving from either edge. */
export function useWheelScroll(set: (update: (value: number) => number) => void, max: number, active = true): void {
  useWheel((delta) => set((value) => Math.max(0, Math.min(Math.max(0, max), Math.min(value, Math.max(0, max)) + delta * 3))), active);
}

/** Wheel navigation in pickers moves one item per notch and never selects an empty list. */
export function useWheelSelection(set: (update: (value: number) => number) => void, length: number, active = true): void {
  useWheel((delta) => set((value) => Math.max(0, Math.min(Math.max(0, length - 1), value + delta))), active);
}
