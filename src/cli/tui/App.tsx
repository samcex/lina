// The LINA terminal UI: header, transcript, live agent panels, composer, overlays.
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useAnimation, useInput, usePaste, useWindowSize } from 'ink';
import type { AgentView } from '../../shared/reducer.js';
import type { AgentId, AgentModelChoice, Project, Role, SearchHit } from '../../shared/types.js';
import { AGENT_IDS } from '../../shared/types.js';
import { bg, bold, dim, fg, padAnsi, strWidth } from '../ansi.js';
import { computeLayout, shortId, visibleWindow } from '../layout.js';
import { SLASH_COMMANDS, argLabel, argSuggestions, complete, leadingMention, parseSlash, slashSuggestions, type SlashAction } from '../slash.js';
import { buildTranscript, transcriptEventLine, welcomeLines } from '../transcript.js';
import { AGENT_NAME, C, SPINNER, actorColor, actorDim } from '../theme.js';
import { agentScopes, composerView, compactPanelLines, footerControls, headerLines, panelUpdate, isActive, panelLines, spread } from './chrome.js';
import * as E from './editor.js';
import { useStore } from './hooks.js';
import { useMouse, useWheel } from './mouse.js';
import { F1_SEQUENCES, useRawInput } from './ink-internals.js';
import { Lines } from './Lines.js';
import { DiffOverlay, DoctorOverlay, FindingsOverlay, HelpOverlay, LiveOverlay, MenuOverlay, ModeOverlay, ModelsOverlay, SearchOverlay, SessionsOverlay, TeamOverlay, TestsOverlay, type OverlayKind } from './overlays.js';
import { ProjectPicker, RegisterPrompt } from './ProjectPicker.js';
import type { TuiStore } from './store.js';

export interface InitialAction { prompt?: string; sessionId?: string }

export interface AppProps {
  store: TuiStore;
  cwd: string;
  initial?: InitialAction;
  onQuit: () => void;
  openUrl?: (url: string) => Promise<boolean>;
  /** Fixed terminal size (tests); defaults to the live window size. */
  size?: { columns: number; rows: number };
}

type Scroll = { follow: true } | { follow: false; anchor: number; offset: number };

const idleAgent = (): AgentView => ({ status: 'idle', since: Date.now(), activity: [] });

const MAX_SUGGESTIONS = 6;

type PanelProps = Parameters<typeof panelLines>[0];

function AgentPanel(p: { agent: AgentId; view: AgentView; role?: Role; model?: AgentModelChoice; rateLimit?: PanelProps['rateLimit']; scope?: PanelProps['scope']; width: number; height: number; frame: number; now: number; compact?: boolean; update?: PanelProps['update'] }) {
  const active = isActive(p.view.status);
  const color = active ? actorColor(p.agent) : p.view.status === 'error' ? C.err : actorDim(p.agent);
  const input = { agent: p.agent, view: p.view, role: p.role, model: p.model, rateLimit: p.rateLimit, scope: p.scope, update: p.update, now: p.now, frame: p.frame, width: Math.max(8, p.width - 4) };
  const inner = Math.max(1, p.height - 2);
  const lines = p.compact ? compactPanelLines(input, inner).slice(0, inner) : panelLines(input, inner);
  return (
    <Box borderStyle="round" borderColor={color} width={p.width} height={p.height} paddingX={1} flexDirection="column" overflow="hidden">
      <Lines lines={lines} height={inner} />
    </Box>
  );
}

