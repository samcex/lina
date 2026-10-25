// The app controller: owns the backend client + live connection, folds server
// messages into the store with the shared reducer, and exposes user actions.
import { createContext, useContext } from 'react';
import { applyEvent, viewFromSnapshot, type SessionView } from '@shared/reducer';
import { prependHistory } from '@shared/history';
import type { ServerMessage } from '@shared/protocol';
import type {
  AgentId, AnyLinaEvent, ApplyStrategy, Attachment, LiveState, Project, Session, SessionConfig, SessionSnapshot, Settings,
} from '@shared/types';
import type { Backend, LiveLike } from './backend';
import { Store, getStore, writeLocal, type AppState, type InspectorTab, type PendingMsg, type Toast, type UIState } from './store';
import { writeSessionHash } from './auth';

export interface ApiErr { message: string; code?: string; hint?: string; status?: number }
export function asApiErr(e: unknown): ApiErr {
  if (e && typeof e === 'object') {
    const x = e as { message?: string; code?: string; hint?: string; status?: number };
    return { message: x.message ?? String(e), code: x.code, hint: x.hint, status: x.status };
  }
  return { message: String(e) };
}

let toastSeq = 1;
let cidSeq = 1;

export class Lina {
  readonly store: Store<AppState>;
  private live: LiveLike | null = null;
  private resyncing: { sessionId: string; queued: AnyLinaEvent[] } | null = null;
  private snapshotTimer?: ReturnType<typeof setTimeout>;
  private resyncTimer?: ReturnType<typeof setTimeout>;
  private historyLoads = new Map<string, Promise<void>>();
  private navigation = 0;
  /** Sessions this client deleted itself (their session.deleted echo needs no toast). */
  private selfDeleted = new Set<string>();

  constructor(public backend: Backend) {
    this.store = getStore();
  }

  get client() { return this.backend.client; }
  private get s() { return this.store.get(); }

  // ── lifecycle ────────────────────────────────────────────────────────
  init(initialSession: string | null) {
    this.applyTheme(this.s.ui.theme);
    this.live = this.client.connect({
      onMessage: (m) => this.onServer(m),
      onStatus: (st) => {
        const prev = this.s.conn;
        this.store.set({ conn: st, everOpen: this.s.everOpen || st === 'open' });
        if (st === 'open' && prev !== 'open' && this.s.everOpen) {
          // Re-sync the lists after a reconnect (the live socket re-subscribes by itself).
          void this.loadLists();
        }
      },
    });
    this.live.watchAll();
    void this.loadLists().then(() => {
      if (initialSession) this.select(initialSession, { replace: true });
    });
    void this.loadSettings();
    void this.loadModels(false);
  }

  async loadLists() {
    try {
      const [projects, sessions] = await Promise.all([this.client.projects(), this.client.sessions()]);
      const map: Record<string, Session> = {};
      for (const s of sessions) map[s.id] = s;
      this.store.set({ projects, sessions: map, projectsLoaded: true, sessionsLoaded: true });
    } catch (e) {
      this.store.set({ projectsLoaded: true, sessionsLoaded: true });
      if (asApiErr(e).status === 401) { this.store.set({ unauthorized: true }); return; }
      this.toastErr('Could not load projects', e);
    }
  }

  async loadSettings() {
    try {
      const settings = await this.client.getSettings();
      this.store.set({ settings });
      if (settings.theme && settings.theme !== this.s.ui.theme) {
        this.setUI({ theme: settings.theme });
        this.applyTheme(settings.theme);
      }
    } catch { /* settings are optional for rendering */ }
  }

  async loadModels(refresh: boolean) {
    this.store.set({ modelsLoading: true, modelsError: null });
    try {
      const models = await this.client.models(refresh);
      this.store.set({ models, modelsLoading: false });
    } catch (e) {
      this.store.set({ modelsLoading: false, modelsError: asApiErr(e).message });
    }
  }

