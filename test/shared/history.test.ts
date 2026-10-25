import { describe, expect, it } from 'vitest';
import { prependHistory } from '../../src/shared/history.js';
import { viewFromSnapshot } from '../../src/shared/reducer.js';
import type { AnyLinaEvent } from '../../src/shared/types.js';
import { snapshot } from '../cli/fixture.js';

describe('older history loading', () => {
  it('restores historical messages/tests/activity without rolling back live state or replay cursor', () => {
    const full = snapshot();
    const view = viewFromSnapshot({ ...full, events: full.events.slice(6) });
    const before = { ...view, agents: { ...view.agents, codex: { ...view.agents.codex, status: 'writing' as const, detail: 'Current work', since: Date.now() } }, streams: { live: { agent: 'codex' as const, text: 'Current stream' } } };
    const loaded = prependHistory(before, [...full.events.slice(0, 7), full.events[0]]);
    expect(loaded.timeline.map((e) => e.seq)).toEqual(full.events.map((e) => e.seq));
    expect(loaded.timeline[0].type).toBe('message');
    expect(loaded.tests).toHaveLength(1);
    expect(loaded.agents.codex.activity.some((a) => a.title === 'npm test')).toBe(true);
    expect(loaded.agents.codex.status).toBe('writing');
    expect(loaded.agents.codex.detail).toBe('Current work');
    expect(loaded.streams).toBe(before.streams);
    expect(loaded.session).toBe(before.session);
    expect(loaded.findings).toBe(before.findings);
    expect(loaded.lastSeq).toBe(before.lastSeq);
    expect(loaded.phase).toBe(before.phase);
    expect(loaded.round).toBe(before.round);
    expect(prependHistory(loaded, full.events)).toBe(loaded);
  });
  it('ignores unrelated-session and ephemeral events', () => {
    const full = snapshot();
    const view = viewFromSnapshot({ ...full, events: full.events.slice(3) });
    expect(prependHistory(view, [
      { ...full.events[0], sessionId: 'another-session' },
      { ...full.events[0], seq: 0 },
    ] as AnyLinaEvent[])).toBe(view);
  });
});
