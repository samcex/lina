// Pure transcript renderer: folds a SessionView timeline (+ TUI-local notices)
// into pre-wrapped ANSI lines. Results are cached per event object and width,
// so streaming updates only re-render the streaming tail.
import type { AgentId, AnyLinaEvent, Candidate, Finding, LinaEvent, Mode, Severity, TestRun } from '../shared/types.js';
import type { SessionView } from '../shared/reducer.js';
import { PHASE_LABEL } from '../shared/reducer.js';
import { agentDisplayText } from '../shared/agent-display.js';
import { bg, bold, dim, fg, italic, padAnsi, strWidth, truncateAnsi, wrapAnsi } from './ansi.js';
import { renderMarkdown } from './markdown.js';
import { AGENT_NAME, C, SEVERITY_COLOR, SEVERITY_ORDER, actorColor, actorName } from './theme.js';
import { formatClock, formatDuration } from './layout.js';

export interface LocalNotice { id: string; ts: number; level: 'info' | 'error' | 'success' | 'warn'; text: string; hint?: string }

const INDENT = '  ';

/**
 * Session facts that change how an event reads. Part of the render-cache key, so a cached
 * card re-renders when (say) the compete winner gets picked.
 */
export interface RenderCtx {
  mode?: Mode;
  /** The session developer (parallel: the lead). */
  lead?: AgentId;
  /** compete: the candidate you picked. */
  chosen?: AgentId;
}

export function ctxOf(view: SessionView | undefined): RenderCtx {
  if (!view) return {};
  const c = view.session.config;
  return { mode: c.mode, lead: c.developer, chosen: view.session.chosenVariant };
}
const ctxKey = (c: RenderCtx) => `${c.mode ?? ''}|${c.lead ?? ''}|${c.chosen ?? ''}`;

const possessive = (a: AgentId) => `${AGENT_NAME[a]}'s`;
/** "version" in compete, "part" in parallel, "worktree" when unsure. */
function lineOfWork(ctx: RenderCtx): string { return ctx.mode === 'compete' ? 'version' : ctx.mode === 'parallel' ? 'part' : 'worktree'; }

/**
 * Label for work done in an agent's worktree, from the point of view of `actor`:
 * "reviewing Claude's version" (someone else's line of work) or "Codex's version" (its own).
 */
export function variantLabel(actor: AnyLinaEvent['actor'], variant: AgentId, ctx: RenderCtx, reviewing = false): string {
  const what = `${possessive(variant)} ${lineOfWork(ctx)}`;
  if (actor === variant) return what;
  return reviewing ? `reviewing ${what}` : `on ${what}`;
}

/** A colored "· Codex's worktree"-style tag for LINA-run work (tests, checkpoints). */
function worktreeTag(variant: AgentId | undefined): string {
  return variant ? dim(' · ') + fg(actorColor(variant))(`${possessive(variant)} worktree`) : '';
}

function badge(actor: AnyLinaEvent['actor']): string {
  const name = actorName(actor).toUpperCase();
  if (actor === 'user') return bg('#3F3F46')(fg(C.user)(bold(` ${name} `)));
  return bg(actorColor(actor))(fg(C.ink)(bold(` ${name} `)));
}

function headerLine(left: string, right: string, width: number): string {
  const gap = width - strWidth(left) - strWidth(right);
  return gap >= 1 ? left + ' '.repeat(gap) + right : truncateAnsi(left, Math.max(4, width - strWidth(right) - 1)) + ' ' + right;
}

function indent(lines: string[], pre = INDENT): string[] { return lines.map((l) => pre + l); }

function card(lines: string[], color: string): string[] { return lines.map((l) => INDENT + fg(color)('│') + ' ' + l); }

export function severityChip(sev: Severity, count?: number): string {
  const label = count === undefined ? ` ${sev.toUpperCase()} ` : ` ${sev.toUpperCase()} ${count} `;
  return bg(SEVERITY_COLOR[sev])(fg(C.ink)(bold(label)));
}

