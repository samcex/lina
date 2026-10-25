// Token bootstrap. `lina ui` opens http://127.0.0.1:<port>/#token=<t>[&session=<id>].
// The token is moved to sessionStorage (+ localStorage on loopback/tailnet for PWA relaunches)
// and stripped from the address bar immediately.

const KEY = 'lina.token';

function safe<T>(fn: () => T): T | undefined {
  try { return fn(); } catch { return undefined; }
}

export interface Boot { token: string | null; session: string | null; fixture: boolean }

export function bootstrap(): Boot {
  const host = window.location.hostname;
  // Loopback, or a tailnet-only HTTPS name from `lina tailscale on` (the installed phone app).
  const persistent = host === '127.0.0.1' || host === 'localhost' || host.endsWith('.ts.net');
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const query = new URLSearchParams(window.location.search);
  const fromHash = params.get('token');
  const session = params.get('session') ?? params.get('s');
  const fixture = query.get('fixture') === '1';

  if (fromHash) {
    safe(() => sessionStorage.setItem(KEY, fromHash));
    // Persistence enables installed-app relaunches, but anyone using this browser
    // profile gains full daemon control. Limit it to loopback/tailnet; users can forget it.
    if (persistent) safe(() => localStorage.setItem(KEY, fromHash));
  }
  if (fromHash || params.has('session')) {
    const clean = window.location.pathname + window.location.search + (session ? `#s=${encodeURIComponent(session)}` : '');
    history.replaceState(null, '', clean);
  }
  const token = fromHash ?? safe(() => sessionStorage.getItem(KEY)) ?? (persistent ? safe(() => localStorage.getItem(KEY)) : null) ?? null;
  if (token) safe(() => sessionStorage.setItem(KEY, token));
  if (persistent && token) safe(() => localStorage.setItem(KEY, token));
  return { token, session, fixture };
}

export function forgetToken() {
  safe(() => sessionStorage.removeItem(KEY));
  safe(() => localStorage.removeItem(KEY));
}

/** Session id carried in the location hash (#s=<id>). */
export function sessionFromHash(): string | null {
  const p = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  return p.get('s');
}

export function writeSessionHash(id: string | null) {
  const next = window.location.pathname + window.location.search + (id ? `#s=${encodeURIComponent(id)}` : '');
  if (next !== window.location.pathname + window.location.search + window.location.hash) history.pushState(null, '', next);
}
