// Full-area overlays. Each one owns its keys while mounted (App's input is inactive).
import React, { useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { SessionView } from '../../shared/reducer.js';
import type { AgentId, AgentModels, DiffFile, DoctorCheck, Effort, Finding, Mode, ModelInfo, ModelValidation, SearchHit, Session, TeamConfig, TestRun } from '../../shared/types.js';
import { MODE_DESCRIPTION, MODE_LABEL, PHASE_LABEL, pipelineFor } from '../../shared/reducer.js';
import { AGENT_IDS } from '../../shared/types.js';
import { CLI_MODES } from '../args.js';
import { defaultTeam, formatTeamSpec, rolesForTeam, teamSummary, validateTeam } from '../team.js';
import { bg, bold, dim, fg, italic, padAnsi, stripAnsi, strWidth, truncateAnsi, wrapAnsi } from '../ansi.js';
import { renderMarkdown } from '../markdown.js';
import { AGENT_NAME, C, SEVERITY_COLOR, actorColor } from '../theme.js';
import { findingScope, findingStatus, severityChip } from '../transcript.js';
import { formatAgo, formatClock, formatDuration, listWindow, shortId } from '../layout.js';
import { SLASH_COMMANDS, type SlashAction } from '../slash.js';
import { describeError, type TuiStore } from './store.js';
import { useAsync, useStore } from './hooks.js';
import { Lines } from './Lines.js';
import { useMouse, useWheel, useWheelScroll, useWheelSelection } from './mouse.js';
import { activityLine, agentScopes, isActive, panelStatus, panelTitle, panelRole, spread } from './chrome.js';

export type OverlayKind = 'menu' | 'live' | 'help' | 'sessions' | 'search' | 'models' | 'diff' | 'findings' | 'tests' | 'doctor' | 'project' | 'mode' | 'team';

interface Common { store: TuiStore; width: number; height: number; onClose: () => void }

export function MenuOverlay({ store, width, height, onClose, onSelect }: Common & { onSelect: (action: SlashAction) => void }) {
  const st = useStore(store);
  const [selected, setSelected] = useState(0);
  const entries: { title: string; detail: string; action: SlashAction }[] = [
    { title: 'New conversation', detail: '/new', action: { type: 'new' } },
    { title: 'Conversations', detail: '/sessions', action: { type: 'sessions' } },
    { title: 'Codex activity', detail: '/live codex', action: { type: 'live', agent: 'codex' } },
    { title: 'Claude activity', detail: '/live claude', action: { type: 'live', agent: 'claude' } },
    { title: 'Changes & diff', detail: '/diff', action: { type: 'diff' } },
    { title: 'Test results', detail: '/tests', action: { type: 'tests' } },
    { title: 'Review findings', detail: '/findings', action: { type: 'findings' } },
    { title: 'Models', detail: '/models', action: { type: 'models' } },
    { title: 'Collaboration mode', detail: '/mode', action: { type: 'mode-picker' } },
    { title: 'Custom team', detail: '/team', action: { type: 'team-picker' } },
    { title: 'Switch project', detail: '/project', action: { type: 'project' } },
    ...(st.view?.session.status === 'running' ? [{ title: 'Pause agents', detail: '/pause', action: { type: 'control' as const, action: 'pause' as const } }] : []),
    ...(st.view && ['paused','failed','interrupted','cancelled'].includes(st.view.session.status) ? [{ title: 'Resume agents', detail: '/resume', action: { type: 'control' as const, action: 'resume' as const } }] : []),
    { title: 'Scroll mode', detail: '/scroll', action: { type: 'scroll' } },
    { title: 'Open web interface', detail: '/ui', action: { type: 'ui' } },
    { title: 'Help & shortcuts', detail: '/help', action: { type: 'help' } },
  ];
  const h = innerH(height), w = innerW(width);
  const window = listWindow(entries.length, h, selected);
  const choose = (index: number) => { if (entries[index]) onSelect(entries[index].action); };
  useWheelSelection(setSelected, entries.length);
  useMouse((event) => {
    if (event.released || event.motion || event.button !== 0 || event.x < 2 || event.x >= width) return;
    const row = event.y - 6;
    if (row >= 0 && row < h) choose(window.start + row);
  });
  useInput((input, key) => {
    if (key.escape || (key.ctrl && ['c','k'].includes(input))) return onClose();
    if (key.upArrow || input === 'k') setSelected((n) => Math.max(0, n - 1));
    if (key.downArrow || input === 'j') setSelected((n) => Math.min(entries.length - 1, n + 1));
    if (key.pageUp) setSelected((n) => Math.max(0, n - h));
    if (key.pageDown) setSelected((n) => Math.min(entries.length - 1, n + h));
    if (key.return) choose(selected);
  });
  const lines = entries.slice(window.start, window.end).map((item, index) => {
    const chosen = window.start + index === selected;
    const line = spread((chosen ? '› ' : '  ') + item.title, dim(item.detail), w);
    return chosen ? bg('#292535')(fg(C.linaSoft)(padAnsi(line, w))) : fg(C.text)(line);
  });
  return <Frame onClose={onClose} title="◆ Menu" hint="Tap an item · ↑/↓ select · Enter open" width={width} height={height}><Lines lines={lines} height={h} /></Frame>;
}

export function SearchOverlay({ store, width, height, onClose, query, onSelect }: Common & { query: string; onSelect: (hit: SearchHit) => void }) {
  const result = useAsync(() => store.search(query), [query]);
  const [selected, setSelected] = useState(0);
  const hits = result.data ?? [];
  const page = Math.max(1, Math.floor(innerH(height) / 3));
  useWheelSelection(setSelected, hits.length);
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) return onClose();
    if (key.upArrow) setSelected((n) => Math.max(0, n - 1));
    if (key.downArrow) setSelected((n) => Math.min(Math.max(0, hits.length - 1), n + 1));
    if (key.pageUp) setSelected((n) => Math.max(0, n - page));
    if (key.pageDown) setSelected((n) => Math.min(Math.max(0, hits.length - 1), n + page));
    if (key.return && hits[selected]) onSelect(hits[selected]);
  });
  let lines: string[];
  if (result.loading) lines = [dim('Searching conversations…')];
  else if (result.error) lines = errorLines(result.error, innerW(width));
  else if (!hits.length) lines = [dim('No matching messages.')];
  else {
    const window = listWindow(hits.length, page, selected);
    lines = hits.slice(window.start, window.end).flatMap((hit, i) => {
      const title = `${window.start + i === selected ? '▸' : ' '} ${hit.sessionTitle || 'Untitled'} · ${hit.actor} · event ${hit.seq}`;
      const snippet = hit.snippet.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ');
      return [window.start + i === selected ? fg(C.lina)(truncateAnsi(title, innerW(width))) : truncateAnsi(title, innerW(width)), dim(truncateAnsi('  ' + snippet, innerW(width))), ''];
    });
  }
  return <Frame onClose={onClose} title={`◆ Search · ${query}`} hint="↑/↓ select · Enter open message · Esc close" width={width} height={height}><Lines lines={lines} height={innerH(height)} /></Frame>;
}

export function Frame({ title, hint, width, height, children, color = C.lina, onClose }: { title: string; hint: string; width: number; height: number; children: React.ReactNode; color?: string; onClose?: () => void }) {
  useMouse((event) => {
    if (!event.released && !event.motion && event.button === 0 && event.y === 5 && event.x >= width - 9 && event.x <= width - 2) onClose?.();
  }, !!onClose);
  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="round" borderColor={color} paddingX={1} overflow="hidden">
      <Text wrap="truncate-end">{spread(bold(fg(color)(title)), dim(onClose ? '[Back]' : 'Esc close'), width - 4)}</Text>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">{children}</Box>
      <Text wrap="truncate-end">{dim(hint)}</Text>
    </Box>
  );
}

