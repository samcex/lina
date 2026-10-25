import { describe, expect, it } from 'vitest';
import { ArgError, parseArgs, parseSettingValue, validateCommand } from '../../src/cli/args.js';
import { formatTeamSpec, parseTeamSpec, roleTags, teamSummary, validateTeam } from '../../src/cli/team.js';
import { configFromFlags } from '../../src/cli/util.js';
import { DEFAULT_SETTINGS } from '../../src/shared/types.js';

const p = (s: string[]) => { const a = parseArgs(s); validateCommand(a); return a; };
const argErr = (fn: () => unknown): ArgError => {
  try { fn(); } catch (e) { expect(e).toBeInstanceOf(ArgError); return e as ArgError; }
  throw new Error('expected an ArgError');
};

describe('--mode', () => {
  it('accepts all six modes', () => {
    for (const m of ['pair', 'architect', 'solo', 'parallel', 'compete', 'custom']) expect(p(['--mode', m, 'Do it']).global.mode).toBe(m);
  });
  it('rejects unknown modes with a suggestion', () => {
    const e = argErr(() => parseArgs(['--mode', 'competition']));
    expect(e.message).toContain('Invalid value for --mode');
    expect(e.hint).toContain('parallel, compete, custom');
    expect(argErr(() => parseArgs(['--mode', 'paralel'])).hint).toContain('did you mean "parallel"');
  });
});

describe('--team', () => {
  it('parses the compact spec into a TeamConfig and implies custom mode', () => {
    const a = p(['Build it', '--team', 'plan=claude,critic=codex,dev=claude,review=codex+claude']);
    expect(a.global.team).toEqual({ planner: 'claude', planCritic: 'codex', developer: 'claude', reviewers: ['codex', 'claude'] });
    expect(a.global.mode).toBe('custom');
    expect(a.positionals).toEqual(['Build it']);
    expect(p(['--mode', 'custom', '--team=dev=codex,plan=none,critic=none,review=']).global.team).toEqual({ planner: null, planCritic: null, developer: 'codex', reviewers: [] });
  });
  it('fills omitted roles like the daemon default (dev plans, the other critiques and reviews)', () => {
    expect(parseTeamSpec('dev=claude')).toEqual({ ok: true, team: { planner: 'claude', planCritic: 'codex', developer: 'claude', reviewers: ['codex'] } });
    expect(parseTeamSpec('review=none critic=none')).toEqual({ ok: true, team: { planner: 'codex', planCritic: null, developer: 'codex', reviewers: [] } });
    expect(parseTeamSpec('developer=codex reviewers=codex')).toEqual({ ok: true, team: { planner: 'codex', planCritic: 'claude', developer: 'codex', reviewers: ['codex'] } });
  });
  it('gives friendly errors', () => {
    const cases: [string, RegExp, RegExp?][] = [
      ['dev=none', /cannot be none/],
      ['dev=gemini', /Unknown agent "gemini" for dev=/],
      ['plan=cluade', /Unknown agent "cluade" for plan=/, /did you mean "claude"/],
      ['reveiw=codex', /Unknown team role "reveiw"/, /did you mean "review"/],
      ['dev=codex,dev=claude', /given twice/],
      ['review=claude+claude', /listed twice/],
      ['review=codex+claude+codex', /listed twice/],
      ['codex', /not key=value/],
      ['', /Empty team spec/],
    ];
    for (const [spec, msg, hint] of cases) {
      const r = parseTeamSpec(spec);
      expect(r.ok, spec).toBe(false);
      if (r.ok) continue;
      expect(r.message).toMatch(msg);
      if (hint) expect(r.hint).toMatch(hint);
    }
    const e = argErr(() => parseArgs(['--team', 'dev=gemini']));
    expect(e.message).toContain('Invalid value for --team');
    expect(e.hint).toContain('codex, claude');
  });
  it('conflicts with a non-custom --mode or a different --developer', () => {
    expect(argErr(() => parseArgs(['--mode', 'pair', '--team', 'dev=codex'])).message).toMatch(/only applies to --mode custom/);
    expect(argErr(() => parseArgs(['--developer', 'claude', '--team', 'dev=codex'])).message).toMatch(/conflicts with dev=codex/);
    expect(p(['--developer', 'codex', '--team', 'dev=codex']).global.developer).toBe('codex');
  });
  it('round-trips and summarizes', () => {
    const t = { planner: 'claude', planCritic: null, developer: 'codex', reviewers: ['claude', 'codex'] } as const;
    const spec = formatTeamSpec({ ...t, reviewers: [...t.reviewers] });
    expect(spec).toBe('plan=claude,critic=none,dev=codex,review=claude+codex');
    expect(parseTeamSpec(spec)).toEqual({ ok: true, team: { ...t, reviewers: ['claude', 'codex'] } });
    expect(teamSummary({ ...t, reviewers: [...t.reviewers] })).toBe('Claude plans · Codex builds · Claude + Codex review');
    expect(validateTeam({ planner: null, planCritic: null, developer: 'codex', reviewers: ['codex', 'claude', 'codex'] as never })).toMatchObject({ message: 'At most two reviewers' });
  });
  it('role tags for the header', () => {
    const team = { planner: 'claude', planCritic: 'codex', developer: 'claude', reviewers: ['codex', 'claude'] } as const;
    const cfg = { mode: 'custom' as const, developer: 'claude' as const, reviewer: 'codex' as const, team: { ...team, reviewers: [...team.reviewers] } };
    expect(roleTags('claude', cfg)).toBe('plan+dev+rev');
    expect(roleTags('codex', cfg)).toBe('crit+rev');
    expect(roleTags('codex', { ...cfg, mode: 'compete' })).toBe('rival');
    expect(roleTags('claude', { ...cfg, mode: 'parallel' })).toBe('lead');
    expect(roleTags('codex', { ...cfg, mode: 'solo' })).toBe('idle');
    expect(roleTags('codex', { ...cfg, mode: 'pair' })).toBe('rev');
  });
});

