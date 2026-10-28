import { memo, useState, type ReactNode } from 'react';
import {
  ChevronRight, CircleAlert, FileDiff, GitCommitHorizontal, Play, RotateCcw, ShieldCheck, Timer, ArrowRight, Wrench,
  GitMerge, GitPullRequestDraft, Split, TriangleAlert, CircleCheck, CircleX, FileCode2,
} from 'lucide-react';
import type { Actor, AgentId, Finding, LinaEvent, SessionConfig } from '@shared/types';
import { PHASE_LABEL } from '@shared/reducer';
import type { ActEvent } from '../../lib/timeline';
import { useLina } from '../../lib/lina';
import { useApp } from '../../lib/store';
import { AGENT_NAME, clockTime, cx, duration, fullTime, shortSha } from '../../lib/format';
import { Avatar, Glyph } from '../ui/Glyphs';
import { ActivityLegend, ActivityRow } from '../Activity';
import { FindingRow, SeverityTally, StatusChip } from '../Findings';
import { Spinner } from '../ui/Overlay';
import { actorForPhase, poss, variantPhrase } from '../../lib/modes';
import { SandboxBadge, VariantChip } from '../Variants';

export function PhaseDivider({ e, cfg }: { e: LinaEvent<'phase'>; cfg: SessionConfig }) {
  const actor = actorForPhase(e.data.phase, cfg);
  const terminal = ['failed', 'cancelled', 'interrupted', 'rejected'].includes(e.data.phase);
  return (
    <div className={cx('phase-div', terminal && 'is-terminal', (e.data.phase === 'approved' || e.data.phase === 'completed') && 'is-approved')} data-actor={actor} id={`ev-${e.seq}`}>
      <span className="phase-line" />
      <span className="phase-pill">
        <i className="phase-dot" />
        {e.data.round > 0 && !['idle', 'planning', 'plan_review'].includes(e.data.phase) && <span className="phase-round">Round {e.data.round}</span>}
        <span>{PHASE_LABEL[e.data.phase]}</span>
        {e.data.note && <span className="phase-note">· {e.data.note}</span>}
      </span>
      <span className="phase-line" />
    </div>
  );
}

export const ActivityGroup = memo(function ActivityGroup({ agent, acts, start, end }: { agent: ActEvent['data']['agent']; acts: ActEvent[]; start: number; end: number }) {
  const [open, setOpen] = useState(false);
  const observed = acts.filter((a) => a.data.source === 'observed');
  const narrated = acts.length - observed.length;
  const running = acts.some((a) => a.data.state === 'running');
  const failed = observed.filter((a) => a.data.state === 'error').length;
  const byKind: Record<string, number> = {};
  for (const a of observed) byKind[a.data.kind] = (byKind[a.data.kind] ?? 0) + 1;
  const KIND_WORD: Record<string, [string, string]> = {
    command: ['command', 'commands'], read: ['read', 'reads'], search: ['search', 'searches'], edit: ['edit', 'edits'], write: ['new file', 'new files'],
    web: ['web call', 'web calls'], tool: ['tool call', 'tool calls'], test: ['test run', 'test runs'], git: ['git op', 'git ops'], note: ['note', 'notes'],
  };
  const parts = Object.entries(byKind).map(([k, n]) => `${n} ${KIND_WORD[k]?.[n === 1 ? 0 : 1] ?? k}`);
  if (narrated) parts.push(`${narrated} said`);
  return (
    <div className={cx('actgroup', open && 'is-open')} data-actor={agent}>
      <button className="actgroup-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="actgroup-glyph"><Glyph actor={agent} size={13} /></span>
        <span className="actgroup-title">{running ? <><Spinner size={11} /> {AGENT_NAME[agent]} is working</> : <>{AGENT_NAME[agent]} worked{end - start > 1500 ? ` for ${duration(end - start)}` : ''}</>}</span>
        <span className="actgroup-parts">{parts.join(' · ')}</span>
        {failed > 0 && <span className="actgroup-fail">{failed} failed</span>}
        <ChevronRight size={13} className={cx('chev', open && 'is-open')} />
      </button>
      {open && (
        <div className="actgroup-body">
          <ul className="act-list">{acts.map((a) => <ActivityRow key={a.data.id} a={{ ...a.data, ts: a.ts }} showTime />)}</ul>
          <ActivityLegend />
        </div>
      )}
    </div>
  );
}, (a, b) => a.acts.length === b.acts.length && a.acts[a.acts.length - 1] === b.acts[b.acts.length - 1]);

