// Handwritten argument parser for the `lina` command (no dependencies).
import type { AgentId, Effort, Mode, TeamConfig } from '../shared/types.js';
import { TEAM_SPEC_EXAMPLE, parseTeamSpec } from './team.js';

export const COMMANDS = ['attach', 'sessions', 'projects', 'add', 'ui', 'models', 'settings', 'doctor', 'daemon', 'preview', 'notify', 'tailscale', 'home', 'help', 'version'] as const;
export type CommandName = (typeof COMMANDS)[number] | 'tui';

export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const CLI_MODES: Mode[] = ['pair', 'architect', 'solo', 'parallel', 'compete', 'custom'];
export const SANDBOX_MODES = ['auto', 'on', 'off'] as const;
export const AGENTS: AgentId[] = ['codex', 'claude'];

export interface GlobalOptions {
  project?: string;
  codexModel?: string;
  claudeModel?: string;
  codexEffort?: Effort;
  claudeEffort?: Effort;
  developer?: AgentId;
  mode?: Mode;
  workspaceMode?: 'direct' | 'isolated';
  interactionMode?: 'chat' | 'workflow';
  /** custom mode: who plans, critiques, implements and reviews (from --team). */
  team?: TeamConfig;
  maxRounds?: number;
  mock?: boolean;
}

export interface ParsedArgs {
  command: CommandName;
  /** Positional arguments after the command (for `tui`: the prompt words). */
  positionals: string[];
  global: GlobalOptions;
  /** Command-specific flags. */
  flags: {
    all?: boolean; refresh?: boolean; effort?: Effort; create?: boolean; initGit?: boolean;
    live?: boolean; follow?: boolean; lines?: number; json?: boolean; name?: string; url?: boolean; qr?: boolean;
    session?: string; port?: number; email?: string; host?: string;
  };
  help?: boolean;
  version?: boolean;
}

export class ArgError extends Error {
  constructor(message: string, public hint?: string) { super(message); }
}

type FlagSpec = { key: string; takesValue: boolean; scope: 'global' | 'local'; short?: string };

const FLAGS: Record<string, FlagSpec> = {
  '--host': { key: 'host', takesValue: true, scope: 'local' },
  '--session': { key: 'session', takesValue: true, scope: 'local' },
  '--port': { key: 'port', takesValue: true, scope: 'local' },
  '--url': { key: 'url', takesValue: false, scope: 'local' },
  '--qr': { key: 'qr', takesValue: false, scope: 'local' },
  '--project': { key: 'project', takesValue: true, scope: 'global' },
  '--codex-model': { key: 'codexModel', takesValue: true, scope: 'global' },
  '--claude-model': { key: 'claudeModel', takesValue: true, scope: 'global' },
  '--codex-effort': { key: 'codexEffort', takesValue: true, scope: 'global' },
  '--claude-effort': { key: 'claudeEffort', takesValue: true, scope: 'global' },
  '--developer': { key: 'developer', takesValue: true, scope: 'global' },
  '--workspace': { key: 'workspaceMode', takesValue: true, scope: 'global' },
  '--interaction': { key: 'interactionMode', takesValue: true, scope: 'global' },
  '--mode': { key: 'mode', takesValue: true, scope: 'global' },
  '--team': { key: 'team', takesValue: true, scope: 'global' },
  '--max-rounds': { key: 'maxRounds', takesValue: true, scope: 'global' },
  '--mock': { key: 'mock', takesValue: false, scope: 'global' },
  '--help': { key: 'help', takesValue: false, scope: 'global', short: '-h' },
  '--version': { key: 'version', takesValue: false, scope: 'global', short: '-v' },
  '--all': { key: 'all', takesValue: false, scope: 'local', short: '-a' },
  '--refresh': { key: 'refresh', takesValue: false, scope: 'local' },
  '--effort': { key: 'effort', takesValue: true, scope: 'local' },
  '--create': { key: 'create', takesValue: false, scope: 'local' },
  '--init-git': { key: 'initGit', takesValue: false, scope: 'local' },
  '--live': { key: 'live', takesValue: false, scope: 'local' },
  '--follow': { key: 'follow', takesValue: false, scope: 'local', short: '-f' },
  '--lines': { key: 'lines', takesValue: true, scope: 'local', short: '-n' },
  '--json': { key: 'json', takesValue: false, scope: 'local' },
  '--name': { key: 'name', takesValue: true, scope: 'local' },
  '--email': { key: 'email', takesValue: true, scope: 'local' },
};

