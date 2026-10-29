import { panelAgentsFor } from '../team.js';
// Pure line builders for the TUI chrome: header, agent panels, composer, footer.
import type { AgentView, SessionView } from '../../shared/reducer.js';
import { PIPELINE, PHASE_LABEL, STATUS_LABEL, pipelineFor } from '../../shared/reducer.js';
import { agentDisplayText } from '../../shared/agent-display.js';
import type { AgentId, AgentModelChoice, Mode, Phase, RateLimitInfo, Role, SessionConfig, SessionStatus } from '../../shared/types.js';
import { bg, bold, charWidth, dim, fg, inverse, italic, strWidth, truncateAnsi } from '../ansi.js';
import { roleTags } from '../team.js';
import { renderMarkdown } from '../markdown.js';
import { formatElapsed, modelLabel } from '../layout.js';
import { ACTIVITY_ICON, AGENT_NAME, C, SPINNER, actorColor } from '../theme.js';
import type { ConnState } from './store.js';
import { graphemes, type Ed } from './editor.js';

export function spread(left: string, right: string, width: number): string {
  const gap = width - strWidth(left) - strWidth(right);
  if (gap >= 1) return left + ' '.repeat(gap) + right;
  const l = truncateAnsi(left, Math.max(1, width - strWidth(right) - 1));
  const g = width - strWidth(l) - strWidth(right);
  return g >= 1 ? l + ' '.repeat(g) + right : truncateAnsi(left, width);
}

const SHORT_PHASE: Partial<Record<Phase, string>> = { awaiting_approval: 'Approval', implementing: 'Implement', planning: 'Plan', plan_review: 'Critique', reviewing: 'Review', revising: 'Revise', integrating: 'Integrate', verifying: 'Verify', testing: 'Test' };

/** Phases of the progress rail for a session config (falls back to the pair pipeline). */
export function railFor(cfg?: Partial<Pick<SessionConfig, 'mode' | 'developer' | 'reviewer' | 'team' | 'workspaceMode' | 'interactionMode'>>): Phase[] {
  if (!cfg?.mode) return PIPELINE;
  const dev: AgentId = cfg.developer ?? 'codex';
  return pipelineFor({ mode: cfg.mode, developer: dev, reviewer: cfg.reviewer ?? (dev === 'codex' ? 'claude' : 'codex'), team: cfg.team, workspaceMode: cfg.workspaceMode, interactionMode: cfg.interactionMode });
}

export function pipelineRail(phase: Phase, compact: boolean, pipeline: Phase[] = PIPELINE): string {
  // a plan review outside the rail (e.g. an older session) shows on the Plan step
  const cur = phase === 'plan_review' && !pipeline.includes('plan_review') ? 'planning' : phase;
  let idx = pipeline.indexOf(cur);
  const finished = phase === 'completed' || phase === 'approved' || phase === 'rejected';
  if (finished) idx = pipeline.length;
  const parts = pipeline.map((p, i) => {
    const label = compact ? (SHORT_PHASE[p] ?? PHASE_LABEL[p]) : p === 'awaiting_approval' ? 'Approval' : PHASE_LABEL[p];
    if (i === idx) return bg(C.linaDeep)(fg('#FFFFFF')(bold(` ${phase !== cur ? PHASE_LABEL[phase] : label} `)));
    if (idx >= 0 && i < idx) return fg(C.linaSoft)('✓ ' + label);
    return fg(C.faint)(label);
  });
  return parts.join(fg(C.faint)(compact ? ' › ' : '  ›  '));
}

const STATUS_CHIP: Record<SessionStatus, () => string> = {
  idle: () => dim('idle'),
  running: () => fg(C.ok)('● running'),
  paused: () => fg(C.warn)('❚❚ paused'),
  awaiting_approval: () => bold(fg(C.lina)('◆ awaiting approval')),
  completed: () => fg(C.ok)('✔ completed'),
  approved: () => fg(C.ok)('✔ approved'),
  rejected: () => fg(C.err)('✖ rejected'),
  cancelled: () => fg(C.muted)('■ cancelled'),
  failed: () => fg(C.err)('✖ failed'),
  interrupted: () => fg(C.warn)('◌ interrupted'),
};

export function connIndicator(conn: ConnState, everOpen: boolean): string {
  if (conn === 'open') return fg(C.ok)('● live');
  if (conn === 'offline') return dim('○ offline');
  return fg(C.warn)(everOpen ? '◌ reconnecting…' : '◌ connecting…');
}

export interface HeaderInput {
  width: number;
  projectName?: string;
  view?: SessionView;
  models: Partial<Record<AgentId, AgentModelChoice>>;
  developer: AgentId;
  mode?: Mode;
  /** Config the rail and role tags follow (session config, or the pending one before a session). */
  config?: Partial<Pick<SessionConfig, 'mode' | 'developer' | 'reviewer' | 'team' | 'workspaceMode' | 'interactionMode'>>;
  maxRounds?: number;
  conn: ConnState;
  everOpen: boolean;
  mock?: boolean;
}

