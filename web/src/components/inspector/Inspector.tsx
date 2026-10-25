import { useMemo, useRef, type PointerEvent as RPointerEvent } from 'react';
import { Activity, FileDiff, FolderTree, ListChecks, FlaskConical, ScrollText, X } from 'lucide-react';
import { AGENT_IDS } from '@shared/types';
import type { SessionView } from '@shared/reducer';
import { useLina } from '../../lib/lina';
import { useUI, type InspectorTab } from '../../lib/store';
import { cx } from '../../lib/format';
import { isBusy } from '../ui/Status';
import { LivePanel } from './LivePanel';
import { ChangesPanel } from './ChangesPanel';
import { FilesPanel } from './FilesPanel';
import { ReviewBoard } from './ReviewBoard';
import { TestsPanel } from './TestsPanel';
import { SummaryPanel } from './SummaryPanel';
import { PreviewsPanel } from './PreviewsPanel';

const TABS: { id: InspectorTab; label: string; icon: typeof Activity }[] = [
  { id: 'live', label: 'Live', icon: Activity },
  { id: 'changes', label: 'Changes', icon: FileDiff },
  { id: 'files', label: 'Files', icon: FolderTree },
  { id: 'review', label: 'Review', icon: ListChecks },
  { id: 'tests', label: 'Tests', icon: FlaskConical },
  { id: 'previews', label: 'Previews', icon: Activity },
  { id: 'summary', label: 'Summary', icon: ScrollText },
];

export function Inspector({ view }: { view: SessionView }) {
  const lina = useLina();
  const tab = useUI((u) => u.inspectorTab);
  const width = useUI((u) => u.inspectorWidth);
  const drag = useRef<{ x: number; w: number } | null>(null);

  const badges = useMemo(() => {
    const busy = AGENT_IDS.filter((a) => isBusy(view.agents[a].status)).length;
    const files = new Set<string>();
    for (const e of view.timeline) if (e.type === 'checkpoint') for (const f of e.data.files) files.add(f.path);
    const open = view.findings.filter((f) => ['open', 'disputed', 'fixed', 'escalated'].includes(f.status)).length;
    const escalated = view.findings.some((f) => f.status === 'escalated');
    const last = view.tests[view.tests.length - 1];
    return {
      live: busy ? { n: busy, tone: 'live' } : null,
      changes: files.size ? { n: files.size, tone: '' } : null,
      files: null,
      previews: null,
      review: open ? { n: open, tone: escalated ? 'warn' : '' } : null,
      tests: view.tests.length ? { n: view.tests.length, tone: last && !last.ok && !last.skippedReason ? 'bad' : 'ok' } : null,
      summary: view.session.status === 'awaiting_approval' ? { n: '!', tone: 'iris' } : null,
    } as Record<InspectorTab, { n: number | string; tone: string } | null>;
  }, [view]);

  const onDown = (e: RPointerEvent<HTMLDivElement>) => {
    drag.current = { x: e.clientX, w: width };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const w = Math.max(320, Math.min(Math.round(window.innerWidth * 0.6), drag.current.w + (drag.current.x - e.clientX)));
    document.documentElement.style.setProperty('--inspector-w', `${w}px`);
  };
  const onUp = (e: RPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const w = Math.max(320, Math.min(Math.round(window.innerWidth * 0.6), drag.current.w + (drag.current.x - e.clientX)));
    drag.current = null;
    lina.setUI({ inspectorWidth: w });
  };

  return (
    <aside className="inspector" aria-label="Inspector">
      <div className="insp-resize" role="separator" aria-orientation="vertical" aria-label="Resize inspector"
        tabIndex={0} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') lina.setUI({ inspectorWidth: Math.min(window.innerWidth * 0.6, width + 24) });
          if (e.key === 'ArrowRight') lina.setUI({ inspectorWidth: Math.max(320, width - 24) });
        }} />
      <div className="insp-tabs" role="tablist" aria-label="Inspector views">
        {TABS.map((t) => {
          const b = badges[t.id];
          return (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={cx('insp-tab', tab === t.id && 'is-active')}
              onClick={() => lina.setUI({ inspectorTab: t.id })} id={`tab-${t.id}`} aria-controls={`panel-${t.id}`}>
              <t.icon size={14} />
              <span className="insp-tab-label">{t.label}</span>
              {b && <span className={cx('badge', b.tone && `is-${b.tone}`)}>{b.n}</span>}
            </button>
          );
        })}
        <button className="icon-btn insp-close" onClick={() => lina.setUI({ inspectorOpen: false })} aria-label="Close inspector"><X size={16} /></button>
      </div>
      <div className="insp-body" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'live' && <LivePanel view={view} />}
        {tab === 'changes' && <ChangesPanel view={view} />}
        {tab === 'files' && <FilesPanel view={view} />}
        {tab === 'review' && <ReviewBoard view={view} />}
        {tab === 'tests' && <TestsPanel view={view} />}
        {tab === 'previews' && <PreviewsPanel view={view} />}
        {tab === 'summary' && <SummaryPanel view={view} />}
      </div>
    </aside>
  );
}
