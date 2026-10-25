import { useState, type ReactNode } from 'react';
import { ChevronRight, FileCode2 } from 'lucide-react';
import type { Finding, FindingStatus, Severity } from '@shared/types';
import { useLina } from '../lib/lina';
import { useApp } from '../lib/store';
import { AGENT_NAME, cx } from '../lib/format';
import { poss } from '../lib/modes';
import { Glyph } from './ui/Glyphs';

export const SEVERITY_ORDER: Severity[] = ['blocker', 'major', 'minor', 'nit'];
export const STATUS_TEXT: Record<FindingStatus, string> = {
  open: 'Open', fixed: 'Fixed?', disputed: 'Disputed', resolved: 'Resolved', withdrawn: 'Withdrawn', escalated: 'Escalated', waived: 'Waived',
};
const STATUS_HELP: Record<FindingStatus, string> = {
  open: 'Raised or maintained by the reviewer',
  fixed: 'Developer says fixed — awaiting reviewer confirmation',
  disputed: 'Developer disagrees, with rationale',
  resolved: 'Reviewer confirmed the fix',
  withdrawn: "Reviewer accepted the developer's argument",
  escalated: 'They could not agree — your decision',
  waived: 'You decided not to fix it',
};

export function SeverityChip({ s }: { s: Severity }) {
  return <span className="sev" data-sev={s}>{s}</span>;
}
export function StatusChip({ s }: { s: FindingStatus }) {
  return <span className="fstat" data-fstat={s} title={STATUS_HELP[s]}>{STATUS_TEXT[s]}</span>;
}

export function FileRef({ file, line }: { file: string; line?: number }) {
  const lina = useLina();
  return (
    <button className="file-link mono" onClick={(e) => { e.stopPropagation(); lina.openInspector('files', { filePath: file }); }} title={`Open ${file}`}>
      <FileCode2 size={12} />{file}{line ? `:${line}` : ''}
    </button>
  );
}

export function SeverityTally({ findings }: { findings: Finding[] }) {
  const counts = SEVERITY_ORDER.map((s) => [s, findings.filter((f) => f.severity === s).length] as const).filter(([, n]) => n);
  if (!counts.length) return null;
  return (
    <span className="tally">
      {counts.map(([s, n]) => <span key={s} className="tally-item" data-sev={s}><i />{n} {s}</span>)}
    </span>
  );
}

/** A finding with expandable detail + per-round history ("who said what"). */
export function FindingRow({ f, current, showHistory = false, actions }: {
  f: Finding; current?: Finding; showHistory?: boolean; actions?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const live = current ?? f;
  const cfg = useApp((s) => s.view?.session.config);
  // Owner is only news when it isn't simply "the developer" of a classic pair session.
  const showOwner = !!f.owner && (!!f.variant || !cfg || cfg.mode === 'parallel' || cfg.mode === 'compete' || cfg.mode === 'custom' || f.owner !== cfg.developer);
  return (
    <div className={cx('finding', open && 'is-open')} data-sev={f.severity} data-fstat={live.status}>
      <button className="finding-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <ChevronRight size={13} className={cx('chev', open && 'is-open')} />
        <SeverityChip s={f.severity} />
        <span className="finding-id mono">{f.id}</span>
        <span className="finding-title">{f.title}</span>
        <StatusChip s={live.status} />
      </button>
      {(f.file || actions || showOwner || f.variant) && (
        <div className="finding-meta">
          {f.variant && <span className="fbadge is-variant" data-agent={f.variant} title={`About ${poss(f.variant)} version (raised by ${AGENT_NAME[f.raisedBy]})`}><Glyph actor={f.variant} size={10} />{poss(f.variant)} version</span>}
          {showOwner && f.owner && <span className="fbadge" data-agent={f.owner} title={`${AGENT_NAME[f.owner]} is expected to fix this`}>fix: {AGENT_NAME[f.owner]}</span>}
          {f.file && <FileRef file={f.file} line={f.line} />}
          {actions && <span className="finding-actions">{actions}</span>}
        </div>
      )}
      {open && (
        <div className="finding-body">
          {f.detail && <p className="finding-detail">{f.detail}</p>}
          {f.suggestion && <div className="finding-suggest"><span>Suggestion</span>{f.suggestion}</div>}
          {showHistory && live.history.length > 0 && <FindingHistory f={live} />}
        </div>
      )}
    </div>
  );
}

export function FindingHistory({ f }: { f: Finding }) {
  return (
    <ol className="fhist">
      {f.history.map((h, i) => (
        <li key={i} className="fhist-item" data-actor={h.actor}>
          <span className="fhist-dot"><Glyph actor={h.actor} size={11} /></span>
          <div className="fhist-body">
            <div className="fhist-head"><b>{AGENT_NAME[h.actor]}</b> <span className="fhist-action">{h.action}</span> <span className="text-dim">· round {h.round}</span></div>
            {h.note && <p className="fhist-note">{h.note}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}