function CardHead({ actor, title, right, sub }: { actor: Actor; title: ReactNode; right?: ReactNode; sub?: ReactNode }) {
  return (
    <div className="card-head">
      <Avatar actor={actor} size={22} />
      <div className="card-titles"><div className="card-title">{title}</div>{sub && <div className="card-sub">{sub}</div>}</div>
      {right && <div className="card-right">{right}</div>}
    </div>
  );
}

export function ReviewCard({ e }: { e: LinaEvent<'review'> }) {
  const current = useApp((s) => s.view?.findings);
  const d = e.data;
  const byId = new Map((current ?? []).map((f) => [f.id, f]));
  const verdict = d.verdict === 'approve' ? { cls: 'ok', text: 'Approves' } : d.verdict === 'request_changes' ? { cls: 'warn', text: 'Changes requested' } : { cls: 'dim', text: 'Unparsed' };
  const raised = d.findings.filter((f) => f.round === d.round);
  const carried = d.findings.filter((f) => f.round !== d.round);
  return (
    <section className="card card-review" data-actor={d.reviewer} id={`ev-${e.seq}`}>
      <CardHead
        actor={d.reviewer}
        title={<>Review <span className="text-dim">· round {d.round}</span></>}
        sub={<>{AGENT_NAME[d.reviewer]}{d.variant && <> · <span className="card-variant" data-agent={d.variant}>{variantPhrase(d.reviewer, d.variant, 'review')}</span></>} · {clockTime(e.ts)}</>}
        right={<span className={cx('verdict', `is-${verdict.cls}`)}>{verdict.text}</span>}
      />
      {d.summary && <p className="card-text">{d.summary}</p>}
      {d.findings.length > 0 && (
        <>
          {raised.length > 0 && <div className="card-row"><span className="tally-label">Raised this round</span><SeverityTally findings={raised} /></div>}
          <div className="findings">
            {raised.map((f) => <FindingRow key={f.id} f={f} current={byId.get(f.id)} />)}
            {carried.length > 0 && <div className="findings-sep">Carried from earlier rounds</div>}
            {carried.map((f) => <FindingRow key={f.id} f={f} current={byId.get(f.id)} />)}
          </div>
        </>
      )}
      {d.verdict === 'unparsed' && <p className="card-note">LINA could not parse a structured review from this turn; the prose above is shown as-is.</p>}
    </section>
  );
}

