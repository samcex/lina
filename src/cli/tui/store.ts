// TUI state controller: owns the daemon connection and folds events with the
// shared reducer. React components read it through useSyncExternalStore.
import type { LinaClient, LiveConnection } from '../../shared/client.js';
import { LinaApiError } from '../../shared/client.js';
import type { ServerMessage } from '../../shared/protocol.js';
import { applyEvent, viewFromSnapshot, type SessionView } from '../../shared/reducer.js';
import { MODE_LABEL } from '../../shared/reducer.js';
import { prependHistory } from '../../shared/history.js';
import type {
  AgentId, AgentModelChoice, ApplyStrategy, Effort, Mode, Project, SearchHit, Session, SessionConfig, SessionSnapshot, Settings, TeamConfig,
} from '../../shared/types.js';
import { defaultTeam, rolesForTeam, teamSummary } from '../team.js';
import { AGENT_NAME } from '../theme.js';
import type { LocalNotice } from '../transcript.js';

export type ConnState = 'connecting' | 'open' | 'closed' | 'offline';

/** The subset of LinaClient the TUI uses (lets tests pass a stub). */
export type ClientLike = Pick<LinaClient,
  'session' | 'createSession' | 'send' | 'control' | 'approval' | 'updateSession' | 'sessions' | 'projects' | 'addProject'
  | 'models' | 'validateModel' | 'diff' | 'doctor' | 'getSettings' | 'putSettings'>
  & Partial<Pick<LinaClient, 'turnChanges' | 'turnDiff' | 'undo' | 'previews' | 'startPreview' | 'stopPreview' | 'previewLogs' | 'history' | 'search'>>
  & { connect?: LinaClient['connect'] };

export interface StoreState {
  conn: ConnState;
  /** Ever connected at least once (to tell "connecting" from "reconnecting"). */
  everOpen: boolean;
  project?: Project;
  settings?: Settings;
  view?: SessionView;
  sessionId?: string;
  notices: LocalNotice[];
  /** Config used for the next new session (settings + CLI flags + /model etc.). */
  pendingConfig: Partial<SessionConfig>;
  recent: Session[];
  /** A request is in flight (send/create). */
  busy?: string;
  loadingSession?: boolean;
  historyLoading?: boolean;
  /** Sessions deleted while this TUI was open (from session.deleted); lists filter them out. */
  deletedIds: string[];
}

let noticeSeq = 0;

export function mergeSnapshot(prev: SessionView | undefined, snap: SessionSnapshot): SessionView {
  if (!prev || prev.session.id !== snap.session.id) return viewFromSnapshot(snap);
  // Snapshot after a resubscribe: events are those after our lastSeq. Fold them onto
  // the existing view, then take live/session state from the fresh snapshot.
  const fresh = viewFromSnapshot({ ...snap, events: [] });
  let v = prev;
  for (const e of snap.events) v = applyEvent(v, e);
  const agents = { ...v.agents };
  for (const id of Object.keys(fresh.agents) as AgentId[]) {
    agents[id] = { ...fresh.agents[id], activity: v.agents[id]?.activity ?? [], model: fresh.agents[id].model ?? v.agents[id]?.model };
  }
  return {
    ...v,
    session: fresh.session, project: fresh.project, phase: fresh.phase, round: fresh.round, findings: fresh.findings,
    streams: fresh.streams, rateLimits: { ...v.rateLimits, ...fresh.rateLimits }, agents,
  };
}

export function describeError(e: unknown): { text: string; hint?: string } {
  if (e instanceof LinaApiError) {
    if (e.code === 'choose_variant') {
      return {
        text: 'Pick a winner first — this compete session has two candidate versions.',
        hint: e.hint ?? '/choose codex|claude adopts one (you can still review it), or /approve codex|claude [squash|merge|branch] picks and applies in one step. /diff codex|claude compares them.',
      };
    }
    const hint = e.hint ?? (e.code === 'dirty_worktree' ? 'Commit or stash your changes in the project, then /approve again (or /approve branch).' : undefined);
    return { text: e.code ? `${e.message} (${e.code})` : e.message, hint };
  }
  const err = e as Error & { cause?: { code?: string } };
  if (err?.cause?.code === 'ECONNREFUSED' || /fetch failed/i.test(err?.message ?? '')) {
    return { text: 'Cannot reach the LINA daemon.', hint: 'It may be restarting — `lina daemon status` / `lina daemon start`.' };
  }
  return { text: err?.message ?? String(e) };
}