  // ── server messages ──────────────────────────────────────────────────
  private onServer(m: ServerMessage) {
    switch (m.kind) {
      case 'snapshot': return this.onSnapshot(m.sessionId, m.snapshot);
      case 'event': return this.onEvent(m.event);
      case 'projects': return this.store.set({ projects: m.projects, projectsLoaded: true });
      case 'error': return this.toast({ tone: 'error', title: 'Daemon error', detail: m.message });
      default: return;
    }
  }

  private onSnapshot(sessionId: string, snap: SessionSnapshot) {
    this.store.set((s) => ({ sessions: { ...s.sessions, [snap.session.id]: snap.session } }));
    if (sessionId !== this.s.currentId) return;
    clearTimeout(this.snapshotTimer);
    const cur = this.s.view;
    const view = cur && cur.session.id === sessionId && cur.lastSeq > 0 ? mergeSnapshot(cur, snap) : viewFromSnapshot(snap);
    this.store.set({ view, viewError: null });
    this.reconcilePending(view);
  }

  private onEvent(e: AnyLinaEvent) {
    if (e.type === 'session.deleted') { this.onDeleted(e.data.sessionId || e.sessionId); return; }
    if (e.type === 'session.updated') {
      const sess = e.data.session;
      this.store.set((s) => ({ sessions: { ...s.sessions, [sess.id]: sess } }));
    }
    const view = this.s.view;
    if (!view || e.sessionId !== view.session.id) return;
    if (this.resyncing?.sessionId === e.sessionId && e.seq > 0) { this.resyncing.queued.push(e); return; }

    if (e.type === 'session.updated' && e.seq > view.lastSeq + 1) {
      // Possibly delivered via watchAll ahead of the session stream: patch without advancing seq.
      const sess = e.data.session;
      this.store.set({ view: { ...view, session: sess, phase: sess.phase, round: sess.round } });
      return;
    }
    if (e.seq > view.lastSeq + 1 && view.lastSeq > 0) {
      void this.resync(e);
      return;
    }
    const next = applyEvent(view, e);
    if (next !== view) this.store.set({ view: next });
    if (e.type === 'message' && e.actor === 'user') this.reconcilePending(next);
  }

  /** A session was deleted (by this client or another): drop it everywhere; if it is open, say so. */
  private onDeleted(id: string) {
    const known = this.s.sessions[id];
    const isOpen = this.s.currentId === id;
    const title = known?.title || (isOpen ? this.s.view?.session.title : '') || 'Untitled session';
    this.store.set((s) => {
      const sessions = { ...s.sessions };
      delete sessions[id];
      return { sessions, pending: s.pending.filter((p) => p.sessionId !== id) };
    });
    const mine = this.selfDeleted.delete(id);
    if (!isOpen) return;
    this.live?.unsubscribe(id);
    clearTimeout(this.snapshotTimer);
    this.store.set({ view: null, viewError: null, deleted: { id, title } });
    this.setUI({ diffRange: null, filePath: null, worktree: null, liveAgent: null });
    if (!mine) this.toast({ tone: 'warn', title: 'This session was deleted', detail: `“${title}” and its workspace were removed from another window or the terminal.` });
  }

  private async resync(trigger: AnyLinaEvent, attempt = 0) {
    const view = this.s.view;
    if (!view) return;
    clearTimeout(this.resyncTimer);
    const job = { sessionId: view.session.id, queued: [trigger] };
    this.resyncing = job;
    try {
      const missing = await this.client.events(view.session.id, view.lastSeq);
      let v = this.s.view;
      if (!v || v.session.id !== view.session.id) return;
      for (const ev of [...missing, ...job.queued].sort((a, b) => a.seq - b.seq)) v = applyEvent(v, ev);
      this.store.set({ view: v });
      this.reconcilePending(v);
    } catch {
      // Keep the replay cursor before the gap. Advancing it to queued events would
      // permanently skip the missing history on reconnect. The next event or
      // retry can recover from the last complete cursor, even if work has ended
      // and there will be no further events to trigger recovery.
      if (this.s.currentId === job.sessionId && this.resyncing === job) {
        this.resyncTimer = setTimeout(() => {
          if (this.s.currentId === job.sessionId) void this.resync(trigger, attempt + 1);
        }, Math.min(1000 * 2 ** attempt, 10_000));
      }
    } finally {
      if (this.resyncing === job) this.resyncing = null;
    }
  }

