import { useState } from 'react';
import {
  Ban, ChevronDown, CircleAlert, CircleCheck, CircleX, Coins, FileDiff, FlaskConical, GitBranch, GitMerge, GitPullRequestArrow,
  ListChecks, MessageSquarePlus, Scale, Trophy, XCircle,
} from 'lucide-react';
import type { AgentId, ApplyStrategy, Candidate } from '@shared/types';
import { useLina, type ApiErr } from '../../lib/lina';
import { useApp } from '../../lib/store';
import { AGENT_NAME, cx, other, shortSha, tokens, usd } from '../../lib/format';
import { poss } from '../../lib/modes';
import { Markdown } from '../Markdown';
import { Avatar } from '../ui/Glyphs';
import { Spinner } from '../ui/Overlay';
import { Popover } from '../ui/Popover';
import { SandboxBadge } from '../Variants';
import { DiffBar } from './Cards';

export const APPLY: { id: ApplyStrategy; label: string; hint: string; icon: typeof GitMerge }[] = [
  { id: 'squash', label: 'Squash', hint: 'One commit on your current branch', icon: GitPullRequestArrow },
  { id: 'merge', label: 'Merge', hint: "Merge commit keeping LINA's checkpoints", icon: GitMerge },
  { id: 'branch', label: 'Branch only', hint: "Only create the branch — your working tree isn't touched", icon: GitBranch },
];

type Busy = `choose:${AgentId}` | `approve:${AgentId}:${ApplyStrategy}` | 'reject' | null;

