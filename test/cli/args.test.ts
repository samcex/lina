import { describe, expect, it } from 'vitest';
import { ArgError, parseArgs, validateCommand } from '../../src/cli/args.js';

const p = (s: string[]) => { const a = parseArgs(s); validateCommand(a); return a; };

describe('parseArgs', () => {
  it('defaults to the TUI with no args', () => {
    expect(p([])).toMatchObject({ command: 'tui', positionals: [] });
  });
  it('treats non-command words as a prompt', () => {
    const a = p(['Build a modern dashboard']);
    expect(a.command).toBe('tui');
    expect(a.positionals).toEqual(['Build a modern dashboard']);
  });
  it('parses commands and global flags in any position', () => {
    const a = p(['--mock', 'attach', 'abc', '--codex-model', 'gpt-x', '--claude-effort=high', '--developer', 'claude', '--mode', 'solo', '--max-rounds', '5']);
    expect(a.command).toBe('attach');
    expect(a.positionals).toEqual(['abc']);
    expect(a.global).toEqual({ mock: true, codexModel: 'gpt-x', claudeEffort: 'high', developer: 'claude', mode: 'solo', maxRounds: 5 });
  });
  it('help/version short flags', () => {
    expect(p(['-h']).help).toBe(true);
    expect(p(['-v']).version).toBe(true);
    expect(p(['help']).help).toBe(true);
  });
  it('accepts direct or isolated workspace selection', () => {
    expect(p(['--workspace', 'direct']).global.workspaceMode).toBe('direct');
    expect(p(['--workspace=isolated', 'Build it']).global.workspaceMode).toBe('isolated');
    expect(() => p(['--workspace', 'typo'])).toThrow(/Invalid value/);
  });
  it('parses natural interaction and persistent preview commands without requiring a TTY', () => {
    expect(p(['--interaction', 'chat']).global.interactionMode).toBe('chat');
    expect(p(['--interaction=workflow']).global.interactionMode).toBe('workflow');
    expect(p(['preview', 'start', 'npm run dev -- --port {port}', '--session', 'abc', '--port', '5173']).flags).toMatchObject({ session: 'abc', port: 5173 });
    expect(p(['preview', 'list', '--session', 'abc', '--json']).command).toBe('preview');
    expect(() => p(['preview', 'stop'])).toThrow();
    expect(() => p(['preview', 'start', 'echo', '--port', '-1'])).toThrow();
  });
  it('command-specific flags', () => {
    expect(p(['sessions', '--all']).flags.all).toBe(true);
    expect(p(['add', './x', '--create', '--init-git']).flags).toMatchObject({ create: true, initGit: true });
    expect(p(['models', 'set', 'codex', 'gpt-6', '--effort', 'xhigh']).flags.effort).toBe('xhigh');
    expect(p(['daemon', 'logs', '-f', '-n', '20']).flags).toMatchObject({ follow: true, lines: 20 });
    expect(p(['doctor', '--live']).flags.live).toBe(true);
  });
  it('-- stops flag parsing', () => {
    expect(p(['--', '--not-a-flag']).positionals).toEqual(['--not-a-flag']);
  });
  it('rejects unknown flags with a suggestion', () => {
    try { parseArgs(['--moc']); throw new Error('no'); } catch (e) {
      expect(e).toBeInstanceOf(ArgError);
      expect((e as ArgError).message).toContain('--moc');
      expect((e as ArgError).hint).toContain('--mock');
    }
  });
  it('rejects bad values and misplaced flags', () => {
    expect(() => parseArgs(['--mode', 'chaos'])).toThrow(/Invalid value/);
    expect(() => parseArgs(['--developer', 'gemini'])).toThrow(ArgError);
    expect(() => parseArgs(['--max-rounds', '0'])).toThrow(/Invalid value/);
    expect(() => parseArgs(['--codex-model'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--all'])).toThrow(/not valid/);
    expect(() => parseArgs(['--mock=1'])).toThrow(/does not take a value/);
  });
  it('validates subcommands', () => {
    expect(() => p(['daemon'])).toThrow(/subcommand/);
    expect(() => p(['daemon', 'strat'])).toThrow(ArgError);
    try { p(['daemon', 'strat']); } catch (e) { expect((e as ArgError).hint).toContain('start'); }
    expect(() => p(['models', 'set', 'codex'])).toThrow(/needs an agent and a model/);
    expect(() => p(['models', 'validate', 'gpt', 'x'])).toThrow(/Invalid value for agent/);
    expect(() => p(['add'])).toThrow(/exactly one path/);
    expect(() => p(['sessions', 'extra'])).toThrow(/Unexpected argument/);
  });
});