/** Which command-specific flags each command accepts. */
const LOCAL_FLAGS: Partial<Record<CommandName, string[]>> = {
  preview: ['session', 'port', 'json'],
  ui: ['url', 'qr'],
  tailscale: ['port', 'qr', 'email'],
  home: ['host', 'port', 'json'],
  sessions: ['all', 'json'],
  projects: ['json'],
  add: ['create', 'initGit', 'name'],
  models: ['refresh', 'effort', 'json'],
  settings: ['json'],
  doctor: ['live', 'json'],
  daemon: ['follow', 'lines'],
};

const SHORT: Record<string, string> = Object.fromEntries(
  Object.entries(FLAGS).filter(([, s]) => s.short).map(([long, s]) => [s.short!, long]),
);

export function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

export function closest(word: string, options: readonly string[], max = 3): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const o of options) {
    const d = levenshtein(word, o);
    if (d < bestD) { bestD = d; best = o; }
  }
  return bestD <= max ? best : undefined;
}

function oneOf<T extends string>(flag: string, v: string, options: readonly T[]): T {
  if ((options as readonly string[]).includes(v)) return v as T;
  const near = closest(v, options as readonly string[], 2);
  throw new ArgError(`Invalid value for ${flag}: "${v}"`, `Expected one of: ${options.join(', ')}${near ? ` (did you mean "${near}"?)` : ''}`);
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { command: 'tui', positionals: [], global: {}, flags: {} };
  const rest: string[] = [];
  const raw: [FlagSpec, string, string | undefined][] = [];
  let onlyPositionals = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (onlyPositionals || a === '-' || !a.startsWith('-')) { rest.push(a); continue; }
    if (a === '--') { onlyPositionals = true; continue; }
    let name = a;
    let value: string | undefined;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 0) { name = a.slice(0, eq); value = a.slice(eq + 1); }
    if (!a.startsWith('--')) name = SHORT[a] ?? a;
    const spec = FLAGS[name];
    if (!spec) {
      // A negative number or prose starting with '-' as part of a prompt is unlikely; treat as unknown flag.
      const near = closest(name, Object.keys(FLAGS), 3);
      throw new ArgError(`Unknown option: ${a}`, near ? `Did you mean ${near}? Run \`lina --help\` for all options.` : 'Run `lina --help` for all options.');
    }
    if (spec.takesValue) {
      if (value === undefined) {
        const next = argv[i + 1];
        if (next === undefined || (next.startsWith('-') && next !== '-')) throw new ArgError(`Option ${name} needs a value`, `Example: ${name} <value>`);
        value = next;
        i++;
      }
    } else if (value !== undefined) {
      throw new ArgError(`Option ${name} does not take a value`);
    }
    raw.push([spec, name, value]);
  }

  // command
  if (rest.length) {
    const first = rest[0];
    if ((COMMANDS as readonly string[]).includes(first)) { out.command = first as CommandName; rest.shift(); }
  }
  out.positionals = rest;

  for (const [spec, name, value] of raw) {
    if (spec.key === 'help') { out.help = true; continue; }
    if (spec.key === 'version') { out.version = true; continue; }
    if (spec.scope === 'local') {
      const allowed = LOCAL_FLAGS[out.command] ?? [];
      if (!allowed.includes(spec.key)) {
        throw new ArgError(`Option ${name} is not valid for \`${out.command === 'tui' ? 'lina' : `lina ${out.command}`}\``,
          allowed.length ? `Valid options here: ${allowed.map((k) => Object.entries(FLAGS).find(([, s]) => s.key === k)![0]).join(', ')}` : 'Run `lina --help` for usage.');
      }
    }
    const g = out.global as Record<string, unknown>;
    const f = out.flags as Record<string, unknown>;
    switch (spec.key) {
      case 'codexEffort': case 'claudeEffort': g[spec.key] = oneOf(name, value!, EFFORTS); break;
      case 'effort': f.effort = oneOf(name, value!, EFFORTS); break;
      case 'developer': g.developer = oneOf(name, value!, AGENTS); break;
      case 'workspaceMode': g.workspaceMode = oneOf(name, value!, ['direct', 'isolated']); break;
      case 'interactionMode': g.interactionMode = oneOf(name, value!, ['chat', 'workflow']); break;
      case 'mode': g.mode = oneOf(name, value!, CLI_MODES); break;
      case 'team': {
        const r = parseTeamSpec(value!);
        if (!r.ok) throw new ArgError(`Invalid value for ${name}: ${r.message}`, r.hint ?? `Example: --team ${TEAM_SPEC_EXAMPLE}`);
        g.team = r.team;
        break;
      }
      case 'maxRounds': {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1 || n > 20) throw new ArgError(`Invalid value for ${name}: "${value}"`, 'Expected a whole number between 1 and 20');
        g.maxRounds = n;
        break;
      }
      case 'lines': {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) throw new ArgError(`Invalid value for ${name}: "${value}"`, 'Expected a positive whole number');
        f.lines = n;
        break;
      }
      case 'port': {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1 || n > 65535) throw new ArgError('Port must be 1–65535');
        f.port = n;
        break;
      }
      default:
        if (spec.scope === 'global') g[spec.key] = spec.takesValue ? value : true;
        else f[spec.key] = spec.takesValue ? value : true;
    }
  }

  // --team implies (and only makes sense with) custom mode; it also decides the developer.
  if (out.global.team) {
    if (out.global.mode && out.global.mode !== 'custom') {
      throw new ArgError(`--team only applies to --mode custom (got --mode ${out.global.mode})`, 'Drop --mode, or use --mode custom --team plan=…,dev=…,review=…');
    }
    if (out.global.developer && out.global.developer !== out.global.team.developer) {
      throw new ArgError(`--developer ${out.global.developer} conflicts with dev=${out.global.team.developer} in --team`, 'In custom mode the team decides who implements: drop --developer or change dev=.');
    }
    out.global.mode = 'custom';
  }

  if (out.command === 'help') { out.help = true; }
  if (out.command === 'version') { out.version = true; }
  return out;
}

