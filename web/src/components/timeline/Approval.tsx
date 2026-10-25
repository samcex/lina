import { useState } from 'react';
import {
  Ban, CircleAlert, CircleCheck, GitBranch, GitMerge, GitPullRequestArrow, MessageSquarePlus, ShieldCheck, Stamp, TriangleAlert, XCircle,
} from 'lucide-react';
import type { ApplyStrategy, Finding, LinaEvent } from '@shared/types';
import { useLina, type ApiErr } from '../../lib/lina';
import { useApp } from '../../lib/store';
import { clockTime, cx } from '../../lib/format';
import { Markdown } from '../Markdown';
import { FindingRow, SeverityTally } from '../Findings';
import { Spinner } from '../ui/Overlay';
import { BrandMark } from '../ui/Glyphs';
import { CandidateChoice } from './Compete';
import { SandboxBadge, VariantChip } from '../Variants';
import { poss } from '../../lib/modes';

const STRATEGIES: { id: ApplyStrategy; label: string; icon: typeof GitMerge; tip: string }[] = [
  { id: 'squash', label: 'Approve & squash', icon: GitPullRequestArrow, tip: 'One commit on your current branch' },
  { id: 'merge', label: 'Merge', icon: GitMerge, tip: "Merge commit preserving LINA's checkpoints" },
  { id: 'branch', label: 'Branch only', icon: GitBranch, tip: "Only create the branch in your repo — your working tree isn't touched" },
];

function explain(err: ApiErr, projectPath?: string) {
  if (err.code === 'dirty_worktree') {
    return {
      title: 'Your project has uncommitted changes',
      body: <>LINA won't squash or merge over local edits in <code>{projectPath ?? 'your project'}</code>. Commit or stash them and try again — or choose <b>Branch only</b>, which doesn't touch your working tree.</>,
    };
  }
  if (err.code === 'choose_variant') {
    return {
      title: 'Pick a version first',
      body: <>This session is a competition. Choose Codex's or Claude's version — or use <b>Approve … version</b> on one of them to choose and apply in one step.</>,
    };
  }
  if (err.code === 'conflict') {
    return {
      title: 'The changes conflict with your current branch',
      body: <>LINA aborted cleanly and nothing was applied. Choose <b>Branch only</b> to get <code>lina/…</code> in your repo and resolve the merge yourself.</>,
    };
  }
  return { title: err.message, body: err.hint ? <>{err.hint}</> : null };
}

