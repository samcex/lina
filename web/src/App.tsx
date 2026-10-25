import { useEffect } from 'react';
import { FolderPlus, Plus, WifiOff, Command, PanelLeft, Menu, CircleAlert, Trash2 } from 'lucide-react';
import { useApp, useUI } from './lib/store';
import { useLina } from './lib/lina';
import { forgetToken, sessionFromHash } from './lib/auth';
import { modKey, useMedia } from './lib/hooks';
import { cx } from './lib/format';
import { Sidebar } from './components/Sidebar';
import { SessionHeader } from './components/SessionHeader';
import { Conversation } from './components/Conversation';
import { Composer } from './components/Composer';
import { Inspector } from './components/inspector/Inspector';
import { CommandPalette } from './components/dialogs/CommandPalette';
import { SettingsDialog } from './components/dialogs/Settings';
import { AddProjectDialog } from './components/dialogs/AddProject';
import { NewSessionDialog } from './components/dialogs/NewSession';
import { Toasts } from './components/ui/Toasts';
import { BrandMark } from './components/ui/Glyphs';
import { Kbd, Skeleton } from './components/ui/Overlay';

export function App() {
  const lina = useLina();
  const sidebarOpen = useUI((u) => u.sidebarOpen);
  const inspectorOpen = useUI((u) => u.inspectorOpen);
  const inspectorWidth = useUI((u) => u.inspectorWidth);
  const view = useApp((s) => s.view);
  const currentId = useApp((s) => s.currentId);
  const viewError = useApp((s) => s.viewError);
  const conn = useApp((s) => s.conn);
  const everOpen = useApp((s) => s.everOpen);
  const narrow = useMedia('(max-width: 899px)');
  const midInspector = useMedia('(max-width: 1279px)');
  const unauthorized = useApp((s) => s.unauthorized);
  const deleted = useApp((s) => s.deleted);

  useEffect(() => { document.documentElement.style.setProperty('--inspector-w', `${inspectorWidth}px`); }, [inspectorWidth]);
  useEffect(() => { document.title = view ? `${view.session.title || 'Session'} · LINA` : 'LINA'; }, [view?.session.title]); // eslint-disable-line

  // Browser back/forward between sessions.
  useEffect(() => {
    const f = () => {
      const id = sessionFromHash();
      if (id !== lina.store.get().currentId) lina.select(id, { replace: true });
      const seq = Number(new URLSearchParams(window.location.hash.slice(1)).get('e'));
      if (seq > 0) lina.setUI({ focusSeq: seq });
    };
    window.addEventListener('popstate', f);
    return () => window.removeEventListener('popstate', f);
  }, [lina]);

  // Global keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      const ui = lina.store.get().ui;
      if (mod && k === 'k') { e.preventDefault(); lina.setUI({ palette: !ui.palette }); return; }
      if (mod && k === 'b') { e.preventDefault(); lina.toggleSidebar(); return; }
      if (mod && k === 'i') { e.preventDefault(); lina.toggleInspector(); return; }
      const t = e.target as HTMLElement;
      const typing = t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName);
      if (e.key === '/' && !typing && !mod) { e.preventDefault(); lina.focusComposer(); return; }
      if (e.key === 'Escape' && !typing) {
        if (ui.palette) lina.setUI({ palette: false });
        else if (window.innerWidth < 1280 && ui.inspectorOpen) lina.setUI({ inspectorOpen: false });
        else if (window.innerWidth < 900 && ui.sidebarOpen) lina.setUI({ sidebarOpen: false });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lina]);

  const showInspector = inspectorOpen && !!view;
  if (unauthorized) return <NoToken expired />;
  return (
    <div className={cx('app', sidebarOpen && 'has-sidebar', showInspector && 'has-inspector', narrow && 'is-narrow', midInspector && 'is-mid')}>
      {conn === 'closed' && everOpen && (
        <div className="banner" role="status"><WifiOff size={14} /> Connection to the LINA daemon lost — reconnecting… <span className="text-dim">Agents keep running in the background.</span></div>
      )}
      <div className={cx('drawer-scrim', ((narrow && sidebarOpen) || (midInspector && showInspector)) && 'is-on')}
        onClick={() => lina.setUI(narrow && sidebarOpen ? { sidebarOpen: false } : { inspectorOpen: false })} aria-hidden="true" />
      <div className="col-sidebar">{sidebarOpen && <Sidebar />}</div>
      <main className="col-main" aria-label="Session">
        {view ? (
          <>
            <SessionHeader view={view} />
            <Conversation view={view} />
            <Composer view={view} />
          </>
        ) : deleted && deleted.id === currentId ? (
          <SessionDeleted title={deleted.title} />
        ) : currentId ? (
          viewError ? <SessionError message={viewError} /> : <SessionSkeleton />
        ) : (
          <Welcome />
        )}
      </main>
      <div className="col-inspector">{showInspector && view && <Inspector view={view} />}</div>
      <CommandPalette />
      <SettingsDialog />
      <AddProjectDialog />
      <NewSessionDialog />
      <Toasts />
    </div>
  );
}

