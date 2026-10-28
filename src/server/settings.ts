// Global settings stored in the db (k='settings'), merged over DEFAULT_SETTINGS.
import {
  AGENT_IDS, DEFAULT_SETTINGS, IMPLEMENTED_MODES, type AgentId, type AgentModelChoice, type Effort, type Settings, type TeamConfig,
} from '../shared/types.js';
import type { Db } from './db.js';
import { LinaError } from './util.js';

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export function isAgentId(x: unknown): x is AgentId {
  return typeof x === 'string' && (AGENT_IDS as string[]).includes(x);
}

export function validateModelChoice(agent: string, c: unknown): AgentModelChoice {
  if (!c || typeof c !== 'object') throw new LinaError(`Invalid model choice for ${agent}`, 'invalid');
  const m = (c as { model?: unknown }).model;
  const e = (c as { effort?: unknown }).effort;
  if (typeof m !== 'string' || !m.trim() || m.trim().startsWith('/')) throw new LinaError(`Model for ${agent} must be a model ID, not a slash command`, 'invalid');
  if (e !== undefined && e !== null && !(EFFORTS as unknown[]).includes(e)) throw new LinaError(`Invalid effort for ${agent}: ${String(e)}`, 'invalid');
  return e ? { model: m.trim(), effort: e as Effort } : { model: m.trim() };
}

/** Validates a partial models record (unknown agent ids are rejected). */
export function validateModels(models: unknown): Partial<Record<AgentId, AgentModelChoice>> {
  if (!models || typeof models !== 'object') throw new LinaError('models must be an object', 'invalid');
  const out: Partial<Record<AgentId, AgentModelChoice>> = {};
  for (const [k, v] of Object.entries(models)) {
    if (!isAgentId(k)) throw new LinaError(`Unknown agent: ${k}`, 'invalid');
    out[k] = validateModelChoice(k, v);
  }
  return out;
}

/**
 * Validates a custom-mode team: known agents, 0–2 distinct reviewers, planner/planCritic an agent or null
 * (a plan critic needs a planner: there is nothing to critique otherwise).
 */
export function validateTeam(t: unknown): TeamConfig {
  if (!t || typeof t !== 'object' || Array.isArray(t)) throw new LinaError('team must be an object', 'invalid');
  const o = t as Record<string, unknown>;
  if (!isAgentId(o.developer)) throw new LinaError(`Unknown agent for team.developer: ${String(o.developer)}`, 'invalid');
  const opt = (v: unknown, name: string): AgentId | null => {
    if (v === null || v === undefined) return null;
    if (!isAgentId(v)) throw new LinaError(`Unknown agent for team.${name}: ${String(v)}`, 'invalid');
    return v;
  };
  const planner = opt(o.planner, 'planner');
  const planCritic = opt(o.planCritic, 'planCritic');
  if (planCritic && !planner) throw new LinaError('team.planCritic needs a planner', 'invalid');
  const reviewers = o.reviewers === undefined || o.reviewers === null ? [] : o.reviewers;
  if (!Array.isArray(reviewers)) throw new LinaError('team.reviewers must be an array', 'invalid');
  if (reviewers.length > 2) throw new LinaError('team.reviewers takes at most 2 agents', 'invalid');
  for (const r of reviewers) if (!isAgentId(r)) throw new LinaError(`Unknown agent in team.reviewers: ${String(r)}`, 'invalid');
  if (new Set(reviewers).size !== reviewers.length) throw new LinaError('team.reviewers must be distinct agents', 'invalid');
  return { planner, planCritic, developer: o.developer, reviewers: [...reviewers] as AgentId[] };
}

export function getSettings(db: Db): Settings {
  const stored = db.getSetting<Partial<Settings>>('settings') ?? {};
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    models: {
      codex: { ...DEFAULT_SETTINGS.models.codex, ...stored.models?.codex },
      claude: { ...DEFAULT_SETTINGS.models.claude, ...stored.models?.claude },
      freebuff: { ...DEFAULT_SETTINGS.models.freebuff, ...stored.models?.freebuff },
    },
  };
}

