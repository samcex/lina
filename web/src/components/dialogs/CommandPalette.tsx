import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  Activity, ArrowLeftRight, Cpu, Eye, FileDiff, FolderPlus, FolderTree, ListChecks, MessageSquare, Moon, PanelLeft, PanelRight,
  Pause, Play, Plus, ScrollText, Settings2, Square, Stamp, Stethoscope, FlaskConical, Search,
} from 'lucide-react';
import { PHASE_LABEL } from '@shared/reducer';
import { useApp } from '../../lib/store';
import { useLina } from '../../lib/lina';
import { cx, relTime } from '../../lib/format';
import { modKey } from '../../lib/hooks';
import { SessionDot } from '../ui/Status';

interface Cmd { id: string; group: string; label: string; hint?: string; icon: typeof Plus; run: () => void; keys?: string; dot?: ReactNode }

function score(q: string, text: string): number {
  if (!q) return 1;
  const t = text.toLowerCase();
  const i = t.indexOf(q);
  if (i >= 0) return 100 - i;
  let p = 0;
  for (const ch of q) { p = t.indexOf(ch, p); if (p < 0) return 0; p++; }
  return 10;
}

export function CommandPalette() {
  const lina = useLina();
  const open = useApp((s) => s.ui.palette);
  const sessions = useApp((s) => s.sessions);
  const projects = useApp((s) => s.projects);
  const view = useApp((s) => s.view);
  const theme = useApp((s) => s.ui.theme);
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => { if (open) { setQ(''); setIdx(0); setTimeout(() => input.current?.focus(), 10); } }, [open]);
  const close = () => lina.setUI({ palette: false });

  const cmds = useMemo<Cmd[]>(() => {
    const c: Cmd[] = [];
    const st = view?.session.status;
    if (view) {
      if (st === 'awaiting_approval') c.push({ id: 'approve', group: 'Session', label: 'Approve…', hint: 'Open approval controls', icon: Stamp, run: () => lina.openInspector('summary') });
      if (st === 'running') c.push({ id: 'pause', group: 'Session', label: 'Pause', hint: 'Stop at the next turn boundary', icon: Pause, run: () => void lina.control('pause') });
      if (st && ['paused', 'interrupted', 'failed', 'cancelled'].includes(st)) c.push({ id: 'resume', group: 'Session', label: 'Resume', icon: Play, run: () => void lina.control('resume') });
      if (st === 'running' || st === 'paused') c.push({ id: 'cancel', group: 'Session', label: 'Cancel current turn', icon: Square, run: () => void lina.control('cancel') });
      c.push({ id: 'review', group: 'Session', label: 'Run an extra review round', icon: Eye, run: () => void lina.control('review') });
      const mode = view.session.config.mode;
      if (mode !== 'custom' && mode !== 'compete') c.push({ id: 'swap', group: 'Session', label: mode === 'parallel' ? 'Swap the lead' : 'Swap developer / reviewer', icon: ArrowLeftRight, run: () => lina.swapRoles() });
      c.push({ id: 'models', group: 'Session', label: 'Change models…', hint: 'Use the agent pills in the header', icon: Cpu, run: () => (document.querySelector('.apill') as HTMLElement | null)?.click() });
      c.push({ id: 'compose', group: 'Session', label: 'Focus composer', icon: MessageSquare, keys: '/', run: () => lina.focusComposer() });
      const tabs = [['live', 'Live activity', Activity], ['changes', 'Changes', FileDiff], ['files', 'Files', FolderTree], ['review', 'Review board', ListChecks], ['tests', 'Tests', FlaskConical], ['summary', 'Summary', ScrollText]] as const;
      for (const [id, label, icon] of tabs) c.push({ id: `tab-${id}`, group: 'Inspector', label: `Show ${label}`, icon, run: () => lina.openInspector(id) });
    }
    c.push({ id: 'new', group: 'General', label: 'New session', icon: Plus, run: () => lina.setUI({ newSession: {} }) });
    c.push({ id: 'add', group: 'General', label: 'Add project', icon: FolderPlus, run: () => lina.setUI({ addProject: true }) });
    c.push({ id: 'insp', group: 'General', label: 'Toggle inspector', icon: PanelRight, keys: `${modKey}+I`, run: () => lina.toggleInspector() });
    c.push({ id: 'side', group: 'General', label: 'Toggle sidebar', icon: PanelLeft, keys: `${modKey}+B`, run: () => lina.toggleSidebar() });
    c.push({ id: 'theme', group: 'General', label: theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme', icon: Moon, run: () => lina.setTheme(theme === 'dark' ? 'light' : 'dark') });
    c.push({ id: 'settings', group: 'General', label: 'Settings & default models', icon: Settings2, run: () => lina.setUI({ settings: 'general' }) });
    c.push({ id: 'modelsg', group: 'General', label: 'Validate models', icon: Cpu, run: () => lina.setUI({ settings: 'models' }) });
    c.push({ id: 'doctor', group: 'General', label: 'Run doctor', icon: Stethoscope, run: () => lina.setUI({ settings: 'doctor' }) });
    const pname = new Map(projects.map((p) => [p.id, p.name]));
    for (const s of Object.values(sessions).sort((a, b) => b.updatedAt - a.updatedAt)) {
      c.push({
        id: `s-${s.id}`, group: 'Sessions', label: s.title || 'Untitled session',
        hint: `${pname.get(s.projectId) ?? ''} · ${s.status === 'running' ? PHASE_LABEL[s.phase] : relTime(s.updatedAt)}`,
        icon: MessageSquare, dot: <SessionDot status={s.status} />, run: () => lina.select(s.id),
      });
    }
    return c;
  }, [view, sessions, projects, theme, lina]);

  const ql = q.trim().toLowerCase();
  const results = useMemo(() => cmds.map((c) => ({ c, s: score(ql, `${c.label} ${c.hint ?? ''}`) })).filter((x) => x.s > 0)
    .sort((a, b) => (ql ? b.s - a.s : 0)).slice(0, 60).map((x) => x.c), [cmds, ql]);
  useEffect(() => setIdx(0), [ql]);
  useEffect(() => { list.current?.querySelector('.is-on')?.scrollIntoView({ block: 'nearest' }); }, [idx]);

  if (!open) return null;
  const exec = (c?: Cmd) => { if (!c) return; close(); setTimeout(c.run, 0); };

  let lastGroup = '';
  return createPortal(
    <div className="scrim scrim-top" onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="palette-input">
          <Search size={16} />
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type a command or search sessions…"
            role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={results[idx] ? `pc-${results[idx].id}` : undefined}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(results.length - 1, i + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
              else if (e.key === 'Enter') { e.preventDefault(); exec(results[idx]); }
              else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
            }} />
          <kbd className="kbd">Esc</kbd>
        </div>
        <div className="palette-list" id="palette-list" role="listbox" ref={list}>
          {results.length === 0 && <div className="palette-empty">No matches</div>}
          {results.map((c, i) => {
            const header = !ql && c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <div key={c.id}>
                {header && <div className="palette-group">{header}</div>}
                <button id={`pc-${c.id}`} role="option" aria-selected={i === idx} className={cx('palette-item', i === idx && 'is-on')}
                  onMouseMove={() => setIdx(i)} onClick={() => exec(c)}>
                  {c.dot ?? <c.icon size={15} />}
                  <span className="palette-label">{c.label}</span>
                  {c.hint && <span className="palette-hint">{c.hint}</span>}
                  {c.keys && <kbd className="kbd">{c.keys}</kbd>}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
