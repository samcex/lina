import { expect, it, vi } from 'vitest';
import { TuiStore, type ClientLike } from '../../src/cli/tui/store.js';
import type { Project } from '../../src/shared/types.js';
import { viewFromSnapshot } from '../../src/shared/reducer.js';
import { snapshot, project } from './fixture.js';
it('does not start work when the running daemon cannot persist goals', async () => {
  const createSession = vi.fn(async (_body: unknown) => ({ id: 'old-daemon-session', config: {} }));
  const send = vi.fn();
  const client = { createSession, send } as unknown as ClientLike;
  const store = new TuiStore(client, { live: false, project: { id: 'project' } as Project });
  await store.goal('Build hello');
  expect(createSession.mock.calls[0]?.[0]).toMatchObject({ config: { goal: 'Build hello' } });
  expect(createSession.mock.calls[0]?.[0]).not.toHaveProperty('prompt');
  expect(send).not.toHaveBeenCalled();
  expect(JSON.stringify(store.getState().notices)).toContain('daemon does not support goals');
  store.dispose();
});

function savedGoal(status: 'paused' | 'completed' | 'running' = 'paused') {
  const snap = snapshot();
  snap.session = { ...snap.session, status, config: { ...snap.session.config, goal: 'Build hello' }, goalStatus: status === 'completed' ? 'complete' : 'working', retryAt: null };
  const control = vi.fn(async () => ({ ...snap.session, status: 'running' as const }));
  const createSession = vi.fn();
  const client = { session: vi.fn(async () => snap), sessions: vi.fn(async () => [snap.session]), control, createSession } as unknown as ClientLike;
  return { snap, client, control, createSession };
}
it.each(['resume', 'pause', 'cancel'] as const)('/goal %s controls the saved goal instead of creating a new objective', async command => {
  const f = savedGoal();
  const store = new TuiStore(f.client, { live: false, view: viewFromSnapshot(f.snap) });
  try {
    await store.goal(command);
    expect(f.control).toHaveBeenCalledWith(f.snap.session.id, command);
    expect(f.createSession).not.toHaveBeenCalled();
  } finally { store.dispose(); }
});
it('reopens the latest real goal in this project, skipping legacy control-word goals and other projects', async () => {
  const f = savedGoal();
  f.client.sessions = vi.fn(async () => [
    { ...f.snap.session, id: 'other-project', projectId: 'other', updatedAt: Date.now() },
    { ...f.snap.session, id: 'legacy', config: { ...f.snap.session.config, goal: 'resume' }, updatedAt: Date.now() },
    f.snap.session,
  ]);
  const store = new TuiStore(f.client, { live: false, project });
  try {
    await store.goal('resume');
    expect(f.client.sessions).toHaveBeenCalledWith({ projectId: project.id });
    expect(f.control).toHaveBeenCalledWith(f.snap.session.id, 'resume');
    expect(f.createSession).not.toHaveBeenCalled();
  } finally { store.dispose(); }
});
it.each(['completed', 'running'] as const)('does not restart an already %s goal', async status => {
  const f = savedGoal(status);
  const store = new TuiStore(f.client, { live: false, view: viewFromSnapshot(f.snap) });
  try {
    await store.goal('resume');
    expect(f.control).not.toHaveBeenCalled();
    expect(f.createSession).not.toHaveBeenCalled();
    expect(JSON.stringify(store.getState().notices)).toContain(status === 'completed' ? 'already complete' : 'already running');
  } finally { store.dispose(); }
});
it('shows /goal status without creating another goal', async () => {
  const f = savedGoal();
  const store = new TuiStore(f.client, { live: false, view: viewFromSnapshot(f.snap) });
  try {
    await store.goal('status');
    expect(f.createSession).not.toHaveBeenCalled();
    expect(JSON.stringify(store.getState().notices)).toContain('Goal: Build hello');
  } finally { store.dispose(); }
});