const STATUS_STYLE: Record<Finding['status'], (s: string) => string> = {
  open: fg(C.warn), fixed: fg(C.info), disputed: fg(C.claudeSoft), resolved: fg(C.ok),
  withdrawn: fg(C.muted), escalated: (s) => bold(fg(C.err)(s)), waived: fg(C.muted),
};
export function findingStatus(s: Finding['status']): string { return STATUS_STYLE[s](s); }

/** "on Claude's version" (compete) or "→ Claude" (owner, parallel) — empty when neither applies. */
export function findingScope(f: Finding, showOwner = false): string {
  if (f.variant) return fg(actorColor(f.variant))(`on ${possessive(f.variant)} version`);
  if (f.owner && showOwner) return fg(actorColor(f.owner))(`→ ${AGENT_NAME[f.owner]}`);
  return '';
}

export function findingLine(f: Finding, width: number, opts: { showOwner?: boolean } = {}): string {
  const sev = fg(SEVERITY_COLOR[f.severity])('●');
  const loc = f.file ? dim(` ${f.file}${f.line ? ':' + f.line : ''}`) : '';
  const scope = findingScope(f, opts.showOwner);
  const left = `${sev} ${bold(f.id)} ${f.title}${loc}${scope ? ' ' + scope : ''}`;
  const right = findingStatus(f.status);
  return headerLine(truncateAnsi(left, Math.max(10, width - strWidth(right) - 2)), right, width);
}

function chips(findings: Finding[]): string {
  return SEVERITY_ORDER.map((s) => [s, findings.filter((f) => f.severity === s).length] as const)
    .filter(([, n]) => n > 0).map(([s, n]) => severityChip(s, n)).join(' ');
}

function renderMessage(e: LinaEvent<'message'>, width: number, ctx: RenderCtx = {}): string[] {
  const d = e.data;
  if (d.kind === 'notice' && e.actor === 'lina') {
    return [...indent(wrapAnsi(fg(C.linaSoft)('◆ ') + italic(fg(C.linaSoft)(d.text)), width - 2)), ''];
  }
  const tags: string[] = [];
  if (d.role) tags.push(d.role);
  if (d.kind !== 'chat') tags.push(d.kind === 'question' ? fg(C.warn)('question') : d.kind);
  if (d.mention) tags.push(fg(actorColor(d.mention))(`→ @${d.mention}`));
  if (d.variant) tags.push(fg(actorColor(d.variant))(variantLabel(e.actor, d.variant, ctx, d.kind === 'review' || d.role === 'reviewer')));
  if (d.queued) tags.push(fg(C.warn)('queued'));
  const meta = tags.length ? ' ' + dim(tags.join(' · ')) : '';
  const right = dim((d.model ? d.model + '  ' : '') + formatClock(e.ts));
  const out = [headerLine(badge(e.actor) + meta, right, width)];
  const body = renderMarkdown(e.actor === 'codex' || e.actor === 'claude' ? agentDisplayText(d.text) : d.text, width - 2);
  out.push(...indent(body));
  if (d.attachments?.length) out.push(...indent(d.attachments.map((a) => dim(`📎 ${a.name} (${Math.ceil(a.size / 1024)} KB)`))));
  out.push('');
  return out;
}

function renderPhase(e: LinaEvent<'phase'>, width: number): string[] {
  const label = PHASE_LABEL[e.data.phase] ?? e.data.phase;
  const round = e.data.round > 0 ? dim(` · round ${e.data.round}`) : '';
  const note = e.data.note ? dim(` · ${e.data.note}`) : '';
  const core = `${fg(C.faint)('──')} ${fg(C.lina)(label)}${round}${note} `;
  const fill = Math.max(0, width - strWidth(core));
  return [truncateAnsi(core + fg(C.faint)('─'.repeat(fill)), width), ''];
}