  private reconcilePending(view: SessionView) {
    const pend = this.s.pending;
    if (!pend.length) return;
    const userMsgs = view.timeline.filter((e) => e.type === 'message' && e.actor === 'user') as Extract<AnyLinaEvent, { type: 'message' }>[];
    const used = new Set<number>();
    const left = pend.filter((p) => {
      if (p.sessionId !== view.session.id || p.state === 'failed') return true;
      const hit = userMsgs.find((m) => !used.has(m.seq) && m.seq > (p.afterSeq ?? 0) && m.data.text.trim() === p.text.trim() && m.ts >= p.ts - 15_000);
      if (hit) { used.add(hit.seq); return false; }
      return true;
    });
    if (left.length !== pend.length) this.store.set({ pending: left });
  }

  /** Load one older page, or enough pages to reveal a search target. */
  async loadEarlier(targetSeq?: number): Promise<void> {
    const id = this.s.currentId;
    if (!id || this.s.view?.session.id !== id) return;
    const navigation = this.navigation;
    const pending = this.historyLoads.get(id);
    if (pending) {
      await pending;
      if (targetSeq !== undefined && this.s.currentId === id) return this.loadEarlier(targetSeq);
      return;
    }
    const load = async () => {
      for (;;) {
        const view = this.s.view;
        if (this.navigation !== navigation || this.s.currentId !== id || view?.session.id !== id) return;
        const first = view.timeline.find((e) => e.seq > 0)?.seq ?? 1;
        if (first <= 1 || (targetSeq !== undefined && first <= targetSeq)) return;
        const events = await this.client.history(id, first);
        const current = this.s.view;
        if (this.navigation !== navigation || this.s.currentId !== id || current?.session.id !== id) return;
        const next = prependHistory(current, events);
        if (next === current) throw new Error('Earlier messages could not be loaded. Please reconnect and try again.');
        this.store.set({ view: next });
        if (targetSeq === undefined) return;
      }
    };
    const job = load();
    this.historyLoads.set(id, job);
    try { await job; } finally { if (this.historyLoads.get(id) === job) this.historyLoads.delete(id); }
  }

  // ── navigation ───────────────────────────────────────────────────────
  select(id: string | null, opts: { replace?: boolean } = {}) {
    const prev = this.s.currentId;
    if (prev === id && (id === null || this.s.view) && !this.s.deleted) return;
    this.navigation++;
    if (prev && this.live) this.live.unsubscribe(prev);
    clearTimeout(this.snapshotTimer);
    clearTimeout(this.resyncTimer);
    this.store.set({ currentId: id, view: null, viewError: null, deleted: null });
    this.setUI({ diffRange: null, filePath: null, worktree: null, liveAgent: null, composerPrefill: null, focusSeq: null });
    if (!opts.replace) writeSessionHash(id);
    if (!id) return;
    this.live?.subscribe(id, 0);
    clearTimeout(this.snapshotTimer);
    // REST fallback in case the socket is down or slow.
    this.snapshotTimer = setTimeout(() => void this.fetchSnapshot(id), this.s.conn === 'open' ? 1500 : 50);
    if (window.innerWidth < 900) this.setUI({ sidebarOpen: false });
  }

  private async fetchSnapshot(id: string) {
    if (this.s.currentId !== id || this.s.view) return;
    try {
      const snap = await this.client.session(id);
      if (this.s.currentId === id && !this.s.view) this.onSnapshot(id, snap);
    } catch (e) {
      if (this.s.currentId === id && !this.s.view) this.store.set({ viewError: asApiErr(e).message });
    }
  }

  // ── session actions ──────────────────────────────────────────────────
  async send(text: string, attachments: Attachment[], interrupt: boolean) {
    const id = this.s.currentId;
    return this.sendTo(id, text, attachments, interrupt);
  }

