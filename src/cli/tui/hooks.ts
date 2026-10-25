import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { StoreState, TuiStore } from './store.js';

export function useStore(store: TuiStore): StoreState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

export interface AsyncState<T> { data?: T; error?: unknown; loading: boolean; reload: () => void }

/** Runs an async loader on mount (and on reload()). Ignores results after unmount. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [state, setState] = useState<{ data?: T; error?: unknown; loading: boolean }>({ loading: true });
  const [nonce, setNonce] = useState(0);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    fn().then(
      (data) => { if (!cancelled && alive.current) setState({ data, loading: false }); },
      (error) => { if (!cancelled && alive.current) setState({ error, loading: false }); },
    );
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, ...deps]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, reload };
}

/** Re-renders every `ms` while active; returns Date.now(). */
export function useNow(ms: number, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms, active]);
  return active ? now : Date.now();
}