export function headerLines(h: HeaderInput): string[] {
  const { width, view } = h;
  const title = view ? view.session.title || 'Untitled session' : 'new session';
  const left1 = width < 28 ? bold(fg(C.lina)('◆ LINA')) : `${bold(fg(C.lina)('◆ LINA'))}  ${bold(fg(C.text)(h.projectName ?? 'no project'))}${dim(' / ')}${view ? fg(C.text)(title) : dim(italic(title))}`;
  const rightBits: string[] = [];
  if (h.mock || view?.session.mock || view?.session.config.mock) rightBits.push(bg(C.warn)(fg(C.ink)(bold(' MOCK '))));
  if (view && width >= 64) rightBits.push(STATUS_CHIP[view.session.status]?.() ?? dim(view.session.status));
  rightBits.push(connIndicator(h.conn, h.everOpen));
  const line1 = spread(left1, rightBits.join('  '), width);

  const reviewer: AgentId = h.developer === 'codex' ? 'claude' : 'codex';
  const c = h.config ?? {};
  const cfg: Pick<SessionConfig, 'mode' | 'developer' | 'reviewer' | 'team' | 'workspaceMode' | 'interactionMode'> = { mode: c.mode ?? h.mode ?? 'pair', developer: c.developer ?? h.developer, reviewer: c.reviewer ?? reviewer, team: c.team, workspaceMode: view?.session.config.workspaceMode ?? c.workspaceMode, interactionMode: view?.session.config.interactionMode ?? c.interactionMode };
  const m = (a: AgentId) => `${fg(actorColor(a))(a)} ${fg(C.text)(modelLabel(h.models[a]))}${dim(' ' + roleTags(a, cfg))}`;
  const first = cfg.mode === 'custom' && cfg.team ? cfg.team.developer : h.developer;
  const configured = panelAgentsFor(cfg, h.models);
  const shown = configured.includes('freebuff') ? configured : [first, ...configured.filter(a=>a!==first)];
  const models = shown.map(m).join('  ');
  const round = view && view.round > 0 ? fg(C.muted)(`round ${view.round}/${view.session.config.maxRounds ?? h.maxRounds ?? '?'}`) : '';
  const chosen = view?.session.chosenVariant;
  const modeTag = h.mode ? dim(h.mode) + (chosen ? dim(' · ') + fg(actorColor(chosen))(`${AGENT_NAME[chosen]}'s version`) : '') : '';
  const phase: Phase = view?.phase ?? 'idle';
  const pipeline = railFor(cfg);
  const extraPhase = !pipeline.includes(phase) && phase !== 'plan_review' && phase !== 'idle' && phase !== 'approved' ? '  ' + fg(C.warn)(PHASE_LABEL[phase]) : '';
  const budget = width - strWidth(models) - 4;
  let rail = pipelineRail(phase, false, pipeline);
  if (strWidth(rail) + strWidth(round) + strWidth(modeTag) + 6 > budget) rail = pipelineRail(phase, true, pipeline);
  let left2 = [rail + extraPhase, round, modeTag].filter(Boolean).join('  ');
  if (strWidth(left2) > budget) left2 = [pipelineRail(phase, true, pipeline) + extraPhase, round].filter(Boolean).join('  '); // drop the mode tag first
  if (strWidth(left2) > budget) left2 = [fg(C.lina)(PHASE_LABEL[phase]), round].filter(Boolean).join('  ');
  const line2 = spread(left2, models, width);
  return [line1, line2, fg(C.border)('─'.repeat(width))];
}

export function footerControls(width: number, reading: boolean): { text: string; ranges: { start: number; end: number; action: 'up' | 'down' | 'latest' | 'read' }[] } {
  const labels = width < 24 ? ['[↑]', '[↓]', '[End]'] : width < 44 ? ['[↑]', '[↓]', '[End]', reading ? '[Write]' : '[Read]'] : ['[↑]', '[↓]', '[Latest]', reading ? '[Write]' : '[Scroll]'];
  let start = 2;
  return { text: labels.join(' '), ranges: labels.map((label, index) => { const at = start; start += label.length + 1; return { start: at, end: at + label.length - 1, action: (['up', 'down', 'latest', 'read'] as const)[index] }; }) };
}

// ── agent panels ────────────────────────────────────────────────────────────
export interface PanelInput {
  agent: AgentId;
  view: AgentView;
  role?: Role;
  model?: AgentModelChoice;
  rateLimit?: RateLimitInfo;
  update?: { text: string; streaming: boolean };
  /** parallel/compete: the worktree the agent's current turn runs in ("Claude's version"). */
  scope?: { variant: AgentId; label: string };
  now: number;
  frame: number;
  width: number; // inner width
}

