import { afterAll, describe, expect, it } from 'vitest';
import { makeRepo, setupEnv } from './helpers.js';

setupEnv();
const { startServer } = await import('../../src/server/daemon.js');
const { LinaClient } = await import('../../src/shared/client.js');
const srv = await startServer({ port: 0 });
const baseUrl = `http://127.0.0.1:${srv.port}`;
const headers = { authorization: `Bearer ${srv.token}` };
const api = new LinaClient({ baseUrl, token: srv.token });
afterAll(() => srv.close());

describe('incremental REST snapshots for mobile polling', () => {
  it('returns only events after the cursor while retaining the complete current state', async () => {
    const project = await api.addProject({ path: makeRepo() });
    const session = await api.createSession({ projectId: project.id, config: { mock: true } });
    const cursor = (await api.session(session.id)).session.lastSeq;
    const event = srv.manager.events.append(session.id, 'message', 'user', { id: 'new-message', kind: 'chat', text: 'New since the previous poll' });
    srv.manager.events.emitEphemeral(session.id, 'agent.status', 'codex', { agent: 'codex', status: 'thinking', role: 'developer' });
    srv.manager.events.emitEphemeral(session.id, 'stream', 'codex', { agent: 'codex', msgId: 'active', delta: 'Current streamed answer' });
    const incremental = await (await fetch(`${baseUrl}/api/sessions/${session.id}?since=${cursor}`, { headers })).json();
    expect(incremental.events.map((e: { seq: number }) => e.seq)).toEqual([event.seq]);
    expect(incremental.session.lastSeq).toBe(event.seq);
    expect(incremental.project.id).toBe(project.id);
    expect(incremental.live.agents.codex.status).toBe('thinking');
    expect(incremental.live.streams.active.text).toBe('Current streamed answer');
    const unchanged = await (await fetch(`${baseUrl}/api/sessions/${session.id}?since=${event.seq}`, { headers })).json();
    expect(unchanged.events).toEqual([]);
    expect(unchanged.live.streams.active.text).toBe('Current streamed answer');
    expect((await api.session(session.id)).events.length).toBeGreaterThan(incremental.events.length);
  });
  it('rejects negative, fractional and non-finite cursors', async () => {
    for (const since of ['-1', '0.5', 'Infinity', 'NaN', '9007199254740992']) {
      const res = await fetch(`${baseUrl}/api/sessions/unused?since=${since}`, { headers });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'invalid' });
    }
  });
});
