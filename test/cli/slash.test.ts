import { describe, expect, it } from 'vitest';
import { argLabel, argSuggestions, complete, leadingMention, parseSlash, slashSuggestions } from '../../src/cli/slash.js';

describe('parseSlash', () => {
  it('recognizes goals, preserves the objective and completes the command', () => {
    expect(parseSlash('/goal')).toEqual({ type: 'goal' });
    expect(parseSlash('/goal Build hello\nthen test it')).toEqual({ type: 'goal', objective: 'Build hello\nthen test it' });
    expect(complete('/go', 3)?.value).toBe('/goal ');
  });
  it('parses history, undo and persistent preview controls', () => {
    expect(parseSlash('/changes')).toEqual({ type: 'changes' });
    expect(parseSlash('/changes 3')).toEqual({ type: 'changes', turn: 3 });
    expect(parseSlash('/undo')).toEqual({ type: 'undo' });
    expect(parseSlash('/undo 4')).toEqual({ type: 'undo', turn: 4 });
    expect(parseSlash('/undo 0').type).toBe('error');
    expect(parseSlash('/changes nonsense').type).toBe('error');
    expect(parseSlash('/previews')).toEqual({ type: 'preview', action: 'list' });
    expect(parseSlash('/preview start npm run dev -- --port {port}')).toEqual({ type: 'preview', action: 'start', value: 'npm run dev -- --port {port}' });
    expect(parseSlash('/preview stop abc')).toEqual({ type: 'preview', action: 'stop', value: 'abc' });
    expect(parseSlash('/preview logs abc')).toEqual({ type: 'preview', action: 'logs', value: 'abc' });
  });
  it('plain text is a message; // escapes a leading slash', () => {
    expect(parseSlash('hello')).toEqual({ type: 'send', text: 'hello' });
    expect(parseSlash('//etc/hosts is wrong')).toEqual({ type: 'send', text: '/etc/hosts is wrong' });
  });
  it('parses commands with arguments', () => {
    expect(parseSlash('/new Build a thing')).toEqual({ type: 'new', prompt: 'Build a thing' });
    expect(parseSlash('/new')).toEqual({ type: 'new' });
    expect(parseSlash('/model codex gpt-6.1-sol high')).toEqual({ type: 'model', agent: 'codex', model: 'gpt-6.1-sol', effort: 'high' });
    expect(parseSlash('/model claude opus')).toEqual({ type: 'model', agent: 'claude', model: 'opus' });
    expect(parseSlash('/mode architect')).toEqual({ type: 'mode', mode: 'architect' });
    expect(parseSlash('/approve merge')).toEqual({ type: 'approve', strategy: 'merge' });
    expect(parseSlash('/approve')).toEqual({ type: 'approve' });
    expect(parseSlash('/reject not what I wanted')).toEqual({ type: 'reject', note: 'not what I wanted' });
    expect(parseSlash('/interrupt stop using lodash')).toEqual({ type: 'interrupt', text: 'stop using lodash' });
    expect(parseSlash('/pause')).toEqual({ type: 'control', action: 'pause' });
    expect(parseSlash('/review')).toEqual({ type: 'control', action: 'review' });
    expect(parseSlash('/exit')).toEqual({ type: 'quit' });
    expect(parseSlash('  /HELP ')).toEqual({ type: 'help' });
  });
  it('reports errors with hints', () => {
    const e = parseSlash('/difff');
    expect(e).toMatchObject({ type: 'error', message: 'Unknown command /difff' });
    expect((e as { hint: string }).hint).toContain('/diff');
    expect(parseSlash('/model gemini x')).toMatchObject({ type: 'error' });
    expect(parseSlash('/model codex')).toMatchObject({ type: 'error' });
    expect(parseSlash('/model codex m turbo')).toMatchObject({ type: 'error', message: expect.stringContaining('effort') });
    expect(parseSlash('/mode chaos')).toMatchObject({ type: 'error' });
    expect(parseSlash('/approve yolo')).toMatchObject({ type: 'error' });
    expect(parseSlash('/interrupt')).toMatchObject({ type: 'error' });
    expect(parseSlash('/diff now')).toMatchObject({ type: 'error', message: 'Unknown agent "now"' });
    expect(parseSlash('/tests now')).toMatchObject({ type: 'error', message: '/tests takes no arguments' });
  });
});

describe('completion', () => {
  it('suggests commands by prefix', () => {
    expect(slashSuggestions('/re').map((s) => s.name)).toEqual(['reject', 'resume', 'retry', 'review']);
    expect(slashSuggestions('/mode x')).toEqual([]);
    expect(slashSuggestions('hello')).toEqual([]);
  });
  it('completes a unique command, common prefixes, and arguments', () => {
    expect(complete('/dif', 4)).toEqual({ value: '/diff ', cursor: 6 });
    expect(complete('/ret', 4)).toEqual({ value: '/retry ', cursor: 7 });
    expect(complete('/res', 4)).toEqual({ value: '/resume ', cursor: 8 });
    expect(complete('/mode ar', 8)).toEqual({ value: '/mode architect ', cursor: 16 });
    expect(argSuggestions('/approve ')).toEqual(['squash', 'merge', 'branch', 'codex', 'claude']);
    expect(argSuggestions('/model codex gpt x')).toEqual(['xhigh']);
  });
  it('completes @mentions anywhere', () => {
    expect(complete('@co', 3)).toEqual({ value: '@codex ', cursor: 7 });
    expect(complete('ask @cl', 7)).toEqual({ value: 'ask @claude ', cursor: 12 });
    expect(complete('@c', 2)).toBeNull(); // ambiguous
    expect(leadingMention('@Claude why?')).toBe('claude');
    expect(leadingMention('hi @codex')).toBeUndefined();
  });
});