function renderReview(e: LinaEvent<'review'>, width: number, ctx: RenderCtx = {}): string[] {
  const d = e.data;
  const color = actorColor(d.reviewer);
  const verdict = d.verdict === 'approve' ? fg(C.ok)('approved') : d.verdict === 'request_changes' ? fg(C.warn)('changes requested') : fg(C.muted)('unparsed review');
  const inner = width - 4;
  const scope = d.variant ? ` ${dim('·')} ${fg(actorColor(d.variant))(variantLabel(d.reviewer, d.variant, ctx, true))}` : '';
  const lines: string[] = [`${bold(fg(color)('◇ Review'))} ${dim('by')} ${fg(color)(AGENT_NAME[d.reviewer])}${scope} ${dim(`· round ${d.round} —`)} ${verdict}`];
  if (d.summary) lines.push(...wrapAnsi(dim(d.summary), inner));
  // compete: the ledger holds both candidates' findings — this card is about one of them
  const ledger = d.variant ? d.findings.filter((f) => !f.variant || f.variant === d.variant) : d.findings;
  const raised = ledger.filter((f) => f.round === d.round && f.raisedBy === d.reviewer);
  const shown = ledger.filter((f) => f.status === 'open' || f.status === 'escalated' || (f.round === d.round && f.raisedBy === d.reviewer));
  if (shown.length) {
    lines.push(chips(shown) + dim(`  ${raised.length} new · ${ledger.filter((f) => f.status === 'open').length} open`));
    for (const f of shown.slice(0, 6)) lines.push(findingLine(f, inner, { showOwner: ctx.mode === 'parallel' }));
    if (shown.length > 6) lines.push(dim(`+${shown.length - 6} more — /findings or Ctrl+F`));
  } else if (d.verdict === 'approve') lines.push(fg(C.ok)('No open findings.'));
  return [...card(lines, color), ''];
}

function renderResponse(e: LinaEvent<'response'>, width: number): string[] {
  const d = e.data;
  const color = actorColor(d.developer);
  const lines = [`${bold(fg(color)('↩ Response'))} ${dim('from')} ${fg(color)(AGENT_NAME[d.developer])} ${dim(`· round ${d.round}`)}`];
  const style = { fixed: fg(C.ok), disputed: fg(C.claudeSoft), deferred: fg(C.muted) } as const;
  for (const it of d.items.slice(0, 8)) {
    lines.push(truncateAnsi(`${bold(it.id)} ${style[it.action](it.action)}${it.note ? dim(' — ' + it.note.replace(/\s+/g, ' ')) : ''}`, width - 4));
  }
  if (d.items.length > 8) lines.push(dim(`+${d.items.length - 8} more`));
  return [...card(lines, color), ''];
}

function renderTests(e: LinaEvent<'tests'>, width: number): string[] {
  const t = e.data;
  if (t.skippedReason) return [...card([`${fg(C.muted)('○ Tests skipped')}${worktreeTag(t.variant)} ${dim('— ' + t.skippedReason)}`], C.faint), ''];
  const color = t.ok ? C.ok : C.err;
  const counts = [t.passed !== undefined ? fg(C.ok)(`✔ ${t.passed} passed`) : '', t.failed !== undefined ? (t.failed > 0 ? fg(C.err)(`✖ ${t.failed} failed`) : dim('0 failed')) : '']
    .filter(Boolean).join(dim(' · '));
  const head = `${bold(fg(color)(t.ok ? '✔ Tests passed' : '✖ Tests failed'))}${worktreeTag(t.variant)}${counts ? '  ' + counts : ''}  ${dim(formatDuration(t.durationMs))}`;
  const lines = [head, `${dim('$')} ${fg(C.text)(t.command)}${t.exitCode !== null && t.exitCode !== 0 ? fg(C.err)(`  exit ${t.exitCode}`) : ''}  ${fg(C.lina)('verified by LINA')}${t.sandboxed ? dim(' · sandboxed') : fg(C.warn)(' · not sandboxed')}`];
  if (!t.ok && t.output) {
    const tail = t.output.trimEnd().split('\n').slice(-8);
    for (const l of tail) lines.push(dim(truncateAnsi(l, width - 6)));
  }
  return [...card(lines, color), ''];
}

