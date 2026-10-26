// Slash commands for the TUI composer: parsing, validation and completion.
import type { AgentId, ApplyStrategy, Effort, Mode, TeamConfig } from '../shared/types.js';
import { AGENTS, CLI_MODES, EFFORTS, closest } from './args.js';
import { TEAM_SPEC_HELP, parseTeamSpec, teamTokenSuggestions } from './team.js';

export interface SlashSpec { name: string; args?: string; desc: string; aliases?: string[] }

export const SLASH_COMMANDS: SlashSpec[] = [
  { name: 'menu', desc: 'Open navigation and tools (Ctrl+K when empty)' },
  { name: 'goal', args: '[objective|status|resume|pause|cancel]', desc: 'Start a persistent goal, show its status, or control the saved goal' },
  { name: 'new', args: '[prompt]', desc: 'Start a new session (optionally with a task)' },
  { name: 'sessions', desc: 'Switch to another session' },
  { name: 'scroll', args: '[on|off]', desc: 'Scroll with arrows/j/k; Esc returns to writing (Ctrl+G)' },
  { name: 'history', args: '[earlier|event number]', desc: 'Open saved conversations; earlier or a number loads messages in this chat' },
  { name: 'search', args: '<text>', desc: 'Search all conversations and open a matching message' },
  { name: 'project', desc: 'Switch project' },
  { name: 'model', args: 'codex|claude <id> [effort]', desc: 'Set an agent model for this session' },
  { name: 'models', desc: 'Browse and validate available models' },
  { name: 'roles', desc: 'Swap developer and reviewer' },
  { name: 'mode', args: '[pair|architect|solo|parallel|compete|custom]', desc: 'Change the collaboration mode (no argument: picker)' },
  { name: 'team', args: '[plan=… critic=… dev=… review=…]', desc: 'Custom team: who plans, critiques, builds, reviews (no argument: picker)' },
  { name: 'live', args: '[codex|claude]', aliases: ['agents', 'activity'], desc: 'What the agents are doing right now: live text, commands, output (Ctrl+T)' },
  { name: 'diff', args: '[codex|claude]', desc: 'Show the diff (of one agent\'s version in parallel/compete)' },
  { name: 'changes', args: '[turn]', desc: 'List writing turns, or inspect one turn’s actual diff' },
  { name: 'undo', args: '[turn]', desc: 'Undo the latest writing turn, preserving later independent edits' },
  { name: 'preview', args: '[start <command>|stop <id>|logs <id>]', aliases: ['previews'], desc: 'List or manage persistent preview servers' },
  { name: 'findings', desc: 'Review findings (w waives an escalated one)' },
  { name: 'tests', desc: 'Test runs verified by LINA' },
  { name: 'choose', args: '<codex|claude>', desc: 'Compete: pick the winning version (still awaits approval)' },
  { name: 'approve', args: '[codex|claude] [squash|merge|branch]', desc: 'Apply the work to your repository (compete: name the winner)' },
  { name: 'reject', args: '[note]', desc: 'Reject the result (workspace is kept)' },
  { name: 'pause', desc: 'Pause at the next turn boundary' },
  { name: 'resume', args: '[last|session id]', desc: 'Reopen a saved conversation or resume the current paused session' },
  { name: 'cancel', desc: 'Cancel the running turn now' },
  { name: 'retry', desc: 'Re-run the last failed step' },
  { name: 'review', desc: 'Run an extra review round' },
  { name: 'interrupt', args: '<message>', desc: 'Stop the current turn and re-run it with your message' },
  { name: 'ui', desc: 'Open this session in the web UI' },
  { name: 'doctor', desc: 'Check CLIs, auth and sandbox' },
  { name: 'help', desc: 'Keys and commands', aliases: ['?'] },
  { name: 'quit', desc: 'Leave the TUI (agents keep working)', aliases: ['exit', 'q'] },
];

export type SlashAction =
  | { type: 'menu' }
  | { type: 'goal'; objective?: string }
  | { type: 'new'; prompt?: string }
  | { type: 'sessions' }
  | { type: 'scroll'; enabled?: boolean }
  | { type: 'history'; seq?: number; earlier?: boolean }
  | { type: 'resume'; selector?: string }
  | { type: 'search'; query: string }
  | { type: 'project' }
  | { type: 'model'; agent: AgentId; model: string; effort?: Effort }
  | { type: 'models' }
  | { type: 'roles' }
  | { type: 'mode'; mode: Mode; team?: TeamConfig }
  | { type: 'mode-picker' }
  | { type: 'team'; team: TeamConfig }
  | { type: 'team-picker' }
  | { type: 'live'; agent?: AgentId }
  | { type: 'diff'; variant?: AgentId }
  | { type: 'changes'; turn?: number }
  | { type: 'undo'; turn?: number }
  | { type: 'preview'; action: 'list' | 'start' | 'stop' | 'logs'; value?: string }
  | { type: 'choose'; variant: AgentId }
  | { type: 'findings' }
  | { type: 'tests' }
  | { type: 'approve'; strategy?: ApplyStrategy; variant?: AgentId }
  | { type: 'reject'; note?: string }
  | { type: 'control'; action: 'pause' | 'resume' | 'cancel' | 'retry' | 'review' }
  | { type: 'interrupt'; text: string }
  | { type: 'ui' }
  | { type: 'doctor' }
  | { type: 'help' }
  | { type: 'quit' }
  | { type: 'send'; text: string }
  | { type: 'error'; message: string; hint?: string };

