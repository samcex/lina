import { expect, it, vi } from 'vitest';
import { TuiStore, type ClientLike } from '../../src/cli/tui/store.js';
import type { Project } from '../../src/shared/types.js';
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
