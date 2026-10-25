// SessionManager: projects, sessions, message routing, control and approval.
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import {
  AGENT_IDS, IMPLEMENTED_MODES, type AgentId, type AnyLinaEvent, type ApplyStrategy, type Attachment, type DiffFile,
  type Project, type ProjectSettings, type SearchHit, type Session, type SessionConfig, type SessionSnapshot, type Settings,
  type TeamConfig, type TreeEntry,
} from '../shared/types.js';
import { mockEnabled } from './agents/index.js';
import type { Db } from './db.js';
import type { EventStore } from './events.js';
import * as git from './git.js';
import { log } from './log.js';
import { paths } from './paths.js';
import { initialState, migrateState, SessionRunner, type RunnerState } from './runner.js';
import { getSettings, intIn, isAgentId, putSettings, validateModels, validateTeam } from './settings.js';
import { LinaError, rid, titleFrom } from './util.js';
import { TurnHistory } from './undo.js';
import { PreviewManager } from './previews.js';

export const SNAPSHOT_EVENT_CAP = 2000;
const DEFAULT_TITLE = 'New session';
export const ATTACHMENT_MAX = 20 * 1024 * 1024;

function otherAgent(a: AgentId): AgentId { return a === 'codex' ? 'claude' : 'codex'; }

export class SessionManager {
  private editing = new Set<string>();
  readonly history: TurnHistory;
  readonly previews: PreviewManager;
  private runners = new Map<string, SessionRunner>();
  private projectListeners = new Set<(projects: Project[]) => void>();
  private automaticEnabled = false;
  private automaticTimer?: ReturnType<typeof setTimeout>;
  private automaticTimerAt?: number;
  private automaticDeferrals = new Map<string, number>();


  constructor(public db: Db, public events: EventStore) {
    this.history = new TurnHistory(db);
    this.previews = new PreviewManager(db, (preview) => {
      this.events.append(preview.sessionId, 'message', 'lina', { id: rid(), kind: 'notice', text: `Preview ${preview.id}: ${preview.status} · ${preview.url}${preview.error ? ` · ${preview.error}` : ''}` });
    });
    this.recover();
  }

  // ── startup / shutdown ────────────────────────────────────────────────

  /** Sessions left 'running' by a crash become 'interrupted' (resumable). */
  private recover(): void {
    for (const s of this.db.listSessions()) {
      if (s.status !== 'running') continue;
      const r = this.runner(s.id);
      r.session.status = 'interrupted';
      r.session.phase = 'interrupted';
      this.events.append(s.id, 'phase', 'lina', { phase: 'interrupted', round: r.state.round });
      this.events.append(s.id, 'message', 'lina', { id: rid(), text: r.state.limitRetryPending && !r.state.automaticDisabled ? 'LINA restarted during automatic work. Continuation is scheduled automatically.' : 'LINA restarted while this session was running. Resume to continue from the last step.', kind: 'notice' });
      r.persist();
      log.info(`recovered session ${s.id} as interrupted`);
    }
  }

  /** One-shot durable quota/review schedules, activated after server startup. */
  startAutomatic(): void {
    this.automaticEnabled = true;
    for (const session of this.db.listSessions()) {
      const state = this.db.getSessionState<RunnerState>(session.id);
      if (state?.limitRetryPending || state?.deferredReview || (state?.providerLimits && ['failed','completed'].includes(session.status)) || (state?.selfReviewed && state.lastWriters?.main && session.status === 'completed')) this.runner(session.id);
    }
    this.armAutomatic();
  }

  stopAutomatic(): void {
    this.automaticEnabled = false;
    if (this.automaticTimer) clearTimeout(this.automaticTimer);
    this.automaticTimer = undefined; this.automaticTimerAt = undefined;
  }