const STRATEGIES: ApplyStrategy[] = ['squash', 'merge', 'branch'];

function agentArg(raw: string): { ok: true; agent: AgentId } | { ok: false; message: string } {
  const x = raw.toLowerCase().replace(/^@/, '');
  if ((AGENTS as string[]).includes(x)) return { ok: true, agent: x as AgentId };
  const near = closest(x, AGENTS, 2);
  return { ok: false, message: `Unknown agent "${raw}"${near ? ` — did you mean ${near}?` : ''}` };
}

function usage(name: string): string {
  const s = SLASH_COMMANDS.find((c) => c.name === name)!;
  return `Usage: /${s.name}${s.args ? ' ' + s.args : ''}`;
}

/** Parses composer text that starts with '/'. Plain text returns {type:'send'}. `//x` sends "/x" literally. */
export function parseSlash(input: string): SlashAction {
  const text = input.trim();
  if (!text.startsWith('/')) return { type: 'send', text: input };
  if (text.startsWith('//')) return { type: 'send', text: text.slice(1) };
  const m = /^\/(\S*)\s*([\s\S]*)$/.exec(text)!;
  const word = m[1].toLowerCase();
  const rest = m[2].trim();
  const args = rest ? rest.split(/\s+/) : [];
  const spec = SLASH_COMMANDS.find((c) => c.name === word || c.aliases?.includes(word));
  if (!spec) {
    const near = closest(word, SLASH_COMMANDS.map((c) => c.name), 2);
    return { type: 'error', message: `Unknown command /${word}`, hint: near ? `Did you mean /${near}? (Start with // to send a message beginning with "/")` : 'Type /help for commands. Start with // to send text beginning with "/".' };
  }
  const noArgs = (a: SlashAction): SlashAction => (args.length ? { type: 'error', message: `/${spec.name} takes no arguments`, hint: usage(spec.name) } : a);
  switch (spec.name) {
    case 'changes': case 'undo': {
      if (args.length > 1 || (args[0] && (!/^\d+$/.test(args[0]) || Number(args[0]) < 1))) return { type: 'error', message: 'Expected a positive turn number', hint: usage(spec.name) };
      return { type: spec.name, ...(args[0] ? { turn: Number(args[0]) } : {}) };
    }
    case 'preview': {
      if (!rest || rest === 'list') return { type: 'preview', action: 'list' };
      const m = /^(start|stop|logs)\s+([\s\S]+)$/.exec(rest);
      if (!m || ((m[1] === 'stop' || m[1] === 'logs') && /\s/.test(m[2]))) return { type: 'error', message: 'Expected start <command>, stop <id>, or logs <id>', hint: usage('preview') };
      return { type: 'preview', action: m[1] as 'start' | 'stop' | 'logs', value: m[2] };
    }
    case 'goal': return rest ? { type: 'goal', objective: rest } : { type: 'goal' };
    case 'new': return rest ? { type: 'new', prompt: rest } : { type: 'new' };
    case 'sessions': return noArgs({ type: 'sessions' });
    case 'scroll':
      if (!args.length) return { type: 'scroll' };
      if (args.length === 1 && (args[0] === 'on' || args[0] === 'off')) return { type: 'scroll', enabled: args[0] === 'on' };
      return { type: 'error', message: 'Expected on or off', hint: usage('scroll') };
    case 'history':
      if (!args.length) return { type: 'history' };
      if (args.length === 1 && args[0] === 'earlier') return { type: 'history', earlier: true };
      if (args.length === 1 && /^\d+$/.test(args[0]) && Number.isSafeInteger(Number(args[0])) && Number(args[0]) > 0) return { type: 'history', seq: Number(args[0]) };
      return { type: 'error', message: 'Expected a positive event number', hint: usage('history') };
    case 'search':
      return rest ? { type: 'search', query: rest } : { type: 'error', message: 'Enter text to search for', hint: usage('search') };
    case 'project': return noArgs({ type: 'project' });
    case 'models': return noArgs({ type: 'models' });
    case 'roles': return noArgs({ type: 'roles' });
    case 'live': {
      if (!args.length) return { type: 'live' };
      if (args.length > 1) return { type: 'error', message: 'Too many arguments', hint: usage('live') };
      const a = agentArg(args[0]);
      return a.ok ? { type: 'live', agent: a.agent } : { type: 'error', message: a.message, hint: usage('live') };
    }
    case 'diff': {
      if (!args.length) return { type: 'diff' };
      if (args.length > 1) return { type: 'error', message: 'Too many arguments', hint: usage('diff') };
      const a = agentArg(args[0]);
      return a.ok ? { type: 'diff', variant: a.agent } : { type: 'error', message: a.message, hint: usage('diff') };
    }
    case 'choose': {
      if (args.length !== 1) return { type: 'error', message: 'Which version?', hint: usage('choose') };
      const a = agentArg(args[0]);
      return a.ok ? { type: 'choose', variant: a.agent } : { type: 'error', message: a.message, hint: usage('choose') };
    }
    case 'team': {
      if (!rest) return { type: 'team-picker' };
      const r = parseTeamSpec(rest);
      return r.ok ? { type: 'team', team: r.team } : { type: 'error', message: r.message, hint: r.hint ?? TEAM_SPEC_HELP };
    }
    case 'findings': return noArgs({ type: 'findings' });
    case 'tests': return noArgs({ type: 'tests' });
    case 'ui': return noArgs({ type: 'ui' });
    case 'doctor': return noArgs({ type: 'doctor' });
    case 'menu': return noArgs({ type: 'menu' });
    case 'help': return { type: 'help' };
    case 'quit': return { type: 'quit' };
    case 'resume':
      if (args.length <= 1) return { type: 'resume', ...(args.length ? { selector: args[0] } : {}) };
      return { type: 'error', message: 'Expected last or a session id', hint: usage('resume') };
    case 'pause': case 'cancel': case 'retry': case 'review':
      return noArgs({ type: 'control', action: spec.name });
    case 'model': {
      const [agent, model, effort] = args;
      if (!agent || !model || args.length > 3) return { type: 'error', message: 'Missing model', hint: usage('model') };
      if (!(AGENTS as string[]).includes(agent)) return { type: 'error', message: `Unknown agent "${agent}"`, hint: 'Agents: codex, claude' };
      if (effort && !(EFFORTS as string[]).includes(effort)) return { type: 'error', message: `Unknown effort "${effort}"`, hint: `Efforts: ${EFFORTS.join(', ')}` };
      return { type: 'model', agent: agent as AgentId, model, ...(effort ? { effort: effort as Effort } : {}) };
    }
    case 'mode': {
      if (!args.length) return { type: 'mode-picker' };
      const m = args[0].toLowerCase();
      if (!(CLI_MODES as string[]).includes(m)) {
        const near = closest(m, CLI_MODES, 2);
        return { type: 'error', message: `Unknown mode "${args[0]}"`, hint: `Modes: ${CLI_MODES.join(', ')}${near ? ` (did you mean "${near}"?)` : ''} — /mode alone opens a picker` };
      }
      if (args.length > 1) {
        // "/mode custom plan=… dev=…" sets the team in the same step
        if (m !== 'custom') return { type: 'error', message: 'Too many arguments', hint: usage('mode') };
        const r = parseTeamSpec(args.slice(1).join(' '));
        return r.ok ? { type: 'mode', mode: 'custom', team: r.team } : { type: 'error', message: r.message, hint: r.hint ?? TEAM_SPEC_HELP };
      }
      return { type: 'mode', mode: m as Mode };
    }
    case 'approve': {
      // [codex|claude] [squash|merge|branch], in either order
      let strategy: ApplyStrategy | undefined;
      let variant: AgentId | undefined;
      for (const raw of args) {
        const x = raw.toLowerCase();
        if ((STRATEGIES as string[]).includes(x) && !strategy) strategy = x as ApplyStrategy;
        else if ((AGENTS as string[]).includes(x) && !variant) variant = x as AgentId;
        else if (args.length > 2) return { type: 'error', message: 'Too many arguments', hint: usage('approve') };
        else {
          const near = closest(x, [...AGENTS, ...STRATEGIES], 2);
          return { type: 'error', message: `Unknown ${strategy || variant ? 'argument' : 'strategy or agent'} "${raw}"`, hint: `${near ? `Did you mean "${near}"? ` : ''}squash (one commit, default) · merge (keep checkpoints) · branch (only create lina/<id>) · compete: name the winner first, e.g. /approve claude squash` };
        }
      }
      return { type: 'approve', ...(variant ? { variant } : {}), ...(strategy ? { strategy } : {}) };
    }
    case 'reject': return rest ? { type: 'reject', note: rest } : { type: 'reject' };
    case 'interrupt':
      if (!rest) return { type: 'error', message: '/interrupt needs a message', hint: usage('interrupt') };
      return { type: 'interrupt', text: rest };
  }
  return { type: 'error', message: `Unhandled command /${spec.name}` };
}