export class TuiStore {
  private state: StoreState;
  private listeners = new Set<() => void>();
  private conn?: LiveConnection;
  private emitTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private navigation = 0;
  private historyLoad?: { navigation: number; promise: Promise<void> };

  constructor(
    public readonly client: ClientLike,
    init: { project?: Project; settings?: Settings; pendingConfig?: Partial<SessionConfig>; view?: SessionView; live?: boolean; recent?: Session[] },
    private openUrl?: (sessionId?: string) => string,
  ) {
    this.state = {
      conn: init.live === false ? 'offline' : 'connecting',
      everOpen: false,
      project: init.project ?? init.view?.project,
      settings: init.settings,
      view: init.view,
      sessionId: init.view?.session.id,
      notices: [],
      pendingConfig: init.pendingConfig ?? {},
      recent: init.recent ?? [],
      deletedIds: [],
    };
    if (init.live !== false && client.connect) {
      this.conn = client.connect({
        onMessage: (m) => this.onServerMessage(m),
        onStatus: (s) => this.set({ conn: s === 'open' ? 'open' : s === 'connecting' ? 'connecting' : 'closed', everOpen: this.state.everOpen || s === 'open' }),
      });
      // global watcher: session.updated / session.deleted for every session keep lists current
      this.conn.watchAll();
    }
  }

  // ── external store plumbing ──
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getState = () => this.state;