export function App({ store, cwd, initial, onQuit, openUrl, size }: AppProps) {
  const win = useWindowSize();
  const columns = size?.columns ?? win.columns ?? 100;
  const rows = size?.rows ?? win.rows ?? 30;
  const st = useStore(store);
  const view = st.view;
  const [ed, setEd] = useState<E.Ed>(E.empty);
  const [hist, setHist] = useState<{ items: string[]; idx: number | null; draft: string }>({ items: [], idx: null, draft: '' });
  const [overlay, setOverlay] = useState<OverlayKind | null>(null);
  const [sessionPicker, setSessionPicker] = useState<'sessions' | 'history' | 'resume'>('sessions');
  const [diffVariant, setDiffVariant] = useState<AgentId | undefined>(undefined);
  const [liveAgent, setLiveAgent] = useState<AgentId | undefined>(undefined);
  const [scroll, setScroll] = useState<Scroll>({ follow: true });
  const [scrollMode, setScrollMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [focusEvent, setFocusEvent] = useState<{ sessionId: string; seq: number }>();
  const [confirm, setConfirm] = useState<null | 'cancel'>(null);
  const [quitArmed, setQuitArmed] = useState(0);
  const [sugSel, setSugSel] = useState(0);
  const [sugDismissed, setSugDismissed] = useState(false);
  const started = useRef(false);

  // initial action (attach / new session with prompt)
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (initial?.sessionId) void store.openSession(initial.sessionId);
    else if (initial?.prompt) void store.createSession(initial.prompt);
    else void store.refreshRecent();
  }, [store, initial]);

  useEffect(() => {
    if (!quitArmed) return;
    const t = setTimeout(() => setQuitArmed(0), 2000);
    return () => clearTimeout(t);
  }, [quitArmed]);

  // ── derived ──
  const session = view?.session;
  const status = session?.status;
  const running = status === 'running';
  const cfg = store.currentConfig();
  const models: Partial<Record<AgentId, AgentModelChoice>> = { ...(st.settings?.models ?? {}), ...(cfg.models ?? {}) };
  const developer: AgentId = cfg.developer ?? st.settings?.developer ?? 'codex';
  const mode = cfg.mode ?? st.settings?.defaultMode;
  const agents: Record<AgentId, AgentView> = view?.agents ?? { codex: idleAgent(), claude: idleAgent() };
  const anyActive = AGENT_IDS.some((a) => isActive(agents[a].status));
  const hasStreams = !!view && Object.keys(view.streams).length > 0;
  const { frame } = useAnimation({ interval: 100, isActive: anyActive || hasStreams || !!st.busy || st.conn === 'connecting' });
  const now = Date.now();

  const suggestions = sugDismissed ? [] : slashSuggestions(ed.value).slice(0, MAX_SUGGESTIONS);
  const exactCmd = SLASH_COMMANDS.some((c) => '/' + c.name === ed.value.trim() || c.aliases?.some((a) => '/' + a === ed.value.trim()));
  const argSugs = sugDismissed ? [] : argSuggestions(ed.value);
  const mentionTyping = /(^|\s)@\w*$/.test(ed.value.slice(0, ed.cursor));
  let suggestionLines = suggestions.length && !exactCmd ? suggestions.length : argSugs.length || mentionTyping ? 1 : 0;

  let banner: string | null = null;
  if (confirm === 'cancel') banner = bg(C.warn)(fg(C.ink)(bold(' Cancel the running turn? '))) + '  ' + bold(fg(C.ok)('y')) + dim(' yes  ') + bold(fg(C.err)('n')) + dim(' no  · Ctrl+C again quits (agents keep working)');
  else if (status === 'awaiting_approval' && session?.config.mode === 'compete' && !session.chosenVariant) banner = bold(fg(C.lina)('◆ Pick the winner')) + dim(' — ') + fg(C.lina)('/choose') + dim(' codex|claude · ') + fg(C.ok)('/approve') + dim(' <agent> [squash|merge|branch] · ') + fg(C.text)('/diff codex|claude') + dim(' compares · ') + fg(C.err)('/reject');
  else if (status === 'awaiting_approval') banner = bold(fg(C.lina)('◆ Awaiting your approval')) + dim(' — ') + fg(C.ok)('/approve') + dim(' [squash|merge|branch] · ') + fg(C.err)('/reject') + dim(' · or type a message to request changes');
  else if (running) banner = fg(C.ok)('● ') + dim('Agents are working — messages are queued for the next turn boundary · ') + fg(C.text)('/interrupt <msg>') + dim(' cuts in · Ctrl+P pause') + (session && session.pendingMessages > 0 ? fg(C.warn)(` · ${session.pendingMessages} queued`) : '');
  else if (session?.goalResumeQueued) banner = fg(C.info)('◌ Goal queued') + dim(' — continues automatically when the project is available');
  else if (status === 'paused') banner = fg(C.warn)('❚❚ Paused') + dim(' — /resume or Ctrl+P to continue');
  else if (status === 'failed' && view?.session.retryAt) banner = fg(C.warn)(session?.config.goal ? '◷ Goal will retry automatically' : '◷ Waiting for usage reset') + dim(` — automatic retry ${new Date(view.session.retryAt).toLocaleTimeString()} · /pause stops retry`);
  else if (status === 'interrupted' || status === 'failed') banner = fg(C.warn)(status === 'failed' ? '✖ Failed' : '◌ Interrupted') + dim(' — /resume continues from the last step · /retry re-runs the failed step');


  const composerTextWidth = Math.max(8, columns - 5);
  const comp = composerView(ed, composerTextWidth, !overlay, Math.max(1, Math.min(8, rows - 9)));
  suggestionLines = Math.min(suggestionLines, Math.max(0, rows - 3 - comp.lines.length - (rows < 10 ? 1 : 2) - 1 - (banner ? 1 : 0) - 1));
  const layout = computeLayout({ columns, rows, composerLines: comp.lines.length, suggestionLines, bannerLines: banner ? 1 : 0 });
  const mainHeight = layout.wide ? layout.transcriptHeight : layout.transcriptHeight + layout.compactRowHeight;

  // ── transcript ──
  const cursorOn = frame % 8 < 5;
  const tw = layout.transcriptWidth;
  const lines = useMemo(() => {
    if (!view) {
      const base = st.loadingSession ? ['', '  ' + fg(C.lina)('◌ ') + dim('Loading session…')] : welcomeLines(tw, st.project?.name ?? 'your project', st.recent.map((s) => ({ id: s.id, title: s.title, status: s.status })));
      return [...base, ...(st.notices.length ? ['', ...buildTranscript(undefined, st.notices, tw)] : [])];
    }
    return buildTranscript(view, st.notices, tw, hasStreams ? cursorOn : false);
  }, [view, st.notices, st.loadingSession, st.project, st.recent, tw, layout.transcriptHeight, hasStreams ? cursorOn : false]);
  const eff = scroll.follow ? 0 : scroll.offset + (lines.length - scroll.anchor);
  const winT = visibleWindow(lines.length, layout.transcriptHeight, eff);
  const shown = lines.slice(winT.start, winT.end);
  const newBelow = scroll.follow ? 0 : Math.max(0, lines.length - scroll.anchor);
  const previousHistory = useRef({ sessionId: st.sessionId, first: view?.timeline[0]?.seq, lineCount: lines.length });
  useLayoutEffect(() => {
    const previous = previousHistory.current;
    const first = view?.timeline[0]?.seq;
    if (previous.sessionId === st.sessionId && first !== undefined && previous.first !== undefined && first < previous.first) {
      setScroll((s) => s.follow ? s : { follow: false, anchor: lines.length, offset: s.offset + previous.lineCount - s.anchor });
    } else if (previous.sessionId !== st.sessionId) setScroll({ follow: true });
    previousHistory.current = { sessionId: st.sessionId, first, lineCount: lines.length };
  }, [st.sessionId, view?.timeline[0]?.seq, lines.length]);
  useLayoutEffect(() => {
    if (!focusEvent || view?.session.id !== focusEvent.sessionId) return;
    const row = transcriptEventLine(view, st.notices, tw, focusEvent.seq);
    if (row !== undefined) setScroll({ follow: false, anchor: lines.length, offset: Math.max(0, lines.length - layout.transcriptHeight - row) });
    setFocusEvent(undefined);
  }, [focusEvent, view, st.notices, tw, lines.length, layout.transcriptHeight]);

  // ── actions ──
  const quit = useCallback(() => onQuit(), [onQuit]);
  const openWeb = useCallback(() => {
    const url = store.webUrl(st.sessionId);
    if (!url) { store.notice('warn', 'Web UI URL unavailable.'); return; }
    (openUrl ?? (async () => false))(url).then((ok) => {
      store.notice(ok ? 'success' : 'info', ok ? 'Opened this session in the web UI.' : `Open in your browser: ${url}`);
    }, () => store.notice('info', `Open in your browser: ${url}`));
  }, [store, st.sessionId, openUrl]);

  const run = useCallback((a: SlashAction) => {
    switch (a.type) {
      case 'menu': setOverlay('menu'); break;
      case 'resume': {
        if (a.selector) { void store.resumeSession(a.selector); break; }
        const current = store.getState().view?.session;
        if (current && (['paused','interrupted','failed','cancelled'].includes(current.status) || (current.status === 'idle' && current.config.goal))) void store.control('resume');
        else { setSessionPicker('resume'); setOverlay('sessions'); }
        break;
      }
      case 'history': {
        if (a.seq === undefined && !a.earlier) { setSessionPicker('history'); setOverlay('sessions'); break; }
        if (!store.getState().sessionId) { setSessionPicker('history'); setOverlay('sessions'); break; }
        const id = store.getState().sessionId;
        void store.loadEarlier(a.seq).then(() => {
          const current = store.getState().view;
          if (!current || current.session.id !== id) return;
          const seq = a.seq ?? current.timeline.find((e) => e.seq > 0)?.seq;
          if (seq !== undefined && current.timeline.some((e) => e.seq === seq)) setFocusEvent({ sessionId: current.session.id, seq });
          else if (a.seq !== undefined) store.notice('warn', `Event ${a.seq} is not available in this session.`);
        });
        break;
      }
      case 'search': setSearchQuery(a.query); setOverlay('search'); break;
      case 'scroll': setScrollMode((enabled) => a.enabled ?? !enabled); break;
      case 'changes': void store.changes(a.turn); break;
      case 'undo': void store.undo(a.turn); break;
      case 'preview': void store.preview(a.action, a.value); break;
      case 'send': {
        const m = leadingMention(a.text);
        void store.sendMessage(a.text);
        if (m && !view) store.notice('info', `Starting a session and asking ${m === 'codex' ? 'Codex' : 'Claude'}…`);
        break;
      }
      case 'goal': void store.goal(a.objective); break;
      case 'new': store.newDraft(); if (a.prompt) void store.createSession(a.prompt); break;
      case 'sessions': setSessionPicker('sessions'); setOverlay('sessions'); break;
      case 'project': setOverlay('project'); break;
      case 'models': setOverlay('models'); break;
      case 'diff': {
        if (a.variant && !view?.session.variants?.[a.variant]) {
          store.notice('warn', view ? `There is no ${AGENT_NAME[a.variant]} worktree in this session.` : 'No session yet — nothing to diff.', view ? 'Only parallel and compete sessions give each agent its own worktree. /diff shows the session diff.' : undefined);
          break;
        }
        setDiffVariant(a.variant);
        setOverlay('diff');
        break;
      }
      case 'live': setLiveAgent(a.agent); setOverlay('live'); break;
      case 'mode-picker': setOverlay('mode'); break;
      case 'team-picker': setOverlay('team'); break;
      case 'team': void store.setTeam(a.team); break;
      case 'choose': void store.choose(a.variant); break;
      case 'findings': setOverlay('findings'); break;
      case 'tests': setOverlay('tests'); break;
      case 'doctor': setOverlay('doctor'); break;
      case 'help': setOverlay('help'); break;
      case 'model': void store.setModel(a.agent, a.model, a.effort); break;
      case 'roles': void store.swapRoles(); break;
      case 'mode': void store.setMode(a.mode, a.team); break;
      case 'approve': void store.approve(a.strategy, a.variant); break;
      case 'reject': void store.reject(a.note); break;
      case 'control': void store.control(a.action); break;
      case 'interrupt': void store.sendMessage(a.text, true); break;
      case 'ui': openWeb(); break;
      case 'quit': quit(); break;
      case 'error': store.notice('error', a.message, a.hint); break;
    }
  }, [store, view, openWeb, quit]);

  const pushHistory = (text: string) => setHist((h) => ({ items: [...h.items.filter((x) => x !== text), text].slice(-200), idx: null, draft: '' }));

  const submit = () => {
    const text = ed.value;
    if (!text.trim()) return;
    if (suggestions.length && !exactCmd) {
      const s = suggestions[Math.min(sugSel, suggestions.length - 1)];
      if (s.args && !s.args.startsWith('[')) { setEd(E.insert(E.empty, `/${s.name} `)); return; }
      pushHistory('/' + s.name);
      setEd(E.empty);
      setSugSel(0);
      run(parseSlash('/' + s.name));
      return;
    }
    pushHistory(text);
    setEd(E.empty);
    setSugSel(0);
    setSugDismissed(false);
    setScroll({ follow: true });
    run(parseSlash(text));
  };

  const edit = (f: (e: E.Ed) => E.Ed) => { setEd(f); setSugDismissed(false); setSugSel(0); };

  const pauseResume = () => {
    if (!session) { store.notice('warn', 'No session yet.'); return; }
    if (status === 'running') void store.control('pause');
    else if (status === 'paused' || status === 'interrupted' || status === 'cancelled' || status === 'failed') void store.control('resume');
    else store.notice('info', `Session is ${status?.replace('_', ' ')} — nothing to pause.`);
  };

  const scrollBy = (delta: number) => {
    setScroll((s) => {
      const cur = s.follow ? 0 : s.offset + (lines.length - s.anchor);
      const maximum = Math.max(0, lines.length - layout.transcriptHeight);
      const next = Math.max(0, Math.min(maximum, cur + delta));
      return next === 0 ? { follow: true } : { follow: false, anchor: lines.length, offset: next };
    });
    const state = store.getState();
    if (delta > 0 && winT.start === 0 && (view?.timeline[0]?.seq ?? 0) > 1 && !state.historyLoading) void store.loadEarlier();
  };

  useWheel((delta) => scrollBy(-delta * 3), !overlay && !confirm);
  const dragRow = useRef<number | null>(null);
  useMouse((event) => {
    if (event.released) { dragRow.current = null; return; }
    if ((event.button & 31) !== 0) return; // leave modified selection gestures alone
    if (event.motion) {
      if (dragRow.current !== null) { scrollBy(event.y - dragRow.current); dragRow.current = event.y; }
      return;
    }
    if (overlay) return;
    if (layout.wide && event.x > columns - layout.sideWidth && event.y >= 4 && event.y < 4 + mainHeight) {
      setLiveAgent(event.y < 4 + layout.panelHeight ? 'codex' : 'claude'); setOverlay('live'); return;
    }
    if (!layout.wide && layout.compactRowHeight > 0 && event.y >= 4 + layout.transcriptHeight && event.y < 4 + mainHeight) {
      setLiveAgent(event.x <= Math.floor(columns / 2) ? 'codex' : 'claude'); setOverlay('live'); return;
    }

    if (event.y === layout.rows) {
      const hit = footerControls(columns, scrollMode).ranges.find((item) => event.x >= item.start && event.x <= item.end);
      if (hit?.action === 'up') scrollBy(Math.max(1, layout.transcriptHeight - 2));
      else if (hit?.action === 'down') scrollBy(-Math.max(1, layout.transcriptHeight - 2));
      else if (hit?.action === 'latest') setScroll({ follow: true });
      else if (hit?.action === 'read') setScrollMode((enabled) => !enabled);
    } else if (event.y >= 4 && event.y < 4 + layout.transcriptHeight && event.x <= tw) dragRow.current = event.y;
  }, !confirm);

  useRawInput(useCallback((d: string) => { if (F1_SEQUENCES.includes(d)) setOverlay((o) => (o === 'help' ? null : 'help')); }, []));

  usePaste((text) => edit((e) => E.insert(e, text)), { isActive: !overlay });

  useInput((input, key) => {
    if (confirm) {
      if (input === 'y' || input === 'Y') { setConfirm(null); void store.control('cancel'); }
      else if (key.ctrl && input === 'c') quit();
      else if (input === 'n' || input === 'N' || key.escape) setConfirm(null);
      return;
    }
    if (key.ctrl && input === 'c') {
      if (ed.value) { setEd(E.empty); return; }
      const t = Date.now();
      if (quitArmed && t - quitArmed < 2000) { quit(); return; }
      setQuitArmed(t);
      if (running) setConfirm('cancel');
      return;
    }
    if (quitArmed) setQuitArmed(0);
    const page = Math.max(1, layout.transcriptHeight - 2);
    if (key.ctrl && input === 'k' && !ed.value) { setOverlay('menu'); return; }
    if (key.ctrl && input === 'g') { setScrollMode((enabled) => !enabled); return; }
    if (key.pageUp) { scrollBy(page); return; }
    if (key.pageDown) { scrollBy(-page); return; }
    if (scrollMode) {
      if (key.escape || key.return || input === 'q') { setScrollMode(false); return; }
      if (key.upArrow || input === 'k') scrollBy(3);
      else if (key.downArrow || input === 'j') scrollBy(-3);
      else if (key.home || input === 'g') scrollBy(1e9);
      else if (key.end || input === 'G') setScroll({ follow: true });
      else if (input === ' ') scrollBy(-page);
      return;
    }
    if (key.ctrl) {
      switch (input) {
        case 'p': pauseResume(); return;
        case 'd': setDiffVariant(undefined); setOverlay('diff'); return;
        case 't': setLiveAgent(undefined); setOverlay('live'); return;
        case 'f': setOverlay('findings'); return;
        case 'o': openWeb(); return;
        case 'l': setOverlay('sessions'); return;
        case 'a': edit(E.lineStart); return;
        case 'e': edit(E.lineEnd); return;
        case 'u': edit(E.killToLineStart); return;
        case 'k': edit(E.killToLineEnd); return;
        case 'w': edit(E.deleteWordBack); return;
        case 'j': edit((e) => E.insert(e, '\n')); return;
        default: break;
      }
    }
    if (key.escape) {
      if (suggestions.length || argSugs.length) setSugDismissed(true);
      else if (!scroll.follow) setScroll({ follow: true });
      return;
    }
    if (key.return) {
      if (key.meta || key.shift) edit((e) => E.insert(e, '\n'));
      else submit();
      return;
    }
    if (input === '\n') { edit((e) => E.insert(e, '\n')); return; }
    if (key.tab) {
      if (suggestions.length && !exactCmd) {
        const s = suggestions[Math.min(sugSel, suggestions.length - 1)];
        setEd(E.insert(E.empty, `/${s.name}${s.args ? ' ' : ''}`));
        setSugSel(0);
        return;
      }
      const c = complete(ed.value, ed.cursor);
      if (c) setEd({ value: c.value, cursor: c.cursor });
      return;
    }
    if (key.upArrow) {
      if (suggestions.length && !exactCmd) { setSugSel((s) => (s - 1 + suggestions.length) % suggestions.length); return; }
      if (key.shift) { scrollBy(1); return; }
      // Phone SSH clients often translate finger swipes to ordinary arrow keys.
      if (!ed.value && !key.meta) { scrollBy(3); return; }
      const moved = E.up(ed);
      if (moved) { setEd(moved); return; }
      if (!hist.items.length) return;
      const idx = hist.idx === null ? hist.items.length - 1 : Math.max(0, hist.idx - 1);
      setHist((h) => ({ ...h, idx, draft: h.idx === null ? ed.value : h.draft }));
      const v = hist.items[idx];
      setEd({ value: v, cursor: v.length });
      return;
    }
    if (key.downArrow) {
      if (suggestions.length && !exactCmd) { setSugSel((s) => (s + 1) % suggestions.length); return; }
      if (key.shift) { scrollBy(-1); return; }
      if (!ed.value && !key.meta) { scrollBy(-3); return; }
      const moved = E.down(ed);
      if (moved) { setEd(moved); return; }
      if (hist.idx === null) return;
      const idx = hist.idx + 1;
      if (idx >= hist.items.length) { setHist((h) => ({ ...h, idx: null })); setEd({ value: hist.draft, cursor: hist.draft.length }); return; }
      setHist((h) => ({ ...h, idx }));
      setEd({ value: hist.items[idx], cursor: hist.items[idx].length });
      return;
    }
    if (key.leftArrow) { edit(key.meta || key.ctrl ? E.wordLeft : E.left); return; }
    if (key.rightArrow) { edit(key.meta || key.ctrl ? E.wordRight : E.right); return; }
    if (key.home) { if (!ed.value) scrollBy(1e9); else edit(E.lineStart); return; }
    if (key.end) { if (!ed.value) setScroll({ follow: true }); else edit(E.lineEnd); return; }
    if (key.backspace) { edit(key.meta ? E.deleteWordBack : E.backspace); return; }
    if (key.delete) { edit(E.del); return; }
    if (key.meta) {
      if (input === 'b') edit(E.wordLeft);
      else if (input === 'f') edit(E.wordRight);
      return;
    }
    if (input === '?' && !ed.value) { setOverlay('help'); return; }
    if (input && !key.ctrl) {
      // eslint-disable-next-line no-control-regex
      const clean = input.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
      if (clean) edit((e) => E.insert(e, clean));
    }
  }, { isActive: !overlay });

  // ── render ──
  const header = headerLines({ width: columns, projectName: st.project?.name, view, models, developer, mode, config: { ...cfg, mode, team: cfg.team ?? (mode === 'custom' ? st.settings?.team : undefined) }, maxRounds: cfg.maxRounds, conn: st.conn, everOpen: st.everOpen, mock: !!cfg.mock });
  const roleOf = (a: AgentId): Role | undefined => {
    if (agents[a].role) return agents[a].role;
    if (mode === 'compete' || mode === 'parallel') return 'developer'; // both build (each in its own worktree)
    const team = cfg.team ?? (mode === 'custom' ? st.settings?.team : undefined);
    if (mode === 'custom' && team) return team.developer === a ? 'developer' : team.reviewers.includes(a) ? 'reviewer' : undefined;
    return mode === 'solo' && a !== developer ? undefined : a === developer ? 'developer' : 'reviewer';
  };
  const scopes = useMemo(() => agentScopes(view), [view?.timeline, view?.session.config.mode]);
  const panel = (a: AgentId, width: number, height: number, compact = false) => (
    <AgentPanel key={a} agent={a} view={agents[a]} role={roleOf(a)} model={models[a]} rateLimit={view?.rateLimits[a]} scope={scopes[a]} width={width} height={height} frame={frame} now={now} compact={compact} update={panelUpdate(view, a)} />
  );

  const closeOverlay = () => setOverlay(null);
  const openSearchHit = async (hit: SearchHit) => {
    setOverlay(null);
    if (store.getState().sessionId !== hit.sessionId) await store.openSession(hit.sessionId);
    if (store.getState().sessionId !== hit.sessionId) return;
    await store.loadEarlier(hit.seq);
    if (store.getState().view?.timeline.some((e) => e.seq === hit.seq) && store.getState().sessionId === hit.sessionId) setFocusEvent({ sessionId: hit.sessionId, seq: hit.seq });
  };
  const overlayEl = (() => {
    if (!overlay) return null;
    const common = { store, width: columns, height: mainHeight, onClose: closeOverlay };
    switch (overlay) {
      case 'menu': return <MenuOverlay {...common} onSelect={(action) => { setOverlay(null); run(action); }} />;
      case 'live': return <LiveOverlay {...common} agent={liveAgent} frame={frame} now={now} />;
      case 'help': return <HelpOverlay {...common} />;
      case 'sessions': return <SessionsOverlay {...common} mode={sessionPicker} />;
      case 'search': return <SearchOverlay {...common} query={searchQuery} onSelect={(hit) => void openSearchHit(hit)} />;
      case 'models': return <ModelsOverlay {...common} />;
      case 'diff': return <DiffOverlay {...common} variant={diffVariant} />;
      case 'mode': return <ModeOverlay {...common} onTeam={() => setOverlay('team')} />;
      case 'team': return <TeamOverlay {...common} />;
      case 'findings': return <FindingsOverlay {...common} />;
      case 'tests': return <TestsOverlay {...common} />;
      case 'doctor': return <DoctorOverlay {...common} />;
      case 'project': return <ProjectPicker client={store.client} cwd={cwd} width={columns} height={mainHeight} title="◆ Switch project" onCancel={closeOverlay} onSelect={(p: Project) => { store.setProject(p); closeOverlay(); }} />;
    }
  })();

  const transcriptBox = (
    <Box flexDirection="column" width={layout.wide ? columns - layout.sideWidth : columns} height={layout.transcriptHeight} paddingLeft={1} paddingRight={layout.wide ? 2 : 1} overflow="hidden">
      <Lines lines={shown} height={layout.transcriptHeight} />
    </Box>
  );

  const main = overlayEl ?? (layout.wide ? (
    <Box flexDirection="row" height={mainHeight}>
      {transcriptBox}
      <Box flexDirection="column" width={layout.sideWidth}>
        {panel('codex', layout.sideWidth, layout.panelHeight)}
        {panel('claude', layout.sideWidth, mainHeight - layout.panelHeight)}
      </Box>
    </Box>
  ) : (
    <Box flexDirection="column" height={mainHeight}>
      {transcriptBox}
      {layout.compactRowHeight > 0 ? (
        <Box flexDirection="row" height={layout.compactRowHeight}>
          {panel('codex', Math.floor(columns / 2), layout.compactRowHeight, true)}
          {panel('claude', columns - Math.floor(columns / 2), layout.compactRowHeight, true)}
        </Box>
      ) : null}
    </Box>
  ));

  // suggestions popup
  let sugLines: string[] = [];
  if (suggestions.length && !exactCmd) {
    sugLines = suggestions.map((s, i) => {
      const sel = i === Math.min(sugSel, suggestions.length - 1);
      const line = `${fg(C.lina)('/' + s.name)}${s.args ? ' ' + dim(s.args) : ''}`;
      const full = padAnsi(' ' + line, 34) + dim(s.desc);
      return sel ? bg('#2E2645')(padAnsi(full, columns - 2)) : full;
    });
  } else if (argSugs.length) sugLines = [' ' + argSugs.map((a, i) => (i === 0 ? fg(C.lina)(argLabel(a)) : dim(argLabel(a)))).join(dim(' · ')) + dim('   Tab to complete')];
  else if (mentionTyping) sugLines = [' ' + fg(C.codex)('@codex') + dim(' · ') + fg(C.claude)('@claude') + dim('   Tab to complete — asks that agent directly')];

  const mention = leadingMention(ed.value);
  const composerColor = overlay ? C.faint : mention ? actorColor(mention) : C.lina;
  const placeholder = !ed.value ? dim(view ? (running ? ' Message the team (queued for the next turn)…  / for commands' : ' Reply, ask @codex / @claude, or / for commands') : ' Describe what to build…  @codex/@claude to ask one agent · / for commands') : '';
  const composerLines = comp.lines.map((line, index) => (index === 0 ? fg(composerColor)('❯ ') : '  ') + line + (index === 0 && placeholder ? placeholder : ''));

  let footerLeft: string;
  if (quitArmed) footerLeft = fg(C.warn)('Press Ctrl+C again to quit') + dim(' — agents keep working in the background');
  else if (st.busy || st.historyLoading) footerLeft = fg(C.lina)(SPINNER[frame % SPINNER.length]) + ' ' + dim(st.busy ?? 'Loading earlier messages…');
  else footerLeft = fg(C.info)(footerControls(columns, scrollMode).text) + (scrollMode ? dim(columns >= 60 ? ' · SCROLL ↑↓ j/k · Esc write' : ' · SCROLL') : dim(columns < 110 ? ' · ↑↓ scroll · /help' : ' · Wheel/↑↓/PgUp/PgDn · Alt+↑ history · Enter send · Ctrl+T live · /help'));
  const footerRight = !scroll.follow && columns >= 32
    ? fg(C.info)(columns < 44 ? `↑ ${eff}` : `↑ ${eff} line${eff === 1 ? '' : 's'} up`) + (columns >= 70 && newBelow ? fg(C.warn)(` · ${newBelow} new`) : '') + (columns >= 70 ? dim(' · Esc follows') : '')
    : session && columns >= 100 ? dim(`${shortId(session.id)}`) : '';

  return (
    <Box flexDirection="column" width={columns} height={layout.rows}>
      <Lines lines={header} height={3} />
      {main}
      {banner ? <Text wrap="truncate-end">{' ' + banner}</Text> : null}
      {suggestionLines ? <Lines lines={sugLines.slice(0, suggestionLines)} height={suggestionLines} /> : null}
      <Box borderStyle="round" borderColor={composerColor} width={columns} height={layout.composerHeight} flexDirection="column" paddingLeft={0}>
        <Lines lines={composerLines} height={composerLines.length} />
      </Box>
      <Text wrap="truncate-end">{spread(' ' + footerLeft, footerRight + ' ', columns)}</Text>
    </Box>
  );
}

/** Top-level: project launcher (register / pick) until a project is chosen, then the App. */
export function Root(props: AppProps & { launch?: { kind: 'register'; root: string } | { kind: 'picker'; intro?: string } }) {
  const st = useStore(props.store);
  const win = useWindowSize();
  const columns = props.size?.columns ?? win.columns ?? 100;
  const rows = props.size?.rows ?? win.rows ?? 30;
  const [launch, setLaunch] = useState(props.launch);
  if (!st.project && launch) {
    const h = Math.min(rows, 22);
    if (launch.kind === 'register') {
      return <RegisterPrompt client={props.store.client} root={launch.root} width={Math.min(columns, 100)} height={h}
        onDone={(p) => props.store.setProject(p)} onDecline={() => setLaunch({ kind: 'picker' })} />;
    }
    return (
      <ProjectPicker client={props.store.client} cwd={props.cwd} width={Math.min(columns, 100)} height={h} title="◆ LINA — choose a project"
        intro={launch.intro} onSelect={(p) => props.store.setProject(p)} onCancel={props.onQuit} />
    );
  }
  return <App {...props} />;
}