function renderCheckpoint(e: LinaEvent<'checkpoint'>, width: number): string[] {
  const d = e.data;
  const add = d.files.reduce((a, f) => a + f.additions, 0);
  const del = d.files.reduce((a, f) => a + f.deletions, 0);
  const lines = [truncateAnsi(`${fg(C.lina)('⎇')} ${bold('Checkpoint')} ${fg(C.muted)(d.commit.slice(0, 7))}${worktreeTag(d.variant)} ${dim('·')} ${d.message.split('\n')[0]}  ${dim(`${d.files.length} file${d.files.length === 1 ? '' : 's'}`)} ${fg(C.ok)('+' + add)} ${fg(C.err)('−' + del)}`, width - 2)];
  const statusColor = (s: string) => (s.startsWith('A') || s === 'added' ? C.ok : s.startsWith('D') || s === 'deleted' ? C.err : C.warn);
  for (const f of d.files.slice(0, 8)) {
    const st = (f.status || 'M').slice(0, 1).toUpperCase();
    lines.push(truncateAnsi(`  ${fg(statusColor(f.status))(st)} ${f.path}  ${fg(C.ok)('+' + f.additions)} ${fg(C.err)('−' + f.deletions)}`, width - 2));
  }
  if (d.files.length > 8) lines.push(dim(`  +${d.files.length - 8} more — /diff`));
  return [...indent(lines), ''];
}

function box(title: string, body: string[], width: number, color: string): string[] {
  const inner = Math.max(10, width - 6);
  const t = ` ${title} `;
  const top = fg(color)('╭─') + bold(fg(color)(t)) + fg(color)('─'.repeat(Math.max(0, inner + 1 - strWidth(t))) + '╮');
  const mid = body.map((l) => fg(color)('│') + ' ' + padAnsi(truncateAnsi(l, inner), inner) + ' ' + fg(color)('│'));
  const bot = fg(color)('╰' + '─'.repeat(inner + 2) + '╯');
  return indent([top, ...mid, bot]);
}

// ── parallel ────────────────────────────────────────────────────────────────
function renderSplit(e: LinaEvent<'split'>, width: number): string[] {
  const d = e.data;
  const inner = width - 4;
  const lead = d.lead ? fg(actorColor(d.lead))(AGENT_NAME[d.lead]) : 'the lead';
  const lines: string[] = [`${bold(fg(C.lina)('⑂ Task split'))} ${dim('by')} ${lead} ${dim(`(lead) · ${d.parts.length} part${d.parts.length === 1 ? '' : 's'}, built at the same time in separate worktrees`)}`];
  for (const part of d.parts) {
    const color = actorColor(part.agent);
    lines.push('');
    lines.push(truncateAnsi(`${bg(color)(fg(C.ink)(bold(` ${AGENT_NAME[part.agent].toUpperCase()} `)))} ${bold(fg(C.text)(part.title || 'Untitled part'))}`, inner));
    if (part.scope) lines.push(...wrapAnsi(part.scope.replace(/\s+/g, ' '), inner - 2).map((l) => '  ' + fg('#C8C8D0')(l)));
    if (part.files?.length) {
      const shown = part.files.slice(0, 8).map((f) => fg(color)(f)).join(dim(', '));
      lines.push(...wrapAnsi(dim('files ') + shown + (part.files.length > 8 ? dim(` +${part.files.length - 8} more`) : ''), inner - 2).map((l) => '  ' + l));
    }
  }
  return [...card(lines, C.lina), ''];
}