export function putSettings(db: Db, patch: Partial<Settings>): Settings {
  if (!patch || typeof patch !== 'object') throw new LinaError('Body must be an object', 'invalid');
  const cur = getSettings(db);
  const next: Settings = { ...cur };
  if (patch.reaEnabled !== undefined) {
    if (typeof patch.reaEnabled !== 'boolean') throw new LinaError('reaEnabled must be boolean', 'invalid');
    next.reaEnabled = patch.reaEnabled;
  }
  if (patch.accessMode !== undefined) {
    if (!['full', 'restricted'].includes(patch.accessMode)) throw new LinaError('accessMode must be full|restricted', 'invalid');
    next.accessMode = patch.accessMode;
  }
  if (patch.models !== undefined) {
    const m = validateModels(patch.models);
    next.models = { ...cur.models, ...m };
  }
  if (patch.developer !== undefined) {
    if (!isAgentId(patch.developer)) throw new LinaError('Unknown agent for developer', 'invalid');
    next.developer = patch.developer;
  }
  if (patch.defaultMode !== undefined) {
    if (!IMPLEMENTED_MODES.includes(patch.defaultMode)) throw new LinaError(`Mode not implemented: ${patch.defaultMode}`, 'invalid');
    next.defaultMode = patch.defaultMode;
  }
  if (patch.maxRounds !== undefined) next.maxRounds = intIn(patch.maxRounds, 1, 20, 'maxRounds');
  if (patch.turnTimeoutMs !== undefined) next.turnTimeoutMs = intIn(patch.turnTimeoutMs, 10_000, 24 * 3600_000, 'turnTimeoutMs');
  if (patch.idleTimeoutMs !== undefined) next.idleTimeoutMs = intIn(patch.idleTimeoutMs, 5_000, 24 * 3600_000, 'idleTimeoutMs');
  if (patch.claudeSandbox !== undefined) {
    if (!['auto', 'on', 'off'].includes(patch.claudeSandbox)) throw new LinaError('claudeSandbox must be auto|on|off', 'invalid');
    next.claudeSandbox = patch.claudeSandbox;
  }
  if (patch.testSandbox !== undefined) {
    if (!['auto', 'on', 'off'].includes(patch.testSandbox)) throw new LinaError('testSandbox must be auto|on|off', 'invalid');
    next.testSandbox = patch.testSandbox;
  }
  if (patch.team !== undefined) {
    if (patch.team === null) delete next.team;
    else next.team = validateTeam(patch.team);
  }
  if (patch.remoteOrigins !== undefined) {
    if (patch.remoteOrigins === null || (Array.isArray(patch.remoteOrigins) && !patch.remoteOrigins.length)) delete next.remoteOrigins;
    else next.remoteOrigins = validateRemoteOrigins(patch.remoteOrigins);
  }
  if (patch.tailnetUsers !== undefined) {
    if (patch.tailnetUsers === null || (Array.isArray(patch.tailnetUsers) && !patch.tailnetUsers.length)) delete next.tailnetUsers;
    else next.tailnetUsers = validateTailnetUsers(patch.tailnetUsers);
  }
  if (patch.theme !== undefined) {
    if (!['dark', 'light'].includes(patch.theme)) throw new LinaError('theme must be dark|light', 'invalid');
    next.theme = patch.theme;
  }
  db.setSetting('settings', next);
  return next;
}

/** `https://host[:port]` origins only (normalized; no path, query or credentials), at most 8. */
export function validateRemoteOrigins(v: unknown): string[] {
  if (!Array.isArray(v)) throw new LinaError('remoteOrigins must be an array of https origins', 'invalid');
  if (v.length > 8) throw new LinaError('remoteOrigins takes at most 8 origins', 'invalid');
  const out = new Set<string>();
  for (const x of v) {
    let u: URL;
    try { u = new URL(String(x)); } catch { throw new LinaError(`Invalid remote origin: ${String(x)}`, 'invalid'); }
    if (u.protocol !== 'https:' || u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) {
      throw new LinaError(`Remote origin must look like https://host[:port]: ${String(x)}`, 'invalid');
    }
    out.add(u.origin);
  }
  return [...out];
}

/** Tailscale login names: email-like, lowercased, at most 8. */
export function validateTailnetUsers(v: unknown): string[] {
  if (!Array.isArray(v)) throw new LinaError('tailnetUsers must be an array of emails', 'invalid');
  if (v.length > 8) throw new LinaError('tailnetUsers takes at most 8 emails', 'invalid');
  const out = new Set<string>();
  for (const x of v) {
    const e = typeof x === 'string' ? x.trim().toLowerCase() : '';
    if (!/^[^\s@]+@[^\s@]+$/.test(e)) throw new LinaError(`Not a Tailscale login email: ${String(x)}`, 'invalid');
    out.add(e);
  }
  return [...out];
}

export function intIn(v: unknown, min: number, max: number, name: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new LinaError(`${name} must be an integer between ${min} and ${max}`, 'invalid');
  }
  return v;
}