export function ApprovalPanel({ summary, unresolved, compact }: { summary?: string; unresolved: Finding[]; compact?: boolean }) {
  const lina = useLina();
  const view = useApp((s) => s.view);
  const findings = useApp((s) => s.view?.findings ?? []);
  const [busy, setBusy] = useState<ApplyStrategy | 'reject' | null>(null);
  const [err, setErr] = useState<ApiErr | null>(null);
  const [confirmReject, setConfirmReject] = useState(false);
  const [note, setNote] = useState('');

  const chosen = view?.session.chosenVariant;
  // After a compete choice the rival candidate's findings no longer apply.
  const live = unresolved.map((f) => findings.find((x) => x.id === f.id) ?? f)
    .filter((f) => !['resolved', 'withdrawn', 'waived'].includes(f.status))
    .filter((f) => !chosen || !f.variant || f.variant === chosen)
    .filter((f) => !findings.length || findings.some((x) => x.id === f.id));
  const escalated = live.filter((f) => f.status === 'escalated');
  // After a compete choice, the rival's worktree runs no longer describe what you are approving.
  const runs = (view?.tests ?? []).filter((t) => !view?.session.chosenVariant || !t.variant || t.variant === view.session.chosenVariant);
  const lastTests = runs[runs.length - 1];

  const approve = async (s: ApplyStrategy) => {
    setBusy(s); setErr(null);
    const e = await lina.approve(s, note.trim() || undefined);
    setBusy(null);
    if (e) setErr(e); else lina.toast({ tone: 'ok', title: s === 'branch' ? 'Branch created in your repo' : 'Applied to your repo', detail: s === 'branch' ? undefined : `Strategy: ${s}` });
  };
  const reject = async () => {
    setBusy('reject'); setErr(null);
    const e = await lina.reject(note.trim() || undefined);
    setBusy(null); setConfirmReject(false);
    if (e) setErr(e);
  };
  const ex = err ? explain(err, view?.project.path) : null;

  return (
    <div className={cx('approval-panel', compact && 'is-compact')}>
      {summary && <div className="approval-summary"><Markdown text={summary} /></div>}

      <div className="approval-facts">
        {lastTests && (
          <span className={cx('fact', lastTests.ok ? 'is-ok' : lastTests.skippedReason ? '' : 'is-bad')}>
            <ShieldCheck size={13} /> {lastTests.skippedReason ? 'Tests skipped' : lastTests.ok ? 'Tests pass' : 'Tests fail'} <em>verified by LINA</em>
          </span>
        )}
        {lastTests && !lastTests.skippedReason && <SandboxBadge sandboxed={lastTests.sandboxed} compact />}
        <span className={cx('fact', live.length ? 'is-warn' : 'is-ok')}>
          {live.length ? <TriangleAlert size={13} /> : <CircleCheck size={13} />} {live.length ? `${live.length} unresolved` : 'No open findings'}
        </span>
        {live.length > 0 && <SeverityTally findings={live} />}
      </div>

      {live.length > 0 && (
        <div className="approval-unresolved">
          {escalated.length > 0 && <div className="approval-sub"><TriangleAlert size={12} /> Escalated — they disagree, you decide</div>}
          {[...escalated, ...live.filter((f) => f.status !== 'escalated')].map((f) => (
            <FindingRow key={f.id} f={f} showHistory
              actions={f.status === 'escalated' ? (
                <button className="btn btn-xs" onClick={() => void lina.waive(f.id)} data-tip="Accept without a fix (recorded as your decision)">Waive</button>
              ) : undefined}
            />
          ))}
        </div>
      )}

      <label className="approval-note">
        <span className="sr-only">Note (optional)</span>
        <input className="input input-sm" placeholder="Optional note for the record…" value={note} onChange={(e) => setNote(e.target.value)} />
      </label>

      {ex && (
        <div className="approval-err" role="alert">
          <CircleAlert size={15} />
          <div><b>{ex.title}</b>{ex.body && <p>{ex.body}</p>}</div>
        </div>
      )}

      <div className="approval-actions">
        {STRATEGIES.map((s, i) => (
          <button key={s.id} className={cx('btn', i === 0 ? 'btn-primary btn-glow' : 'btn-outline')} disabled={!!busy} onClick={() => void approve(s.id)} data-tip={s.tip}>
            {busy === s.id ? <Spinner size={13} /> : <s.icon size={14} />} {s.label}
          </button>
        ))}
        <span className="approval-gap" />
        <button className="btn btn-ghost" disabled={!!busy} onClick={() => { lina.prefillComposer(''); lina.focusComposer(); lina.toast({ tone: 'info', title: 'Describe the changes you want', detail: 'Your next message starts a revision cycle.' }); }}>
          <MessageSquarePlus size={14} /> Request changes
        </button>
        {!confirmReject ? (
          <button className="btn btn-ghost btn-danger-text" disabled={!!busy} onClick={() => setConfirmReject(true)}><Ban size={14} /> Reject</button>
        ) : (
          <span className="confirm-inline" role="group" aria-label="Confirm rejection">
            <span>Reject this work? The workspace is kept until you delete the session.</span>
            <button className="btn btn-sm btn-ghost" onClick={() => setConfirmReject(false)}>Keep</button>
            <button className="btn btn-sm btn-danger" onClick={() => void reject()} disabled={busy === 'reject'} data-autofocus>
              {busy === 'reject' ? <Spinner size={12} /> : <XCircle size={13} />} Reject
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

export function ApprovalCard({ e, active }: { e: LinaEvent<'approval'>; active: boolean }) {
  const chosen = useApp((s) => s.view?.session.chosenVariant);
  const d = e.data;
  if (d.state === 'requested') {
    if (!active) {
      return (
        <div className="card card-approval-past" id={`ev-${e.seq}`}>
          <Stamp size={14} /> {d.candidates?.length ? `Choice requested · ${d.candidates.length} candidates` : 'Approval requested'} · {clockTime(e.ts)}
          {d.unresolved?.length ? <span className="text-dim"> · {d.unresolved.length} unresolved</span> : null}
        </div>
      );
    }
    const choosing = !!d.candidates?.length && !chosen;
    return (
      <section className={cx('card card-approval', choosing && 'is-choice')} id={`ev-${e.seq}`} aria-label={choosing ? 'Choose a version' : 'Approval required'}>
        <div className="approval-hero">
          <BrandMark size={34} />
          <div>
            <h3>{choosing ? 'Two versions — you pick the winner' : 'Ready for your approval'}</h3>
            <p>{choosing
              ? 'Each agent built the task on its own and reviewed the other\'s version. Every number below was measured by LINA.'
              : 'Nothing touches your repository until you choose how to apply it.'}</p>
          </div>
        </div>
        {choosing ? <CandidateChoice candidates={d.candidates!} summary={d.summary} /> : (
          <>
            {chosen && d.candidates?.length ? (
              <div className="chosen-note" data-agent={chosen}>
                <VariantChip agent={chosen} text={`${poss(chosen)} version chosen`} />
                <span>It is now the session branch; the other version's findings were dropped. Approve to apply it, or keep iterating.</span>
              </div>
            ) : null}
            <ApprovalPanel summary={d.summary} unresolved={d.unresolved ?? []} />
          </>
        )}
      </section>
    );
  }
  const ok = d.state === 'approved';
  return (
    <section className={cx('card card-outcome', ok ? 'is-ok' : d.state === 'rejected' ? 'is-rejected' : 'is-bad')} id={`ev-${e.seq}`}>
      {ok ? <CircleCheck size={17} /> : d.state === 'rejected' ? <Ban size={17} /> : <CircleAlert size={17} />}
      <div>
        <div className="outcome-title">
          {ok ? `Approved${d.variant ? ` · ${poss(d.variant)} version` : ''}${d.strategy ? ` · ${d.strategy === 'branch' ? 'branch created' : d.strategy}` : ''}` : d.state === 'rejected' ? 'Rejected' : 'Apply failed'}
        </div>
        {(d.result || d.note) && <div className="outcome-detail">{d.result}{d.result && d.note ? ' — ' : ''}{d.note && <i>“{d.note}”</i>}</div>}
      </div>
      <time>{clockTime(e.ts)}</time>
    </section>
  );
}