  private set(patch: Partial<StoreState>, immediate = true) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    if (immediate) this.flush();
    else if (!this.emitTimer) this.emitTimer = setTimeout(() => this.flush(), 33);
  }
  private flush() {
    if (this.emitTimer) { clearTimeout(this.emitTimer); this.emitTimer = undefined; }
    for (const l of this.listeners) l();
  }

  dispose() {
    this.disposed = true;
    this.navigation++;
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.conn?.close();
  }

  // ── events ──
  private onServerMessage(m: ServerMessage) {
    try {
      if (m.kind === 'snapshot') {
        if (m.sessionId !== this.state.sessionId) return;
        const view = mergeSnapshot(this.state.view, m.snapshot);
        this.set({ view, project: view.project, loadingSession: false });
      } else if (m.kind === 'event') {
        if (m.event.type === 'session.deleted') { this.onSessionDeleted(m.event.data.sessionId || m.event.sessionId); return; }
        const v = this.state.view;
        if (m.event.type === 'session.updated' && (!v || m.event.sessionId !== v.session.id)) {
          const s = m.event.data.session;
          if (this.state.recent.some((r) => r.id === s.id)) this.set({ recent: this.state.recent.map((r) => (r.id === s.id ? s : r)) }, false);
          return;
        }
        if (!v || m.event.sessionId !== v.session.id) return;
        const next = applyEvent(v, m.event);
        if (next !== v) this.set({ view: next }, false); // throttled (~30 fps) to keep re-render cost low
      } else if (m.kind === 'error') {
        this.notice('error', m.message);
      }
    } catch (e) {
      this.notice('error', `Could not apply an update: ${(e as Error).message}`);
    }
  }

  /** A session was deleted (here or in another client): drop it from lists; leave it if it is open. */
  onSessionDeleted(id: string) {
    const recent = this.state.recent.filter((r) => r.id !== id);
    const deletedIds = this.state.deletedIds.includes(id) ? this.state.deletedIds : [...this.state.deletedIds, id];
    if (this.state.sessionId !== id) { this.set({ recent, deletedIds }); return; }
    const title = this.state.view?.session.title;
    this.navigation++;
    this.conn?.unsubscribe(id);
    const n: LocalNotice = {
      id: `n${++noticeSeq}`, ts: Date.now(), level: 'warn',
      text: `This session${title ? ` (“${title}”)` : ''} was deleted.`,
      hint: 'Describe a new task to start another session, or Ctrl+L to open a different one.',
    };
    this.set({ sessionId: undefined, view: undefined, loadingSession: false, historyLoading: false, recent, deletedIds, notices: [n] });
  }

  notice(level: LocalNotice['level'], text: string, hint?: string) {
    const n: LocalNotice = { id: `n${++noticeSeq}`, ts: Date.now(), level, text, hint };
    this.set({ notices: [...this.state.notices, n].slice(-200) });
  }

  fail(e: unknown, prefix?: string) {
    const d = describeError(e);
    this.notice('error', prefix ? `${prefix}: ${d.text}` : d.text, d.hint);
  }

  webUrl(sessionId?: string): string | undefined { return this.openUrl?.(sessionId); }

  // ── sessions ──
  async openSession(id: string) {
    const navigation = ++this.navigation;
    const prevId = this.state.sessionId;
    if (prevId && prevId !== id) this.conn?.unsubscribe(prevId);
    this.set({ sessionId: id, loadingSession: true, historyLoading: false, view: prevId === id ? this.state.view : undefined, notices: prevId === id ? this.state.notices : [] });
    try {
      const snap = await this.client.session(id);
      if (this.navigation !== navigation || this.state.sessionId !== id) return;
      const view = mergeSnapshot(this.state.view, snap);
      this.set({ view, project: snap.project, loadingSession: false });
      this.conn?.subscribe(id, view.lastSeq);
    } catch (e) {
      if (this.navigation !== navigation || this.state.sessionId !== id) return;
      this.set({ loadingSession: false });
      this.fail(e, 'Could not open session');
      // still subscribe: the WS snapshot may succeed
      this.conn?.subscribe(id, 0);
    }
  }

  /** Reopen saved conversations across projects, resuming work only when stopped. */
  async resumeSession(selector: string) {
    try {
      const sessions = (await this.client.sessions({})).filter((s) => !this.state.deletedIds.includes(s.id)).sort((a, b) => b.updatedAt - a.updatedAt);
      const matches = selector === 'last' ? sessions.slice(0, 1) : sessions.filter((s) => s.id === selector || s.id.startsWith(selector));
      if (matches.length !== 1) {
        this.notice('warn', matches.length ? `Session id ${selector} is ambiguous.` : 'No matching saved conversation.', 'Use /history to choose a conversation.');
        return;
      }
      const target = matches[0];
      await this.openSession(target.id);
      const current = this.state.view?.session;
      if (current?.id === target.id && (['paused', 'interrupted', 'failed', 'cancelled'].includes(current.status) || (current.status === 'idle' && current.config.goal))) await this.control('resume');
    } catch (e) { this.fail(e, 'Could not reopen conversation'); }
  }

  /** Leaves the current session and shows the "new session" composer. */
  newDraft() {
    this.navigation++;
    if (this.state.sessionId) this.conn?.unsubscribe(this.state.sessionId);
    this.set({ sessionId: undefined, view: undefined, loadingSession: false, historyLoading: false, notices: [] });
    void this.refreshRecent();
  }

  /** Older pages preserve current live/session state and never advance the replay cursor. */
  async loadEarlier(targetSeq?: number): Promise<void> {
    const sid = this.state.sessionId, navigation = this.navigation;
    if (!sid || this.state.view?.session.id !== sid) { this.notice('warn', 'No session yet.'); return; }
    if (!this.client.history) { this.notice('error', 'This client cannot load older history. Reopen the updated TUI.'); return; }
    if (this.historyLoad?.navigation === navigation) {
      try { await this.historyLoad.promise; } catch { return; } // the original caller reports the error
      if (targetSeq !== undefined && this.navigation === navigation) return this.loadEarlier(targetSeq);
      return;
    }
    this.set({ historyLoading: true });
    const load = async () => {
      for (;;) {
        const view = this.state.view;
        if (this.navigation !== navigation || this.disposed || view?.session.id !== sid) return;
        const first = view.timeline.find((e) => e.seq > 0)?.seq ?? 1;
        if (first <= 1 || (targetSeq !== undefined && first <= targetSeq)) return;
        const events = await this.client.history!(sid, first, 500);
        const current = this.state.view;
        if (this.navigation !== navigation || this.disposed || current?.session.id !== sid) return;
        const next = prependHistory(current, events);
        if (next === current) throw new Error('Earlier history did not advance. Reconnect and try again.');
        this.set({ view: next });
        if (targetSeq === undefined) return;
      }
    };
    const promise = load();
    this.historyLoad = { navigation, promise };
    try { await promise; }
    catch (e) { if (this.navigation === navigation) this.fail(e, 'Could not load earlier history'); }
    finally {
      if (this.historyLoad?.promise === promise) this.historyLoad = undefined;
      if (this.navigation === navigation) this.set({ historyLoading: false });
    }
  }

  async search(query: string): Promise<SearchHit[]> {
    if (!this.client.search) throw new Error('This client cannot search history. Reopen the updated TUI.');
    return this.client.search(query);
  }

  async refreshRecent() {
    const projectId = this.state.project?.id;
    if (!projectId) return;
    try {
      const recent = await this.client.sessions({ projectId });
      if (this.state.project?.id !== projectId) return;
      this.set({ recent: recent.sort((a, b) => b.updatedAt - a.updatedAt) });
    } catch { /* non-fatal */ }
  }

  async createSession(prompt?: string, config?: Partial<SessionConfig>): Promise<Session | undefined> {
    const project = this.state.project;
    if (!project) { this.notice('error', 'No project selected', 'Use /project to pick one.'); return; }
    this.set({ busy: 'Starting session…' });
    try {
      const goal = config?.goal;
      const s = await this.client.createSession({ projectId: project.id, config: config ?? this.state.pendingConfig,
        ...(prompt ? { title: titleFrom(prompt), ...(!goal ? { prompt } : {}) } : {}) });
      if (goal && s.config.goal !== goal) throw new Error('The running daemon does not support goals. Run lina daemon restart after active work finishes, then try /goal again.');
      this.set({ busy: undefined });
      await this.openSession(s.id);
      if (goal && prompt) await this.sendMessage(prompt);
      return s;
    } catch (e) {
      this.set({ busy: undefined });
      this.fail(e, 'Could not start the session');
      return undefined;
    }
  }

  async goal(objective?: string): Promise<void> {
    const command = objective?.trim().toLowerCase();
    if (command && ['resume', 'pause', 'cancel'].includes(command)) {
      try {
        const isGoal = (s?: Session) => !!s?.config.goal && !/^(resume|pause|cancel|status)$/i.test(s.config.goal.trim());
        let session = this.state.view?.session;
        if (!isGoal(session)) {
          // Goal controls stay within the selected project. Ignore control words
          // accidentally saved as objectives by older releases.
          const goals = (await this.client.sessions({ projectId: this.state.project?.id }))
            .filter((s) => s.projectId === this.state.project?.id && isGoal(s) && !this.state.deletedIds.includes(s.id))
            .sort((a, b) => b.updatedAt - a.updatedAt);
          session = goals.find((s) => !['completed', 'approved', 'rejected'].includes(s.status)) ?? goals[0];
          if (session) await this.openSession(session.id);
        }
        if (!isGoal(session) || !session || this.state.view?.session.id !== session.id) { this.notice('warn', 'No saved goal could be opened in this project.', 'Start one with /goal <objective>.'); return; }
        const navigation = this.navigation;
        session = (await this.client.session(session.id)).session;
        if (navigation !== this.navigation) return;
        this.patchSession(session);
        if (session.status === 'completed' && session.goalStatus === 'complete' && !session.retryAt) {
          this.notice('info', 'Goal already complete: independently verified. No further input is needed for this objective.');
          return;
        }
        if (command === 'resume' && session.status === 'running') { this.notice('info', 'The goal is already running autonomously.'); return; }
        await this.control(command as 'resume' | 'pause' | 'cancel');
      } catch (e) { this.fail(e, 'Could not control the goal'); }
      return;
    }
    if (command === 'status') objective = undefined;
    if (!objective) {
      let session = this.state.view?.session;
      if (session) {
        try { session = (await this.client.session(session.id)).session; }
        catch (e) { this.fail(e, 'Could not load the goal'); return; }
      }
      this.notice('info', session?.config.goal
        ? `Goal: ${session.config.goal} · ${session.goalResumeQueued ? 'queued — continues automatically when the project is free' : session.goalStatus ?? session.status} (${session.status})`
        : 'No goal in this conversation. Start one with /goal <objective>.',
      [session?.goalTask ? `Current item: ${session.goalTask}` : '', session?.goalDeferred?.length ? `Deferred evidence checks: ${session.goalDeferred.map((w) => w.key).join(', ')}` : '', 'Goals use structured implementation, tests and review. /pause · /resume · /cancel'].filter(Boolean).join('\n'));
      return;
    }
    // A dedicated conversation preserves the current task and its settings/history.
    const developer = this.currentConfig().developer ?? this.state.settings?.developer ?? 'claude';
    const config = { ...this.currentConfig(), developer, goal: objective, mode: 'architect' as const, reviewer: developer === 'codex' ? 'claude' as const : 'codex' as const, interactionMode: 'workflow' as const, stepMode: false };
    await this.createSession(objective, config);
  }

  async sendMessage(text: string, interrupt = false) {
    const v = this.state.view;
    if (!v) { await this.createSession(text); return; }
    this.set({ busy: interrupt ? 'Interrupting…' : 'Sending…' });
    try {
      const r = await this.client.send(v.session.id, text, interrupt ? { interrupt: true } : {});
      this.set({ busy: undefined });
      if (r.queued && !interrupt) this.notice('info', 'Queued — the agents will see it at the next turn boundary.');
    } catch (e) {
      this.set({ busy: undefined });
      this.fail(e, 'Message not sent');
    }
  }

  async control(action: 'pause' | 'resume' | 'cancel' | 'review' | 'retry') {
    const v = this.state.view;
    if (!v) { this.notice('warn', `Nothing to ${action} yet — start a session first.`); return; }
    try {
      const s = await this.client.control(v.session.id, action);
      this.patchSession(s);
      const msg = { pause: 'Pausing at the next turn boundary.', resume: 'Resuming.', cancel: 'Cancelled the running turn.', review: 'Extra review round requested.', retry: 'Retrying the last step.' }[action];
      this.notice('info', msg);
    } catch (e) { this.fail(e, `Could not ${action}`); }
  }

  async changes(turn?: number) {
    const sid = this.state.view?.session.id;
    if (!sid) { this.notice('warn', 'No session yet.'); return; }
    try {
      if (turn !== undefined) {
        const d = await this.client.turnDiff!(sid, turn);
        this.notice('info', `Writing turn ${turn}\n${d.files.map((f) => `${f.path} +${f.additions} -${f.deletions}\n${f.binary ? '(binary file)' : f.patch}`).join('\n').slice(0, 24000)}`);
      } else {
        const list = await this.client.turnChanges!(sid);
        this.notice('info', list.length ? list.map((t) => `Turn ${t.turn} · ${t.agent} · ${t.status}\n  ${t.files.map((f) => f.path).join(', ')}`).join('\n') : 'No writing turns recorded yet.', '/changes <turn> inspects its diff; /undo [turn] restores its previous files.');
      }
    } catch (e) { this.fail(e, 'Could not inspect writing turns'); }
  }

  async undo(turn?: number) {
    const sid = this.state.view?.session.id;
    if (!sid) { this.notice('warn', 'No session yet.'); return; }
    try { const c = await this.client.undo!(sid, turn); this.notice('success', `Undid writing turn ${c.turn}. Other files and staged changes were kept.`); }
    catch (e) { this.fail(e, 'Could not undo'); }
  }

  async preview(action: 'list' | 'start' | 'stop' | 'logs', value?: string) {
    const sid = this.state.view?.session.id;
    if (!sid) { this.notice('warn', 'Start a session before managing previews.'); return; }
    try {
      if (action === 'logs') { this.notice('info', (await this.client.previewLogs!(sid, value!)).output || 'No output yet.'); return; }
      if (action === 'stop') { await this.client.stopPreview!(sid, value!); this.notice('success', `Stopped preview ${value}`); return; }
      if (action === 'start') { const p = await this.client.startPreview!(sid, { command: value! }); this.notice('success', `Preview ${p.id} · ${p.status} · ${p.url}`, 'Use /preview to check readiness, /preview logs <id> for output, /preview stop <id> to stop.'); return; }
      const list = await this.client.previews!(sid);
      this.notice('info', list.length ? list.map((p) => `${p.id} · ${p.status} · ${p.url}\n  ${p.command}`).join('\n') : 'No previews yet.', '/preview start npm run dev -- --host 127.0.0.1 --port {port}');
    } catch (e) { this.fail(e, 'Could not manage previews'); }
  }

  /**
   * approve [variant] [strategy]. compete: with a variant it chooses that candidate and applies in one
   * step; without one (and nothing chosen yet) the daemon answers choose_variant.
   */
  async approve(strategy?: ApplyStrategy, variant?: AgentId) {
    const v = this.state.view;
    if (!v) { this.notice('warn', 'No session to approve.'); return; }
    const s = v.session;
    if (variant) {
      if (s.chosenVariant === variant) variant = undefined; // already the session branch
      else if (s.chosenVariant) {
        this.notice('warn', `You already picked ${AGENT_NAME[s.chosenVariant]}'s version.`, `/approve ${strategy ?? ''}`.trimEnd() + ' applies it.');
        return;
      } else if (s.config.mode !== 'compete') {
        this.notice('warn', `There is only one version in a ${s.config.mode} session — nothing to pick.`, `/approve ${strategy ?? '[squash|merge|branch]'}`);
        return;
      }
    }
    try {
      this.patchSession(await this.client.approval(s.id, { decision: 'approve', ...(strategy ? { strategy } : {}), ...(variant ? { variant } : {}) }));
    } catch (e) { this.fail(e, 'Approval failed'); }
  }

  /** compete: adopt one candidate. The session becomes a pair session (winner develops, rival reviews), still awaiting approval. */
  async choose(variant: AgentId) {
    const v = this.state.view;
    if (!v) { this.notice('warn', 'No session yet — /choose picks the winner of a compete session.'); return; }
    const s = v.session;
    if (s.chosenVariant) {
      this.notice(s.chosenVariant === variant ? 'info' : 'warn', `You already picked ${AGENT_NAME[s.chosenVariant]}'s version.`, '/approve [squash|merge|branch] applies it · type a message to request changes');
      return;
    }
    if (s.config.mode !== 'compete') {
      this.notice('warn', `/choose is for compete sessions (this one is ${s.config.mode}).`, 'Start one with /mode compete, or `lina "<task>" --mode compete`.');
      return;
    }
    try {
      this.patchSession(await this.client.approval(s.id, { decision: 'choose', variant }));
      const rival: AgentId = variant === 'codex' ? 'claude' : 'codex';
      this.notice('success', `You picked ${AGENT_NAME[variant]}'s version — it is now the session branch, ${AGENT_NAME[rival]} reviews.`, '/approve [squash|merge|branch] applies it · /reject · or type a message to request changes');
    } catch (e) { this.fail(e, 'Could not choose'); }
  }

  async reject(note?: string) {
    const v = this.state.view;
    if (!v) { this.notice('warn', 'No session to reject.'); return; }
    try { this.patchSession(await this.client.approval(v.session.id, { decision: 'reject', ...(note ? { note } : {}) })); } catch (e) { this.fail(e, 'Reject failed'); }
  }

  async waive(findingId: string) {
    const v = this.state.view;
    if (!v) return;
    try {
      this.patchSession(await this.client.approval(v.session.id, { decision: 'waive', findingId }));
      this.notice('success', `Waived ${findingId}.`);
    } catch (e) { this.fail(e, `Could not waive ${findingId}`); }
  }

  private patchSession(s: Session) {
    const v = this.state.view;
    if (v && v.session.id === s.id && s.updatedAt >= v.session.updatedAt) this.set({ view: { ...v, session: s, phase: s.phase, round: s.round } });
  }

  currentConfig(): Partial<SessionConfig> {
    return this.state.view?.session.config ?? this.state.pendingConfig;
  }

  private async patchConfig(config: Partial<SessionConfig>, what: string) {
    const v = this.state.view;
    if (!v) {
      this.set({ pendingConfig: { ...this.state.pendingConfig, ...config } });
      this.notice('success', `${what} — applies to the next session you start.`);
      return true;
    }
    try {
      this.patchSession(await this.client.updateSession(v.session.id, { config }));
      this.notice('success', `${what} — applies from the next turn.`);
      return true;
    } catch (e) { this.fail(e, 'Could not update the session'); return false; }
  }

  async setModel(agent: AgentId, model: string, effort?: Effort) {
    const cur = { ...this.state.settings?.models, ...this.currentConfig().models };
    const models = { ...(cur ?? {}), [agent]: { model, ...(effort ? { effort } : {}) } as AgentModelChoice } as Record<AgentId, AgentModelChoice>;
    return this.patchConfig({ models }, `${agent === 'codex' ? 'Codex' : 'Claude'} → ${model}${effort ? ' · ' + effort : ''}`);
  }

  async swapRoles() {
    const cfg = this.currentConfig();
    const dev: AgentId = cfg.developer ?? this.state.settings?.developer ?? 'codex';
    const next: AgentId = dev === 'codex' ? 'claude' : 'codex';
    await this.patchConfig({ developer: next, reviewer: dev }, `${next === 'codex' ? 'Codex' : 'Claude'} now develops, ${dev === 'codex' ? 'Codex' : 'Claude'} reviews`);
  }

  async setMode(mode: Mode, team?: TeamConfig) {
    if (mode === 'custom') { await this.setTeam(team ?? defaultTeam(this.currentConfig(), this.state.settings?.team)); return; }
    await this.patchConfig({ mode }, `Mode: ${MODE_LABEL[mode]}`);
  }

  /** Custom team (switches to custom mode). developer/reviewer mirror the team like the daemon does. */
  async setTeam(team: TeamConfig) {
    await this.patchConfig({ mode: 'custom', team, ...rolesForTeam(team) }, `Mode: ${MODE_LABEL.custom} — ${teamSummary(team)}`);
  }

  /** Saves a team as the default for new custom sessions (settings.team). */
  async saveDefaultTeam(team: TeamConfig) {
    try {
      const settings = await this.client.putSettings({ team });
      if (settings && JSON.stringify(settings.team) !== JSON.stringify(team)) {
        this.notice('warn', 'The daemon did not store the default team.', 'It may be older than this TUI — `lina daemon restart` when no session is running.');
        return;
      }
      this.set({ settings: settings ?? (this.state.settings ? { ...this.state.settings, team } : undefined) });
      this.notice('success', `Default team saved — ${teamSummary(team)}`);
    } catch (e) { this.fail(e, 'Could not save the default team'); }
  }

  setProject(p: Project) {
    this.navigation++;
    if (this.state.sessionId) this.conn?.unsubscribe(this.state.sessionId);
    this.set({ project: p, sessionId: undefined, view: undefined, loadingSession: false, historyLoading: false, notices: [], recent: [] });
    void this.refreshRecent();
  }
}

export function titleFrom(prompt: string): string {
  const line = prompt.trim().split('\n')[0].replace(/\s+/g, ' ');
  return line.length > 72 ? line.slice(0, 71) + '…' : line;
}