const innerH = (h: number) => Math.max(1, h - 4);
const innerW = (w: number) => Math.max(10, w - 4);

function errorLines(e: unknown, width: number): string[] {
  const d = describeError(e);
  return [...wrapAnsi(fg(C.err)('✖ ' + d.text), width), ...(d.hint ? wrapAnsi(dim('↳ ' + d.hint), width) : [])];
}

function scrollKeys(input: string, key: { upArrow: boolean; downArrow: boolean; pageUp: boolean; pageDown: boolean; home: boolean; end: boolean }, page: number, set: (f: (n: number) => number) => void) {
  if (key.upArrow || input === 'k') set((n) => n - 1);
  else if (key.downArrow || input === 'j') set((n) => n + 1);
  else if (key.pageUp) set((n) => n - page);
  else if (key.pageDown || input === ' ') set((n) => n + page);
  else if (key.home || input === 'g') set(() => 0);
  else if (key.end || input === 'G') set(() => 1e9);
}

/** Scrollable list of lines with a top offset. */
function ScrollLines({ lines, height, top }: { lines: string[]; height: number; top: number }) {
  const maxTop = Math.max(0, lines.length - height);
  const t = Math.min(Math.max(0, top), maxTop);
  const shown = lines.slice(t, t + height);
  const more = lines.length > height ? dim(`  ${t + 1}–${Math.min(lines.length, t + height)} of ${lines.length}`) : '';
  return <Lines lines={more && shown.length === height ? [...shown.slice(0, height - 1), more] : shown} height={height} />;
}

// ── live agent activity ───────────────────────────────────────────────────────
export type LiveFocus = AgentId | 'all';

export interface LiveOptions {
  width: number;
  now: number;
  frame: number;
  /** Show a cursor on `selected`, or on the newest item when it is unset or gone. */
  cursor?: boolean;
  selected?: string;
  expanded?: ReadonlySet<string>;
  /** Rows of streamed / latest text to show. */
  updateRows: number;
}

export interface LiveBlock {
  lines: string[];
  /** Activity keys, newest first, with the first and last line of each item. */
  items: { key: string; start: number; end: number }[];
}

/** The agent's newest completed message in the timeline. */
export function latestAgentMessage(view: SessionView, agent: AgentId): string | undefined {
  const e = view.timeline.findLast((x) => x.type === 'message' && x.actor === agent);
  return e?.type === 'message' ? e.data.text : undefined;
}

/** Everything one agent is doing: status, what it is writing, and its full activity feed (newest first). */
export function liveAgentLines(view: SessionView, agent: AgentId, o: LiveOptions): LiveBlock {
  const w = Math.max(10, o.width);
  const a = view.agents[agent];
  const cfg = view.session.config;
  const configuredRole = cfg.mode === 'parallel' || cfg.mode === 'compete' ? 'developer'
    : cfg.developer === agent ? 'developer'
    : cfg.mode === 'solo' || (cfg.mode === 'custom' && !cfg.team?.reviewers.includes(agent)) ? undefined : 'reviewer';
  const p = { agent, view: a, role: a.role ?? configuredRole, model: a.model ? { model: a.model, effort: cfg.models[agent]?.effort } : cfg.models[agent], rateLimit: view.rateLimits[agent], scope: agentScopes(view)[agent], now: o.now, frame: o.frame, width: w };
  const u = view.session.usage?.[agent];
  const lines = w < 64 ? [panelTitle(p), panelRole(p), panelStatus(p)] : [panelTitle(p), panelStatus(p)];
  if (u && u.inputTokens + u.outputTokens > 0) lines.push(dim(`${(u.inputTokens + u.outputTokens).toLocaleString('en-US')} tokens · ${u.turns} turn${u.turns === 1 ? '' : 's'} this session`));

  const streams = Object.values(view.streams).filter((s) => s.agent === agent);
  const latest = streams.length ? undefined : latestAgentMessage(view, agent);
  if (streams.length || latest) {
    lines.push('', fg(actorColor(agent))(streams.length ? '▍ Writing now' : '▍ Latest update'));
    const body = streams.length ? renderMarkdown(streams.map((s) => s.text).join('\n\n') || '…', w - 2) : renderMarkdown(latest!, w - 2);
    const rows = Math.max(1, o.updateRows);
    // a stream shows its newest lines; a finished message its beginning
    const shown = body.length <= rows ? body : streams.length ? [dim(`… ${body.length - rows + 1} earlier lines`), ...body.slice(-(rows - 1))] : [...body.slice(0, rows - 1), dim(`… ${body.length - rows + 1} more lines`)];
    lines.push(...shown.map((l) => '  ' + truncateAnsi(l, w - 2)));
  }

  const acts = a.activity.slice().reverse();
  lines.push('', spread(fg(actorColor(agent))('▍ Activity'), dim(acts.length ? `${acts.length} event${acts.length === 1 ? '' : 's'} · newest first` : ''), w));
  const items: LiveBlock['items'] = [];
  const selKey = !o.cursor ? undefined : acts.some((x) => x.key === o.selected) ? o.selected : acts[0]?.key;
  if (!acts.length) lines.push(dim(isActive(a.status) ? '  Waiting for the first event…' : '  No activity yet.'));
  for (const x of acts) {
    const start = lines.length;
    const sel = selKey === x.key;
    const open = o.expanded?.has(x.key);
    const more = !!(x.output || x.files?.length || (x.detail && x.detail.trim() !== x.title.trim()));
    const head = `${sel ? fg(C.lina)('▸') : ' '} ${dim(formatClock(x.ts))} ${activityLine(x, agent, o.frame, w - 10)}`;
    lines.push(more && !open ? spread(head, dim('›'), w) : head);
    if (open) {
      const pad = '        ';
      const iw = Math.max(10, w - pad.length);
      if (x.detail && x.detail.trim() !== x.title.trim()) lines.push(...wrapAnsi(fg(C.muted)(x.detail), iw).map((l) => pad + l));
      if (x.files?.length) lines.push(...wrapAnsi(dim('files ') + x.files.map((f) => fg(C.text)(f)).join(dim(', ')), iw).map((l) => pad + l));
      if (x.output) {
        const out = x.output.replace(/\t/g, '    ').replace(/\s+$/, '').split('\n');
        const tail = out.slice(-40);
        if (out.length > tail.length) lines.push(pad + dim(`… ${out.length - tail.length} earlier output lines`));
        lines.push(...tail.map((l) => pad + truncateAnsi(dim(l), iw)));
      }
      if (!more) lines.push(pad + dim('(no further detail)'));
    }
    items.push({ key: x.key, start, end: lines.length - 1 });
  }
  return { lines: lines.map((l) => truncateAnsi(l, w)), items };
}

/** Side-by-side columns (wide) or stacked blocks of both agents. */
export function liveAllLines(view: SessionView, o: Omit<LiveOptions, 'selected' | 'expanded'>): string[] {
  if (o.width >= 100) {
    const cw = Math.floor((o.width - 3) / 2);
    const cols = AGENT_IDS.map((a) => liveAgentLines(view, a, { ...o, width: cw }).lines);
    const n = Math.max(...cols.map((c) => c.length));
    return Array.from({ length: n }, (_, i) => padAnsi(cols[0][i] ?? '', cw) + ' ' + fg(C.border)('│') + ' ' + (cols[1][i] ?? ''));
  }
  const [x, y] = AGENT_IDS.map((a) => liveAgentLines(view, a, o).lines);
  return [...x, '', fg(C.border)('─'.repeat(o.width)), ...y];
}

