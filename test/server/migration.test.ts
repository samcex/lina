import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeRepo, setupEnv, waitUntil } from './helpers.js';

const home = setupEnv();
const { startServer } = await import('../../src/server/daemon.js');
const { LinaClient } = await import('../../src/shared/client.js');
const { mockCalls } = await import('../../src/server/agents/mock.js');

describe('provider-session migration', () => {
  it('a session persisted with v1 state (keyed by agent) resumes the right provider sessions after a restart', async () => {
    let srv = await startServer({ port: 0 });
    let api = new LinaClient({ baseUrl: `http://127.0.0.1:${srv.port}`, token: srv.token });
    const project = await api.addProject({ path: makeRepo() });
    const s = await api.createSession({ projectId: project.id, config: { workspaceMode: 'isolated', mock: true }, prompt: 'First task' });
    await waitUntil(async () => (await api.session(s.id)).session.status === 'awaiting_approval', 20_000, 'approval');
    await srv.close();

    // rewrite the persisted state the way v1 stored it
    const db = new DatabaseSync(join(home, 'lina.db'));
    const row = db.prepare('SELECT state FROM sessions WHERE id = ?').get(s.id) as { state: string };
    const st = JSON.parse(row.state);
    st.v = 1;
    st.providers = { codex: { id: 'old-codex-thread', role: 'developer' }, claude: { id: 'old-claude-session', role: 'reviewer' } };
    st.primed = { codex: 'developer', claude: 'reviewer' };
    delete st.done;
    db.prepare('UPDATE sessions SET state = ? WHERE id = ?').run(JSON.stringify(st), s.id);
    db.close();

    srv = await startServer({ port: 0 });
    api = new LinaClient({ baseUrl: `http://127.0.0.1:${srv.port}`, token: srv.token });
    const before = mockCalls.length;
    await api.send(s.id, 'Also add a NOTES.md entry');
    await waitUntil(async () => mockCalls.length > before && (await api.session(s.id)).session.status === 'awaiting_approval', 20_000, 'revision');
    const calls = mockCalls.slice(before);
    const impl = calls.find((c) => c.step === 'implement')!;
    expect(impl.opts.resumeId).toBe('old-codex-thread');
    expect(impl.prompt).not.toContain('Request from the project owner'); // still primed
    expect(calls.find((c) => c.step === 'review')!.opts.resumeId).toBe('old-claude-session');
    const migrated = srv.manager.db.getSessionState<{ v: number; providers: Record<string, string> }>(s.id)!;
    expect(migrated.v).toBe(2);
    expect(migrated.providers).toEqual({ 'codex:developer@main': 'old-codex-thread', 'claude:reviewer@main': 'old-claude-session' });
    await srv.close();
  });
});
