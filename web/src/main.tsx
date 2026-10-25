import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles/tokens.css';
import './styles/base.css';
import './styles/shell.css';
import './styles/conversation.css';
import './styles/inspector.css';
import './styles/overlays.css';
import './styles/modes.css';
import { LinaClient } from '@shared/client';
import { bootstrap } from './lib/auth';
import { Store, initialState, setStore } from './lib/store';
import { Lina, LinaContext } from './lib/lina';
import type { Backend } from './lib/backend';
import { App, NoToken } from './App';

/** On a tailnet address, asks whether the daemon signs this Tailscale login in without a token. */
async function tailnetSignIn(): Promise<boolean> {
  if (!window.location.hostname.endsWith('.ts.net')) return false;
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    return res.ok && !!((await res.json()) as { tailnetUser?: string }).tailnetUser;
  } catch { return false; }
}

async function start() {
  const boot = bootstrap();
  const root = createRoot(document.getElementById('root')!);
  const store = new Store(initialState(boot.fixture));
  setStore(store);
  document.documentElement.dataset.theme = store.get().ui.theme;

  let backend: Backend;
  if (boot.fixture) {
    // Dev-only handcrafted data: a separate lazy chunk, never loaded otherwise.
    const { createFixtureBackend } = await import('./fixtures/backend');
    backend = createFixtureBackend();
  } else if (boot.token) {
    backend = { client: new LinaClient({ baseUrl: window.location.origin, token: boot.token }), fixture: false };
  } else if (await tailnetSignIn()) {
    // `lina tailscale on`: the daemon recognises this device's Tailscale login, no token needed
    backend = { client: new LinaClient({ baseUrl: window.location.origin, token: '' }), fixture: false };
  } else {
    root.render(<StrictMode><NoToken /></StrictMode>);
    return;
  }

  const lina = new Lina(backend);
  const hash = new URLSearchParams(window.location.hash.slice(1));
  lina.init(boot.session ?? hash.get('s') ?? (boot.fixture ? 'ses_fixture' : null));
  // #s=<session>&e=<seq>: open the session scrolled to that event (same as picking a search hit).
  const focusSeq = Number(hash.get('e'));
  if (focusSeq > 0) lina.setUI({ focusSeq });
  root.render(
    <StrictMode>
      <LinaContext.Provider value={lina}>
        <App />
      </LinaContext.Provider>
    </StrictMode>,
  );
}

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch((err: unknown) => console.warn('LINA service worker registration failed', err));
  });
}

void start();