export function LiveOverlay({ store, width, height, onClose, frame, now, agent }: Common & { frame: number; now: number; agent?: AgentId }) {
  const st = useStore(store);
  const view = st.view;
  const [focus, setFocus] = useState<LiveFocus>(agent ?? 'all');
  const [sel, setSel] = useState<string | undefined>(undefined);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [allTop, setAllTop] = useState(0);
  const top = useRef(0);
  const w = innerW(width);
  const h = innerH(height) - 1; // one row for the agent tabs
  const order: LiveFocus[] = ['all', ...AGENT_IDS];
  const base = { width: w, now, frame };

  const single = view && focus !== 'all' ? liveAgentLines(view, focus, { ...base, cursor: true, selected: sel, expanded, updateRows: Math.max(4, Math.floor(h / 3)) }) : undefined;
  // the cursor sits on the newest item until moved; it follows its item as new events arrive
  const selIdx = single ? Math.max(0, single.items.findIndex((i) => i.key === sel)) : 0;
  const cur = single?.items[selIdx];
  const all = view && focus === 'all' ? liveAllLines(view, { ...base, updateRows: 6 }) : undefined;

  let lines: string[];
  let t = 0;
  if (!view) lines = [dim('No session yet — start one and the agents\' live work appears here.')];
  else if (single) {
    lines = single.lines;
    t = top.current;
    const vis = lines.length > h ? h - 1 : h; // ScrollLines uses the last row for its position
    if (cur) {
      if (selIdx === 0 && cur.start < t + vis) t = 0; // keep the status and live text in view at the newest item
      if (cur.start < t) t = cur.start;
      if (cur.end >= t + vis) t = Math.min(cur.start, cur.end - vis + 1);
    }
    t = Math.max(0, Math.min(t, lines.length - h));
    top.current = t;
  } else {
    lines = all!;
    t = Math.max(0, Math.min(allTop, lines.length - h));
  }

  const move = (d: number) => {
    if (!single?.items.length) return;
    const i = Math.max(0, Math.min(single.items.length - 1, selIdx + d));
    setSel(single.items[i].key);
  };
  useWheel((delta) => {
    if (single) move(delta);
    else setAllTop((x) => Math.max(0, Math.min(Math.max(0, lines.length - h), x + delta * 3)));
  });
  const switchTo = (f: LiveFocus) => { setFocus(f); setSel(undefined); top.current = 0; setAllTop(0); };
  useInput((input, key) => {
    if (key.escape || input === 'q' || (key.ctrl && (input === 'c' || input === 't'))) return onClose();
    if (key.tab || key.rightArrow || key.leftArrow) {
      const d = key.leftArrow || key.shift ? -1 : 1;
      return switchTo(order[(order.indexOf(focus) + d + order.length) % order.length]);
    }
    if (input === '1' || input === 'a') return switchTo('all');
    if (input === '2') return switchTo('codex');
    if (input === '3') return switchTo('claude');
    if (single) {
      if (key.upArrow || input === 'k') move(-1);
      else if (key.downArrow || input === 'j') move(1);
      else if (key.pageUp) move(-10);
      else if (key.pageDown || input === ' ') move(10);
      else if (key.home || input === 'g') move(-1e9);
      else if (key.end || input === 'G') move(1e9);
      else if ((key.return || input === 'o') && cur) setExpanded((s) => { const n = new Set(s); if (n.has(cur.key)) n.delete(cur.key); else n.add(cur.key); return n; });
      else if (input === 'e' && single.items.length) setExpanded((s) => (s.size ? new Set() : new Set(single.items.map((i) => i.key))));
      return;
    }
    scrollKeys(input, key, h - 1, (f) => setAllTop((x) => Math.max(0, Math.min(Math.max(0, lines.length - h), f(Math.min(x, Math.max(0, lines.length - h)))))));
  });

  const tab = (f: LiveFocus) => {
    const label = f === 'all' ? (w < 48 ? 'All' : 'All agents') : AGENT_NAME[f];
    const color = f === 'all' ? C.lina : actorColor(f);
    const busy = w >= 32 && f !== 'all' && view && isActive(view.agents[f].status) ? ' ' + fg(color)('●') : '';
    return (f === focus ? bg(color)(fg(C.ink)(bold(` ${label} `))) : fg(color)(` ${label} `)) + busy;
  };
  useMouse((event) => {
    if (event.released || event.motion || event.button !== 0 || event.y !== 6) return;
    let left = 3;
    for (const item of order) {
      const cellWidth = stripAnsi(tab(item)).length;
      if (event.x >= left && event.x < left + cellWidth) { switchTo(item); return; }
      left += cellWidth + 1;
    }
  });
  useMouse((event) => {
    if (event.released || event.motion || event.button !== 0 || event.y < 7 || event.x < 3 || event.x > width - 2 || !single) return;
    const line = event.y - 7 + t;
    const item = single.items.find((activity) => line >= activity.start && line <= activity.end);
    if (item) { setSel(item.key); setExpanded((current) => { const next = new Set(current); if (next.has(item.key)) next.delete(item.key); else next.add(item.key); return next; }); }
  });
  const both = view && AGENT_IDS.every((a) => isActive(view.agents[a].status));
  const tabs = spread(order.map(tab).join(' '), both ? fg(C.ok)('both agents are working at the same time') : '', w);
  const hint = focus === 'all'
    ? 'Tab/1-3 agent · ↑/↓ PgUp/PgDn scroll · Esc close'
    : 'Tab/1-3 agent · ↑/↓ select · Enter show output/files · e expand all · Esc close';
  return (
    <Frame onClose={onClose} title={`◆ Live ${dim('· what the agents are doing')}`} hint={hint} width={width} height={height}>
      <Text wrap="truncate-end">{tabs}</Text>
      <ScrollLines lines={lines} height={h} top={t} />
    </Frame>
  );
}

// ── help ────────────────────────────────────────────────────────────────────
export function helpLines(width: number): string[] {
  const k = (keys: string, what: string) => padAnsi(fg(C.lina)(keys), 22) + fg(C.text)(what);
  const out: string[] = [
    bold('Composer'),
    k('Enter', 'send message (or run a /command)'),
    k('Alt+Enter · Ctrl+J', 'new line'),
    k('↑ / ↓', 'scroll when empty · history/caret while writing · pick suggestion'),
    k('Alt+↑ / Alt+↓', 'recall message history, including from an empty composer'),
    k('Tab', 'complete @codex @claude and /commands'),
    k('Ctrl+A/E · Ctrl+U/K · Ctrl+W', 'line start/end · kill to start/end · delete word'),
    k('//text', 'send a message that starts with "/"'),
    '',
    bold('Session'),
    k('Ctrl+C', 'cancel the running turn (asks first) · twice to quit'),
    k('Ctrl+P', 'pause / resume'),
    k('Ctrl+K (empty) · /menu', 'navigation and tools; tap [Menu] on a phone'),
    k('Ctrl+T', 'live view: what each agent is doing right now'),
    k('Ctrl+D', 'diff of the work so far'),
    k('Ctrl+F', 'review findings'),
    k('Ctrl+L', 'switch session'),
    k('Ctrl+O', 'open this session in the web UI'),
    k('Swipe · Wheel · PgUp / PgDn', 'scroll; scrolling past the top loads earlier messages'),
    k('Tap [↑] [↓] [Latest] [Scroll]', 'phone controls; Scroll mode preserves your draft while reading'),
    k('Ctrl+G · /scroll', 'scroll mode: arrows and j/k scroll even with a draft; Esc writes'),
    k('F1 · ? (empty)', 'this help'),
    k('Esc', 'close overlay · jump to bottom'),
    '',
    bold('Commands'),
    ...SLASH_COMMANDS.map((c) => padAnsi(fg(C.lina)('/' + c.name) + (c.args ? ' ' + dim(c.args) : ''), 38) + fg(C.text)(c.desc)),
    '',
    bold('Talking to one agent'),
    ...wrapAnsi(`Start a message with ${fg(C.codex)('@codex')} or ${fg(C.claude)('@claude')} to ask that agent directly (a consult turn with its role's permissions).`, width),
    '',
    ...wrapAnsi(dim('While agents are working your messages are queued and delivered at the next turn boundary; /interrupt <msg> cuts in immediately. Quitting the TUI never stops the agents — `lina attach` brings you back.'), width),
  ];
  return out.map((l) => truncateAnsi(l, width));
}

