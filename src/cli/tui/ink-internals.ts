// Access to Ink's raw input stream, needed for keys useInput cannot distinguish
// (F1 arrives as an empty input with no flags). Loaded by file URL because Ink's
// package exports only expose ".". Falls back to a no-op context if unavailable.
import { createContext, useContext, useEffect, type Context } from 'react';
import { EventEmitter } from 'node:events';

type StdinCtx = { internal_eventEmitter?: EventEmitter };
const fallback = createContext<StdinCtx>({});
let ctx: Context<StdinCtx> = fallback;

export async function loadInkInternals(): Promise<boolean> {
  try {
    const base = import.meta.resolve('ink');
    const mod = (await import(new URL('./components/StdinContext.js', base).href)) as { default?: Context<StdinCtx> };
    if (mod.default) { ctx = mod.default; return true; }
  } catch { /* optional */ }
  return false;
}

export const F1_SEQUENCES = ['\x1bOP', '\x1b[11~', '\x1b[[A', '\x1b[P', '\x1b[1P'];

/** Calls handler with every raw key sequence Ink reads. */
export function useRawInput(handler: (data: string) => void, active = true): void {
  const c = useContext(ctx);
  useEffect(() => {
    const em = c.internal_eventEmitter;
    if (!em || !active) return;
    const fn = (d: unknown) => { if (typeof d === 'string') handler(d); };
    em.on('input', fn);
    return () => { em.removeListener('input', fn); };
  }, [c, handler, active]);
}