describe('session config from flags', () => {
  it('passes the new modes through', () => {
    expect(configFromFlags(p(['Build', '--mode', 'compete']).global, DEFAULT_SETTINGS)).toEqual({ mode: 'compete' });
    expect(configFromFlags(p(['Build', '--mode', 'parallel', '--developer', 'claude']).global, DEFAULT_SETTINGS)).toEqual({ mode: 'parallel', developer: 'claude', reviewer: 'codex' });
  });
  it('custom always carries a team: --team, else the saved default, else architect-like', () => {
    expect(configFromFlags(p(['--team', 'plan=none,critic=none,dev=claude,review=codex+claude']).global, DEFAULT_SETTINGS)).toEqual({
      mode: 'custom', team: { planner: null, planCritic: null, developer: 'claude', reviewers: ['codex', 'claude'] }, developer: 'claude', reviewer: 'codex',
    });
    const saved = { planner: 'claude', planCritic: null, developer: 'claude', reviewers: [] } as const;
    expect(configFromFlags(p(['--mode', 'custom']).global, { ...DEFAULT_SETTINGS, team: { ...saved, reviewers: [] } })).toMatchObject({ mode: 'custom', team: saved, developer: 'claude', reviewer: 'codex' });
    expect(configFromFlags(p(['--mode', 'custom']).global, DEFAULT_SETTINGS)).toMatchObject({ mode: 'custom', team: { planner: 'codex', planCritic: 'claude', developer: 'codex', reviewers: ['claude'] } });
    expect(configFromFlags(p(['--mode', 'custom', '--developer', 'claude']).global, DEFAULT_SETTINGS)).toMatchObject({ team: { planner: 'claude', planCritic: 'codex', developer: 'claude', reviewers: ['codex'] } });
  });
});

describe('lina settings', () => {
  it('parses settings set pairs', () => {
    expect(parseSettingValue('access', 'full')).toEqual({ key: 'access', patch: { accessMode: 'full' } });
    expect(parseSettingValue('access', 'restricted')).toEqual({ key: 'access', patch: { accessMode: 'restricted' } });
    expect(p(['settings']).command).toBe('settings');
    expect(p(['settings', '--json']).flags.json).toBe(true);
    expect(parseSettingValue('test-sandbox', 'on')).toEqual({ key: 'test-sandbox', patch: { testSandbox: 'on' } });
    expect(parseSettingValue('claude-sandbox', 'off')).toEqual({ key: 'claude-sandbox', patch: { claudeSandbox: 'off' } });
    expect(parseSettingValue('mode', 'compete')).toEqual({ key: 'mode', patch: { defaultMode: 'compete' } });
    expect(parseSettingValue('team', 'dev=claude,review=codex')).toEqual({ key: 'team', patch: { team: { planner: 'claude', planCritic: 'codex', developer: 'claude', reviewers: ['codex'] } } });
    expect(p(['settings', 'set', 'team', 'plan=none', 'dev=codex']).positionals).toEqual(['set', 'team', 'plan=none', 'dev=codex']);
  });
  it('rejects bad keys and values', () => {
    expect(argErr(() => p(['settings', 'set', 'test-sandbox', 'maybe'])).hint).toContain('auto, on, off');
    expect(argErr(() => p(['settings', 'set', 'tset-sandbox', 'on'])).hint).toContain('did you mean "test-sandbox"');
    expect(argErr(() => p(['settings', 'set', 'team', 'dev=none'])).message).toMatch(/cannot be none/);
    expect(argErr(() => p(['settings', 'set', 'mode'])).message).toMatch(/needs a key and a value/);
    expect(argErr(() => p(['settings', 'sett'])).hint).toContain('lina settings set');
  });
});