export function HelpOverlay({ width, height, onClose }: Common) {
  const [top, setTop] = useState(0);
  const lines = useMemo(() => helpLines(innerW(width)), [width]);
  useWheelScroll(setTop, lines.length - innerH(height));
  useInput((input, key) => {
    if (key.escape || input === 'q' || input === '?' || (key.ctrl && input === 'c')) return onClose();
    scrollKeys(input, key, innerH(height) - 1, (f) => setTop((t) => Math.max(0, Math.min(lines.length - innerH(height), f(t)))));
  });
  return (
    <Frame onClose={onClose} title="◆ Help" hint="↑/↓ scroll · Esc close" width={width} height={height}>
      <ScrollLines lines={lines} height={innerH(height)} top={top} />
    </Frame>
  );
}

// ── sessions ────────────────────────────────────────────────────────────────
const STATUS_COLOR: Record<string, string> = { running: C.ok, paused: C.warn, awaiting_approval: C.lina, completed: C.ok, approved: C.ok, rejected: C.err, failed: C.err, cancelled: C.muted, interrupted: C.warn, idle: C.muted };

export function SessionsOverlay({ store, width, height, onClose, mode = 'sessions' }: Common & { mode?: 'sessions' | 'history' | 'resume' }) {
  const st = useStore(store);
  const [all, setAll] = useState(mode !== 'sessions');
  const [sel, setSel] = useState(0);
  const open = (id: string) => { void (mode === 'resume' ? store.resumeSession(id) : store.openSession(id)); onClose(); };
  const projectId = st.project?.id;
  const res = useAsync(async () => {
    const list = await store.client.sessions(all || !projectId ? {} : { projectId });
    return list.sort((a, b) => b.updatedAt - a.updatedAt);
  }, [all, projectId]);
  const list: Session[] = useMemo(() => (res.data ?? []).filter((s) => !st.deletedIds.includes(s.id)), [res.data, st.deletedIds]);
  const w = innerW(width);
  const h = innerH(height);
  const page = Math.max(1, Math.floor(h / 2));
  const window = listWindow(list.length, page, sel);
  useMouse((event) => {
    if (event.released || event.motion || event.button !== 0 || event.x < 2 || event.x >= width) return;
    const row = event.y - 6;
    const item = row >= 0 && row < page * 2 ? list[window.start + Math.floor(row / 2)] : undefined;
    if (item) open(item.id);
  });
  useWheelSelection(setSel, list.length);
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) return onClose();
    if (key.tab) { setAll((a) => !a); setSel(0); return; }
    if (input === 'n') { store.newDraft(); return onClose(); }
    if (input === 'r') return res.reload();
    if (key.upArrow) setSel((s) => Math.max(0, s - 1));
    if (key.downArrow) setSel((s) => Math.max(0, Math.min(list.length - 1, s + 1)));
    if (key.pageUp) setSel((s) => Math.max(0, s - h));
    if (key.pageDown) setSel((s) => Math.max(0, Math.min(list.length - 1, s + h)));
    if (key.return && list[sel]) open(list[sel].id);
  });
  let lines: string[];
  if (res.loading && !res.data) lines = [dim('Loading sessions…')];
  else if (res.error) lines = errorLines(res.error, w);
  else if (!list.length) lines = [dim(all ? 'No sessions yet.' : 'No sessions in this project yet — press n to start one, Tab for all projects.')];
  else {
    lines = list.slice(window.start, window.end).flatMap((item, index) => {
      const selected = window.start + index === sel;
      const current = item.id === st.sessionId ? '● ' : '  ';
      const title = (selected ? '› ' : current) + (item.title || 'Untitled conversation');
      const status = fg(STATUS_COLOR[item.status] ?? C.muted)(item.status.replaceAll('_', ' '));
      const meta = '  ' + status + dim(' · ' + formatAgo(item.updatedAt)) + (width >= 80 ? dim(' · ' + shortId(item.id)) : '');
      return [selected ? bg('#292535')(fg(C.linaSoft)(padAnsi(truncateAnsi(title, w), w))) : fg(C.text)(truncateAnsi(title, w)), truncateAnsi(meta, w)];
    });
  }
  return (
    <Frame onClose={onClose} title={`◆ ${mode === 'history' ? 'History' : mode === 'resume' ? 'Resume conversation' : 'Sessions'} ${all ? dim('· all projects') : dim('· ' + (st.project?.name ?? ''))}`} hint="↑/↓ select · Enter open · n new session · Tab all projects · r refresh" width={width} height={height}>
      <Lines lines={lines} height={h} />
    </Frame>
  );
}