/** Validates positional shapes per command; throws ArgError with usage hints. */
export function validateCommand(p: ParsedArgs): void {
  const pos = p.positionals;
  const usage = (u: string) => `Usage: ${u}`;
  switch (p.command) {
    case 'preview':
      if (!['start', 'list', 'stop', 'logs'].includes(pos[0])) throw new ArgError('Expected preview start|list|stop|logs');
      if (pos[0] === 'start' && pos.length < 2) throw new ArgError('A preview command is required', 'lina preview start "npm run dev -- --host 127.0.0.1 --port {port}" --session <id>');
      if ((pos[0] === 'stop' || pos[0] === 'logs') && pos.length !== 2) throw new ArgError('A preview id is required');
      if (pos[0] === 'list' && pos.length !== 1) throw new ArgError('preview list takes no positional arguments');
      break;
    case 'notify':
      if (pos[0] && !['status', 'setup', 'test', 'off', 'events'].includes(pos[0])) throw new ArgError(`Unknown notify command: ${pos[0]}`, usage('lina notify [status] | setup telegram [token] | test | events <list> | off'));
      break;
    case 'home':
      if (pos.length > 1 || (pos[0] && !['status', 'on', 'off'].includes(pos[0]))) throw new ArgError(`Unknown home command: ${pos.join(' ')}`, usage('lina home [status] | on [--host LAN_IP] [--port N] | off'));
      if ((p.flags.host || p.flags.port) && pos[0] !== 'on') throw new ArgError('--host/--port only apply to `lina home on`');
      break;
    case 'tailscale':
      if (pos.length > 1 || (pos[0] && !['status', 'on', 'off'].includes(pos[0]))) throw new ArgError(`Unknown tailscale command: ${pos.join(' ')}`, usage('lina tailscale [status] | on [--port N] [--email you@example.com] [--qr] | off'));
      break;
    case 'attach': if (pos.length > 1) throw new ArgError('Too many arguments for attach', usage('lina attach [sessionId]')); break;
    case 'sessions': case 'projects': case 'ui':
      if (pos.length) throw new ArgError(`Unexpected argument: ${pos[0]}`, usage(`lina ${p.command}`)); break;
    case 'add': if (pos.length !== 1) throw new ArgError('add needs exactly one path', usage('lina add <path> [--create] [--init-git] [--name <name>]')); break;
    case 'doctor': if (pos.length) throw new ArgError(`Unexpected argument: ${pos[0]}`, usage('lina doctor [--live]')); break;
    case 'settings': {
      const sub = pos[0];
      if (!sub) break;
      if (sub !== 'set') {
        const near = closest(sub, ['set'], 2);
        throw new ArgError(`Unknown settings subcommand: ${sub}`, near ? 'Did you mean `lina settings set`?' : usage('lina settings [--json] | lina settings set <key> <value>'));
      }
      if (pos.length < 3) throw new ArgError('settings set needs a key and a value', usage(`lina settings set ${SETTING_KEYS.join('|')} <value>`));
      parseSettingValue(pos[1], pos.slice(2).join(' '));
      break;
    }
    case 'models': {
      const sub = pos[0];
      if (!sub) break;
      if (sub === 'validate' || sub === 'set') {
        if (pos.length !== 3) throw new ArgError(`models ${sub} needs an agent and a model`, usage(`lina models ${sub} <codex|claude> <model>${sub === 'set' ? ' [--effort low|medium|high|xhigh|max]' : ''}`));
        oneOf('agent', pos[1], AGENTS);
        if (sub === 'validate' && p.flags.effort) throw new ArgError('--effort only applies to `lina models set`');
        break;
      }
      const near = closest(sub, ['validate', 'set'], 3);
      throw new ArgError(`Unknown models subcommand: ${sub}`, near ? `Did you mean \`lina models ${near}\`?` : usage('lina models [--refresh] | validate <agent> <model> | set <agent> <model> [--effort e]'));
    }
    case 'daemon': {
      const subs = ['start', 'stop', 'status', 'run', 'logs', 'restart'];
      const sub = pos[0];
      if (!sub) throw new ArgError('daemon needs a subcommand', usage('lina daemon start|stop|restart|status|run|logs'));
      if (!subs.includes(sub)) {
        const near = closest(sub, subs, 3);
        throw new ArgError(`Unknown daemon subcommand: ${sub}`, near ? `Did you mean \`lina daemon ${near}\`?` : usage('lina daemon start|stop|restart|status|run|logs'));
      }
      if (pos.length > 1) throw new ArgError(`Unexpected argument: ${pos[1]}`);
      if ((p.flags.follow || p.flags.lines) && sub !== 'logs') throw new ArgError('--follow/--lines only apply to `lina daemon logs`');
      break;
    }
    default: break;
  }
}