/** Slash commands matching what's typed so far (only while typing the command word). */
export function slashSuggestions(input: string): SlashSpec[] {
  if (!input.startsWith('/') || input.startsWith('//') || /\s/.test(input) || input.includes('\n')) return [];
  const w = input.slice(1).toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(w) || c.aliases?.some((a) => a.startsWith(w) && w.length > 0));
}

/**
 * Argument hints for a typed command, e.g. "/mode " → the six modes, "/approve " → agents and strategies,
 * "/team plan=cl" → ["plan=claude"]. Each hint is the full replacement for the last word.
 */
export function argSuggestions(input: string): string[] {
  const team = /^\/(?:team|mode\s+custom)\s+((?:\S+\s+)*)(\S*)$/.exec(input);
  if (team) return teamTokenSuggestions(team[2], team[1].split(/\s+/).filter(Boolean));
  const m2 = /^\/model\s+(codex|claude)\s+\S+\s+(\S*)$/.exec(input);
  if (m2) return EFFORTS.filter((e) => e.startsWith(m2[2]) && e !== m2[2]);
  const ap = /^\/approve\s+(\S+)\s+(\S*)$/.exec(input);
  if (ap) {
    const first = ap[1].toLowerCase();
    const pool: string[] = (AGENTS as string[]).includes(first) ? STRATEGIES : (STRATEGIES as string[]).includes(first) ? AGENTS : [];
    return pool.filter((x) => x.startsWith(ap[2]) && x !== ap[2]);
  }
  const m = /^\/(\w+)\s+(\S*)$/.exec(input);
  if (!m) return [];
  const [, cmd, partial] = m;
  const pool: string[] = cmd === 'mode' ? CLI_MODES
    : cmd === 'scroll' ? ['on', 'off']
    : cmd === 'approve' ? [...STRATEGIES, ...AGENTS]
    : cmd === 'model' || cmd === 'diff' || cmd === 'choose' || cmd === 'live' ? AGENTS : [];
  return pool.filter((x) => x.startsWith(partial) && x !== partial);
}

