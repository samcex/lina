// In-memory stand-in for the LINA daemon. Simulates live streaming so motion can be reviewed.
import type { LiveHandlers } from '@shared/client';
import type { ServerMessage } from '@shared/protocol';
import { AGENT_IDS, AGENT_LABEL, peerOf, type AgentId, type AnyLinaEvent, type Attachment, type EventDataMap, type EventType, type Finding, type Project, type Session, type SessionSnapshot, type Settings } from '@shared/types';
import type { Backend, ClientLike, LiveLike } from '../lib/backend';
import { DIFF, DOCTOR, FILES, MODELS, PROJECTS, SETTINGS, TREE, emptySnapshot, mainFixture, runningFixture, sidebarSessions } from './data';
import { competeFixture, competeWorkspaces, customFixture, customWorkspaces, parallelFixture, parallelWorkspaces, type Workspace, type Workspaces } from './modes';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clone = <T,>(x: T): T => structuredClone(x);

class Err extends Error { constructor(m: string, public status: number, public code?: string, public hint?: string) { super(m); } }

export function createFixtureBackend(): Backend {
  const snaps = new Map<string, SessionSnapshot>([
    ['ses_fixture', mainFixture()], ['ses_running', runningFixture()],
    ['ses_compete', competeFixture()], ['ses_parallel', parallelFixture()], ['ses_custom', customFixture()],
  ]);
  const sessions = new Map<string, Session>(sidebarSessions().map((s) => [s.id, snaps.get(s.id)?.session ?? s]));
  for (const id of ['ses_compete', 'ses_parallel', 'ses_custom']) sessions.set(id, snaps.get(id)!.session);
  // Per-session workspaces: `main` = the session workspace, codex/claude = their worktrees (?variant=).
  const defaultWs: Workspace = { diff: DIFF, tree: TREE, files: FILES };
  const workspaces = new Map<string, Workspaces>([['ses_compete', competeWorkspaces()], ['ses_parallel', parallelWorkspaces()], ['ses_custom', customWorkspaces()]]);
  const wsFor = (sid: string, variant?: AgentId): Workspace => {
    const all = workspaces.get(sid);
    if (!variant) return all?.main ?? defaultWs;
    const w = all?.[variant];
    if (!w) throw new Err(`This session has no ${variant} worktree`, 404, 'not_found');
    return w;
  };
  const projects: Project[] = clone(PROJECTS);
  let settings: Settings = clone(SETTINGS);
  const handlers = new Set<LiveHandlers>();
  const subs = new Set<string>();
  const emit = (m: ServerMessage) => handlers.forEach((h) => h.onMessage(m));

  const push = <T extends EventType>(sid: string, type: T, actor: AnyLinaEvent['actor'], data: EventDataMap[T], ephemeral = false) => {
    const snap = snapFor(sid);
    const seq = ephemeral ? 0 : ++snap.session.lastSeq;
    const e = { sessionId: sid, seq, ts: Date.now(), type, actor, data } as unknown as AnyLinaEvent;
    if (!ephemeral) snap.events.push(e);
    if (subs.has(sid)) emit({ kind: 'event', event: e });
    return e;
  };
  const snapFor = (sid: string): SessionSnapshot => {
    let s = snaps.get(sid);
    if (!s) { const sess = sessions.get(sid); if (!sess) throw new Err('Session not found', 404); s = emptySnapshot(sess); snaps.set(sid, s); }
    return s;
  };
  const emitDeleted = (sid: string) => {
    sessions.delete(sid); snaps.delete(sid); workspaces.delete(sid);
    emit({ kind: 'event', event: { sessionId: sid, seq: 0, ts: Date.now(), type: 'session.deleted', actor: 'lina', data: { sessionId: sid } } as AnyLinaEvent });
  };
  // ?simulateDelete=<id>: pretend another client deletes that session a few seconds after load.
  const simDelete = new URLSearchParams(window.location.search).get('simulateDelete');
  if (simDelete) setTimeout(() => emitDeleted(simDelete), 3500);

  const updateSession = (sid: string, patch: Partial<Session>) => {
    const snap = snapFor(sid);
    snap.session = { ...snap.session, ...patch, updatedAt: Date.now() };
    sessions.set(sid, snap.session);
    push(sid, 'session.updated', 'lina', { session: snap.session });
    if (!subs.has(sid)) emit({ kind: 'event', event: { sessionId: sid, seq: 0, ts: Date.now(), type: 'session.updated', actor: 'lina', data: { session: snap.session } } as AnyLinaEvent });
    return snap.session;
  };

  // Stream a text into the conversation word by word, then persist it as a message.
  const streamText = async (sid: string, agent: AgentId, msgId: string, text: string, prefix = '') => {
    const words = text.split(/(\s+)/);
    let acc = prefix;
    for (let i = 0; i < words.length; i += 2) {
      const delta = words.slice(i, i + 2).join('');
      acc += delta;
      push(sid, 'stream', agent, { msgId, agent, delta }, true);
      await wait(45 + Math.random() * 70);
    }
    push(sid, 'stream.end', agent, { msgId, agent }, true);
    push(sid, 'message', agent, { id: msgId, kind: 'chat', role: snapFor(sid).session.config.developer === agent ? 'developer' : 'reviewer', model: MODELS[agent].defaultModel, text: acc });
  };

  let mainStarted = false;
  const runMain = async () => {
    if (mainStarted) return; mainStarted = true;
    await wait(1600);
    push('ses_fixture', 'agent.status', 'claude', { agent: 'claude', status: 'reading', detail: 'fly.toml', role: 'reviewer' });
    push('ses_fixture', 'activity', 'claude', { agent: 'claude', id: 'q1', kind: 'read', title: 'fly.toml', state: 'running', source: 'observed' });
    await wait(900);
    push('ses_fixture', 'activity', 'claude', { agent: 'claude', id: 'q1', kind: 'read', title: 'fly.toml', state: 'ok', source: 'observed' });
    push('ses_fixture', 'agent.status', 'claude', { agent: 'claude', status: 'writing', role: 'reviewer' });
    const prefix = snaps.get('ses_fixture')!.live.streams.s_claude_1?.text ?? '';
    await streamText('ses_fixture', 'claude', 's_claude_1', "`req.ip` becomes the real client and F2 is resolved without trusting arbitrary `X-Forwarded-For` chains. I'd **waive nothing** — approve with this one line added, or send it back as a revision.", prefix);
    snaps.get('ses_fixture')!.live.streams = {};
    push('ses_fixture', 'agent.status', 'claude', { agent: 'claude', status: 'done', role: 'reviewer' });
  };

  let runStarted = false;
  const runRunning = async () => {
    if (runStarted) return; runStarted = true;
    await wait(2200);
    push('ses_running', 'activity', 'claude', { agent: 'claude', id: 'c3', kind: 'command', title: 'npx tsc --noEmit', state: 'ok', exitCode: 0, output: '', source: 'observed' });
    push('ses_running', 'activity', 'claude', { agent: 'claude', id: 'c4', kind: 'note', title: 'Types are clean; adding contract tests for the legacy schema next.', state: 'ok', source: 'narrated' });
    push('ses_running', 'agent.status', 'claude', { agent: 'claude', status: 'writing', role: 'developer' });
    await streamText('ses_running', 'claude', 'r_stream', "The adapter now normalizes `invoice.paid` (v2) and `invoice.payment_succeeded` (legacy) into one shape:\n\n```ts\nexport function normalize(evt: StripeEvent): BillingEvent {\n  switch (evt.type) {\n    case 'invoice.paid':\n    case 'invoice.payment_succeeded':\n      return { kind: 'paid', invoiceId: evt.data.object.id };\n    default:\n      return { kind: 'ignored' };\n  }\n}\n```\n\nNext: contract tests.");
    push('ses_running', 'agent.status', 'claude', { agent: 'claude', status: 'testing', role: 'developer' });
  };

  let parStarted = false;
  const runParallel = async () => {
    if (parStarted) return; parStarted = true;
    const steps: [AgentId, string, 'read' | 'command' | 'search', string?][] = [
      ['claude', 'pr1', 'command', 'npx vitest run test/seats.api.test.ts'], ['codex', 'pc1', 'read', 'src/components/Dialog.tsx'],
      ['claude', 'pr2', 'search', 'rg -n "last_admin" src'], ['codex', 'pc2', 'command', 'git diff 2d7e19b..a83c5f2 -- src/components'],
      ['claude', 'pr3', 'read', 'src/db/migrations/014_seats.sql'], ['codex', 'pc3', 'read', 'src/pages/settings/Seats.tsx'],
    ];
    for (const [agent, id, kind, title] of steps) {
      await wait(2600 + Math.random() * 1400);
      if (!snaps.has('ses_parallel')) return;
      push('ses_parallel', 'agent.status', agent, { agent, status: kind === 'command' ? 'running' : 'reading', detail: title, role: 'reviewer' });
      push('ses_parallel', 'activity', agent, { agent, id, kind, title: title!, state: 'running', source: 'observed' });
      await wait(900);
      push('ses_parallel', 'activity', agent, { agent, id, kind, title: title!, state: 'ok', exitCode: kind === 'command' ? 0 : undefined, source: 'observed' });
      push('ses_parallel', 'agent.status', agent, { agent, status: 'reviewing', detail: title, role: 'reviewer' });
    }
  };

  // compete: a request-changes message makes both candidates revise at once, each in its own worktree.
  const reviseBoth = async (sid: string) => {
    const round = snapFor(sid).session.round;
    push(sid, 'phase', 'lina', { phase: 'revising', round, note: 'both candidates' });
    updateSession(sid, { status: 'running', phase: 'revising' });
    for (const a of ['codex', 'claude'] as AgentId[]) {
      push(sid, 'turn', a, { agent: a, state: 'start', role: 'developer', phase: 'revising', model: MODELS[a].defaultModel, variant: a });
      push(sid, 'agent.status', a, { agent: a, status: 'thinking', role: 'developer' });
    }
    await wait(1500);
    push(sid, 'agent.status', 'codex', { agent: 'codex', status: 'writing', detail: 'src/lib/csv.ts', role: 'developer' });
    push(sid, 'activity', 'codex', { agent: 'codex', id: `rv${Date.now()}`, kind: 'edit', title: 'src/lib/csv.ts', state: 'running', source: 'observed' });
    await wait(900);
    push(sid, 'agent.status', 'claude', { agent: 'claude', status: 'running', detail: 'npx vitest run test/csv.test.ts', role: 'developer' });
    push(sid, 'activity', 'claude', { agent: 'claude', id: `rv${Date.now()}`, kind: 'command', title: 'npx vitest run test/csv.test.ts', state: 'running', source: 'observed' });
  };

  const live = (h: LiveHandlers): LiveLike => {
    handlers.add(h);
    setTimeout(() => { h.onStatus?.('open'); h.onMessage({ kind: 'hello', version: '0.1.0', serverTime: Date.now() }); }, 120);
    return {
      subscribe(sid: string) {
        subs.add(sid);
        setTimeout(() => {
          try { h.onMessage({ kind: 'snapshot', sessionId: sid, snapshot: clone(snapFor(sid)) }); } catch (e) { h.onMessage({ kind: 'error', message: (e as Error).message }); }
          if (sid === 'ses_fixture') void runMain();
          if (sid === 'ses_running') void runRunning();
          if (sid === 'ses_parallel') void runParallel();
        }, 380);
      },
      unsubscribe(sid: string) { subs.delete(sid); },
      watchAll() { /* session.updated events are always delivered in fixture mode */ },
      close() { handlers.delete(h); },
    };
  };

  const client: ClientLike = {
    async turnChanges() { return []; },
    async previews() { return []; },
    async startPreview() { throw new Err('Preview processes are unavailable in fixture mode', 400, 'invalid'); },
    async stopPreview() { throw new Err('No fixture preview', 404, 'not_found'); },
    async previewLogs() { return { output: '' }; },
    async turnDiff() { throw new Err('No recorded writing turns in this fixture', 404, 'not_found'); },
    async undo() { throw new Err('No recorded writing turns in this fixture', 404, 'not_found'); },
    async health() { return { ok: true, version: '0.1.0', pid: 4242, uptimeMs: 3_600_000, serverId: 'fixture-server' }; },
    async connection() { return { version: 1 as const, serverId: 'fixture-server', token: '' }; },
    async home() { return { enabled: false, active: false, addresses: [] }; },
    async putHome() { throw new Err('Home access is unavailable in fixture mode', 400, 'invalid'); },
    async getSettings() { return clone(settings); },
    async putSettings(s) { settings = { ...settings, ...s }; return clone(settings); },
    async doctor() { await wait(700); return { checks: clone(DOCTOR) }; },
    async models(refresh) { await wait(refresh ? 900 : 200); return clone(MODELS); },
    async validateModel(agent, model) {
      await wait(1400);
      if (/^(gpt|claude|opus|sonnet)/.test(model)) return { ok: true, checkedAt: Date.now(), resolvedModel: model === 'opus' ? 'claude-opus-5-5' : model === 'sonnet' ? 'claude-sonnet-5-5' : model };
      return { ok: false, checkedAt: Date.now(), code: 'model_unavailable', error: `${AGENT_LABEL[agent]}: model "${model}" not found or not allowed for this account` };
    },
    async projects() { return clone(projects); },
    async addProject(b) {
      await wait(500);
      if (!b.initGit && /new|tmp|scratch/.test(b.path)) throw new Err('Directory is not a git repository', 400, 'not_git', 'Pass initGit to run git init');
      const p: Project = { id: `prj_${Math.random().toString(36).slice(2, 8)}`, name: b.name || b.path.split('/').filter(Boolean).pop() || 'project', path: b.path, createdAt: Date.now(), updatedAt: Date.now(), settings: { network: false, maxRounds: 3, defaultMode: 'pair' } };
      projects.push(p); emit({ kind: 'projects', projects: clone(projects) });
      return p;
    },
    async updateProject(id, b) { const p = projects.find((x) => x.id === id)!; Object.assign(p, b.name ? { name: b.name } : {}, b.settings ? { settings: { ...p.settings, ...b.settings } } : {}); return clone(p); },
    async removeProject() { return { ok: true }; },
    async projectTree() { return clone(TREE); },
    async sessions() { return [...sessions.values()].map(clone); },
    async createSession(b) {
      await wait(400);
      const base = sidebarSessions()[5];
      const s: Session = { ...base, id: `ses_${Math.random().toString(36).slice(2, 10)}`, projectId: b.projectId, title: b.title || (b.prompt ? b.prompt.slice(0, 48) : 'New session'), createdAt: Date.now(), updatedAt: Date.now(), config: { ...base.config, ...b.config, models: { ...base.config.models, ...(b.config?.models ?? {}) } } };
      sessions.set(s.id, s);
      snaps.set(s.id, emptySnapshot(s));
      if (b.prompt) setTimeout(() => { push(s.id, 'message', 'user', { id: 'p0', kind: 'chat', text: b.prompt! }); push(s.id, 'phase', 'lina', { phase: 'planning', round: 0 }); updateSession(s.id, { status: 'running', phase: 'planning' }); }, 600);
      return s;
    },
    async session(id) { await wait(150); return clone(snapFor(id)); },
    async events(id, since = 0) { return clone(snapFor(id).events.filter((e) => e.seq > since)); },
    async history(id, before, limit = 500) { return clone(snapFor(id).events.filter((e) => e.seq < before).slice(-limit)); },
    async updateSession(id, b) { await wait(250); const cur = snapFor(id).session; return clone(updateSession(id, { ...(b.title ? { title: b.title } : {}), ...(b.config ? { config: { ...cur.config, ...b.config } } : {}) })); },
    async deleteSession(id) { await wait(200); if (!sessions.has(id)) throw new Err('Session not found', 404); emitDeleted(id); return { ok: true }; },
    async send(id, text, opts = {}) {
      await wait(250);
      const s = snapFor(id).session;
      const queued = s.status === 'running' && !opts.interrupt;
      const mention = text.match(new RegExp(`^@(${AGENT_IDS.join('|')})\\b`))?.[1] as AgentId | undefined;
      push(id, 'message', 'user', { id: `u${Date.now()}`, kind: 'chat', text, queued, mention });
      if (!queued && !mention && s.config.mode === 'compete' && !s.chosenVariant && s.status === 'awaiting_approval') {
        setTimeout(() => void reviseBoth(id), 300);
      } else if (!queued) {
        const agent = mention ?? s.config.developer;
        setTimeout(() => void (async () => {
          push(id, 'agent.status', agent, { agent, status: 'thinking' });
          await wait(900);
          push(id, 'agent.status', agent, { agent, status: 'writing' });
          await streamText(id, agent, `x${Date.now()}`, `On it. (Fixture mode — this reply is simulated.) You said: _${text.slice(0, 80)}_`);
          push(id, 'agent.status', agent, { agent, status: 'idle' });
        })(), 300);
      }
      return { ok: true, queued };
    },
    async upload(_id, name, mime, bytes) { await wait(600); const a: Attachment = { id: `att_${Math.random().toString(36).slice(2, 8)}`, name, mime, size: bytes instanceof Blob ? bytes.size : bytes.byteLength, path: `/home/sam/.lina/attachments/${name}` }; return a; },
    async control(id, action) {
      await wait(250);
      const map: Record<string, Partial<Session>> = { pause: { status: 'paused' }, resume: { status: 'running' }, cancel: { status: 'cancelled', phase: 'cancelled' }, retry: { status: 'running' }, review: { status: 'running', phase: 'reviewing' } };
      return clone(updateSession(id, map[action]));
    },
    async approval(id, b) {
      await wait(700);
      const cur = snapFor(id).session;
      const competing = cur.config.mode === 'compete' && !cur.chosenVariant;
      const choose = (v: AgentId) => {
        const snap = snapFor(id);
        if (!snap.session.variants?.[v]) throw new Err(`No candidate from ${v}`, 400, 'invalid');
        const rival: AgentId = peerOf(v);
        snap.findings = snap.findings.filter((f: Finding) => f.variant !== rival);
        const w = workspaces.get(id);
        if (w?.[v]) w.main = w[v]!;
        push(id, 'findings', 'user', { findings: snap.findings });
        push(id, 'message', 'lina', { id: `ch${Date.now()}`, kind: 'notice', text: `You chose **${AGENT_LABEL[v]}'s version**. Its commits are now the session branch; ${AGENT_LABEL[rival]}'s findings were dropped. ${AGENT_LABEL[rival]} reviews from here.` });
        return updateSession(id, { chosenVariant: v, headCommit: snap.session.variants[v]!.headCommit, config: { ...snap.session.config, mode: 'pair', developer: v, reviewer: rival } });
      };
      if (b.decision === 'choose') {
        if (!b.variant) throw new Err('choose needs a variant', 400, 'invalid');
        if (cur.config.mode !== 'compete' && !cur.chosenVariant) throw new Err('Only competition sessions have candidates to choose from', 400, 'invalid');
        return clone(choose(b.variant));
      }
      if (b.decision === 'approve' && competing) {
        if (!b.variant) throw new Err('Choose a candidate before approving', 409, 'choose_variant', "Pick Codex's or Claude's version first (or approve with a variant).");
        choose(b.variant);
      }
      if (b.decision === 'waive') {
        const snap = snapFor(id);
        snap.findings = snap.findings.map((f) => (f.id === b.findingId ? { ...f, status: 'waived', history: [...f.history, { round: snap.session.round, actor: 'user', action: 'waived', note: b.note, ts: Date.now() }] } : f));
        push(id, 'findings', 'user', { findings: snap.findings });
        return clone(snap.session);
      }
      if (b.decision === 'approve' && b.strategy === 'merge') throw new Err('Project working tree has uncommitted changes', 409, 'dirty_worktree');
      if (b.decision === 'approve') {
        push(id, 'approval', 'user', { state: 'approved', strategy: b.strategy, note: b.note, variant: b.variant, result: b.strategy === 'branch' ? `Created branch ${cur.branch} in ${snapFor(id).project.path}` : 'Squashed into main as 3e91f0c' });
        push(id, 'phase', 'lina', { phase: 'approved', round: snapFor(id).session.round });
        return clone(updateSession(id, { status: 'approved', phase: 'approved' }));
      }
      push(id, 'approval', 'user', { state: 'rejected', note: b.note });
      push(id, 'phase', 'lina', { phase: 'rejected', round: snapFor(id).session.round });
      return clone(updateSession(id, { status: 'rejected', phase: 'rejected' }));
    },
    async diff(id, q = {}) {
      await wait(300);
      const w = wsFor(id, q.variant);
      const sess = snapFor(id).session;
      const head = q.variant ? sess.variants?.[q.variant]?.headCommit : sess.headCommit;
      let files = w.diff;
      if (id === 'ses_fixture' && q.to === 'a41c9e07b2') files = DIFF.filter((f) => f.path !== 'src/config/limits.ts');
      else if (q.to) {
        // A checkpoint range: only the files that checkpoint touched.
        const ck = snapFor(id).events.find((e) => e.type === 'checkpoint' && e.data.commit === q.to) as Extract<AnyLinaEvent, { type: 'checkpoint' }> | undefined;
        if (ck) files = w.diff.filter((f) => ck.data.files.some((x) => x.path === f.path));
      }
      return { base: q.from ?? sess.baseCommit, head: q.to ?? head ?? sess.baseCommit, files: clone(files) };
    },
    async tree(id, variant) { await wait(200); return clone(wsFor(id, variant).tree); },
    async file(id, path, variant) {
      await wait(150);
      const content = wsFor(id, variant).files[path] ?? `// ${path}\n// (fixture: contents not included)\n`;
      return { path, content, truncated: false, binary: false };
    },
    async search(q) {
      await wait(200);
      const out = [];
      for (const snap of snaps.values()) for (const e of snap.events) {
        if (e.type !== 'message' || !e.data.text.toLowerCase().includes(q.toLowerCase())) continue;
        const i = e.data.text.toLowerCase().indexOf(q.toLowerCase());
        out.push({ sessionId: snap.session.id, projectId: snap.session.projectId, sessionTitle: snap.session.title, seq: e.seq, actor: e.actor, ts: e.ts, snippet: (i > 40 ? '…' : '') + e.data.text.slice(Math.max(0, i - 40), i + 80) + '…' });
      }
      return out.slice(0, 20);
    },
    connect: live,
  };
  return { client, fixture: true };
}