/**
 * Where each agent's latest turn runs (parallel/compete): both agents can be active at once, each in
 * its own worktree, or one reviewing the other's version. Derived from the last `turn` start per agent.
 */
export function agentScopes(view: SessionView | undefined): Partial<Record<AgentId, { variant: AgentId; label: string }>> {
  const out: Partial<Record<AgentId, { variant: AgentId; label: string }>> = {};
  if (!view) return out;
  const mode = view.session.config.mode;
  if (mode !== 'compete' && mode !== 'parallel') return out;
  const what = mode === 'compete' ? 'version' : 'part';
  const seen = new Set<AgentId>();
  for (let i = view.timeline.length - 1; i >= 0 && seen.size < 2; i--) {
    const e = view.timeline[i];
    if (e.type !== 'turn' || seen.has(e.data.agent)) continue;
    seen.add(e.data.agent);
    if (e.data.state !== 'start' || !e.data.variant) continue;
    const v = e.data.variant;
    out[e.data.agent] = { variant: v, label: v === e.data.agent ? `own ${what}` : `${AGENT_NAME[v]}'s ${what}` };
  }
  return out;
}

export function isActive(s: AgentView['status']): boolean {
  return s !== 'idle' && s !== 'done' && s !== 'error' && s !== 'waiting';
}

function rateLabel(r?: RateLimitInfo): string {
  if (!r) return '';
  const vals = Object.entries(r.windows);
  if (!vals.length) return '';
  const [name, w] = vals.reduce((a, b) => (b[1].utilization > a[1].utilization ? b : a));
  const pct = Math.round(w.utilization * 100);
  const short = name.replace('five_hour', '5h').replace('seven_day', '7d').replace(/_/g, ' ');
  return (pct >= 90 ? fg(C.err) : pct >= 70 ? fg(C.warn) : dim)(`${short} ${pct}%`);
}

export function panelTitle(p: PanelInput): string {
  const color = actorColor(p.agent);
  const role = p.role ? dim(p.role === 'developer' ? 'Developer' : 'Reviewer') : dim('—');
  const scope = p.scope ? dim(' · ') + fg(actorColor(p.scope.variant))(p.scope.label) : '';
  const model = fg(C.muted)(modelLabel(p.model ?? (p.view.model ? { model: p.view.model } : undefined)));
  if (p.width < 32) return truncateAnsi(`${bold(fg(color)(AGENT_NAME[p.agent]))} ${role}`, p.width);
  return spread(`${bold(fg(color)(AGENT_NAME[p.agent]))} ${role}${scope}`, model, p.width);
}

export function panelRole(p: PanelInput): string {
  const role = p.role ? (p.role === 'developer' ? 'Developer' : 'Reviewer') : 'Not assigned';
  return truncateAnsi(dim(role) + (p.scope ? dim(' · ') + fg(actorColor(p.scope.variant))(p.scope.label) : ''), p.width);
}

export function panelStatus(p: PanelInput): string {
  const color = actorColor(p.agent);
  const s = p.view.status;
  const active = isActive(s);
  const icon = active ? fg(color)(SPINNER[p.frame % SPINNER.length]) : s === 'error' ? fg(C.err)('✖') : s === 'done' ? fg(C.ok)('✔') : s === 'waiting' ? fg(C.warn)('…') : dim('○');
  const label = active ? fg(C.text)(STATUS_LABEL[s]) : s === 'error' ? fg(C.err)(STATUS_LABEL[s]) : dim(STATUS_LABEL[s]);
  const detail = p.view.detail ? dim(' · ' + p.view.detail) : '';
  const elapsed = active || s === 'waiting' ? dim(formatElapsed(p.now - p.view.since)) : '';
  const rl = rateLabel(p.rateLimit);
  return spread(`${icon} ${label}${detail}`, [rl, elapsed].filter(Boolean).join('  '), p.width);
}

export function activityLine(a: AgentView['activity'][number], agent: AgentId, frame: number, width: number): string {
  if (a.source === 'narrated') return truncateAnsi(dim(italic(`“${a.title.replace(/\s+/g, ' ')}”`)), width);
  const marker = a.state === 'running' ? fg(actorColor(agent))(frame % 10 < 5 ? '●' : '○') : a.state === 'ok' ? fg(C.ok)('●') : fg(C.err)('●');
  const icon = fg(C.muted)(ACTIVITY_ICON[a.kind] ?? '•');
  const exit = a.exitCode !== undefined && a.exitCode !== null && a.exitCode !== 0 ? fg(C.err)(` exit ${a.exitCode}`) : a.state === 'error' ? fg(C.err)(' ✖') : '';
  const title = a.state === 'error' ? fg(C.text)(a.title) : a.state === 'running' ? fg(C.text)(a.title) : fg('#C8C8D0')(a.title);
  return truncateAnsi(`${marker} ${icon} ${title.replace(/\n/g, ' ')}`, Math.max(4, width - strWidth(exit))) + exit;
}

