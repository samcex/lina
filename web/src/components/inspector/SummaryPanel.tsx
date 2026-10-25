import { useMemo, useState } from 'react';
import { ScrollText, Trash } from 'lucide-react';
import { useLina } from '../../lib/lina';
import type { LinaEvent } from '@shared/types';
import type { SessionView } from '@shared/reducer';
import { lastOf } from '../../lib/timeline';
import { SESSION_STATUS_LABEL, shortSha, fullTime } from '../../lib/format';
import { Markdown } from '../Markdown';
import { ApprovalPanel, ApprovalCard } from '../timeline/Approval';
import { CandidateChoice } from '../timeline/Compete';
import { Empty } from '../ui/Overlay';

export function SummaryPanel({ view }: { view: SessionView }) {
  const summary = useMemo(() => {
    for (let i = view.timeline.length - 1; i >= 0; i--) {
      const e = view.timeline[i];
      if (e.type === 'message' && e.data.kind === 'summary') return e as LinaEvent<'message'>;
    }
    return undefined;
  }, [view.timeline]);
  const approval = lastOf(view.timeline, 'approval');
  const awaiting = view.session.status === 'awaiting_approval';
  const s = view.session;

  return (
    <div className="summary-panel">
      {summary ? (
        <section className="summary-doc">
          <div className="msg-kind"><ScrollText size={12} /> Final summary · {fullTime(summary.ts)}</div>
          <Markdown text={summary.data.text} />
        </section>
      ) : !awaiting && (
        <Empty icon={<ScrollText size={22} />} title="No summary yet">LINA summarizes the changes, tests and review findings when the task finishes.</Empty>
      )}

      {awaiting && (
        <section className="summary-approval">
          <h3 className="panel-h">{approval?.data.candidates?.length && !s.chosenVariant ? 'Pick the winner' : 'Your decision'}</h3>
          {approval?.data.candidates?.length && !s.chosenVariant
            ? <CandidateChoice candidates={approval.data.candidates} compact />
            : <ApprovalPanel summary={summary ? undefined : approval?.data.summary} unresolved={approval?.data.unresolved ?? []} compact />}
        </section>
      )}
      {!awaiting && approval && approval.data.state !== 'requested' && <ApprovalCard e={approval} active={false} />}

      <dl className="facts">
        <dt>Status</dt><dd>{SESSION_STATUS_LABEL[s.status]}</dd>
        <dt>Branch</dt><dd className="mono">{s.branch}</dd>
        <dt>Base</dt><dd className="mono">{shortSha(s.baseCommit)}</dd>
        {s.headCommit && <><dt>Head</dt><dd className="mono">{shortSha(s.headCommit)}</dd></>}
        <dt>Workspace</dt><dd className="mono facts-path" title={s.workspacePath}>{s.workspacePath}</dd>
      </dl>
      <DeleteSession id={s.id} running={s.status === 'running'} />
    </div>
  );
}

function DeleteSession({ id, running }: { id: string; running: boolean }) {
  const lina = useLina();
  const [confirm, setConfirm] = useState(false);
  if (!confirm) {
    return <button className="btn btn-sm btn-ghost btn-danger-text danger-zone" onClick={() => setConfirm(true)} disabled={running} data-tip={running ? 'Cancel the session first' : undefined}><Trash size={13} /> Delete session…</button>;
  }
  return (
    <div className="confirm-inline" role="group" aria-label="Confirm delete">
      <span>Delete this session and any isolated workspace? Files in your project are kept.</span>
      <button className="btn btn-sm btn-ghost" onClick={() => setConfirm(false)}>Keep</button>
      <button className="btn btn-sm btn-danger" onClick={() => void lina.deleteSession(id)}><Trash size={13} /> Delete</button>
    </div>
  );
}