  private async sendTo(id: string | null, text: string, attachments: Attachment[], interrupt: boolean) {
    if (!id || !text.trim()) return;
    const cid = `c${cidSeq++}`;
    const afterSeq = this.s.view?.session.id === id ? this.s.view.lastSeq : this.s.sessions[id]?.lastSeq ?? 0;
    const p: PendingMsg = { cid, sessionId: id, text, ts: Date.now(), afterSeq, state: 'sending', attachments, interrupt };
    this.store.set((s) => ({ pending: [...s.pending, p] }));
    try {
      const r = await this.client.send(id, text, { attachments: attachments.map((a) => a.id), interrupt: interrupt || undefined });
      this.patchPending(cid, { state: 'sent', queued: r.queued });
      const v = this.s.view;
      if (v) this.reconcilePending(v);
    } catch (e) {
      const err = asApiErr(e);
      this.patchPending(cid, { state: 'failed', error: err.message });
    }
  }

  retryPending(cid: string) {
    const p = this.s.pending.find((x) => x.cid === cid);
    if (!p) return;
    this.dropPending(cid);
    void this.sendTo(p.sessionId, p.text, p.attachments, p.interrupt);
  }
  dropPending(cid: string) { this.store.set((s) => ({ pending: s.pending.filter((x) => x.cid !== cid) })); }
  private patchPending(cid: string, patch: Partial<PendingMsg>) {
    this.store.set((s) => ({ pending: s.pending.map((x) => (x.cid === cid ? { ...x, ...patch } : x)) }));
  }

  async upload(file: File, id = this.s.currentId): Promise<Attachment | null> {
    if (!id) return null;
    try {
      return await this.client.upload(id, file.name || 'pasted-image.png', file.type, file);
    } catch (e) {
      this.toastErr(`Could not attach ${file.name || 'file'}`, e);
      return null;
    }
  }

  async control(action: 'pause' | 'resume' | 'cancel' | 'review' | 'retry') {
    const id = this.s.currentId;
    if (!id) return;
    try {
      const sess = await this.client.control(id, action);
      this.acceptSession(sess);
      const verb = { pause: 'Pausing at the next turn boundary', resume: 'Resuming', cancel: 'Cancelled', review: 'Extra review round requested', retry: 'Retrying the last step' }[action];
      this.toast({ tone: 'info', title: verb });
    } catch (e) { this.toastErr(`Could not ${action}`, e); }
  }

  async undo(turn?: number) {
    const id = this.s.currentId;
    if (!id) return;
    try { const c = await this.client.undo(id, turn); this.openInspector('changes', { diffRange: null }); this.toast({ tone: 'ok', title: `Undid turn ${c.turn}` }); }
    catch (e) { this.toastErr('Could not undo', e); }
  }

  /**
   * Returns an error (for inline display) instead of toasting for approval-specific failures.
   * `variant` (compete): choose that candidate and apply it in one step.
   */
  async approve(strategy: ApplyStrategy, note?: string, variant?: AgentId): Promise<ApiErr | null> {
    const id = this.s.currentId;
    if (!id) return null;
    try {
      const sess = await this.client.approval(id, { decision: 'approve', strategy, note, ...(variant ? { variant } : {}) });
      this.acceptSession(sess);
      return null;
    } catch (e) {
      const err = asApiErr(e);
      if (err.code === 'choose_variant') this.toastChooseFirst();
      return err;
    }
  }

  /** compete: adopt one candidate. The session continues as a pair session, still awaiting approval. */
  async choose(variant: AgentId): Promise<ApiErr | null> {
    const id = this.s.currentId;
    if (!id) return null;
    try {
      this.acceptSession(await this.client.approval(id, { decision: 'choose', variant }));
      this.setUI({ worktree: null, diffRange: null });
      const rival = variant === 'codex' ? 'claude' : 'codex';
      this.toast({ tone: 'ok', title: `You chose ${cap(variant)}'s version`, detail: `Its commits are now the session branch. ${cap(rival)} reviews from here — approve when you're ready.` });
      return null;
    } catch (e) {
      const err = asApiErr(e);
      this.toastErr('Could not choose that version', e);
      return err;
    }
  }