function renderIntegration(e: LinaEvent<'integration'>, width: number, ctx: RenderCtx = {}): string[] {
  const d = e.data;
  const inner = width - 4;
  const lead = ctx.lead ? fg(actorColor(ctx.lead))(AGENT_NAME[ctx.lead]) : 'The lead';
  const commit = d.commit ? ' ' + fg(C.muted)(d.commit.slice(0, 7)) : '';
  let color: string;
  let head: string;
  switch (d.state) {
    case 'merged': color = C.ok; head = `${fg(C.ok)('⎇')} ${bold(fg(C.ok)('Parts merged'))}${commit} ${dim('· both branches merged cleanly — verified by LINA')}`; break;
    case 'conflict': color = C.warn; head = `${fg(C.warn)('⚠')} ${bold(fg(C.warn)('Merge conflict'))} ${dim('·')} ${lead} ${dim(`is resolving ${d.conflicts?.length ?? 0} file${d.conflicts?.length === 1 ? '' : 's'}`)}`; break;
    case 'resolved': color = C.ok; head = `${fg(C.ok)('✔')} ${bold(fg(C.ok)('Conflicts resolved'))}${commit} ${dim('· no conflict markers left — merge committed by LINA')}`; break;
    default: color = C.err; head = `${fg(C.err)('✖')} ${bold(fg(C.err)('Integration failed'))} ${dim('· merge aborted — /retry runs integration again')}`;
  }
  const lines = [truncateAnsi(head, inner)];
  if (d.conflicts?.length) {
    for (const f of d.conflicts.slice(0, 8)) lines.push(truncateAnsi(`  ${fg(d.state === 'resolved' ? C.ok : d.state === 'failed' ? C.err : C.warn)('U')} ${f}`, inner));
    if (d.conflicts.length > 8) lines.push(dim(`  +${d.conflicts.length - 8} more`));
  }
  if (d.note) lines.push(...wrapAnsi(dim(d.note), inner));
  return [...card(lines, color), ''];
}

// ── compete: pick the winner ──────────────────────────────────────────────────
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function candidateTests(t: TestRun | undefined): string {
  if (!t) return dim('not run');
  if (t.skippedReason) return dim('skipped');
  const counts = t.ok
    ? (t.passed !== undefined ? `${t.passed} passed` : 'passed')
    : (t.failed !== undefined ? `${t.failed} failed` : `failed${t.exitCode !== null ? ` (exit ${t.exitCode})` : ''}`);
  return `${t.ok ? fg(C.ok)('✔ ' + counts) : fg(C.err)('✖ ' + counts)}${t.sandboxed ? dim(' · sandboxed') : fg(C.warn)(' · not sandboxed')}`;
}

/** Comparison rows (label + one cell per candidate), all facts measured by LINA. */
export function candidateRows(cands: Candidate[]): { label: string; cells: string[] }[] {
  const rival = (c: Candidate): AgentId | undefined => cands.find((x) => x.agent !== c.agent)?.agent ?? (c.agent === 'codex' ? 'claude' : 'codex');
  return [
    { label: 'Tests', cells: cands.map((c) => candidateTests(c.tests)) },
    { label: 'Changes', cells: cands.map((c) => `${c.files} file${c.files === 1 ? '' : 's'} ${fg(C.ok)('+' + c.additions)} ${fg(C.err)('−' + c.deletions)}`) },
    {
      label: 'Findings',
      cells: cands.map((c) => (c.openFindings === 0 ? fg(C.ok)('none open') : `${fg(C.warn)(`${c.openFindings} open`)} ${dim('·')} ${c.blockingFindings ? fg(C.err)(`${c.blockingFindings} blocking`) : dim('0 blocking')}`)),
    },
    {
      label: 'Verdict',
      cells: cands.map((c) => {
        const r = rival(c);
        const by = r ? dim(` (${AGENT_NAME[r]})`) : '';
        return c.verdict === 'approve' ? fg(C.ok)('approved') + by : c.verdict === 'request_changes' ? fg(C.warn)('changes requested') + by : c.verdict === 'unparsed' ? fg(C.muted)('unparsed') + by : dim('not reviewed');
      }),
    },
    { label: 'Usage', cells: cands.map((c) => dim(`${formatTokens(c.usage.inputTokens)} in · ${formatTokens(c.usage.outputTokens)} out · ${c.usage.turns} turn${c.usage.turns === 1 ? '' : 's'}${c.usage.costUsd ? ` · $${c.usage.costUsd.toFixed(2)}` : ''}`)) },
  ];
}