// ── models ──────────────────────────────────────────────────────────────────
export function ModelsOverlay({ store, width, height, onClose, initialAgent }: Common & { initialAgent?: AgentId }) {
  const st = useStore(store);
  const [agent, setAgent] = useState<AgentId>(initialAgent ?? store.currentConfig().developer ?? st.settings?.developer ?? 'codex');
  const [selected, setSelected] = useState<Partial<Record<AgentId, string>>>({});
  const [efforts, setEfforts] = useState<Record<string, Effort>>({});
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [saving, setSaving] = useState(false);
  const applying = useRef(false);
  const [error, setError] = useState('');
  const [checks, setChecks] = useState<Record<string, ModelValidation | 'pending'>>({});
  const res = useAsync(() => store.client.models(refresh > 0), [refresh]);
  const cfg = store.currentConfig();
  const current = cfg.models?.[agent] ?? st.settings?.models[agent];
  const cat: AgentModels | undefined = res.data?.[agent];
  const models = (cat?.models ?? []).filter((m) => `${m.id} ${m.label ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()));
  const selectedId = selected[agent] ?? current?.model ?? cat?.defaultModel;
  const sel = Math.max(0, models.findIndex((m) => m.id === selectedId));
  const model = models[sel];
  const effortFor = (m: ModelInfo): Effort | undefined => {
    const effort = efforts[`${agent}:${m.id}`] ?? current?.effort;
    return effort && m.efforts?.includes(effort) ? effort : m.defaultEffort;
  };
  const w = innerW(width);
  const h = innerH(height);
  // Tab hit areas drive both rendering and touch input, so they must come from the same list.
  const tabHits: { agent: AgentId; start: number; end: number }[] = [];
  let tabX = 0;
  for (const a of AGENT_IDS) { const label = ` ${AGENT_NAME[a]} `; tabHits.push({ agent: a, start: tabX, end: tabX + strWidth(label) }); tabX += strWidth(label) + 2; }
  const prefixRows = 4;
  const room = Math.max(1, h - prefixRows - 3);
  const win = listWindow(models.length, room, sel);
  const setSel = (update: (n: number) => number) => {
    setSelected((s) => {
      const index = Math.max(0, models.findIndex((m) => m.id === (s[agent] ?? selectedId)));
      const m = models[Math.max(0, Math.min(models.length - 1, update(index)))];
      return m ? { ...s, [agent]: m.id } : s;
    });
  };
  useWheelSelection(setSel, models.length, !saving);
  const switchAgent = (a: AgentId) => { if (!applying.current) { setAgent(a); setQuery(''); setSearching(false); setError(''); } };
  const apply = async (m?: ModelInfo) => {
    if (!m || applying.current) return;
    applying.current = true; setSaving(true); setError('');
    try {
      if (await store.setModel(agent, m.id, effortFor(m))) onClose();
      else setError(store.getState().notices.at(-1)?.text ?? 'Could not change the model. Try again.');
    } catch (e) { setError(describeError(e).text); }
    finally { applying.current = false; setSaving(false); }
  };
  const validate = (m: ModelInfo) => {
    const k = `${agent}:${m.id}`;
    if (checks[k] === 'pending') return;
    setChecks((c) => ({ ...c, [k]: 'pending' }));
    store.client.validateModel(agent, m.id).then(
      (v) => setChecks((c) => ({ ...c, [k]: v })),
      (e) => setChecks((c) => ({ ...c, [k]: { ok: false, checkedAt: Date.now(), error: describeError(e).text } })),
    );
  };
  const cycleEffort = () => {
    if (!model?.efforts?.length) return;
    const choices = model.efforts;
    const next = choices[(choices.indexOf(effortFor(model) as Effort) + 1) % choices.length];
    setEfforts((s) => ({ ...s, [`${agent}:${model.id}`]: next }));
  };
  // The same labels and hit areas drive touch input and rendering.
  const effortButtons: { label: string; start: number; end: number; effort: Effort }[] = [];
  let effortX = strWidth('Effort: ');
  for (const effort of model?.efforts ?? []) {
    const label = `[${effort}]`;
    effortButtons.push({ label, start: effortX, end: effortX + strWidth(label), effort });
    effortX += strWidth(label) + 1;
  }
  const actions = [{ label: '[Use model]', run: () => void apply(model) }, { label: '[Search]', run: () => setSearching(true) },
    { label: '[Refresh]', run: () => setRefresh((n) => n + 1) }, { label: '[Validate]', run: () => { if (model) validate(model); } }];
  let actionX = 0;
  const actionButtons = actions.map((action) => { const start = actionX; actionX += strWidth(action.label) + 1; return { ...action, start, end: actionX - 1 }; });
  useMouse((event) => {
    if (event.released || event.motion || event.button !== 0 || applying.current) return;
    const row = event.y - 6, x = event.x - 3;
    if (x < 0 || x >= w) return;
    if (row === 0) {
      const hit = tabHits.find((t) => x >= t.start && x < t.end);
      if (hit) switchAgent(hit.agent);
    } else if (row === 2) setSearching(true);
    else if (row >= prefixRows && row < prefixRows + room) void apply(models[win.start + row - prefixRows]);
    else if (row === prefixRows + room && model) {
      const hit = effortButtons.find((b) => x >= b.start && x < b.end);
      if (hit) setEfforts((s) => ({ ...s, [`${agent}:${model.id}`]: hit.effort }));
    } else if (row === prefixRows + room + 1) actionButtons.find((b) => x >= b.start && x < b.end)?.run();
  });
  useInput((input, key) => {
    if (applying.current) return;
    if (key.ctrl && input === 'c') return onClose();
    if (key.escape) { if (searching || query) { setSearching(false); setQuery(''); } else onClose(); return; }
    if (key.leftArrow || key.rightArrow || key.tab) {
      const step = key.leftArrow ? AGENT_IDS.length - 1 : 1;
      switchAgent(AGENT_IDS[(AGENT_IDS.indexOf(agent) + step) % AGENT_IDS.length]);
      return;
    }
    if (key.upArrow) { setSel((s) => s - 1); return; }
    if (key.downArrow) { setSel((s) => s + 1); return; }
    if (key.pageUp) { setSel((s) => s - room); return; }
    if (key.pageDown) { setSel((s) => s + room); return; }
    if (key.return) { void apply(model); return; }
    if (searching) {
      if (key.backspace || key.delete) setQuery((q) => q.slice(0, -1));
      else if (input && !key.ctrl && !key.meta) setQuery((q) => q + input.replace(/[\r\n\t]/g, ''));
      return;
    }
    if (input === '/' || (key.ctrl && input === 'f')) setSearching(true);
    else if (input === 'r') setRefresh((n) => n + 1);
    else if (input === 'v' && model) validate(model);
    else if (input === 'e') cycleEffort();
  });
  const tab = (a: AgentId) => (a === agent ? bg(actorColor(a))(fg(C.ink)(bold(` ${AGENT_NAME[a]} `))) : fg(actorColor(a))(` ${AGENT_NAME[a]} `));
  const lines: string[] = [AGENT_IDS.map(tab).join('  '),
    truncateAnsi(dim(`Current: ${current?.model ?? cat?.defaultModel ?? 'CLI default'}${current?.effort ? ' · ' + current.effort : ''}`), w),
    truncateAnsi(searching ? fg(C.linaSoft)(`Search: ${query}▏`) : dim(query ? `Search: ${query}` : '[Search]  / to filter models'), w), ''];
  if (res.loading && !res.data) lines.push(dim('Discovering models…'));
  else if (res.error) lines.push(truncateAnsi(fg(C.err)(describeError(res.error).text), w));
  else if (!models.length) lines.push(truncateAnsi(dim(cat?.error ?? (query ? 'No matching models. Esc clears search.' : 'No models discovered. Refresh to try again.')), w));
  else models.slice(win.start, win.end).forEach((m, i) => {
      const idx = win.start + i;
      const chk = checks[`${agent}:${m.id}`] ?? m.validation;
      const mark = chk === 'pending' ? ' …' : chk ? (chk.ok ? fg(C.ok)(' ✔') : fg(C.err)(' ✖')) : '';
      const isCur = current?.model === m.id;
      const label = `${idx === sel ? '›' : ' '} ${bold(fg(C.text)(m.id))}${isCur ? fg(actorColor(agent))(' ● current') : ''}${mark}`;
      const line = truncateAnsi(label, w);
      lines.push(idx === sel ? bg('#2E2645')(padAnsi(line, w)) : line);
    });
  while (lines.length < prefixRows + room) lines.push('');
  const chosenEffort = model && effortFor(model);
  lines.push('Effort: ' + (effortButtons.length ? effortButtons.map((b) => b.effort === chosenEffort ? bg(actorColor(agent))(fg(C.ink)(b.label)) : dim(b.label)).join(' ') : dim('CLI default')));
  lines.push(saving ? fg(C.linaSoft)('Applying model…') : actionButtons.map((b, i) => i === 0 ? fg(C.linaSoft)(b.label) : dim(b.label)).join(' '));
  const chk = model ? checks[`${agent}:${model.id}`] ?? model.validation : undefined;
  const detail = error ? fg(C.err)(error) : chk === 'pending' ? dim('Checking model access…')
    : chk ? chk.ok ? fg(C.ok)('✔ Model available') : fg(C.err)(chk.error ?? 'Model validation failed')
      : dim(st.view ? 'Applies next turn. Current work keeps running.' : 'Applies to your next conversation.');
  lines.push(truncateAnsi(detail, w));
  return (
    <Frame onClose={saving ? undefined : onClose} title={`◆ Models ${dim(st.view ? '· this session' : '· next session')}`} hint="Tap model to use · ←/→ agent · Enter use · e effort" width={width} height={height}>
      <Lines lines={lines} height={h} />
    </Frame>
  );
}

// ── diff ────────────────────────────────────────────────────────────────────
export function colorPatch(patch: string, width: number): string[] {
  const out: string[] = [];
  for (const raw of patch.split('\n')) {
    const l = raw.replace(/\t/g, '    ');
    let s: string;
    if (l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ')) s = dim(bold(l));
    else if (l.startsWith('@@')) s = fg(C.lina)(l);
    else if (l.startsWith('+')) s = fg(C.ok)(l);
    else if (l.startsWith('-')) s = fg(C.err)(l);
    else if (l.startsWith('\\')) s = dim(italic(l));
    else s = fg('#C8C8D0')(l);
    out.push(truncateAnsi(s, width));
  }
  return out;
}

/** Diff targets of a session: the session workspace, plus each agent's worktree in parallel/compete. */
export function diffTargets(session: Session | undefined): (AgentId | undefined)[] {
  const vs = session?.variants ? (Object.keys(session.variants) as AgentId[]).filter((a) => session.variants?.[a]) : [];
  return [undefined, ...vs.sort()];
}

export function DiffOverlay({ store, width, height, onClose, variant: initial }: Common & { variant?: AgentId }) {
  const st = useStore(store);
  const session = st.view?.session;
  const sid = session?.id;
  const targets = diffTargets(session);
  const [variant, setVariant] = useState<AgentId | undefined>(initial);
  const head = variant ? session?.variants?.[variant]?.headCommit : session?.headCommit;
  const res = useAsync(async () => (sid ? store.client.diff(sid, variant ? { variant } : {}) : undefined), [sid, variant, head]);
  const [sel, setSel] = useState(0);
  const [top, setTop] = useState(0);
  const files: DiffFile[] = res.data?.files ?? [];
  const h = innerH(height);
  const w = innerW(width);
  const sideBySide = w >= 90;
  const listW = sideBySide ? Math.min(40, Math.floor(w * 0.32)) : w;
  const listH = sideBySide ? h : Math.min(files.length + 1 + (targets.length > 1 ? 1 : 0), Math.max(3, Math.floor(h / 3)));
  const patchW = sideBySide ? w - listW - 2 : w;
  const patchH = sideBySide ? h : h - listH - 1;
  const file = files[sel];
  const patchLines = useMemo(() => (file ? (file.binary ? [dim('(binary file)')] : colorPatch(file.patch || '(no textual changes)', patchW)) : []), [file, patchW]);
  useWheelScroll(setTop, patchLines.length - patchH);
  useInput((input, key) => {
    if (key.escape || input === 'q' || (key.ctrl && input === 'c')) return onClose();
    if (input === 'r') return res.reload();
    if (key.tab && targets.length > 1) {
      const i = targets.indexOf(variant);
      setVariant(targets[(i + 1) % targets.length]);
      setSel(0); setTop(0);
      return;
    }
    if (key.upArrow || key.downArrow) {
      setSel((s) => Math.max(0, Math.min(files.length - 1, s + (key.upArrow ? -1 : 1))));
      setTop(0);
      return;
    }
    scrollKeys(input, key, patchH - 1, (f) => setTop((t) => Math.max(0, Math.min(Math.max(0, patchLines.length - patchH), f(t)))));
  });
  if (!sid) return <Frame onClose={onClose} title="◆ Diff" hint="Esc close" width={width} height={height}><Lines lines={[dim('No session yet — nothing to diff.')]} /></Frame>;
  let listLines: string[];
  if (res.loading && !res.data) listLines = [dim('Loading diff…')];
  else if (res.error) listLines = errorLines(res.error, listW);
  else if (!files.length) listLines = [dim('No changes yet.')];
  else {
    const add = files.reduce((a, f) => a + f.additions, 0);
    const del = files.reduce((a, f) => a + f.deletions, 0);
    const room = listH - 1 - (targets.length > 1 ? 1 : 0);
    const win = listWindow(files.length, room, sel);
    listLines = [dim(`${files.length} file${files.length === 1 ? '' : 's'} `) + fg(C.ok)(`+${add}`) + ' ' + fg(C.err)(`−${del}`) + dim(` · ${res.data!.base.slice(0, 7)}..${res.data!.head.slice(0, 7)}`)];
    files.slice(win.start, win.end).forEach((f, i) => {
      const idx = win.start + i;
      const st2 = { added: fg(C.ok)('A'), deleted: fg(C.err)('D'), renamed: fg(C.info)('R'), modified: fg(C.warn)('M') }[f.status] ?? '?';
      const counts = fg(C.ok)(`+${f.additions}`) + ' ' + fg(C.err)(`−${f.deletions}`);
      const name = f.path.length > listW - 14 ? '…' + f.path.slice(-(listW - 15)) : f.path;
      const line = spread(`${st2} ${name}`, counts, listW - 1);
      listLines.push(idx === sel ? bg('#2E2645')(padAnsi(fg(C.lina)('▸') + line, listW)) : ' ' + line);
    });
  }
  const maxTop = Math.max(0, patchLines.length - patchH);
  const t = Math.min(top, maxTop);
  const patchShown = patchLines.slice(t, t + patchH);
  const which = variant ? ' ' + fg(actorColor(variant))(`· ${AGENT_NAME[variant]}'s ${session?.config.mode === 'parallel' ? 'part' : 'version'}`) : targets.length > 1 ? ' ' + dim('· session branch') : '';
  const tabs = targets.length > 1 ? targets.map((t) => {
    const label = t ? AGENT_NAME[t] : 'Session';
    const color = t ? actorColor(t) : C.lina;
    return t === variant ? bg(color)(fg(C.ink)(bold(` ${label} `))) : fg(color)(` ${label} `);
  }).join(' ') + '  ' : '';
  if (tabs) listLines.unshift(tabs);
  return (
    <Frame onClose={onClose} title={`◆ Diff${which} ${dim(file ? '· ' + file.path : '')}`} hint={`↑/↓ file · PgUp/PgDn/j/k scroll${targets.length > 1 ? ' · Tab session/Codex/Claude' : ''} · r refresh · Esc close`} width={width} height={height}>
      <Box flexDirection={sideBySide ? 'row' : 'column'}>
        <Box width={listW} height={listH} flexDirection="column" overflow="hidden"><Lines lines={listLines} height={listH} /></Box>
        {sideBySide ? <Box width={2} /> : <Text>{fg(C.border)('─'.repeat(w))}</Text>}
        <Box width={patchW} height={patchH} flexDirection="column" overflow="hidden"><Lines lines={patchShown} height={patchH} /></Box>
      </Box>
    </Frame>
  );
}

// ── findings ────────────────────────────────────────────────────────────────
export function findingDetail(f: Finding, width: number): string[] {
  const out = [
    `${severityChip(f.severity)} ${bold(f.id)} ${bold(fg(C.text)(f.title))}`,
    `${findingStatus(f.status)} ${dim(`· raised by ${AGENT_NAME[f.raisedBy]} in round ${f.round}`)}${f.variant ? dim(' · on ') + fg(actorColor(f.variant))(`${AGENT_NAME[f.variant]}'s version`) : ''}${f.owner ? dim(' · fix by ') + fg(actorColor(f.owner))(AGENT_NAME[f.owner]) : ''}${f.file ? dim(` · ${f.file}${f.line ? ':' + f.line : ''}`) : ''}`,
    '',
    ...renderMarkdown(f.detail || '', width),
  ];
  if (f.suggestion) out.push('', fg(C.ok)('Suggestion'), ...renderMarkdown(f.suggestion, width));
  if (f.history.length) {
    out.push('', dim('History'));
    for (const n of f.history.slice(-8)) out.push(...wrapAnsi(dim(`r${n.round} `) + fg(actorColor(n.actor === 'user' ? 'lina' : n.actor))(n.actor) + ' ' + n.action + (n.note ? dim(' — ' + n.note) : ''), width));
  }
  if (f.status === 'escalated') out.push('', fg(C.warn)('Escalated: the agents disagree. Press w to waive it (accept without a fix), or reply in the composer with your decision.'));
  return out;
}

export function FindingsOverlay({ store, width, height, onClose }: Common) {
  const st = useStore(store);
  const findings = useMemo(() => {
    const order = { escalated: 0, open: 1, disputed: 2, fixed: 3, resolved: 4, waived: 5, withdrawn: 6 } as Record<string, number>;
    const sev = { blocker: 0, major: 1, minor: 2, nit: 3 } as Record<string, number>;
    return [...(st.view?.findings ?? [])].sort((a, b) => (order[a.status] - order[b.status]) || (sev[a.severity] - sev[b.severity]));
  }, [st.view?.findings]);
  const [sel, setSel] = useState(0);
  const [top, setTop] = useState(0);
  const h = innerH(height);
  const w = innerW(width);
  const f = findings[sel];
  useInput((input, key) => {
    if (key.escape || input === 'q' || (key.ctrl && input === 'c')) return onClose();
    if (key.upArrow) { setSel((s) => Math.max(0, s - 1)); setTop(0); }
    if (key.downArrow) { setSel((s) => Math.max(0, Math.min(findings.length - 1, s + 1))); setTop(0); }
    if (key.pageDown || input === 'j') setTop((t) => t + (key.pageDown ? 5 : 1));
    if (key.pageUp || input === 'k') setTop((t) => Math.max(0, t - (key.pageUp ? 5 : 1)));
    if (input === 'w' && f) {
      if (f.status === 'escalated') void store.waive(f.id);
      else store.notice('warn', `${f.id} is ${f.status} — only escalated findings can be waived.`);
    }
  });
  const listH = Math.min(findings.length + 1, Math.max(4, Math.floor(h * 0.4)));
  const counts = (['blocker', 'major', 'minor', 'nit'] as const).map((s) => [s, findings.filter((x) => x.severity === s && (x.status === 'open' || x.status === 'escalated')).length] as const).filter(([, n]) => n > 0).map(([s, n]) => severityChip(s, n)).join(' ');
  const listLines: string[] = [counts ? `${counts} ${dim('open')}` : dim(findings.length ? 'No open findings.' : 'No findings yet.')];
  const room = listH - 1;
  const win = listWindow(findings.length, room, sel);
  findings.slice(win.start, win.end).forEach((x, i) => {
    const idx = win.start + i;
    const scope = findingScope(x, st.view?.session.config.mode === 'parallel');
    const line = spread(`${fg(SEVERITY_COLOR[x.severity])('●')} ${bold(x.id)} ${x.title}${scope ? ' ' + scope : ''}`, findingStatus(x.status), w - 2);
    listLines.push(idx === sel ? bg('#2E2645')(padAnsi(fg(C.lina)('▸') + line, w)) : ' ' + line);
  });
  const detail = f ? findingDetail(f, w) : [];
  const detH = h - listH - 1;
  const t = Math.min(top, Math.max(0, detail.length - detH));
  useWheelScroll(setTop, detail.length - detH);
  return (
    <Frame onClose={onClose} title="◆ Findings" hint="↑/↓ select · j/k scroll detail · w waive escalated · Esc close" width={width} height={height}>
      <Lines lines={listLines} height={listH} />
      <Text>{fg(C.border)('─'.repeat(w))}</Text>
      <Lines lines={detail.slice(t, t + detH)} height={Math.max(0, detH)} />
    </Frame>
  );
}

// ── tests ───────────────────────────────────────────────────────────────────
export function TestsOverlay({ store, width, height, onClose }: Common) {
  const st = useStore(store);
  const runs: TestRun[] = [...(st.view?.tests ?? [])].reverse();
  const [sel, setSel] = useState(0);
  const [top, setTop] = useState(0);
  const h = innerH(height);
  const w = innerW(width);
  useInput((input, key) => {
    if (key.escape || input === 'q' || (key.ctrl && input === 'c')) return onClose();
    if (key.upArrow) { setSel((s) => Math.max(0, s - 1)); setTop(0); }
    if (key.downArrow) { setSel((s) => Math.max(0, Math.min(runs.length - 1, s + 1))); setTop(0); }
    if (key.pageDown || input === 'j') setTop((t) => t + (key.pageDown ? 10 : 1));
    if (key.pageUp || input === 'k') setTop((t) => Math.max(0, t - (key.pageUp ? 10 : 1)));
  });
  const listH = Math.min(runs.length, Math.max(3, Math.floor(h * 0.35)));
  const win = listWindow(runs.length, listH, sel);
  const list = runs.slice(win.start, win.end).map((r, i) => {
    const mark = r.skippedReason ? dim('○ skipped') : r.ok ? fg(C.ok)('✔ passed') : fg(C.err)('✖ failed');
    const counts = [r.passed !== undefined ? `${r.passed} passed` : '', r.failed !== undefined ? `${r.failed} failed` : ''].filter(Boolean).join(' · ');
    const where = r.variant ? fg(actorColor(r.variant))(`${AGENT_NAME[r.variant]}'s worktree `) : '';
    const line = spread(`${mark} ${where}${fg(C.text)(r.command || '(none)')} ${dim(counts)}`, dim(formatDuration(r.durationMs)), w - 2);
    return win.start + i === sel ? bg('#2E2645')(padAnsi(fg(C.lina)('▸') + line, w)) : ' ' + line;
  });
  const r = runs[sel];
  const out = r ? (r.skippedReason ? [dim(r.skippedReason)] : r.output.split('\n').map((l) => truncateAnsi(dim(l), w))) : [];
  const detH = h - listH - 2;
  const t = Math.min(top, Math.max(0, out.length - detH));
  useWheelScroll(setTop, out.length - detH);
  return (
    <Frame onClose={onClose} title="◆ Tests — verified by LINA" hint="↑/↓ select run · j/k scroll output · Esc close" width={width} height={height}>
      {runs.length ? (
        <>
          <Lines lines={list} height={listH} />
          <Text>{fg(C.border)('─'.repeat(w))}</Text>
          <Text wrap="truncate-end">{r ? dim(`exit ${r.exitCode ?? '—'}`) + (r.sandboxed ? dim(' · sandboxed') : fg(C.warn)(' · not sandboxed')) + (r.variant ? dim(` · ${AGENT_NAME[r.variant]}'s worktree`) : '') : ''}</Text>
          <Lines lines={out.slice(t, t + detH)} height={Math.max(0, detH)} />
        </>
      ) : <Lines lines={[dim('No test runs yet. LINA runs the project tests itself after each implementation turn.')]} />}
    </Frame>
  );
}

// ── mode picker ─────────────────────────────────────────────────────────────
export function modePickerLines(current: Mode | undefined, sel: number, width: number): string[] {
  const out: string[] = [];
  CLI_MODES.forEach((m, i) => {
    const cur = m === current ? fg(C.lina)('●') : ' ';
    const head = `${cur} ${padAnsi(bold(fg(i === sel ? C.text : C.linaSoft)(m)), 11)}${fg(C.text)(MODE_LABEL[m])}`;
    const desc = wrapAnsi(dim(MODE_DESCRIPTION[m]), Math.max(10, width - 16)).map((l) => '              ' + l);
    const block = [head, ...desc];
    out.push(...(i === sel ? block.map((l, j) => bg('#2E2645')(padAnsi((j === 0 ? fg(C.lina)('▸') : ' ') + l, width))) : block.map((l) => ' ' + l)));
  });
  return out;
}

export function ModeOverlay({ store, width, height, onClose, onTeam }: Common & { onTeam: () => void }) {
  const st = useStore(store);
  const current = store.currentConfig().mode ?? st.settings?.defaultMode;
  const [sel, setSel] = useState(Math.max(0, CLI_MODES.indexOf(current ?? 'pair')));
  const w = innerW(width);
  useWheelSelection(setSel, CLI_MODES.length);
  useInput((input, key) => {
    if (key.escape || input === 'q' || (key.ctrl && input === 'c')) return onClose();
    if (key.upArrow || input === 'k') setSel((s) => (s - 1 + CLI_MODES.length) % CLI_MODES.length);
    if (key.downArrow || input === 'j') setSel((s) => (s + 1) % CLI_MODES.length);
    const n = Number(input);
    const pick = key.return ? CLI_MODES[sel] : n >= 1 && n <= CLI_MODES.length ? CLI_MODES[n - 1] : undefined;
    if (!pick) return;
    if (pick === 'custom') { onTeam(); return; } // the team picker applies custom mode
    void store.setMode(pick);
    onClose();
  });
  const lines = modePickerLines(current, sel, w);
  const selectedLine = lines.findIndex((line) => stripAnsi(line).startsWith('▸'));
  const h = innerH(height);
  const top = Math.max(0, selectedLine - Math.max(0, h - 3));
  return (
    <Frame onClose={onClose} title={`◆ Collaboration mode ${dim(st.view ? '· this session' : '· next session')}`} hint="↑/↓ select · Enter use (custom opens the team picker) · 1–6 quick pick · Esc close" width={width} height={height}>
      <ScrollLines lines={lines} height={h} top={top} />
    </Frame>
  );
}

// ── team picker (custom mode) ─────────────────────────────────────────────────
type TeamRow = { key: 'planner' | 'planCritic' | 'developer' | 'reviewers'; label: string; options: (AgentId | null | AgentId[])[] };
const TEAM_ROWS: TeamRow[] = [
  { key: 'planner', label: 'Plan', options: ['codex', 'claude', null] },
  { key: 'planCritic', label: 'Critique the plan', options: ['codex', 'claude', null] },
  { key: 'developer', label: 'Implement', options: ['codex', 'claude'] },
  { key: 'reviewers', label: 'Review', options: [['codex'], ['claude'], ['codex', 'claude'], []] },
];

function teamValueLabel(v: AgentId | null | AgentId[]): string {
  if (v === null) return dim('none');
  if (Array.isArray(v)) return v.length ? v.map((a) => fg(actorColor(a))(AGENT_NAME[a])).join(dim(' + ')) : dim('none');
  return fg(actorColor(v))(AGENT_NAME[v]);
}

/** Cycles one row of the team by `dir` (±1). */
export function cycleTeam(team: TeamConfig, row: number, dir: number): TeamConfig {
  const r = TEAM_ROWS[row];
  const cur = JSON.stringify(team[r.key]);
  const i = r.options.findIndex((o) => JSON.stringify(o) === cur);
  const next = r.options[(Math.max(0, i) + dir + r.options.length) % r.options.length];
  return { ...team, [r.key]: next } as TeamConfig;
}

export function teamPickerLines(team: TeamConfig, sel: number, width: number): string[] {
  const out: string[] = [];
  TEAM_ROWS.forEach((r, i) => {
    const v = team[r.key];
    const line = `${padAnsi(fg(C.text)(r.label), 20)}${dim('‹ ')}${teamValueLabel(v as AgentId | null | AgentId[])}${dim(' ›')}`;
    out.push(i === sel ? bg('#2E2645')(padAnsi(fg(C.lina)('▸ ') + line, width)) : '  ' + line);
  });
  out.push('');
  const rv = rolesForTeam(team);
  const steps = pipelineFor({ mode: 'custom', developer: rv.developer, reviewer: rv.reviewer, team }).map((p) => {
    const who = p === 'planning' ? team.planner : p === 'plan_review' ? team.planCritic : p === 'implementing' || p === 'revising' ? team.developer : undefined;
    const label = p === 'awaiting_approval' ? 'Approval' : PHASE_LABEL[p];
    if (p === 'reviewing') return `${label} ${dim('(')}${team.reviewers.map((a) => fg(actorColor(a))(AGENT_NAME[a])).join(dim(', '))}${dim(')')}`;
    return who ? `${label} ${dim('(')}${fg(actorColor(who))(AGENT_NAME[who])}${dim(')')}` : fg(C.muted)(label);
  });
  out.push(...wrapAnsi(steps.join(fg(C.faint)(' › ')), width));
  out.push('');
  out.push(...wrapAnsi(dim(teamSummary(team)), width));
  out.push(...wrapAnsi(dim('Same as ') + fg(C.lina)(`/team ${formatTeamSpec(team)}`), width));
  if (team.reviewers.includes(team.developer)) out.push(...wrapAnsi(dim(`${AGENT_NAME[team.developer]} also reviews its own code, in a separate read-only session.`), width));
  if (!team.reviewers.length) out.push(...wrapAnsi(fg(C.warn)('No reviewer: the code is only checked by LINA\'s test run.'), width));
  return out;
}

export function TeamOverlay({ store, width, height, onClose }: Common) {
  const st = useStore(store);
  const [team, setTeam] = useState<TeamConfig>(() => defaultTeam(store.currentConfig(), st.settings?.team));
  const [sel, setSel] = useState(0);
  const w = innerW(width);
  useWheelSelection(setSel, TEAM_ROWS.length);
  useInput((input, key) => {
    if (key.escape || input === 'q' || (key.ctrl && input === 'c')) return onClose();
    if (key.upArrow || input === 'k') setSel((s) => (s - 1 + TEAM_ROWS.length) % TEAM_ROWS.length);
    else if (key.downArrow || input === 'j') setSel((s) => (s + 1) % TEAM_ROWS.length);
    else if (key.leftArrow || input === 'h') setTeam((t) => cycleTeam(t, sel, -1));
    else if (key.rightArrow || input === 'l' || input === ' ' || key.tab) setTeam((t) => cycleTeam(t, sel, 1));
    else if (input === 's') { if (!validateTeam(team)) void store.saveDefaultTeam(team); }
    else if (key.return) {
      const problem = validateTeam(team);
      if (problem) { store.notice('error', problem.message, problem.hint); return; }
      void store.setTeam(team);
      onClose();
    }
  });
  return (
    <Frame onClose={onClose} title={`◆ Custom team ${dim(st.view ? '· this session' : '· next session')}`} hint="↑/↓ role · ←/→ change · Enter use (custom mode) · s save as default · Esc close" width={width} height={height}>
      <Lines lines={teamPickerLines(team, sel, w)} height={innerH(height)} />
    </Frame>
  );
}

// ── doctor ──────────────────────────────────────────────────────────────────
export function doctorLines(checks: DoctorCheck[], width: number): string[] {
  const out: string[] = [];
  for (const c of checks) {
    const mark = c.ok ? (c.warn ? fg(C.warn)('!') : fg(C.ok)('✔')) : fg(C.err)('✖');
    out.push(truncateAnsi(`${mark} ${padAnsi(bold(c.label), Math.min(28, Math.floor(width / 3)))} ${c.ok && !c.warn ? dim(c.detail) : fg(C.text)(c.detail)}`, width));
    if (c.hint && (!c.ok || c.warn)) out.push(...wrapAnsi(dim('↳ ' + c.hint), width - 2).map((l) => '  ' + l));
  }
  return out;
}

export function DoctorOverlay({ store, width, height, onClose }: Common) {
  const res = useAsync(() => store.client.doctor(), []);
  const [top, setTop] = useState(0);
  const w = innerW(width);
  const h = innerH(height);
  const lines = res.loading && !res.data ? [dim('Running checks…')] : res.error ? errorLines(res.error, w) : doctorLines(res.data?.checks ?? [], w);
  useInput((input, key) => {
    if (key.escape || input === 'q' || (key.ctrl && input === 'c')) return onClose();
    if (input === 'r') return res.reload();
    scrollKeys(input, key, h - 1, (f) => setTop((t) => Math.max(0, Math.min(Math.max(0, lines.length - h), f(t)))));
  });
  useWheelScroll(setTop, lines.length - h);
  const failed = res.data?.checks.filter((c) => !c.ok).length ?? 0;
  return (
    <Frame onClose={onClose} title={`◆ Doctor ${res.data ? (failed ? fg(C.err)(`· ${failed} problem${failed === 1 ? '' : 's'}`) : fg(C.ok)('· all good')) : ''}`} hint="r re-run · Esc close · `lina doctor --live` runs real model probes" width={width} height={height}>
      <ScrollLines lines={lines} height={h} top={top} />
    </Frame>
  );
}

