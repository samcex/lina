import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeRepo, setupEnv, waitUntil } from './helpers.js';

const home = setupEnv();
const { startServer } = await import('../../src/server/daemon.js');
const { LinaClient } = await import('../../src/shared/client.js');
const { MockAdapter, mockCalls } = await import('../../src/server/agents/mock.js');
const { setAdapterOverride } = await import('../../src/server/agents/index.js');

let hold = true;
setAdapterOverride((agent) => new MockAdapter(agent, { delayMs: 0, holdMs: hold ? { implement: 60_000 } : {} }));

describe('restart recovery', () => {
  it('graceful shutdown mid-run → interrupted; a new server resumes and completes', async () => {
    const repo = makeRepo();
    let srv = await startServer({ port: 0 });
    let api = new LinaClient({ baseUrl: `http://127.0.0.1:${srv.port}`, token: srv.token });
    const project = await api.addProject({ path: repo });
    const s = await api.createSession({ projectId: project.id, config: { interactionMode: 'workflow', mock: true }, prompt: 'Survive a restart' });
    expect(s.title).toBe('Survive a restart');
    await waitUntil(() => mockCalls.some((c) => c.step === 'implement'), 10_000, 'implement turn');
    const t0 = Date.now();
    await srv.close();
    expect(Date.now() - t0).toBeLessThan(6000);

    hold = false;
    srv = await startServer({ port: 0 });
    api = new LinaClient({ baseUrl: `http://127.0.0.1:${srv.port}`, token: srv.token });
    let snap = await api.session(s.id);
    expect(snap.session.status).toBe('interrupted');
    expect(snap.session.phase).toBe('interrupted');
    expect(snap.events.some((e) => e.type === 'message' && e.data.kind === 'notice' && /Resume/.test(e.data.text))).toBe(true);
    await api.control(s.id, 'resume');
    await waitUntil(async () => (await api.session(s.id)).session.status === 'completed', 20_000, 'completed');
    snap = await api.session(s.id);
    expect(snap.findings.map((f) => f.status)).toEqual(['resolved', 'withdrawn']);
    expect(mockCalls.filter((c) => c.step === 'implement')).toHaveLength(2);
    const seqs = snap.events.map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    await srv.close();

    // crash: a session left 'running' in the db becomes interrupted on startup
    const db = new DatabaseSync(join(home, 'lina.db'));
    db.prepare("UPDATE sessions SET status = 'running', phase = 'reviewing' WHERE id = ?").run(s.id);
    db.close();
    srv = await startServer({ port: 0 });
    api = new LinaClient({ baseUrl: `http://127.0.0.1:${srv.port}`, token: srv.token });
    snap = await api.session(s.id);
    expect(snap.session.status).toBe('interrupted');
    expect(snap.events.filter((e) => e.type === 'message' && e.data.kind === 'notice' && /restarted/.test(e.data.text))).toHaveLength(1);
    await srv.close();
  });
});