describe('modes v2 slash commands', () => {
  it('/mode accepts all six modes; no argument opens the picker', () => {
    for (const m of ['pair', 'architect', 'solo', 'parallel', 'compete', 'custom']) expect(parseSlash(`/mode ${m}`)).toEqual({ type: 'mode', mode: m });
    expect(parseSlash('/mode')).toEqual({ type: 'mode-picker' });
    expect(parseSlash('/mode COMPETE')).toEqual({ type: 'mode', mode: 'compete' });
    const e = parseSlash('/mode compet');
    expect(e).toMatchObject({ type: 'error', message: 'Unknown mode "compet"' });
    expect((e as { hint: string }).hint).toContain('did you mean "compete"');
    expect(parseSlash('/mode pair extra')).toMatchObject({ type: 'error', message: 'Too many arguments' });
    expect(parseSlash('/mode custom dev=claude review=none')).toEqual({ type: 'mode', mode: 'custom', team: { planner: 'claude', planCritic: 'codex', developer: 'claude', reviewers: [] } });
  });
  it('/team shows a picker or sets a team from a spec', () => {
    expect(parseSlash('/team')).toEqual({ type: 'team-picker' });
    expect(parseSlash('/team plan=claude,critic=codex,dev=claude,review=codex+claude')).toEqual({ type: 'team', team: { planner: 'claude', planCritic: 'codex', developer: 'claude', reviewers: ['codex', 'claude'] } });
    expect(parseSlash('/team plan=none critic=none dev=codex review=')).toEqual({ type: 'team', team: { planner: null, planCritic: null, developer: 'codex', reviewers: [] } });
    expect(parseSlash('/team dev=gemini')).toMatchObject({ type: 'error', message: 'Unknown agent "gemini" for dev=' });
    expect(parseSlash('/team review=codex+codex')).toMatchObject({ type: 'error', message: expect.stringContaining('twice') });
  });
  it('/diff, /choose and /approve take an agent', () => {
    expect(parseSlash('/diff')).toEqual({ type: 'diff' });
    expect(parseSlash('/diff claude')).toEqual({ type: 'diff', variant: 'claude' });
    expect(parseSlash('/diff codex claude')).toMatchObject({ type: 'error', message: 'Too many arguments' });
    expect(parseSlash('/choose codex')).toEqual({ type: 'choose', variant: 'codex' });
    expect(parseSlash('/choose @Claude')).toEqual({ type: 'choose', variant: 'claude' });
    expect(parseSlash('/choose')).toMatchObject({ type: 'error', message: 'Which version?' });
    expect(parseSlash('/choose cladue')).toMatchObject({ type: 'error', message: expect.stringContaining('did you mean claude') });
    expect(parseSlash('/approve claude')).toEqual({ type: 'approve', variant: 'claude' });
    expect(parseSlash('/approve codex merge')).toEqual({ type: 'approve', variant: 'codex', strategy: 'merge' });
    expect(parseSlash('/approve branch claude')).toEqual({ type: 'approve', variant: 'claude', strategy: 'branch' });
    expect(parseSlash('/approve squash')).toEqual({ type: 'approve', strategy: 'squash' });
    expect(parseSlash('/approve codex claude')).toMatchObject({ type: 'error' });
    expect(parseSlash('/approve codex squash merge')).toMatchObject({ type: 'error', message: 'Too many arguments' });
  });
  it('completes modes, agents, strategies and team specs', () => {
    expect(argSuggestions('/mode ')).toEqual(['pair', 'architect', 'solo', 'parallel', 'compete', 'custom']);
    expect(complete('/mode co', 8)).toEqual({ value: '/mode compete ', cursor: 14 });
    expect(complete('/mode cu', 8)).toEqual({ value: '/mode custom ', cursor: 13 });
    expect(argSuggestions('/choose ')).toEqual(['codex', 'claude']);
    expect(complete('/choose cl', 10)).toEqual({ value: '/choose claude ', cursor: 15 });
    expect(complete('/diff co', 8)).toEqual({ value: '/diff codex ', cursor: 12 });
    expect(argSuggestions('/approve claude ')).toEqual(['squash', 'merge', 'branch']);
    expect(argSuggestions('/approve merge ')).toEqual(['codex', 'claude']);
    expect(argSuggestions('/team ')).toEqual(['plan=', 'critic=', 'dev=', 'review=']);
    expect(complete('/team cr', 8)).toEqual({ value: '/team critic=', cursor: 13 });
    expect(complete('/team critic=cl', 15)).toEqual({ value: '/team critic=claude ', cursor: 20 });
    expect(argSuggestions('/team plan=claude ')).toEqual(['critic=', 'dev=', 'review=']);
    expect(argSuggestions('/team plan=claude,dev=c')).toEqual(['plan=claude,dev=codex', 'plan=claude,dev=claude']);
    expect(argLabel('plan=claude,dev=codex')).toBe('dev=codex');
    expect(argSuggestions('/team review=codex')).toEqual(['review=codex+claude']);
    expect(argSuggestions('/mode custom dev=')).toEqual(['dev=codex', 'dev=claude']);
    expect(slashSuggestions('/ch').map((s) => s.name)).toEqual(['changes', 'choose']);
    expect(slashSuggestions('/te').map((s) => s.name)).toEqual(['team', 'tests']);
  });
});