  private toastChooseFirst() {
    this.toast({
      tone: 'warn', title: 'Pick a version first',
      detail: "This is a competition: choose Codex's or Claude's version in the approval card (or approve one directly), then apply it.",
      action: { label: 'Show candidates', run: () => document.querySelector('.cand-grid')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) },
    }, 9000);
  }

  /** Show one agent's worktree (or the session workspace) in the inspector's Changes tab. */
  viewWorktree(worktree: AgentId | null, tab: InspectorTab = 'changes') {
    this.openInspector(tab, { worktree, diffRange: null, filePath: null });
  }

  async reject(note?: string): Promise<ApiErr | null> {
    const id = this.s.currentId;
    if (!id) return null;
    try {
      this.acceptSession(await this.client.approval(id, { decision: 'reject', note }));
      return null;
    } catch (e) { return asApiErr(e); }
  }

  async waive(findingId: string, note?: string) {
    const id = this.s.currentId;
    if (!id) return;
    try {
      this.acceptSession(await this.client.approval(id, { decision: 'waive', findingId, note }));
      this.toast({ tone: 'ok', title: `${findingId} waived`, detail: 'Recorded as your decision — no fix required.' });
    } catch (e) { this.toastErr(`Could not waive ${findingId}`, e); }
  }

  async rename(title: string) {
    const v = this.s.view;
    if (!v || !title.trim() || title === v.session.title) return;
    const before = v.session;
    this.acceptSession({ ...before, title });
    try { this.acceptSession(await this.client.updateSession(before.id, { title: title.trim() })); }
    catch (e) { this.acceptSession(before); this.toastErr('Rename failed', e); }
  }

  async updateConfig(patch: Partial<SessionConfig>, okMessage?: string) {
    const v = this.s.view;
    if (!v) return;
    const before = v.session;
    this.acceptSession({ ...before, config: { ...before.config, ...patch, models: { ...before.config.models, ...(patch.models ?? {}) } } });
    try {
      this.acceptSession(await this.client.updateSession(before.id, { config: patch }));
      if (okMessage) this.toast({ tone: 'ok', title: okMessage, detail: before.status === 'running' ? 'Applies from the next turn.' : undefined });
    } catch (e) { this.acceptSession(before); this.toastErr('Could not update the session', e); }
  }

  swapRoles() {
    const v = this.s.view;
    if (!v) return;
    const { developer, reviewer, mode } = v.session.config;
    if (mode === 'custom' || mode === 'compete') return; // roles come from the team / both agents build
    void this.updateConfig({ developer: reviewer, reviewer: developer },
      mode === 'parallel' ? `${cap(reviewer)} now leads` : `${cap(reviewer)} now develops · ${cap(developer)} reviews`);
  }

  private acceptSession(sess: Session) {
    this.store.set((s) => ({
      sessions: { ...s.sessions, [sess.id]: sess },
      view: s.view && s.view.session.id === sess.id ? { ...s.view, session: sess, phase: sess.phase, round: sess.round } : s.view,
    }));
  }

  async createSession(body: { projectId: string; title?: string; config?: Partial<SessionConfig>; prompt?: string }) {
    const sess = await this.client.createSession(body);
    this.store.set((s) => ({ sessions: { ...s.sessions, [sess.id]: sess } }));
    this.select(sess.id);
    return sess;
  }

  async deleteSession(id: string) {
    try {
      this.selfDeleted.add(id);
      await this.client.deleteSession(id);
      this.store.set((s) => { const sessions = { ...s.sessions }; delete sessions[id]; return { sessions }; });
      if (this.s.currentId === id) this.select(null);
      void this.loadLists(); // DELETE emits no event — refetch
      this.toast({ tone: 'ok', title: 'Session deleted', detail: 'Its isolated workspace was removed.' });
    } catch (e) { this.selfDeleted.delete(id); this.toastErr('Could not delete session', e); }
  }

  async addProject(body: { path: string; name?: string; create?: boolean; initGit?: boolean }): Promise<Project> {
    const p = await this.client.addProject(body);
    this.store.set((s) => ({ projects: [...s.projects.filter((x) => x.id !== p.id), p] }));
    return p;
  }

  async validateModel(agent: AgentId, model: string) {
    const key = `${agent}:${model}`;
    this.store.set((s) => ({ validations: { ...s.validations, [key]: { state: 'checking' } } }));
    try {
      const result = await this.client.validateModel(agent, model);
      this.store.set((s) => ({ validations: { ...s.validations, [key]: { state: 'done', result } } }));
    } catch (e) {
      const err = asApiErr(e);
      this.store.set((s) => ({ validations: { ...s.validations, [key]: { state: 'done', result: { ok: false, checkedAt: Date.now(), error: err.message, code: err.code as never } } } }));
    }
  }

  async saveSettings(patch: Partial<Settings>) {
    try {
      const settings = await this.client.putSettings(patch);
      this.store.set({ settings });
      return true;
    } catch (e) { this.toastErr('Could not save settings', e); return false; }
  }

  // ── UI ───────────────────────────────────────────────────────────────
  setUI(patch: Partial<UIState>) {
    const ui = { ...this.s.ui, ...patch };
    this.store.set({ ui });
    if ('inspectorOpen' in patch && window.innerWidth >= 1280) writeLocal('lina.inspectorOpen', ui.inspectorOpen);
    if ('inspectorTab' in patch) writeLocal('lina.inspectorTab', ui.inspectorTab);
    if ('inspectorWidth' in patch) writeLocal('lina.inspectorWidth', ui.inspectorWidth);
  }

  openInspector(tab: InspectorTab, extra: Partial<UIState> = {}) { this.setUI({ inspectorOpen: true, inspectorTab: tab, ...extra }); }
  inspectAgent(agent: AgentId) { this.openInspector('live', { liveAgent: agent }); }
  toggleInspector() { this.setUI({ inspectorOpen: !this.s.ui.inspectorOpen }); }
  toggleSidebar() { this.setUI({ sidebarOpen: !this.s.ui.sidebarOpen }); }
  prefillComposer(text: string) { this.setUI({ composerPrefill: { text, nonce: Date.now() } }); }
  focusComposer() { this.setUI({ composerFocus: Date.now() }); }

  setTheme(theme: 'dark' | 'light') {
    this.setUI({ theme });
    writeLocal('lina.theme', theme);
    this.applyTheme(theme);
    if (this.s.settings) void this.saveSettings({ theme });
  }
  private applyTheme(theme: 'dark' | 'light') {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#08090e' : '#f6f6f9');
  }

  toast(t: Omit<Toast, 'id'>, ms = t.tone === 'error' ? 7000 : 3800) {
    const id = toastSeq++;
    this.store.set((s) => ({ toasts: [...s.toasts.slice(-3), { ...t, id }] }));
    setTimeout(() => this.dismissToast(id), ms);
  }
  toastErr(title: string, e: unknown) {
    const err = asApiErr(e);
    this.toast({ tone: 'error', title, detail: [err.message, err.hint].filter(Boolean).join(' — ') });
  }
  dismissToast(id: number) { this.store.set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })); }
}

function cap(a: string) { return a[0].toUpperCase() + a.slice(1); }

/** Fold a (possibly incremental, `since`-based) snapshot into an existing view. */
export function mergeSnapshot(view: SessionView, snap: SessionSnapshot): SessionView {
  let v = view;
  for (const e of snap.events) v = applyEvent(v, e);
  return {
    ...applyLiveState(v, snap.live),
    session: snap.session,
    project: snap.project,
    findings: snap.findings,
    phase: snap.session.phase,
    round: snap.session.round,
    streams: { ...snap.live.streams },
    rateLimits: { ...v.rateLimits, ...snap.live.rateLimits },
  };
}

function applyLiveState(v: SessionView, live: LiveState): SessionView {
  const agents = { ...v.agents };
  for (const id of Object.keys(live.agents) as AgentId[]) {
    const a = live.agents[id];
    agents[id] = { ...agents[id], status: a.status, detail: a.detail, role: a.role, since: a.since, model: a.model ?? agents[id]?.model };
  }
  return { ...v, agents };
}

export const LinaContext = createContext<Lina | null>(null);
export function useLina(): Lina {
  const l = useContext(LinaContext);
  if (!l) throw new Error('LinaContext missing');
  return l;
}
