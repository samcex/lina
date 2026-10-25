import { useEffect, useRef, useState, type RefObject } from 'react';

/** Re-renders every `ms` (shared clock for relative times / timers). */
const tickers = new Map<number, { subs: Set<() => void>; id: ReturnType<typeof setInterval> }>();
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let t = tickers.get(ms);
    if (!t) {
      const subs = new Set<() => void>();
      t = { subs, id: setInterval(() => subs.forEach((f) => f()), ms) };
      tickers.set(ms, t);
    }
    const f = () => setNow(Date.now());
    t.subs.add(f);
    return () => {
      t!.subs.delete(f);
      if (!t!.subs.size) { clearInterval(t!.id); tickers.delete(ms); }
    };
  }, [ms]);
  return now;
}

export function useMedia(query: string): boolean {
  const [m, setM] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const f = () => setM(mq.matches);
    mq.addEventListener('change', f);
    f();
    return () => mq.removeEventListener('change', f);
  }, [query]);
  return m;
}

export function useClickOutside(ref: RefObject<HTMLElement | null>, onOut: () => void, active = true) {
  const cb = useRef(onOut);
  cb.current = onOut;
  useEffect(() => {
    if (!active) return;
    const f = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) cb.current(); };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); cb.current(); } };
    document.addEventListener('pointerdown', f, true);
    document.addEventListener('keydown', k, true);
    return () => { document.removeEventListener('pointerdown', f, true); document.removeEventListener('keydown', k, true); };
  }, [ref, active]);
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const modKey = isMac ? '⌘' : 'Ctrl';

export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch { return false; }
  }
}
