import { describe, expect, it } from 'vitest';
import { initialState, migrateState, providerKey } from '../../src/server/runner.js';

describe('provider-session keys', () => {
  it('are per agent, role and worktree', () => {
    expect(providerKey('codex', 'developer')).toBe('codex:developer@main');
    expect(providerKey('claude', 'reviewer', 'codex')).toBe('claude:reviewer@codex');
  });

  it('migrates v1 state keyed by agent only', () => {
    const v1 = {
      ...initialState(), v: 1, step: 'review',
      providers: { codex: { id: 'thread-1', role: 'developer' }, claude: { id: 'sess-2', role: 'reviewer' } },
      // claude was primed as a developer once, but its session now belongs to the reviewer role
      primed: { codex: 'developer', claude: 'developer' },
    };
    delete (v1 as Record<string, unknown>).done;
    const st = migrateState(v1);
    expect(st.v).toBe(2);
    expect(st.step).toBe('review');
    expect(st.providers).toEqual({ 'codex:developer@main': 'thread-1', 'claude:reviewer@main': 'sess-2' });
    expect(st.primed).toEqual({ 'codex:developer@main': true, 'claude:developer@main': true });
    expect(st.done).toEqual([]);
    // the same state again is a no-op, and garbage is dropped
    expect(migrateState(st)).toEqual(st);
    expect(migrateState({ providers: { codex: 'x', bogus: { id: 1 } }, primed: { nope: 'maybe' } }).providers).toEqual({ codex: 'x' });
    expect(migrateState(undefined)).toEqual(initialState());
  });
});
