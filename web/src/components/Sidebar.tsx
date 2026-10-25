import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ChevronRight, FolderPlus, Moon, PanelLeftClose, Plus, Search, Settings2, Sun, X, FolderGit2, MessageSquareDashed,
} from 'lucide-react';
import type { Project, SearchHit, Session } from '@shared/types';
import { PHASE_LABEL } from '@shared/reducer';
import { useApp, useUI } from '../lib/store';
import { useLina } from '../lib/lina';
import { useDebounced, useNow, modKey } from '../lib/hooks';
import { AGENT_NAME, cx, relTime } from '../lib/format';
import { BrandMark } from './ui/Glyphs';
import { SessionDot } from './ui/Status';
import { Kbd, Skeleton, Spinner } from './ui/Overlay';

export function Sidebar() {
  const lina = useLina();
  const projects = useApp((s) => s.projects);
  const sessionsMap = useApp((s) => s.sessions);
  const loaded = useApp((s) => s.projectsLoaded);
  const currentId = useApp((s) => s.currentId);
  const fixture = useApp((s) => s.fixture);
  const theme = useUI((u) => u.theme);
  const [q, setQ] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  useNow(30_000);

  const byProject = useMemo(() => {
    const m: Record<string, Session[]> = {};
    for (const s of Object.values(sessionsMap)) (m[s.projectId] ??= []).push(s);
    for (const k in m) m[k].sort((a, b) => b.updatedAt - a.updatedAt);
    return m;
  }, [sessionsMap]);

  const sortedProjects = useMemo(() => {
    const last = (p: Project) => Math.max(p.updatedAt, ...(byProject[p.id] ?? []).map((s) => s.updatedAt));
    return [...projects].sort((a, b) => last(b) - last(a));
  }, [projects, byProject]);

  const anyRunning = Object.values(sessionsMap).some((s) => s.status === 'running');

  return (
    <nav className="sidebar" aria-label="Projects and sessions">
      <div className="sb-brand">
        <BrandMark size={26} live={anyRunning} />
        <div className="sb-wordmark">
          <span>LINA</span>
          {fixture && <em className="tag tag-warn" title="Rendering handcrafted fixtures (no daemon)">fixture</em>}
        </div>
        <button className="icon-btn" data-tip={`Hide sidebar (${modKey}+B)`} aria-label="Hide sidebar" onClick={() => lina.toggleSidebar()}>
          <PanelLeftClose size={16} />
        </button>
      </div>

      <div className="sb-actions">
        <button className="btn btn-primary btn-block" onClick={() => lina.setUI({ newSession: {} })}>
          <Plus size={15} /> New session
          <span className="btn-kbd"><Kbd>{modKey}</Kbd><Kbd>K</Kbd></span>
        </button>
      </div>

      <div className="sb-search">
        <Search size={14} className="sb-search-icon" />
        <input
          value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search conversations"
          aria-label="Search all conversations" spellCheck={false}
          onKeyDown={(e) => { if (e.key === 'Escape') setQ(''); }}
        />
        {q && <button className="icon-btn icon-btn-sm" onClick={() => setQ('')} aria-label="Clear search"><X size={13} /></button>}
      </div>

      <div className="sb-scroll">
        {q.trim().length >= 2 ? (
          <SearchResults q={q.trim()} onPick={() => setQ('')} />
        ) : !loaded ? (
          <div className="sb-skel">{[70, 55, 80, 62, 48].map((w, i) => <Skeleton key={i} w={`${w}%`} h={10} />)}</div>
        ) : sortedProjects.length === 0 ? (
          <div className="sb-empty">
            <FolderGit2 size={22} />
            <p>Add a git project to start a session.</p>
            <button className="btn btn-sm" onClick={() => lina.setUI({ addProject: true })}><FolderPlus size={14} /> Add project</button>
          </div>
        ) : (
          sortedProjects.map((p) => {
            const list = byProject[p.id] ?? [];
            const isCollapsed = collapsed[p.id];
            return (
              <section key={p.id} className="sb-project">
                <div className="sb-project-head">
                  <button
                    className="sb-project-toggle" aria-expanded={!isCollapsed}
                    onClick={() => setCollapsed((c) => ({ ...c, [p.id]: !c[p.id] }))} title={p.path}
                  >
                    <ChevronRight size={13} className={cx('chev', !isCollapsed && 'is-open')} />
                    <span className="sb-project-name">{p.name}</span>
                    <span className="sb-count">{list.length || ''}</span>
                  </button>
                  <button className="icon-btn icon-btn-sm" data-tip="New session here" aria-label={`New session in ${p.name}`}
                    onClick={() => lina.setUI({ newSession: { projectId: p.id } })}>
                    <Plus size={14} />
                  </button>
                </div>
                {!isCollapsed && (
                  <ul className="sb-sessions">
                    {list.length === 0 && <li className="sb-none">No sessions yet</li>}
                    {list.map((s) => (
                      <li key={s.id}>
                        <button className={cx('sb-session', s.id === currentId && 'is-active')} onClick={() => lina.select(s.id)} aria-current={s.id === currentId ? 'page' : undefined}>
                          <SessionDot status={s.status} />
                          <span className="sb-session-title">{s.title || 'Untitled session'}</span>
                          <span className="sb-session-meta">
                            {s.status === 'running' ? PHASE_LABEL[s.phase] : s.status === 'awaiting_approval' ? 'Needs you' : relTime(s.updatedAt)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })
        )}
      </div>

      <div className="sb-foot">
        <button className="sb-foot-btn" onClick={() => lina.setUI({ addProject: true })}><FolderPlus size={15} /> Add project</button>
        <div className="sb-foot-icons">
          <button className="icon-btn" data-tip={theme === 'dark' ? 'Light theme' : 'Dark theme'} aria-label="Toggle theme"
            onClick={() => lina.setTheme(theme === 'dark' ? 'light' : 'dark')}>
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <button className="icon-btn" data-tip="Settings & doctor" aria-label="Settings" onClick={() => lina.setUI({ settings: 'general' })}>
            <Settings2 size={16} />
          </button>
        </div>
      </div>
    </nav>
  );
}

function SearchResults({ q, onPick }: { q: string; onPick: () => void }) {
  const lina = useLina();
  const dq = useDebounced(q, 220);
  const [state, setState] = useState<{ q: string; hits: SearchHit[] | null; error?: string }>({ q: '', hits: null });
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, hits: s.q === dq ? s.hits : null }));
    lina.client.search(dq).then(
      (hits) => alive && setState({ q: dq, hits }),
      (e: Error) => alive && setState({ q: dq, hits: [], error: e.message }),
    );
    return () => { alive = false; };
  }, [dq, lina]);

  if (!state.hits) return <div className="sb-searching"><Spinner size={13} /> Searching…</div>;
  if (state.error) return <div className="sb-empty"><p>{state.error}</p></div>;
  if (!state.hits.length) return <div className="sb-empty"><MessageSquareDashed size={20} /><p>No messages match “{dq}”.</p></div>;
  return (
    <ul className="sb-hits" aria-label="Search results">
      {state.hits.map((h) => (
        <li key={`${h.sessionId}:${h.seq}`}>
          <button className="sb-hit" onClick={() => { lina.select(h.sessionId); lina.setUI({ focusSeq: h.seq }); onPick(); }}>
            <div className="sb-hit-head">
              <span className="sb-hit-title">{h.sessionTitle || 'Untitled session'}</span>
              <span className="sb-hit-actor" data-actor={h.actor}>{AGENT_NAME[h.actor]}</span>
            </div>
            <div className="sb-hit-snippet">{highlightTerms(h.snippet, dq)}</div>
            <div className="sb-hit-time">{relTime(h.ts)}</div>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Strips any server-side markup and highlights query terms (safe: React text nodes only). */
function highlightTerms(snippet: string, q: string): ReactNode[] {
  const clean = snippet.replace(/<\/?[^>]+>/g, '').replace(/\[\[|\]\]/g, '').replace(/\*\*|__|`+|^#+\s/gm, '');
  const terms = q.split(/\s+/).filter((t) => t.length > 1).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!terms.length) return [clean];
  const re = new RegExp(`(${terms.join('|')})`, 'gi');
  return clean.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part));
}