  private armAutomatic(): void {
    if (!this.automaticEnabled) return;
    let earliest = Infinity;
    for (const runner of this.runners.values()) {
      const at = runner.automaticAt;
      if (at !== undefined) earliest = Math.min(earliest, Math.max(at, this.automaticDeferrals.get(runner.id) ?? 0));
    }
    if (!Number.isFinite(earliest)) { if (this.automaticTimer) clearTimeout(this.automaticTimer); this.automaticTimer = undefined; this.automaticTimerAt = undefined; return; }
    if (this.automaticTimer && this.automaticTimerAt === earliest) return;
    if (this.automaticTimer) clearTimeout(this.automaticTimer);
    this.automaticTimerAt = earliest;
    this.automaticTimer = setTimeout(() => {
      this.automaticTimer = undefined; this.automaticTimerAt = undefined;
      if (!this.automaticEnabled) return;
      const now = Date.now();
      for (const runner of this.runners.values()) {
        const at = runner.automaticAt;
        if (at === undefined || Math.max(at, this.automaticDeferrals.get(runner.id) ?? 0) > now) continue;
        try { runner.startAutomatic(now); this.automaticDeferrals.delete(runner.id); }
        catch (error) {
          if (error instanceof LinaError && error.code === 'busy') this.automaticDeferrals.set(runner.id, now + 5000);
          else runner.suspendAutomatic((error as Error).message);
        }
      }
      this.armAutomatic();
    }, Math.min(60_000, Math.max(50, earliest - Date.now())));
    this.automaticTimer.unref();
  }

  async shutdown(): Promise<void> {
    this.stopAutomatic();
    this.previews.close();
    await Promise.all([...this.runners.values()].map((r) => r.shutdown().catch(() => {})));
  }

  // ── settings ──────────────────────────────────────────────────────────

  settings(): Settings { return getSettings(this.db); }
  putSettings(patch: Partial<Settings>): Settings { return putSettings(this.db, patch); }

  // ── projects ──────────────────────────────────────────────────────────

  onProjectsChanged(fn: (projects: Project[]) => void): () => void {
    this.projectListeners.add(fn);
    return () => { this.projectListeners.delete(fn); };
  }
  private projectsChanged(): void {
    const list = this.db.listProjects();
    for (const fn of this.projectListeners) { try { fn(list); } catch { /* ignore */ } }
  }

  listProjects(): Project[] { return this.db.listProjects(); }

  getProject(id: string): Project {
    const p = this.db.getProject(id);
    if (!p) throw new LinaError(`Unknown project: ${id}`, 'not_found', 404);
    return p;
  }

  async addProject(body: { path: string; name?: string; create?: boolean; initGit?: boolean }): Promise<Project> {
    if (!body || typeof body.path !== 'string' || !body.path.trim()) throw new LinaError('path is required', 'invalid');
    let p = body.path.trim();
    if (p === '~' || p.startsWith('~/')) p = join(homedir(), p.slice(1));
    if (!isAbsolute(p)) throw new LinaError('path must be absolute', 'invalid');
    const repo = await git.ensureRepo(resolve(p), { initGit: !!body.initGit, create: !!body.create });
    const existing = this.db.getProjectByPath(repo.path);
    if (existing) return existing;
    const s = this.settings();
    const now = Date.now();
    const project: Project = {
      id: 'p' + rid(9), name: (typeof body.name === 'string' && body.name.trim()) || basename(repo.path) || repo.path,
      path: repo.path, createdAt: now, updatedAt: now,
      settings: { network: false, maxRounds: s.maxRounds, defaultMode: s.defaultMode },
    };
    this.db.upsertProject(project);
    log.info(`project added ${project.id} ${project.path}${repo.initialized ? ' (git init)' : ''}${repo.initialCommit ? ' (initial commit created)' : ''}`);
    this.projectsChanged();
    return project;
  }