/** Side-by-side (wide) or stacked (narrow) comparison of the compete candidates. */
export function candidateComparison(cands: Candidate[], width: number, chosen?: AgentId): string[] {
  const rows = candidateRows(cands);
  const labelW = 10;
  const head = (c: Candidate) => {
    const pick = chosen === c.agent ? ' ' + fg(C.ok)('★ chosen') : '';
    return `${bg(actorColor(c.agent))(fg(C.ink)(bold(` ${AGENT_NAME[c.agent].toUpperCase()} `)))} ${fg(C.muted)(c.headCommit.slice(0, 7))}${pick}`;
  };
  const colW = Math.floor((width - labelW) / Math.max(1, cands.length)) - 1;
  if (cands.length > 1 && colW >= 30) {
    const out = [' '.repeat(labelW) + cands.map((c) => padAnsi(truncateAnsi(head(c), colW), colW)).join(' ')];
    for (const r of rows) out.push(padAnsi(dim(r.label), labelW) + r.cells.map((cell) => padAnsi(truncateAnsi(cell, colW), colW)).join(' '));
    return out;
  }
  const out: string[] = [];
  cands.forEach((c, i) => {
    if (i) out.push('');
    out.push(truncateAnsi(head(c), width));
    for (const r of rows) out.push(truncateAnsi(padAnsi(dim(r.label), labelW) + r.cells[i], width));
  });
  return out;
}

const agentsHint = (cands: Candidate[]) => (cands.length ? cands.map((c) => c.agent).join('|') : 'codex|claude');

function renderApproval(e: LinaEvent<'approval'>, width: number, ctx: RenderCtx = {}): string[] {
  const d = e.data;
  if (d.state === 'requested' && d.candidates?.length) {
    const inner = Math.max(10, width - 6);
    const body: string[] = [];
    const chosen = ctx.chosen;
    body.push(...candidateComparison(d.candidates, inner, chosen));
    if (d.summary) {
      body.push('');
      const md = renderMarkdown(d.summary, inner);
      body.push(...md.slice(0, 8));
      if (md.length > 8) body.push(dim(`… /tests, /findings and /diff ${agentsHint(d.candidates)} for the details`));
    }
    body.push('');
    if (chosen) {
      const rival = d.candidates.find((c) => c.agent !== chosen)?.agent;
      body.push(...wrapAnsi(`${fg(C.ok)('★')} You picked ${fg(actorColor(chosen))(possessive(chosen) + ' version')}${rival ? dim(` — it is now the session branch; ${AGENT_NAME[rival]} reviews`) : ''}`, inner));
      body.push(...wrapAnsi(`${bold(fg(C.ok)('/approve'))} ${dim('[squash|merge|branch]')}   ${bold(fg(C.err)('/reject'))}   ${dim('or type a message to request changes')}`, inner));
      return [...box('◆ Awaiting your approval', body, width, C.lina), ''];
    }
    const ag = agentsHint(d.candidates);
    body.push(...wrapAnsi(`${bold(fg(C.lina)('/choose'))} ${dim(ag)}   ${bold(fg(C.ok)('/approve'))} ${dim(`${ag} [squash|merge|branch]`)}   ${bold(fg(C.err)('/reject'))}`, inner));
    body.push(...wrapAnsi(dim(`/diff ${ag} shows a version · a message asks both agents for changes`), inner));
    return [...box('◆ Pick the winner', body, width, C.lina), ''];
  }
  if (d.state === 'requested') {
    const inner = Math.max(10, width - 6);
    const body: string[] = [];
    if (d.summary) body.push(...renderMarkdown(d.summary, inner).slice(0, 12));
    if (d.unresolved?.length) {
      body.push('');
      body.push(fg(C.warn)(`⚠ ${d.unresolved.length} unresolved finding${d.unresolved.length === 1 ? '' : 's'}`) + '  ' + chips(d.unresolved));
    }
    body.push('');
    body.push(`${bold(fg(C.ok)('/approve'))} ${dim('[squash|merge|branch]')}   ${bold(fg(C.err)('/reject'))}   ${dim('or type a message to request changes')}`);
    return [...box('◆ Awaiting your approval', body, width, C.lina), ''];
  }
  const which = d.variant ? ' ' + fg(actorColor(d.variant))(`${possessive(d.variant)} version`) : '';
  if (d.state === 'approved') return [...indent(wrapAnsi(`${bold(fg(C.ok)('✔ Approved'))}${which}${d.strategy ? dim(` (${d.strategy})`) : ''}${d.result ? ' — ' + d.result : ''}`, width - 2)), ''];
  if (d.state === 'rejected') return [...indent(wrapAnsi(`${bold(fg(C.err)('✖ Rejected'))}${d.note ? dim(' — ' + d.note) : ''}`, width - 2)), ''];
  return [...indent(wrapAnsi(`${bold(fg(C.err)('✖ Applying failed'))}${d.note || d.result ? ' — ' + (d.note ?? d.result) : ''}`, width - 2)), ''];
}

