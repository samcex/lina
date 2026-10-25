import { useMemo } from 'react';
import { FlaskConical } from 'lucide-react';
import type { AgentId, LinaEvent } from '@shared/types';
import { AGENT_IDS } from '@shared/types';
import type { SessionView } from '@shared/reducer';
import { TestsCard } from '../timeline/Cards';
import { Empty } from '../ui/Overlay';
import { Glyph } from '../ui/Glyphs';
import { cx } from '../../lib/format';
import { poss } from '../../lib/modes';

type Run = LinaEvent<'tests'>;

export function TestsPanel({ view }: { view: SessionView }) {
  const runs = useMemo(() => view.timeline.filter((e): e is Run => e.type === 'tests').reverse(), [view.timeline]);
  // compete / parallel (before integration): one group per worktree, then the session workspace.
  const groups = useMemo(() => {
    const keys: (AgentId | 'main')[] = [...AGENT_IDS.filter((a) => runs.some((r) => r.data.variant === a)), ...(runs.some((r) => !r.data.variant) ? ['main' as const] : [])];
    return keys.map((k) => ({ key: k, runs: runs.filter((r) => (r.data.variant ?? 'main') === k) }));
  }, [runs]);
  if (!runs.length) {
    return <Empty icon={<FlaskConical size={22} />} title="No test runs yet">LINA runs the project's test command itself after each writing turn — results here are verified, not claimed.</Empty>;
  }
  const passed = runs.filter((r) => r.data.ok && !r.data.skippedReason).length;
  const unsandboxed = runs.filter((r) => !r.data.sandboxed && !r.data.skippedReason).length;
  const grouped = groups.length > 1 || groups[0]?.key !== 'main';
  return (
    <div className="tests-panel">
      <div className="panel-toolbar">
        <span className="panel-stat">
          {runs.length} run{runs.length === 1 ? '' : 's'} · <span className="text-ok">{passed} passing</span>
          {unsandboxed > 0 && <> · <span className="text-warn">{unsandboxed} not sandboxed</span></>}
        </span>
      </div>
      {grouped ? groups.map((g) => {
        const latest = g.runs[0]?.data;
        return (
          <section key={g.key} className="tests-group" data-agent={g.key === 'main' ? undefined : g.key}>
            <header className="tests-group-head">
              {g.key === 'main' ? <span className="tests-group-name">Session workspace</span>
                : <span className="tests-group-name"><Glyph actor={g.key} size={13} /> {poss(g.key)} worktree</span>}
              <span className="tests-group-count">{g.runs.length} run{g.runs.length === 1 ? '' : 's'}</span>
              {latest && <span className={cx('tests-group-last', latest.skippedReason ? '' : latest.ok ? 'text-ok' : 'text-bad')}>latest: {latest.skippedReason ? 'skipped' : latest.ok ? 'pass' : 'fail'}</span>}
            </header>
            <History runs={g.runs} hideVariant />
          </section>
        );
      }) : <History runs={runs} />}
    </div>
  );
}

function History({ runs, hideVariant }: { runs: Run[]; hideVariant?: boolean }) {
  return (
    <div className="tests-history">
      {runs.map((r, i) => (
        <div key={r.seq} className="tests-hist-item">
          <span className="tests-hist-idx mono">#{runs.length - i}</span>
          <TestsCard e={r} hideVariant={hideVariant} />
        </div>
      ))}
    </div>
  );
}