  updateProject(id: string, body: { name?: string; settings?: Partial<ProjectSettings> }): Project {
    const p = this.getProject(id);
    if (body?.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim()) throw new LinaError('name must be a non-empty string', 'invalid');
      p.name = body.name.trim();
    }
    const ps = body?.settings;
    if (ps) {
      if (ps.testCommand !== undefined) {
        if (ps.testCommand === null) delete p.settings.testCommand;
        else if (typeof ps.testCommand !== 'string') throw new LinaError('testCommand must be a string', 'invalid');
        else p.settings.testCommand = ps.testCommand;
      }
      if (ps.network !== undefined) p.settings.network = !!ps.network;
      if (ps.maxRounds !== undefined) p.settings.maxRounds = intIn(ps.maxRounds, 1, 20, 'maxRounds');
      if (ps.defaultMode !== undefined) {
        if (!IMPLEMENTED_MODES.includes(ps.defaultMode)) throw new LinaError(`Mode not implemented: ${ps.defaultMode}`, 'invalid');
        p.settings.defaultMode = ps.defaultMode;
      }
    }
    p.updatedAt = Date.now();
    this.db.upsertProject(p);
    this.projectsChanged();
    return p;
  }

  /** Removes the project from LINA only (never touches its files). Refuses while it has sessions. */
  removeProject(id: string): void {
    this.getProject(id);
    const sessions = this.db.listSessions({ projectId: id });
    if (sessions.length) {
      throw new LinaError(`Project has ${sessions.length} session(s)`, 'has_sessions', 409, 'Delete its sessions first (this removes their LINA workspaces, never your files).');
    }
    this.db.deleteProject(id);
    this.projectsChanged();
  }

  async projectTree(id: string): Promise<TreeEntry[]> {
    return git.projectTree(this.getProject(id).path);
  }

  // ── sessions ──────────────────────────────────────────────────────────

  private runner(id: string): SessionRunner {
    let r = this.runners.get(id);
    if (r) return r;
    const s = this.db.getSession(id);
    if (!s) throw new LinaError(`Unknown session: ${id}`, 'not_found', 404);
    const state = migrateState(this.db.getSessionState<unknown>(id));
    r = new SessionRunner(s, state, {
      db: this.db,
      events: this.events,
      project: () => this.getProject(s.projectId),
      settings: () => this.settings(),
      save: (session, st) => this.save(session, st),
      history: this.history,
      onIdle: () => {
        for (const id of this.automaticDeferrals.keys()) if (this.runners.get(id)?.session.workspacePath === s.workspacePath) this.automaticDeferrals.delete(id);
        this.armAutomatic();
      },
      assertCanStart: () => {
        let directory = false;
        try { directory = statSync(s.workspacePath).isDirectory(); } catch { /* handled below */ }
        if (!directory) throw new LinaError(`Workspace is missing or is not a directory: ${s.workspacePath}`, 'workspace_missing', 409,
          'Restore that directory or start a session in the actual project path. Session history is preserved.');
        if (s.config.workspaceMode !== 'direct') return;
        if (this.editing.has(s.workspacePath)) throw new LinaError('Project files are being restored', 'busy', 409);
        for (const other of this.runners.values()) {
          if (other.id !== s.id && other.busy && other.session.workspacePath === s.workspacePath) {
            throw new LinaError('Another session is working in this project', 'busy', 409, 'Wait for it to finish or pause it before starting another task.');
          }
        }
      },
    });
    this.runners.set(id, r);
    this.armAutomatic();
    return r;
  }

  private save(session: Session, state: RunnerState): void {
    this.db.updateSession(session, state);
    session.lastSeq = this.db.lastSeq(session.id);
    this.events.sessionUpdated({ ...session });
    this.armAutomatic();
  }

  listSessions(f: { projectId?: string; q?: string } = {}): Session[] {
    return this.db.listSessions(f).map((s) => {
      const r = this.runners.get(s.id);
      return r ? { ...r.session, lastSeq: s.lastSeq } : s;
    });
  }

  getSession(id: string): Session {
    const r = this.runner(id);
    return { ...r.session, lastSeq: this.db.lastSeq(id) };
  }

  private resolveConfig(project: Project, req: Partial<SessionConfig> | undefined, base?: SessionConfig): SessionConfig {
    const s = this.settings();
    const c = req ?? {};
    if (typeof c !== 'object') throw new LinaError('config must be an object', 'invalid');
    const mode = c.mode ?? base?.mode ?? project.settings.defaultMode ?? s.defaultMode;
    if (!IMPLEMENTED_MODES.includes(mode)) throw new LinaError(`Mode not implemented: ${String(mode)}`, 'invalid');
    const workspaceMode = c.workspaceMode ?? (base ? base.workspaceMode ?? 'isolated' : (mode === 'parallel' || mode === 'compete' ? 'isolated' : 'direct'));
    if (!['direct', 'isolated'].includes(workspaceMode)) throw new LinaError('workspaceMode must be direct|isolated', 'invalid');
    if (workspaceMode === 'direct' && (mode === 'parallel' || mode === 'compete')) {
      throw new LinaError(`${mode} mode needs isolated workspaces. Start a new session for that mode.`, 'invalid');
    }
    let developer = c.developer ?? (c.reviewer && isAgentId(c.reviewer) ? otherAgent(c.reviewer) : undefined) ?? base?.developer ?? s.developer;
    if (!isAgentId(developer)) throw new LinaError(`Unknown agent: ${String(developer)}`, 'invalid');
    let reviewer = c.reviewer ?? (c.developer ? otherAgent(developer) : base?.reviewer) ?? otherAgent(developer);
    if (!isAgentId(reviewer)) throw new LinaError(`Unknown agent: ${String(reviewer)}`, 'invalid');
    // Only custom mode may have a self-reviewing developer; leaving custom drops an inherited one.
    if (mode !== 'custom' && reviewer === developer && c.reviewer === undefined) reviewer = otherAgent(developer);
    if (mode !== 'custom' && reviewer === developer) throw new LinaError('developer and reviewer must be different agents', 'invalid');
    let team: TeamConfig | undefined;
    if (mode === 'custom') {
      // Explicit team > the session's team > settings.team > architect-like preset of the resolved roles.
      const explicit = c.team !== undefined && c.team !== null;
      const roleChange = c.developer !== undefined || c.reviewer !== undefined;
      team = validateTeam(explicit ? c.team
        : !roleChange && base?.mode === 'custom' && base.team ? base.team
          : !roleChange && s.team ? s.team
            : { planner: developer, planCritic: reviewer, developer, reviewers: [reviewer] });
      developer = team.developer;
      // config.reviewer = the first reviewer (may be the developer itself), else the other agent.
      reviewer = team.reviewers[0] ?? otherAgent(developer);
    }
    const models = { ...(base?.models ?? s.models), ...(c.models ? validateModels(c.models) : {}) } as SessionConfig['models'];
    for (const a of AGENT_IDS) if (!models[a]?.model) models[a] = s.models[a];
    const cfg: SessionConfig = {
      mode, workspaceMode, developer, reviewer, models,
      maxRounds: c.maxRounds !== undefined ? intIn(c.maxRounds, 1, 20, 'maxRounds') : base?.maxRounds ?? project.settings.maxRounds ?? s.maxRounds,
      network: c.network !== undefined ? !!c.network : base?.network ?? !!project.settings.network,
    };
    const interactionMode = c.interactionMode ?? base?.interactionMode ?? (workspaceMode === 'direct' ? 'chat' : 'workflow');
    if (!['chat', 'workflow'].includes(interactionMode)) throw new LinaError('interactionMode must be chat|workflow', 'invalid');
    if (interactionMode === 'chat' && workspaceMode !== 'direct') throw new LinaError('Conversational chat needs a direct workspace', 'invalid');
    cfg.interactionMode = interactionMode;
    if (team) cfg.team = team;
    const tc = c.testCommand !== undefined ? c.testCommand : base?.testCommand;
    if (tc !== undefined && tc !== null) {
      if (typeof tc !== 'string') throw new LinaError('testCommand must be a string', 'invalid');
      cfg.testCommand = tc;
    }
    const stepMode = c.stepMode ?? base?.stepMode;
    if (stepMode) cfg.stepMode = true;
    const mock = base ? base.mock : (c.mock || mockEnabled());
    if (mock) cfg.mock = true;
    return cfg;
  }

  async createSession(body: { projectId: string; title?: string; config?: Partial<SessionConfig>; prompt?: string }): Promise<Session> {
    if (!body || typeof body.projectId !== 'string') throw new LinaError('projectId is required', 'invalid');
    const project = this.getProject(body.projectId);
    const config = this.resolveConfig(project, body.config);
    if (body.prompt !== undefined && typeof body.prompt !== 'string') throw new LinaError('prompt must be a string', 'invalid');
    const id = rid(10);
    const ws = config.workspaceMode === 'direct' ? await git.directWorkspace(project, id) : await git.createWorkspace(project, id);
    const now = Date.now();
    const title = (typeof body.title === 'string' && body.title.trim()) ? body.title.trim().slice(0, 200) : body.prompt?.trim() ? titleFrom(body.prompt) : DEFAULT_TITLE;
    const session: Session = {
      id, projectId: project.id, title, status: 'idle', phase: 'idle', round: 0, createdAt: now, updatedAt: now, config,
      workspacePath: ws.path, branch: ws.branch, baseCommit: ws.baseCommit,
      usage: {
        codex: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0, turns: 0 },
        claude: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0, turns: 0 },
      },
      lastSeq: 0, pendingMessages: 0,
    };
    if (config.mock) session.mock = true;
    this.db.insertSession(session, initialState());
    if (config.workspaceMode === 'direct') {
      this.events.append(id, 'message', 'lina', {
        id: rid(), kind: 'notice', text: 'Working directly in your project. Edits appear immediately and stay uncommitted. Existing changes are included as context and will be preserved; no merge or approval is required.',
      });
    } else if (ws.projectDirty) {
      this.events.append(id, 'message', 'lina', {
        id: rid(), kind: 'notice',
        text: `Your working tree has uncommitted changes; they are not included. Agents start from HEAD ${ws.baseCommit.slice(0, 8)}.`,
      });
    }
    project.updatedAt = now;
    this.db.upsertProject(project);
    const r = this.runner(id);
    r.persist();
    if (body.prompt?.trim()) await this.sendMessage(id, { text: body.prompt });
    return this.getSession(id);
  }

  updateSession(id: string, body: { title?: string; config?: Partial<SessionConfig> }): Session {
    const r = this.runner(id);
    if (body?.title !== undefined) {
      if (typeof body.title !== 'string' || !body.title.trim()) throw new LinaError('title must be a non-empty string', 'invalid');
    }
    if (body?.config) {
      const project = this.getProject(r.session.projectId);
      if ('mock' in body.config && !!body.config.mock !== !!r.session.config.mock) throw new LinaError('mock cannot be changed after creation', 'invalid');
      const next = this.resolveConfig(project, body.config, r.session.config);
      if (r.busy && (next.mode !== r.session.config.mode || next.developer !== r.session.config.developer || next.reviewer !== r.session.config.reviewer || JSON.stringify(next.team) !== JSON.stringify(r.session.config.team))) {
        throw new LinaError('Wait for the current turn to finish before changing agent roles or team mode', 'busy', 409);
      }
      if (r.busy && next.interactionMode !== r.session.config.interactionMode) throw new LinaError('Wait for the current turn to finish before changing chat/workflow mode', 'busy', 409);
      if (next.workspaceMode !== (r.session.config.workspaceMode ?? 'isolated')) {
        throw new LinaError('Start a new session to change workspace mode', 'bad_state', 409);
      }
      const cur = r.session.config.mode;
      const duo = (m: string) => m === 'parallel' || m === 'compete';
      if (next.mode !== cur && (duo(next.mode) || duo(cur)) && r.state.task) {
        throw new LinaError(`Cannot switch a started session ${duo(cur) ? 'out of' : 'to'} ${duo(cur) ? cur : next.mode} mode`, 'bad_state', 409, 'Start a new session for that mode.');
      }
      r.session.config = next;
    }
    if (body?.title !== undefined) r.session.title = body.title.trim().slice(0, 200);
    r.persist();
    return this.getSession(id);
  }

  /** Deletes the session, its workspace and worktrees; tells subscribers and global watchers (session.deleted). */
  async deleteSession(id: string): Promise<void> {
    const r = this.runner(id);
    if (this.editing.has(r.session.workspacePath)) throw new LinaError('Wait for undo to finish before deleting this session', 'busy', 409);
    await r.cancel();
    await this.previews.remove(id);
    if (r.session.config.workspaceMode === 'direct') await this.history.remove(id, r.session.workspacePath);
    if (r.session.config.workspaceMode === 'direct') {
      if (existsSync(r.session.workspacePath)) await git.gitOk(r.session.workspacePath, ['update-ref', '-d', `refs/lina/baselines/${id}`]);
    } else git.removeWorkspace(id);
    const attDir = resolve(paths.attachmentDir(id));
    if (attDir.startsWith(resolve(paths.attachments) + sep)) rmSync(attDir, { recursive: true, force: true });
    this.db.deleteSession(id);
    this.runners.delete(id);
    this.automaticDeferrals.delete(id);
    this.armAutomatic();
    this.events.emitEphemeral(id, 'session.deleted', 'lina', { sessionId: id });
    this.events.dropSession(id);
  }

  snapshot(id: string, since = 0): SessionSnapshot {
    const r = this.runner(id);
    const session = { ...r.session, lastSeq: this.db.lastSeq(id) };
    const events = since > 0 ? this.db.eventPage(id, since, SNAPSHOT_EVENT_CAP) : this.db.events(id, 0, SNAPSHOT_EVENT_CAP);
    const firstSeq = events[0]?.seq ?? 0;
    const cursor = events.at(-1)?.seq ?? since;
    return {
      session,
      project: this.getProject(session.projectId),
      events,
      live: this.events.liveSnapshot(id),
      findings: r.state.findings,
      history: { firstSeq, cursor, hasEarlier: firstSeq > 1, hasLater: cursor < session.lastSeq },
    };
  }

  eventsSince(id: string, since = 0, limit = SNAPSHOT_EVENT_CAP, before?: number): AnyLinaEvent[] {
    this.runner(id);
    return this.db.eventPage(id, since, limit, before);
  }

  // ── messages ──────────────────────────────────────────────────────────

  async sendMessage(id: string, body: { text: string; attachments?: string[]; interrupt?: boolean }): Promise<{ ok: true; queued: boolean }> {
    const r = this.runner(id);
    if (!body || typeof body.text !== 'string' || !body.text.trim()) throw new LinaError('text is required', 'invalid');
    const raw = body.text.trim();
    const m = /^@(codex|claude)\b[:,]?\s*/i.exec(raw);
    const mention = m ? (m[1].toLowerCase() as AgentId) : undefined;
    const text = m ? raw.slice(m[0].length).trim() || raw : raw;
    const atts: Attachment[] = [];
    for (const aid of body.attachments ?? []) {
      const a = this.db.getAttachment(id, String(aid));
      if (!a) throw new LinaError(`Unknown attachment: ${aid}`, 'invalid');
      atts.push(a);
    }
    const msgId = rid();
    const status = r.session.status;
    const queue = r.busy || ['paused', 'interrupted', 'cancelled', 'failed'].includes(status);
    if (!queue) r.assertAvailable();
    if (r.session.title === DEFAULT_TITLE) r.session.title = titleFrom(text);
    const data = { id: msgId, text: raw, kind: 'chat' as const, ...(atts.length ? { attachments: atts } : {}), ...(mention ? { mention } : {}), ...(queue ? { queued: true } : {}) };
    this.events.append(id, 'message', 'user', data);
    if (queue) {
      r.enqueue({ id: msgId, text, target: mention, attachments: atts.length ? atts : undefined, interrupt: body.interrupt === true });
      if (body.interrupt && r.busy) r.interrupt();
      return { ok: true, queued: true };
    }
    if (mention) r.consult(mention, text, atts);
    else if (r.state.step === 'idle' && !r.state.task) r.startTask(text, atts);
    else r.startRevision(text, atts);
    return { ok: true, queued: false };
  }

  async addAttachment(id: string, name: string, mime: string, body: Readable): Promise<Attachment> {
    this.runner(id);
    const dir = paths.attachmentDir(id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const aid = rid(10);
    const clean = sanitizeFilename(name);
    const file = join(dir, `${aid}-${clean}`);
    let size = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > ATTACHMENT_MAX) cb(new LinaError('Attachment exceeds 20 MB', 'too_large', 413));
        else cb(null, chunk);
      },
    });
    try {
      await pipeline(body, limiter, createWriteStream(file, { mode: 0o600 }));
    } catch (e) {
      rmSync(file, { force: true });
      throw e instanceof LinaError ? e : new LinaError(`Upload failed: ${(e as Error).message}`, 'invalid');
    }
    const a: Attachment = { id: aid, name: clean, size: statSync(file).size, mime: (mime || 'application/octet-stream').split(';')[0].trim(), path: file };
    this.db.insertAttachment(id, a);
    return a;
  }

  // ── control / approval ────────────────────────────────────────────────

  turnChanges(id: string) { this.runner(id); return this.history.list(id).filter((c) => c.status === 'recording' || c.files.length); }
  listPreviews(id: string) { this.runner(id); return this.previews.list(id); }
  startPreview(id: string, body: { command: string; port?: number }) {
    const r = this.runner(id);
    if (this.settings().accessMode !== 'full') throw new LinaError('Managed previews require Full access in Settings', 'restricted_access', 403);
    return this.previews.start(id, r.session.workspacePath, body);
  }
  stopPreview(id: string, preview: string) { this.runner(id); return this.previews.stop(id, preview); }
  previewLogs(id: string, preview: string) { this.runner(id); return this.previews.logs(id, preview); }
  turnDiff(id: string, turn: number) { const r = this.runner(id); return this.history.diff(id, r.session.workspacePath, turn); }
  async undoTurn(id: string, turn?: number) {
    const r = this.runner(id);
    if (r.busy) throw new LinaError('Wait for this turn to finish or cancel it before undoing', 'busy', 409);
    r.assertAvailable();
    if (r.session.config.workspaceMode !== 'direct') throw new LinaError('Per-turn undo is available in direct sessions', 'bad_state', 409);
    this.editing.add(r.session.workspacePath);
    let change;
    try { change = await this.history.undo(id, r.session.workspacePath, turn); }
    finally { this.editing.delete(r.session.workspacePath); }
    this.events.append(id, 'message', 'lina', { id: rid(), kind: 'notice', text: `Undid ${change.agent}'s writing turn ${change.turn}: ${change.files.map((f) => f.path).join(', ')}. Other files and staged changes were kept.` });
    r.invalidateAfterUndo(change.turn);
    return change;
  }

  async control(id: string, action: string): Promise<Session> {
    const r = this.runner(id);
    switch (action) {
      case 'pause': r.pause(); break;
      case 'resume': r.resume(); break;
      case 'retry': r.resume(); break;
      case 'cancel': await r.cancel(); break;
      case 'review': r.extraReview(); break;
      default: throw new LinaError(`Unknown action: ${action}`, 'invalid');
    }
    return this.getSession(id);
  }

  async approval(id: string, body: { decision: string; strategy?: ApplyStrategy; note?: string; findingId?: string; variant?: unknown }): Promise<Session> {
    const r = this.runner(id);
    const note = typeof body?.note === 'string' && body.note.trim() ? body.note.trim() : undefined;
    const variant = body?.variant === undefined || body.variant === null ? undefined : body.variant;
    if (variant !== undefined && !isAgentId(variant)) throw new LinaError(`Unknown variant: ${String(variant)}`, 'invalid');
    switch (body?.decision) {
      case 'approve': {
        const project = this.getProject(r.session.projectId);
        if ([...this.runners.values()].some((other) => other.id !== id && other.busy && other.session.config.workspaceMode === 'direct' && other.session.workspacePath === project.path)) {
          throw new LinaError('Another session is working directly in this project', 'busy', 409, 'Wait for it to finish or pause it before applying changes.');
        }
        const strategy = body.strategy ?? 'squash';
        if (!['squash', 'merge', 'branch'].includes(strategy)) throw new LinaError(`Unknown strategy: ${strategy}`, 'invalid');
        await r.approve(strategy, note, variant);
        break;
      }
      case 'choose':
        if (!variant) throw new LinaError('variant is required (codex or claude)', 'invalid');
        await r.choose(variant, note);
        break;
      case 'reject': r.reject(note); break;
      case 'waive':
        if (!body.findingId) throw new LinaError('findingId is required', 'invalid');
        r.waive(String(body.findingId), note);
        break;
      default: throw new LinaError('decision must be approve|reject|waive|choose', 'invalid');
    }
    return this.getSession(id);
  }

  // ── workspace views ───────────────────────────────────────────────────

  /** The session workspace, or an agent's worktree (?variant=); 404 when the session has no such worktree. */
  private viewWorkspace(r: SessionRunner, variant?: string): string {
    if (variant === undefined) return r.session.workspacePath;
    if (!isAgentId(variant)) throw new LinaError(`Unknown variant: ${variant}`, 'invalid');
    const v = r.session.variants?.[variant];
    if (!v || !existsSync(v.workspacePath)) throw new LinaError(`This session has no ${variant} version`, 'not_found', 404);
    return v.workspacePath;
  }

  async diff(id: string, from?: string, to?: string, variant?: string): Promise<{ base: string; head: string; files: DiffFile[] }> {
    const r = this.runner(id);
    const ws = this.viewWorkspace(r, variant);
    const base = from || r.session.baseCommit;
    const target = to || (r.session.config.workspaceMode === 'direct' ? 'worktree' : 'HEAD');
    if (!/^[\w./~^@{}-]+$/.test(base) || base.startsWith('-') || !/^[\w./~^@{}-]+$/.test(target) || target.startsWith('-')) {
      throw new LinaError('Invalid revision', 'invalid');
    }
    const head = target === 'worktree' ? 'worktree' : (await git.gitOk(ws, ['rev-parse', '--verify', `${target}^{commit}`]).catch(() => { throw new LinaError(`Unknown revision: ${target}`, 'invalid'); })).trim();
    const baseSha = (await git.gitOk(ws, ['rev-parse', '--verify', `${base}^{commit}`]).catch(() => { throw new LinaError(`Unknown revision: ${base}`, 'invalid'); })).trim();
    return { base: baseSha, head, files: await git.diff(ws, baseSha, head) };
  }

  async tree(id: string, variant?: string): Promise<TreeEntry[]> {
    const r = this.runner(id);
    return git.tree(this.viewWorkspace(r, variant), r.session.baseCommit, r.session.config.workspaceMode === 'direct');
  }

  file(id: string, path: string, variant?: string): { path: string; content: string; truncated: boolean; binary: boolean } {
    const r = this.runner(id);
    const ws = this.viewWorkspace(r, variant);
    if (!existsSync(ws)) throw new LinaError('Workspace is missing', 'not_found', 404);
    return git.readFile(ws, path);
  }

  search(q: string): SearchHit[] {
    if (!q?.trim()) return [];
    return this.db.search(q);
  }

  /** Test/diagnostic helper: resolves when the session's runner is idle. */
  async waitIdle(id: string): Promise<void> { await this.runner(id).idle(); }
}

export function sanitizeFilename(name: string): string {
  let n = basename(String(name || 'file').replace(/\\/g, '/'));
  n = n.replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '').trim();
  if (!n) n = 'file';
  return n.slice(0, 100);
}