/** compete: side-by-side comparison of both candidates, measured by LINA, with choose / approve actions. */
export function CandidateChoice({ candidates, summary, compact }: { candidates: Candidate[]; summary?: string; compact?: boolean }) {
  const lina = useLina();
  const projectPath = useApp((s) => s.view?.project.path);
  const [busy, setBusy] = useState<Busy>(null);
  const [err, setErr] = useState<ApiErr | null>(null);
  const [confirmReject, setConfirmReject] = useState(false);
  const [showSummary, setShowSummary] = useState(false);

  const choose = async (a: AgentId) => {
    setBusy(`choose:${a}`); setErr(null);
    const e = await lina.choose(a);
    setBusy(null);
    if (e) setErr(e);
  };
  const approve = async (a: AgentId, s: ApplyStrategy) => {
    setBusy(`approve:${a}:${s}`); setErr(null);
    const e = await lina.approve(s, undefined, a);
    setBusy(null);
    if (e) { if (e.code !== 'choose_variant') setErr(e); }
    else lina.toast({ tone: 'ok', title: `${poss(a)} version ${s === 'branch' ? 'branch created in your repo' : 'applied to your repo'}`, detail: s === 'branch' ? undefined : `Strategy: ${s}` });
  };
  const reject = async () => {
    setBusy('reject'); setErr(null);
    const e = await lina.reject();
    setBusy(null); setConfirmReject(false);
    if (e) setErr(e);
  };

  const ordered = [...candidates].sort((a, b) => (a.agent === 'codex' ? -1 : 1) - (b.agent === 'codex' ? -1 : 1));
  return (
    <div className={cx('cand-choice', compact && 'is-compact')}>
      {summary && (
        compact ? (
          <button className="disclosure" onClick={() => setShowSummary((x) => !x)} aria-expanded={showSummary}>
            <Scale size={13} /> {showSummary ? 'Hide' : 'Show'} LINA's comparison
          </button>
        ) : null
      )}
      {summary && (!compact || showSummary) && <div className="approval-summary"><Markdown text={summary} /></div>}

      <div className={cx('cand-grid', compact && 'is-compact')}>
        {ordered.map((c) => (
          <CandidateColumn key={c.agent} c={c} busy={busy} onChoose={() => void choose(c.agent)} onApprove={(s) => void approve(c.agent, s)} />
        ))}
      </div>

      {err && (
        <div className="approval-err" role="alert">
          <CircleAlert size={15} />
          <div>
            <b>{err.code === 'dirty_worktree' ? 'Your project has uncommitted changes' : err.message}</b>
            <p>{err.code === 'dirty_worktree'
              ? <>LINA won't squash or merge over local edits in <code>{projectPath ?? 'your project'}</code>. Commit or stash them — or use <b>Branch only</b>.</>
              : err.hint}</p>
          </div>
        </div>
      )}

      <div className="approval-actions cand-foot">
        <span className="cand-foot-note">Not happy with either? Your message goes to both agents, who revise their own version.</span>
        <span className="approval-gap" />
        <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => { lina.prefillComposer(''); lina.focusComposer(); lina.toast({ tone: 'info', title: 'Describe the changes you want', detail: 'Both candidates revise, then test and cross-review again.' }); }}>
          <MessageSquarePlus size={14} /> Request changes
        </button>
        {!confirmReject ? (
          <button className="btn btn-ghost btn-sm btn-danger-text" disabled={!!busy} onClick={() => setConfirmReject(true)}><Ban size={14} /> Reject both</button>
        ) : (
          <span className="confirm-inline" role="group" aria-label="Confirm rejection">
            <span>Reject both versions?</span>
            <button className="btn btn-sm btn-ghost" onClick={() => setConfirmReject(false)}>Keep</button>
            <button className="btn btn-sm btn-danger" onClick={() => void reject()} disabled={busy === 'reject'}>
              {busy === 'reject' ? <Spinner size={12} /> : <XCircle size={13} />} Reject
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

function CandidateColumn({ c, busy, onChoose, onApprove }: { c: Candidate; busy: Busy; onChoose: () => void; onApprove: (s: ApplyStrategy) => void }) {
  const lina = useLina();
  const t = c.tests;
  const rival = other(c.agent);
  const verdict = c.verdict === 'approve' ? { cls: 'ok', text: 'approves', icon: CircleCheck }
    : c.verdict === 'request_changes' ? { cls: 'warn', text: 'requests changes', icon: CircleAlert }
    : c.verdict === 'unparsed' ? { cls: 'dim', text: 'verdict unparsed', icon: CircleAlert } : null;
  const anyBusy = !!busy;
  return (
    <article className="cand" data-agent={c.agent} aria-label={`${poss(c.agent)} version`}>
      <header className="cand-head">
        <Avatar actor={c.agent} size={28} />
        <div className="cand-titles">
          <div className="cand-name">{poss(c.agent)} version</div>
          <div className="cand-sha mono">{shortSha(c.headCommit)}</div>
        </div>
        <button className="btn btn-xs btn-outline" onClick={() => lina.viewWorktree(c.agent)} data-tip="Opens the diff of this worktree">
          <FileDiff size={12} /> View diff
        </button>
      </header>

      <dl className="cand-facts">
        <dt><FlaskConical size={12} /> Tests</dt>
        <dd>
          {!t ? <span className="text-dim">not run</span>
            : t.skippedReason ? <span className="text-dim" title={t.skippedReason}>skipped</span>
            : <>
              <span className={t.ok ? 'text-ok' : 'text-bad'}>{t.ok ? <CircleCheck size={12} /> : <CircleX size={12} />} {t.ok ? 'pass' : 'fail'}</span>
              {(t.passed != null || t.failed != null) && <span className="mono cand-num">{t.passed ?? 0}✓{t.failed ? <span className="text-bad"> {t.failed}✗</span> : null}</span>}
              <SandboxBadge sandboxed={t.sandboxed} compact />
            </>}
        </dd>
        <dt><FileDiff size={12} /> Changes</dt>
        <dd><span>{c.files} file{c.files === 1 ? '' : 's'}</span><DiffBar add={c.additions} del={c.deletions} /></dd>
        <dt><ListChecks size={12} /> Findings</dt>
        <dd>
          {c.openFindings === 0 ? <span className="text-ok">none open</span> : <span>{c.openFindings} open</span>}
          {c.blockingFindings > 0 ? <span className="cand-block">{c.blockingFindings} blocking</span> : c.openFindings > 0 ? <span className="text-dim">none blocking</span> : null}
        </dd>
        <dt><Trophy size={12} /> {AGENT_NAME[rival]}</dt>
        <dd>{verdict ? <span className={cx('cand-verdict', `is-${verdict.cls}`)} data-agent={rival}><verdict.icon size={12} /> {verdict.text}</span> : <span className="text-dim">not reviewed</span>}</dd>
        <dt><Coins size={12} /> Usage</dt>
        <dd className="mono cand-usage">
          <span title="Input + output tokens">{tokens(c.usage.inputTokens + c.usage.outputTokens)} tok</span>
          <span title="API-equivalent cost (subscription users are not billed this)">≈{usd(c.usage.costUsd)}</span>
          <span>{c.usage.turns} turn{c.usage.turns === 1 ? '' : 's'}</span>
        </dd>
      </dl>

      <div className="cand-actions">
        <button className="btn cand-choose" disabled={anyBusy} onClick={onChoose} data-tip="Adopt this version, then keep reviewing or approve">
          {busy === `choose:${c.agent}` ? <Spinner size={13} /> : <Trophy size={14} />} Choose {poss(c.agent)} version
        </button>
        <SplitApprove agent={c.agent} busy={busy} disabled={anyBusy} onApprove={onApprove} />
      </div>
    </article>
  );
}

/** "Approve Codex's version" + a menu for squash / merge / branch. */
function SplitApprove({ agent, busy, disabled, onApprove }: { agent: AgentId; busy: Busy; disabled: boolean; onApprove: (s: ApplyStrategy) => void }) {
  const mine = busy?.startsWith(`approve:${agent}:`);
  return (
    <div className="split-btn" data-agent={agent}>
      <button className="btn btn-outline split-main" disabled={disabled} onClick={() => onApprove('squash')} title="Choose and apply in one step (squash)">
        {mine ? <Spinner size={13} /> : <GitPullRequestArrow size={14} />} Approve {poss(agent)} version
      </button>
      <Popover align="end" side="top" width={260}
        trigger={({ open, toggle }) => (
          <button className={cx('btn btn-outline split-more', open && 'is-open')} disabled={disabled} onClick={toggle} aria-haspopup="menu" aria-expanded={open} aria-label={`Ways to apply ${poss(agent)} version`}>
            <ChevronDown size={14} />
          </button>
        )}>
        {(close) => (
          <div className="menu" role="menu">
            <div className="menu-label">Approve {poss(agent)} version as…</div>
            {APPLY.map((s) => (
              <button key={s.id} role="menuitem" className="menu-item" onClick={() => { close(); onApprove(s.id); }}>
                <s.icon size={15} />
                <span className="menu-item-main"><span>{s.label}</span><small>{s.hint}</small></span>
              </button>
            ))}
          </div>
        )}
      </Popover>
    </div>
  );
}