function TopLeftToggle() {
  const lina = useLina();
  const sidebarOpen = useUI((u) => u.sidebarOpen);
  if (sidebarOpen) return null;
  return (
    <button className="icon-btn floating-toggle" onClick={() => lina.toggleSidebar()} aria-label="Show sidebar">
      <PanelLeft size={17} className="only-wide" /><Menu size={17} className="only-narrow" />
    </button>
  );
}

function Welcome() {
  const lina = useLina();
  const projects = useApp((s) => s.projects);
  const loaded = useApp((s) => s.projectsLoaded);
  return (
    <div className="welcome">
      <TopLeftToggle />
      <div className="welcome-inner">
        <BrandMark size={72} live />
        <h1 className="welcome-title">Two minds, one codebase.</h1>
        <p className="welcome-sub">
          LINA pairs <span className="hero-agent" data-actor="codex">Codex</span> and <span className="hero-agent" data-actor="claude">Claude</span> as
          a developer and a reviewer. Ask a question, give a coding task, and keep chatting as they work directly in your project.
        </p>
        <div className="welcome-actions">
          {loaded && projects.length === 0 ? (
            <button className="btn btn-primary btn-lg btn-glow" onClick={() => lina.setUI({ addProject: true })}><FolderPlus size={16} /> Add your first project</button>
          ) : (
            <button className="btn btn-primary btn-lg btn-glow" onClick={() => lina.setUI({ newSession: {} })}><Plus size={16} /> New session</button>
          )}
          <button className="btn btn-outline btn-lg" onClick={() => lina.setUI({ palette: true })}><Command size={15} /> Command palette <Kbd>{modKey}</Kbd><Kbd>K</Kbd></button>
        </div>
        <ol className="welcome-steps">
          <li><b>1</b><span><b>Chat</b> — ask a question or describe a task</span></li>
          <li><b>2</b><span><b>Build & verify</b> — edits appear directly in your project</span></li>
          <li><b>3</b><span><b>Review</b> — agents check changes when needed</span></li>
          <li><b>4</b><span><b>Inspect & steer</b> — follow activity, review diffs, or undo a writing turn</span></li>
        </ol>
      </div>
    </div>
  );
}

function SessionSkeleton() {
  return (
    <div className="session-skel" aria-busy="true" aria-label="Loading session">
      <TopLeftToggle />
      <div className="skel-head"><Skeleton w={260} h={18} /><Skeleton w={180} h={10} /><Skeleton w="70%" h={22} r={11} /></div>
      <div className="skel-body">
        {[0, 1, 2].map((i) => (
          <div key={i} className="skel-msg"><Skeleton w={30} h={30} r={10} /><div className="skel-lines"><Skeleton w="30%" h={10} /><Skeleton w="92%" h={10} /><Skeleton w="78%" h={10} /><Skeleton w="54%" h={10} /></div></div>
        ))}
      </div>
    </div>
  );
}

function SessionError({ message }: { message: string }) {
  const lina = useLina();
  return (
    <div className="welcome">
      <TopLeftToggle />
      <div className="welcome-inner">
        <CircleAlert size={30} className="text-bad" />
        <h2 className="welcome-title is-sm">This session could not be opened</h2>
        <p className="welcome-sub">{message}</p>
        <button className="btn" onClick={() => lina.select(null)}>Back</button>
      </div>
    </div>
  );
}

function SessionDeleted({ title }: { title: string }) {
  const lina = useLina();
  return (
    <div className="welcome">
      <TopLeftToggle />
      <div className="welcome-inner">
        <span className="deleted-icon"><Trash2 size={22} /></span>
        <h2 className="welcome-title is-sm">This session was deleted</h2>
        <p className="welcome-sub">“{title}” and its isolated workspace no longer exist. Your project repository was not touched.</p>
        <div className="welcome-actions">
          <button className="btn btn-primary" onClick={() => lina.setUI({ newSession: {} })}><Plus size={15} /> New session</button>
          <button className="btn btn-outline" onClick={() => lina.select(null)}>Close</button>
        </div>
      </div>
    </div>
  );
}

export function NoToken({ expired }: { expired?: boolean }) {
  useEffect(() => { if (expired) forgetToken(); }, [expired]);
  return (
    <div className="notoken">
      <div className="notoken-card">
        <BrandMark size={56} />
        <h1>{expired ? 'Your session key expired' : 'Open LINA from your terminal'}</h1>
        <p>The web interface needs the daemon's access token. On the host running LINA, run:</p>
        <pre className="notoken-cmd"><span className="text-dim">$</span> lina ui --url</pre>
        <p className="text-dim">Open the printed URL in this browser to sign in. If you're using a phone, keep the SSH tunnel running, or run <code>lina tailscale on</code> to sign in with your Tailscale account.</p>
      </div>
    </div>
  );
}
