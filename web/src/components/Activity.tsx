import { useState } from 'react';
import { ChevronRight, Quote } from 'lucide-react';
import type { ActivityKind } from '@shared/types';
import { cx, clockTime } from '../lib/format';
import { ActivityIcon } from './ui/Status';
import { Spinner } from './ui/Overlay';

export interface ActLike {
  kind: ActivityKind; title: string; detail?: string; state: 'running' | 'ok' | 'error';
  exitCode?: number | null; output?: string; files?: string[]; source: 'observed' | 'narrated'; ts: number;
}

/** One activity line. Observed = real tool event; narrated = the agent's own words. */
export function ActivityRow({ a, showTime }: { a: ActLike; showTime?: boolean }) {
  const [open, setOpen] = useState(false);
  if (a.source === 'narrated') {
    return (
      <li className="act is-narrated">
        <span className="act-icon"><Quote size={12} /></span>
        <div className="act-main">
          <span className="act-said">said</span>
          <q className="act-quote">{a.title}{a.detail && a.detail.trim() !== a.title.trim() ? ` — ${a.detail}` : ''}</q>
        </div>
        {showTime && <time className="act-time">{clockTime(a.ts)}</time>}
      </li>
    );
  }
  const expandable = !!(a.output || a.detail || a.files?.length);
  return (
    <li className={cx('act is-observed', `is-${a.state}`, open && 'is-open')}>
      <span className="act-icon"><ActivityIcon kind={a.kind} size={13} /></span>
      <div className="act-main">
        <button className="act-head" onClick={() => expandable && setOpen((o) => !o)} aria-expanded={expandable ? open : undefined} disabled={!expandable}>
          <span className="act-title mono">{a.title}</span>
          {expandable && <ChevronRight size={12} className={cx('chev', open && 'is-open')} />}
        </button>
        {open && (
          <div className="act-body">
            {a.detail && <p className="act-detail">{a.detail}</p>}
            {a.files?.length ? <div className="act-files">{a.files.map((f) => <code key={f}>{f}</code>)}</div> : null}
            {a.output && <pre className="act-output">{a.output}</pre>}
          </div>
        )}
      </div>
      <span className="act-state">
        {a.state === 'running' ? <Spinner size={12} /> : a.state === 'ok'
          ? <span className="act-ok">✓{a.exitCode != null && a.kind === 'command' ? <i>{a.exitCode}</i> : null}</span>
          : <span className="act-bad">✗{a.exitCode != null ? <i>{a.exitCode}</i> : null}</span>}
      </span>
      {showTime && <time className="act-time">{clockTime(a.ts)}</time>}
    </li>
  );
}

export function ActivityLegend() {
  return (
    <div className="act-legend">
      <span><i className="lg-obs" /> Observed: real tool events</span>
      <span><i className="lg-nar" /> Said: agent's own words</span>
    </div>
  );
}
