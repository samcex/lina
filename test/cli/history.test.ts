import { describe, expect, it } from 'vitest';
import type { AnyLinaEvent, SessionSnapshot } from '../../src/shared/types.js';
import { viewFromSnapshot } from '../../src/shared/reducer.js';
import { TuiStore, type ClientLike } from '../../src/cli/tui/store.js';
import { snapshot } from './fixture.js';

function fixture() {
  const base = snapshot();
  const events: AnyLinaEvent[] = Array.from({ length: 4501 }, (_, i) => ({
    sessionId: base.session.id, seq: i + 1, ts: Date.now() + i, type: 'message', actor: 'user',
    data: { id: `old-${i}`, kind: 'chat', text: `History message ${i + 1}` },
  }));
  const snap: SessionSnapshot = { ...base, session: { ...base.session, status: 'completed', phase: 'completed', lastSeq: events.length }, events: events.slice(-2000) };
  return { snap, events };
}

describe('TUI paged history', () => {
  it('loads an older page and a target beyond the initial 2000 events without rolling back live state', async () => {
    const { snap, events } = fixture();
    const calls: number[] = [];
    const client = { history: async (_id: string, before: number, limit = 500) => {
      calls.push(before); return events.filter((e) => e.seq < before).slice(-limit);
    } } as unknown as ClientLike;
    const view = viewFromSnapshot(snap);
    const store = new TuiStore(client, { view, live: false });
    await store.loadEarlier();
    expect(store.getState().view!.timeline[0].seq).toBe(2002);
    await store.loadEarlier(2);
    expect(store.getState().view!.timeline[0].seq).toBe(2);
    await store.loadEarlier();
    const result = store.getState();
    expect(result.view!.timeline.map((e) => e.seq)).toEqual(events.map((e) => e.seq));
    expect(result.view!.session).toBe(view.session);
    expect(result.view!.lastSeq).toBe(4501);
    expect(result.view!.streams).toBe(view.streams);
    expect(result.view!.findings).toBe(view.findings);
    expect(result.historyLoading).toBe(false);
    expect(calls).toEqual([2502, 2002, 1502, 1002, 502, 2]);
    store.dispose();
  });

  it('ignores a page after leaving and reopening the same session', async () => {
    const { snap, events } = fixture();
    let resolve!: (events: AnyLinaEvent[]) => void;
    const client = { history: () => new Promise<AnyLinaEvent[]>((yes) => { resolve = yes; }), session: async () => ({ ...snap, events: events.slice(-1000) }) } as unknown as ClientLike;
    const store = new TuiStore(client, { view: viewFromSnapshot(snap), live: false });
    const loading = store.loadEarlier();
    store.newDraft();
    await store.openSession(snap.session.id);
    resolve(events.slice(2001, 2501));
    await loading;
    expect(store.getState().view!.timeline[0].seq).toBe(3502);
    expect(store.getState().historyLoading).toBe(false);
    store.dispose();
  });

  it('reports a stalled/failed page and keeps the original transcript and cursor', async () => {
    const { snap } = fixture();
    const view = viewFromSnapshot(snap);
    const store = new TuiStore({ history: async () => [] } as unknown as ClientLike, { view, live: false });
    await store.loadEarlier(2);
    expect(store.getState().view).toBe(view);
    expect(store.getState().historyLoading).toBe(false);
    expect(store.getState().notices.at(-1)?.text).toContain('Could not load earlier history');
    store.dispose();
  });
});