function renderError(e: LinaEvent<'error'>, width: number): string[] {
  const d = e.data;
  const who = d.agent ? fg(actorColor(d.agent))(AGENT_NAME[d.agent]) + dim(' · ') : '';
  const lines = wrapAnsi(`${fg(C.err)('✖')} ${who}${fg(C.err)(bold(d.code))} ${fg(C.err)(d.message)}`, width - 2);
  if (d.hint) lines.push(...wrapAnsi(dim('↳ ' + d.hint), width - 4).map((l) => '  ' + l));
  return [...indent(lines), ''];
}

/** Lines for one persisted event; [] for events that don't appear in the transcript. */
export function renderEvent(e: AnyLinaEvent, width: number, ctx: RenderCtx = {}): string[] {
  try {
    switch (e.type) {
      case 'message': return renderMessage(e as LinaEvent<'message'>, width, ctx);
      case 'phase': return renderPhase(e as LinaEvent<'phase'>, width);
      case 'review': return renderReview(e as LinaEvent<'review'>, width, ctx);
      case 'response': return renderResponse(e as LinaEvent<'response'>, width);
      case 'tests': return renderTests(e as LinaEvent<'tests'>, width);
      case 'checkpoint': return renderCheckpoint(e as LinaEvent<'checkpoint'>, width);
      case 'split': return renderSplit(e as LinaEvent<'split'>, width);
      case 'integration': return renderIntegration(e as LinaEvent<'integration'>, width, ctx);
      case 'approval': return renderApproval(e as LinaEvent<'approval'>, width, ctx);
      case 'error': return renderError(e as LinaEvent<'error'>, width);
      default: return [];
    }
  } catch (err) {
    return [INDENT + dim(`(could not render ${e.type} event: ${(err as Error).message})`)];
  }
}

export function renderNotice(n: LocalNotice, width: number): string[] {
  const icon = n.level === 'error' ? fg(C.err)('✖') : n.level === 'success' ? fg(C.ok)('✔') : n.level === 'warn' ? fg(C.warn)('!') : fg(C.lina)('◆');
  const color = n.level === 'error' ? C.err : n.level === 'success' ? C.ok : n.level === 'warn' ? C.warn : C.linaSoft;
  const lines: string[] = [];
  n.text.split('\n').forEach((t, i) => lines.push(...wrapAnsi((i === 0 ? icon + ' ' : '  ') + fg(color)(t), width - 2)));
  if (n.hint) lines.push(...wrapAnsi(dim('↳ ' + n.hint), width - 4).map((l) => '  ' + l));
  return [...indent(lines), ''];
}