export function ResponseCard({ e, reviewer }: { e: LinaEvent<'response'>; reviewer: AgentId }) {
  const findings = useApp((s) => s.view?.findings ?? []);
  const timeline = useApp((s) => s.view?.timeline);
  const d = e.data;
  // Original wording: the finding as raised in the reviews (fallback to current state).
  const lookup = (id: string): Finding | undefined => {
    if (timeline) for (let i = timeline.length - 1; i >= 0; i--) {
      const ev = timeline[i];
      if (ev.type === 'review') { const f = ev.data.findings.find((x) => x.id === id); if (f) return f; }
    }
    return findings.find((f) => f.id === id);
  };
  const disputes = d.items.filter((i) => i.action === 'disputed').length;
  return (
    <section className="card card-response" data-actor={d.developer} id={`ev-${e.seq}`}>
      <CardHead
        actor={d.developer}
        title={<>Response <span className="text-dim">· round {d.round}</span></>}
        sub={<>{AGENT_NAME[d.developer]} answers {d.items.length} finding{d.items.length === 1 ? '' : 's'} · {clockTime(e.ts)}</>}
        right={disputes ? <span className="verdict is-warn">{disputes} disputed</span> : <span className="verdict is-ok">All addressed</span>}
      />
      <div className="dialogue">
        {d.items.map((it) => {
          const f = lookup(it.id);
          const cur = findings.find((x) => x.id === it.id);
          const raiser = f?.raisedBy ?? reviewer; // several reviewers / self-review: who actually raised it
          return (
            <div key={it.id} className={cx('dlg', `is-${it.action}`)}>
              <div className="dlg-line" data-actor={raiser}>
                <span className="dlg-who"><Glyph actor={raiser} size={12} /></span>
                <div className="dlg-bubble">
                  <span className="mono dlg-id">{it.id}</span> {f ? <><b>{f.title}</b>{f.file && <span className="dlg-file mono"> {f.file}{f.line ? `:${f.line}` : ''}</span>}</> : <span className="text-dim">finding</span>}
                </div>
              </div>
              <div className="dlg-line is-reply" data-actor={d.developer}>
                <span className="dlg-who"><Glyph actor={d.developer} size={12} /></span>
                <div className="dlg-bubble">
                  <span className={cx('dlg-action', `is-${it.action}`)}>{it.action === 'fixed' ? 'Fixed' : it.action === 'disputed' ? 'Disagrees' : 'Deferred'}</span>
                  {it.note && <span className="dlg-note">{it.note}</span>}
                </div>
                {cur && <StatusChip s={cur.status} />}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function TestsCard({ e, hideVariant }: { e: LinaEvent<'tests'>; hideVariant?: boolean }) {
  const [open, setOpen] = useState(false);
  const t = e.data;
  const skipped = !!t.skippedReason;
  return (
    <section className={cx('card card-tests', skipped ? 'is-skipped' : t.ok ? 'is-pass' : 'is-fail')} id={`ev-${e.seq}`}>
      <div className="tests-row">
        <span className="verified" title="LINA ran this command itself — not an agent's claim"><ShieldCheck size={13} /> Verified by LINA</span>
        {t.variant && !hideVariant && <VariantChip agent={t.variant} />}
        <span className={cx('tests-result', skipped ? 'is-skip' : t.ok ? 'is-pass' : 'is-fail')}>
          {skipped ? 'Skipped' : t.ok ? 'Tests pass' : 'Tests fail'}
        </span>
        {(t.passed != null || t.failed != null) && (
          <span className="tests-counts mono">
            {t.passed != null && <span className="text-ok">{t.passed} passed</span>}
            {t.failed != null && t.failed > 0 && <span className="text-bad">{t.failed} failed</span>}
          </span>
        )}
        <span className="tests-meta"><Timer size={12} /> {duration(t.durationMs)}{t.exitCode != null && <> · exit {t.exitCode}</>}</span>
        {!skipped && <SandboxBadge sandboxed={t.sandboxed} />}
      </div>
      {skipped ? <p className="card-note">{t.skippedReason}</p> : (
        <>
          <button className="tests-cmd" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            <span className="mono">$ {t.command}</span>
            <span className="tests-toggle">{open ? 'Hide' : 'Show'} output <ChevronRight size={12} className={cx('chev', open && 'is-open')} /></span>
          </button>
          {open && <pre className="tests-output">{t.output || '(no output)'}</pre>}
        </>
      )}
    </section>
  );
}

export function CheckpointCard({ e, prev }: { e: LinaEvent<'checkpoint'>; prev?: string }) {
  const lina = useLina();
  const d = e.data;
  const add = d.files.reduce((n, f) => n + f.additions, 0);
  const del = d.files.reduce((n, f) => n + f.deletions, 0);
  const open = (path?: string) => lina.openInspector('changes', {
    worktree: d.variant ?? null, filePath: null,
    diffRange: { from: prev, to: d.commit, label: `${d.variant ? `${poss(d.variant)} checkpoint` : 'Checkpoint'} ${shortSha(d.commit)}`, focusPath: path },
  });
  const shown = d.files.slice(0, 6);
  return (
    <section className="card card-checkpoint" id={`ev-${e.seq}`} data-agent={d.variant}>
      <div className="ckpt-head">
        <span className="ckpt-icon"><GitCommitHorizontal size={15} /></span>
        <div className="ckpt-titles">
          <div className="ckpt-msg">{d.variant && <VariantChip agent={d.variant} />}{d.message}</div>
          <div className="ckpt-sub"><span className="mono">{shortSha(d.commit)}</span> · {d.files.length} file{d.files.length === 1 ? '' : 's'} · <span className="text-ok">+{add}</span> <span className="text-bad">−{del}</span> · <time title={fullTime(e.ts)}>{clockTime(e.ts)}</time></div>
        </div>
        <button className="btn btn-sm" onClick={() => open()}><FileDiff size={13} /> View diff</button>
      </div>
      <ul className="ckpt-files">
        {shown.map((f) => (
          <li key={f.path}>
            <button onClick={() => open(f.path)} title={`Open diff of ${f.path}`}>
              <span className={cx('fstatus', `is-${f.status[0]?.toUpperCase() === 'A' ? 'added' : f.status[0]?.toUpperCase() === 'D' ? 'deleted' : 'modified'}`)}>{f.status[0]?.toUpperCase() ?? 'M'}</span>
              <span className="mono ckpt-path">{f.path}</span>
              <DiffBar add={f.additions} del={f.deletions} />
            </button>
          </li>
        ))}
        {d.files.length > shown.length && <li className="ckpt-more"><button onClick={() => open()}>+{d.files.length - shown.length} more <ArrowRight size={12} /></button></li>}
      </ul>
    </section>
  );
}

export function DiffBar({ add, del }: { add: number; del: number }) {
  const total = add + del;
  const blocks = 5;
  const a = total ? Math.round((add / total) * blocks) : 0;
  const d = total ? Math.min(blocks - a, Math.max(del ? 1 : 0, Math.round((del / total) * blocks))) : 0;
  return (
    <span className="diffbar" aria-label={`${add} additions, ${del} deletions`}>
      <span className="diffbar-n text-ok">+{add}</span>
      <span className="diffbar-n text-bad">−{del}</span>
      <span className="diffbar-blocks">
        {Array.from({ length: blocks }, (_, i) => <i key={i} className={i < a ? 'is-add' : i < a + d ? 'is-del' : ''} />)}
      </span>
    </span>
  );
}

const ERR_TITLE: Record<string, string> = {
  auth: 'Not signed in', model_unavailable: 'Model unavailable', rate_limited: 'Rate limited', capacity: 'Model at capacity', transient: 'Provider temporarily unavailable', timeout: 'Timed out',
  cli_missing: 'CLI not installed', sandbox: 'Sandbox failure', crashed: 'Agent crashed', parse: 'Could not parse output',
  git: 'Git error', cancelled: 'Cancelled', internal: 'Internal error',
};

export function ErrorCard({ e, isLast }: { e: LinaEvent<'error'>; isLast: boolean }) {
  const lina = useLina();
  const status = useApp((s) => s.view?.session.status);
  const d = e.data;
  const actionable = isLast && (status === 'failed' || status === 'interrupted' || status === 'paused' || status === 'cancelled');
  return (
    <section className="card card-error" id={`ev-${e.seq}`} role="alert">
      <div className="err-head">
        <span className="err-icon"><CircleAlert size={16} /></span>
        <div className="err-titles">
          <div className="err-title">{ERR_TITLE[d.code] ?? 'Error'}{d.agent && <span className="text-dim"> · {AGENT_NAME[d.agent]}</span>}</div>
          <div className="err-msg">{d.message}</div>
        </div>
        <span className="err-code mono">{d.code}</span>
      </div>
      {d.hint && <div className="err-hint"><Wrench size={12} /> {d.hint}</div>}
      {actionable && (
        <div className="err-actions">
          {status === 'failed' && <button className="btn btn-sm" onClick={() => void lina.control('retry')}><RotateCcw size={13} /> Retry step</button>}
          <button className="btn btn-sm btn-accent" onClick={() => void lina.control('resume')}><Play size={13} /> Resume</button>
          {(d.code === 'model_unavailable') && <span className="text-dim err-tip">Tip: pick another model in the header — it applies from the next turn.</span>}
        </div>
      )}
    </section>
  );
}

/** parallel: the lead's division of the task — one card per agent part, in that agent's colour. */
export function SplitCard({ e }: { e: LinaEvent<'split'> }) {
  const d = e.data;
  return (
    <section className="card card-split" data-actor={d.lead} id={`ev-${e.seq}`}>
      <CardHead actor={d.lead} title={<>{AGENT_NAME[d.lead]} split the task</>} sub={<>{d.parts.length} parts · built at the same time, in separate worktrees · {clockTime(e.ts)}</>}
        right={<span className="split-icon"><Split size={15} /></span>} />
      <div className="split-parts">
        {d.parts.map((p, i) => (
          <article key={`${p.agent}-${i}`} className="split-part" data-agent={p.agent}>
            <header className="split-part-head">
              <Glyph actor={p.agent} size={14} />
              <span className="split-part-agent">{AGENT_NAME[p.agent]}</span>
              {p.agent === d.lead && <span className="role-tag">Lead</span>}
              {d.parts.length > 1 && (
                <span className="role-tag" data-agent={d.parts[(i + 1) % d.parts.length].agent} title={`Cross-review: ${AGENT_NAME[d.parts[(i + 1) % d.parts.length].agent]} reviews this part`}>
                  reviewed by {AGENT_NAME[d.parts[(i + 1) % d.parts.length].agent]}
                </span>
              )}
            </header>
            <h4 className="split-part-title">{p.title}</h4>
            <p className="split-part-scope">{p.scope}</p>
            {p.files && p.files.length > 0 && (
              <ul className="split-files" aria-label={`Files ${AGENT_NAME[p.agent]} owns`}>
                {p.files.map((f) => <li key={f} className="mono" title={f}><FileCode2 size={11} />{f}</li>)}
              </ul>
            )}
          </article>
        ))}
      </div>
      {d.parts.length > 1 && (
        <p className="split-review-map">
          cross-review: {d.parts.map((p, i) => `${AGENT_NAME[p.agent]} reviews ${AGENT_NAME[d.parts[(i + 1) % d.parts.length].agent]}`).join(' · ')}
        </p>
      )}
    </section>
  );
}

const INTEGRATION_META = {
  merged: { icon: GitMerge, tone: 'ok', title: 'Branches merged cleanly' },
  conflict: { icon: TriangleAlert, tone: 'warn', title: 'Merge conflict' },
  resolved: { icon: CircleCheck, tone: 'ok', title: 'Conflicts resolved' },
  failed: { icon: CircleX, tone: 'bad', title: 'Integration failed' },
} as const;

/** parallel: LINA merging the part branches into the session branch. */
export function IntegrationCard({ e }: { e: LinaEvent<'integration'> }) {
  const lina = useLina();
  const lead = useApp((s) => s.view?.session.config.developer);
  const d = e.data;
  const m = INTEGRATION_META[d.state];
  const files = d.conflicts ?? [];
  const sub = d.state === 'conflict' ? <>{files.length} file{files.length === 1 ? '' : 's'} conflict{files.length === 1 ? 's' : ''}{lead ? <> — {AGENT_NAME[lead]} (lead) resolves them</> : null}</>
    : d.state === 'resolved' ? <>{lead ? `${AGENT_NAME[lead]} resolved` : 'Resolved'} {files.length ? `${files.length} file${files.length === 1 ? '' : 's'}` : 'the markers'}; LINA verified no markers remain</>
    : d.state === 'merged' ? <>Both parts are now on the session branch</>
    : <>The merge was aborted; retry re-runs the integration</>;
  return (
    <section className={cx('card card-integration', `is-${m.tone}`)} id={`ev-${e.seq}`}>
      <div className="integ-head">
        <span className="integ-icon"><m.icon size={15} /></span>
        <div className="integ-titles">
          <div className="integ-title">{m.title}{d.commit && <span className="mono integ-commit">{shortSha(d.commit)}</span>}</div>
          <div className="integ-sub">{sub} · <time title={fullTime(e.ts)}>{clockTime(e.ts)}</time></div>
        </div>
        {(d.state === 'merged' || d.state === 'resolved') && d.commit && (
          <button className="btn btn-sm" onClick={() => lina.viewWorktree(null)}><GitPullRequestDraft size={13} /> View result</button>
        )}
      </div>
      {files.length > 0 && (
        <ul className="integ-files">
          {files.map((f) => (
            <li key={f}><button onClick={() => lina.openInspector('files', { worktree: null, filePath: f })} title={`Open ${f}`}>
              <span className={cx('fstatus', d.state === 'conflict' ? 'is-deleted' : d.state === 'resolved' ? 'is-added' : 'is-modified')}>{d.state === 'resolved' ? '✓' : 'U'}</span>
              <span className="mono ckpt-path">{f}</span>
            </button></li>
          ))}
        </ul>
      )}
      {d.note && <p className="card-note">{d.note}</p>}
    </section>
  );
}