/** Short label for an argument hint (team hints show only the segment being completed). */
export function argLabel(hint: string): string {
  const i = hint.lastIndexOf(',');
  return i >= 0 ? hint.slice(i + 1) : hint;
}

export interface Completion { value: string; cursor: number }

/**
 * Tab completion: completes "/comm" → "/command ", "@co" → "@codex ", and slash arguments.
 * Returns null if nothing to complete.
 */
export function complete(value: string, cursor: number): Completion | null {
  const before = value.slice(0, cursor);
  const after = value.slice(cursor);
  // @mention at the cursor
  const mm = /(^|\s)@(\w*)$/.exec(before);
  if (mm) {
    const hits = AGENTS.filter((a) => a.startsWith(mm[2].toLowerCase()));
    if (hits.length === 1) {
      const nb = before.slice(0, before.length - mm[2].length) + hits[0] + ' ';
      return { value: nb + after.replace(/^\s+/, ''), cursor: nb.length };
    }
    return null;
  }
  if (after.trim() !== '') return null;
  const sl = slashSuggestions(before);
  if (sl.length >= 1 && before.length > 1) {
    const target = sl.length === 1 ? sl[0].name : commonPrefix(sl.map((s) => s.name));
    const nb = '/' + target + (sl.length === 1 ? ' ' : '');
    if (nb === before) return null;
    return { value: nb, cursor: nb.length };
  }
  const args = argSuggestions(before);
  if (args.length) {
    const partial = /(\S*)$/.exec(before)![1];
    // a completed "key=" waits for its value; anything else ends the word
    const target = args.length === 1 ? args[0] + (args[0].endsWith('=') ? '' : ' ') : commonPrefix(args);
    if (target.length <= partial.length) return null;
    const nb = before.slice(0, before.length - partial.length) + target;
    return { value: nb, cursor: nb.length };
  }
  return null;
}

function commonPrefix(xs: string[]): string {
  if (!xs.length) return '';
  let p = xs[0];
  for (const x of xs) while (!x.startsWith(p)) p = p.slice(0, -1);
  return p;
}

/** Detects a leading @mention in a message (as the daemon routes it). */
export function leadingMention(text: string): AgentId | undefined {
  const m = /^@(codex|claude)\b/i.exec(text.trim());
  return m ? (m[1].toLowerCase() as AgentId) : undefined;
}