export function renderStream(s: { agent: 'codex' | 'claude'; text: string }, width: number, cursorOn: boolean): string[] {
  const color = actorColor(s.agent);
  const out = [headerLine(badge(s.agent) + ' ' + fg(color)(italic('writing…')), '', width)];
  const text = agentDisplayText(s.text, true);
  const body = text ? renderMarkdown(text, width - 2) : [''];
  const cursor = cursorOn ? fg(color)('▍') : ' ';
  body[body.length - 1] = body[body.length - 1] + cursor;
  out.push(...indent(body), '');
  return out;
}

const cache = new WeakMap<object, { width: number; key: string; lines: string[] }>();
function cached<T extends object>(obj: T, width: number, fn: (o: T, w: number, ctx: RenderCtx) => string[], ctx: RenderCtx = {}): string[] {
  const key = ctxKey(ctx);
  const hit = cache.get(obj);
  if (hit && hit.width === width && hit.key === key) return hit.lines;
  const lines = fn(obj, width, ctx);
  cache.set(obj, { width, key, lines });
  return lines;
}

export function welcomeLines(width: number, projectName: string, recent: { id: string; title: string; status: string }[] = []): string[] {
  const out = [
    '',
    INDENT + bold(fg(C.lina)('◆ LINA')) + dim('  Codex + Claude Code, working as one team'),
    '',
    ...indent(wrapAnsi(`Describe what you want built in ${bold(projectName)}. The developer implements, LINA runs the tests, the reviewer reviews. New sessions edit your project directly and leave changes uncommitted.`, width - 2)),
    '',
    INDENT + dim('Try: ') + fg(C.text)('"Add a dark-mode toggle to the settings page"'),
    INDENT + dim('     ') + fg(C.claudeSoft)('@claude') + fg(C.text)(' how is auth wired in this repo?'),
    '',
  ];
  if (recent.length) {
    out.push(INDENT + dim('Recent sessions in this project') + dim('  (Ctrl+L to open)'));
    for (const r of recent.slice(0, 5)) out.push(INDENT + '  ' + dim('·') + ' ' + truncateAnsi(r.title || r.id, width - 20) + ' ' + dim(r.status));
    out.push('');
  }
  out.push(INDENT + dim('/help for commands · F1 for keys · /models to pick models'));
  return out;
}

/**
 * Builds all transcript lines: timeline events merged with local notices by time, then live streams.
 */
export function buildTranscript(view: SessionView | undefined, notices: LocalNotice[], width: number, cursorOn = true): string[] {
  const out: string[] = [];
  const events = view?.timeline ?? [];
  const ctx = ctxOf(view);
  let ni = 0;
  for (const e of events) {
    while (ni < notices.length && notices[ni].ts < e.ts) out.push(...cached(notices[ni++], width, renderNotice));
    out.push(...cached(e, width, renderEvent, ctx));
  }
  while (ni < notices.length) out.push(...cached(notices[ni++], width, renderNotice));
  if (view) for (const s of Object.values(view.streams)) out.push(...renderStream(s, width, cursorOn));
  return out;
}

/** Rendered row containing a persisted event, including interleaved local notices. */
export function transcriptEventLine(view: SessionView, notices: LocalNotice[], width: number, seq: number): number | undefined {
  const ctx = ctxOf(view);
  let row = 0, ni = 0;
  for (const event of view.timeline) {
    while (ni < notices.length && notices[ni].ts < event.ts) row += cached(notices[ni++], width, renderNotice).length;
    if (event.seq === seq) return row;
    row += cached(event, width, renderEvent, ctx).length;
  }
  return undefined;
}