/** The newest visible text, whether the agent is streaming or has just finished. */
export function panelUpdate(view: SessionView | undefined, agent: AgentId): PanelInput['update'] {
  if (!view) return undefined;
  const streams = Object.values(view.streams).filter((stream) => stream.agent === agent);
  const latest = view.timeline.findLast((event) => event.type === 'message' && event.actor === agent);
  const text = agentDisplayText(streams.length ? streams.map((stream) => stream.text).join('\n\n') : latest?.type === 'message' ? latest.data.text : '', streams.length > 0);
  return text ? { text, streaming: streams.length > 0 } : undefined;
}

/** Preserve the original cards, using their room for live text, real activity and output. */
export function panelLines(p: PanelInput, innerHeight: number): string[] {
  const out = [panelTitle(p), panelStatus(p)];
  let room = Math.max(0, innerHeight - out.length);
  const latest = p.view.activity.at(-1);
  const reserved = latest ? Math.min(2, room) : 0;
  if (p.update && room > reserved) {
    if (room >= 6) { out.push(fg(actorColor(p.agent))(p.update.streaming ? '▍ Writing now' : '▍ Latest response')); room--; }
    const count = Math.min(4, Math.max(1, room - reserved));
    const body = renderMarkdown(p.update.text, Math.max(8, p.width - 2)).filter((line) => strWidth(line) > 0);
    const excerpt = p.update.streaming ? body.slice(-count) : body.slice(0, count);
    out.push(...excerpt.map((line) => truncateAnsi(fg(actorColor(p.agent))('▍ ') + line, p.width)));
    room -= excerpt.length;
  }
  if (room > 0 && latest) {
    const output = latest.output?.trimEnd().split('\n').filter(Boolean) ?? [];
    const outputRows = Math.min(2, output.length, Math.max(0, room - 1));
    const actions = p.view.activity.slice(-Math.max(1, room - outputRows));
    out.push(...actions.map((activity) => activityLine(activity, p.agent, p.frame, p.width)));
    out.push(...output.slice(-outputRows || output.length).map((line) => truncateAnsi(dim('  ' + line), p.width)));
  } else if (!p.update && room > 0) out.push(dim(p.view.status === 'idle' ? 'No activity yet' : ''));
  return out.slice(0, innerHeight);
}

export function compactPanelLines(p: PanelInput, innerHeight = 3): string[] {
  return panelLines(p, innerHeight);
}

// ── composer ────────────────────────────────────────────────────────────────
export const COMPOSER_MAX_ROWS = 8;

/** Soft-wraps the editor value and draws the cursor. Returns all visual rows + the cursor row. */
export function composerRows(ed: Ed, width: number, showCursor: boolean): { rows: string[]; cursorRow: number } {
  const w = Math.max(4, width);
  const rows: string[] = [];
  let cursorRow = 0;
  let offset = 0;
  const logical = ed.value.split('\n');
  logical.forEach((line, li) => {
    const chars = [...graphemes(line)].map((part) => part.segment);
    let row = '';
    let rowW = 0;
    let idx = offset; // string index of the current char
    const flush = () => { rows.push(row); row = ''; rowW = 0; };
    if (!chars.length) {
      if (ed.cursor === offset && showCursor) { row = inverse(' '); cursorRow = rows.length; }
      flush();
    } else {
      for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];
        // Joined emoji, flags and combining marks occupy one visible character.
        const cw = /[\ufe0f\u20e3]/u.test(ch) ? 2 : Math.max(1, ...[...ch].map((c) => charWidth(c.codePointAt(0)!)));
        if (rowW + cw > w) flush();
        if (idx === ed.cursor && showCursor) { row += inverse(ch); cursorRow = rows.length; } else row += ch;
        rowW += cw;
        idx += ch.length;
      }
      if (ed.cursor === offset + line.length && showCursor) {
        if (rowW + 1 > w) flush();
        row += inverse(' ');
        cursorRow = rows.length;
      }
      flush();
    }
    offset += line.length + 1;
    void li;
  });
  return { rows, cursorRow };
}

/** Visible slice of composer rows, keeping the cursor in view. */
export function composerView(ed: Ed, width: number, showCursor: boolean, maxRows = COMPOSER_MAX_ROWS): { lines: string[]; total: number } {
  const { rows, cursorRow } = composerRows(ed, width, showCursor);
  if (rows.length <= maxRows) return { lines: rows, total: rows.length };
  const start = Math.min(Math.max(0, cursorRow - maxRows + 1), rows.length - maxRows);
  return { lines: rows.slice(start, start + maxRows), total: rows.length };
}