// ── `lina settings set <key> <value>` ─────────────────────────────────────────
export const SETTING_KEYS = ['access', 'mode', 'developer', 'max-rounds', 'team', 'test-sandbox', 'claude-sandbox'] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

/** Validates one `lina settings set` pair and returns the Settings patch it stands for. */
export function parseSettingValue(rawKey: string, value: string): { key: SettingKey; patch: Record<string, unknown> } {
  const aliases: Record<string, SettingKey> = { 'default-mode': 'mode', defaultmode: 'mode', maxrounds: 'max-rounds', testsandbox: 'test-sandbox', claudesandbox: 'claude-sandbox' };
  const k = rawKey.toLowerCase();
  const key = (SETTING_KEYS as readonly string[]).includes(k) ? (k as SettingKey) : aliases[k];
  if (!key) {
    const near = closest(k, SETTING_KEYS, 3);
    throw new ArgError(`Unknown setting: ${rawKey}`, `Settings: ${SETTING_KEYS.join(', ')}${near ? ` (did you mean "${near}"?)` : ''}`);
  }
  switch (key) {
    case 'access': return { key, patch: { accessMode: oneOf('access', value, ['full', 'restricted']) } };
    case 'mode': return { key, patch: { defaultMode: oneOf('mode', value, CLI_MODES) } };
    case 'developer': return { key, patch: { developer: oneOf('developer', value, AGENTS) } };
    case 'max-rounds': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 20) throw new ArgError(`Invalid value for max-rounds: "${value}"`, 'Expected a whole number between 1 and 20');
      return { key, patch: { maxRounds: n } };
    }
    case 'team': {
      const r = parseTeamSpec(value);
      if (!r.ok) throw new ArgError(`Invalid team: ${r.message}`, r.hint);
      return { key, patch: { team: r.team } };
    }
    case 'test-sandbox': return { key, patch: { testSandbox: oneOf('test-sandbox', value, SANDBOX_MODES) } };
    case 'claude-sandbox': return { key, patch: { claudeSandbox: oneOf('claude-sandbox', value, SANDBOX_MODES) } };
  }
}
