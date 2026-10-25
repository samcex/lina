import { useMemo } from 'react';
import { ListChecks, TriangleAlert } from 'lucide-react';
import type { Finding } from '@shared/types';
import type { SessionView } from '@shared/reducer';
import { useLina } from '../../lib/lina';
import { FindingRow, SEVERITY_ORDER, SeverityTally } from '../Findings';
import { Empty } from '../ui/Overlay';

const LANES: { id: string; title: string; hint: string; match: Finding['status'][] }[] = [
  { id: 'esc', title: 'Needs your decision', hint: 'The agents could not agree', match: ['escalated'] },
  { id: 'open', title: 'In discussion', hint: 'Open, disputed, or awaiting confirmation', match: ['open', 'disputed', 'fixed'] },
  { id: 'closed', title: 'Settled', hint: 'Resolved, withdrawn or waived', match: ['resolved', 'withdrawn', 'waived'] },
];

export function ReviewBoard({ view }: { view: SessionView }) {
  const lina = useLina();
  const sorted = useMemo(
    () => [...view.findings].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || a.id.localeCompare(b.id, undefined, { numeric: true })),
    [view.findings],
  );
  if (!sorted.length) {
    return <Empty icon={<ListChecks size={22} />} title="No findings yet">When the reviewer inspects the changes, each finding is tracked here across rounds — who raised it, who disputed it, and how it was settled.</Empty>;
  }
  return (
    <div className="board">
      <div className="board-summary"><SeverityTally findings={sorted.filter((f) => !['resolved', 'withdrawn', 'waived'].includes(f.status))} /></div>
      {LANES.map((lane) => {
        const list = sorted.filter((f) => lane.match.includes(f.status));
        if (!list.length) return null;
        return (
          <section key={lane.id} className={`lane lane-${lane.id}`}>
            <header className="lane-head">
              {lane.id === 'esc' && <TriangleAlert size={13} />}
              <span className="lane-title">{lane.title}</span>
              <span className="lane-count">{list.length}</span>
              <span className="lane-hint">{lane.hint}</span>
            </header>
            {list.map((f) => (
              <FindingRow key={f.id} f={f} showHistory
                actions={f.status === 'escalated' ? (
                  <button className="btn btn-xs" onClick={() => void lina.waive(f.id)} data-tip="Accept as-is without a fix">Waive</button>
                ) : undefined}
              />
            ))}
          </section>
        );
      })}
    </div>
  );
}
