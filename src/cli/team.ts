// Custom-mode team specs: `plan=claude,critic=codex,dev=claude,review=codex+claude`.
// Parsing, validation (friendly errors), formatting and short role tags.
import { AGENT_IDS, peerOf, type AgentId, type Mode, type SessionConfig, type TeamConfig } from '../shared/types.js';
import { teamOf } from '../shared/types.js';
import { AGENT_NAME } from './theme.js';

const AGENT_LIST: AgentId[] = AGENT_IDS;

/** Stable panel positions include configured fallback agents, even outside the current team. */
export const PANEL_AGENT_ORDER: AgentId[] = ['codex', 'freebuff', 'claude'];
export function panelAgentsFor(cfg: Partial<SessionConfig>, models: Partial<SessionConfig['models']> | undefined = cfg.models): AgentId[] {
  const team = cfg.team;
  const present = new Set([cfg.developer, cfg.reviewer, ...(cfg.participants ?? []), team?.developer, team?.planner, team?.planCritic, ...(team?.reviewers ?? []), ...Object.keys(models ?? {})]);
  return PANEL_AGENT_ORDER.filter(a => present.has(a));
}


export type TeamKey = 'plan' | 'critic' | 'dev' | 'review';
export const TEAM_KEYS: TeamKey[] = ['plan', 'critic', 'dev', 'review'];

/** Accepted spellings for each key. */
const KEY_ALIASES: Record<string, TeamKey> = {
  plan: 'plan', planner: 'plan',
  critic: 'critic', plancritic: 'critic', 'plan-critic': 'critic', 'plan_review': 'critic', 'plan-review': 'critic', crit: 'critic',
  dev: 'dev', developer: 'dev', implement: 'dev', impl: 'dev',
  review: 'review', reviewers: 'review', reviewer: 'review', rev: 'review',
};

export const TEAM_SPEC_EXAMPLE = 'plan=claude,critic=codex,dev=claude,review=codex+claude';
export const TEAM_SPEC_HELP =
  `Spec: ${TEAM_SPEC_EXAMPLE} — plan/critic: ${AGENT_IDS.join('|')}|none · dev: ${AGENT_IDS.join('|')} · review: any two of ${AGENT_IDS.join(', ')} or none (comma or space separated; omitted keys use dev plans, the other agent critiques and reviews)`;

export type TeamParse = { ok: true; team: TeamConfig } | { ok: false; message: string; hint?: string };

function nearest(word: string, options: readonly string[]): string | undefined {
  // tiny edit distance, enough for typos like "cluade" / "reveiw"
  let best: string | undefined;
  let bestD = Infinity;
  for (const o of options) {
    const a = word, b = o;
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
    for (let j = 1; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    const d = dp[a.length][b.length];
    if (d < bestD) { bestD = d; best = o; }
  }
  return bestD <= 2 ? best : undefined;
}

function agentValue(key: string, v: string, allowNone: boolean): AgentId | null | { error: string; hint?: string } {
  const val = v.toLowerCase();
  if ((AGENT_LIST as string[]).includes(val)) return val as AgentId;
  if (allowNone && (val === 'none' || val === '-' || val === 'off')) return null;
  const opts = allowNone ? [...AGENT_LIST, 'none'] : AGENT_LIST;
  const near = nearest(val, opts);
  return { error: val ? `Unknown agent "${v}" for ${key}=` : `${key}= needs a value`, hint: `Expected ${opts.join(', ')}${near ? ` (did you mean "${near}"?)` : ''}` };
}

/**
 * Parses a team spec. Keys may come in any order, separated by commas or spaces.
 * Omitted keys default like the daemon's custom default: `dev` (or `fallbackDev`) plans,
 * the other agent critiques the plan and reviews.
 */
export function parseTeamSpec(spec: string, fallbackDev: AgentId = 'codex'): TeamParse {
  const tokens = spec.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean);
  if (!tokens.length) return { ok: false, message: 'Empty team spec', hint: TEAM_SPEC_HELP };
  const seen = new Map<TeamKey, string>();
  for (const tok of tokens) {
    const eq = tok.indexOf('=');
    if (eq < 0) {
      const near = nearest(tok.toLowerCase(), Object.keys(KEY_ALIASES));
      return { ok: false, message: `"${tok}" is not key=value`, hint: near ? `Did you mean ${KEY_ALIASES[near]}=…? ${TEAM_SPEC_HELP}` : TEAM_SPEC_HELP };
    }
    const rawKey = tok.slice(0, eq).toLowerCase();
    const key = KEY_ALIASES[rawKey];
    if (!key) {
      const near = nearest(rawKey, TEAM_KEYS);
      return { ok: false, message: `Unknown team role "${tok.slice(0, eq)}"`, hint: `Roles: plan, critic, dev, review${near ? ` (did you mean "${near}"?)` : ''}` };
    }
    if (seen.has(key)) return { ok: false, message: `${key}= is given twice` };
    seen.set(key, tok.slice(eq + 1));
  }

  let developer: AgentId = fallbackDev;
  if (seen.has('dev')) {
    const raw = seen.get('dev')!;
    const d = /^(none|-|off)$/i.test(raw) ? null : agentValue('dev', raw, false);
    if (d === null) return { ok: false, message: 'dev= cannot be none — someone has to write the code', hint: `dev=${AGENT_IDS.join(' or dev=')}` };
    if (typeof d === 'object') return { ok: false, message: d.error, hint: d.hint };
    developer = d;
  }
  const other: AgentId = peerOf(developer);

  const pick = (key: 'plan' | 'critic', def: AgentId | null): AgentId | null | TeamParse => {
    if (!seen.has(key)) return def;
    const v = agentValue(key, seen.get(key)!, true);
    if (v !== null && typeof v === 'object') return { ok: false, message: v.error, hint: v.hint };
    return v;
  };
  const planner = pick('plan', developer);
  if (planner && typeof planner === 'object') return planner;
  const planCritic = pick('critic', other);
  if (planCritic && typeof planCritic === 'object') return planCritic;

  let reviewers: AgentId[] = [other];
  if (seen.has('review')) {
    const raw = seen.get('review')!.toLowerCase();
    reviewers = [];
    if (raw !== '' && raw !== 'none' && raw !== '-' && raw !== 'off') {
      for (const part of raw.split('+').map((s) => s.trim())) {
        const v = agentValue('review', part, false);
        if (v === null || typeof v === 'object') return { ok: false, message: (v as { error: string }).error, hint: (v as { hint?: string }).hint ?? `review=${AGENT_IDS[0]}+${AGENT_IDS[1]}, review=${AGENT_IDS[0]} or review=none` };
        if (reviewers.includes(v)) return { ok: false, message: `${AGENT_NAME[v]} is listed twice in review=`, hint: 'Reviewers must be distinct' };
        reviewers.push(v);
      }
    }
  }
  const team: TeamConfig = { planner: planner as AgentId | null, planCritic: planCritic as AgentId | null, developer, reviewers };
  const problem = validateTeam(team);
  return problem ? { ok: false, ...problem } : { ok: true, team };
}

/** Same rules as the daemon: known agents, 0–2 distinct reviewers, planner/critic an agent or null. */
export function validateTeam(t: TeamConfig): { message: string; hint?: string } | undefined {
  const isAgent = (a: unknown) => (AGENT_LIST as unknown[]).includes(a);
  if (!isAgent(t.developer)) return { message: `Unknown developer "${String(t.developer)}"` };
  if (t.planner !== null && !isAgent(t.planner)) return { message: `Unknown planner "${String(t.planner)}"` };
  if (t.planCritic !== null && !isAgent(t.planCritic)) return { message: `Unknown plan critic "${String(t.planCritic)}"` };
  if (!Array.isArray(t.reviewers) || t.reviewers.length > 2) return { message: 'At most two reviewers', hint: `review=${AGENT_IDS[0]}+${AGENT_IDS[1]}` };
  if (new Set(t.reviewers).size !== t.reviewers.length) return { message: 'Reviewers must be distinct', hint: `review=${AGENT_IDS[0]}+${AGENT_IDS[1]}` };
  for (const r of t.reviewers) if (!isAgent(r)) return { message: `Unknown reviewer "${String(r)}"` };
  return undefined;
}

/** Canonical spec string (round-trips through parseTeamSpec). */
export function formatTeamSpec(t: TeamConfig): string {
  return `plan=${t.planner ?? 'none'},critic=${t.planCritic ?? 'none'},dev=${t.developer},review=${t.reviewers.length ? t.reviewers.join('+') : 'none'}`;
}

/** One-line human summary: "Claude plans · Codex critiques · Claude builds · Codex + Claude review". */
export function teamSummary(t: TeamConfig): string {
  const n = (a: AgentId) => AGENT_NAME[a];
  const parts: string[] = [];
  parts.push(t.planner ? `${n(t.planner)} plans` : 'no plan');
  if (t.planCritic) parts.push(`${n(t.planCritic)} critiques the plan`);
  parts.push(`${n(t.developer)} builds`);
  parts.push(t.reviewers.length ? `${t.reviewers.map(n).join(' + ')} review${t.reviewers.length === 1 ? 's' : ''}` : 'no review');
  return parts.join(' · ');
}

/** Mirrors the daemon: config.developer = team.developer, reviewer = first reviewer or the other agent. */
export function rolesForTeam(t: TeamConfig): { developer: AgentId; reviewer: AgentId } {
  return { developer: t.developer, reviewer: t.reviewers[0] ?? peerOf(t.developer) };
}

/** Team used when switching to custom without an explicit one: current team › saved default › architect-like. */
export function defaultTeam(cfg: Partial<Pick<SessionConfig, 'developer' | 'reviewer' | 'team'>>, saved?: TeamConfig): TeamConfig {
  if (cfg.team) return cfg.team;
  if (saved) return saved;
  const dev: AgentId = cfg.developer ?? 'codex';
  const rev: AgentId = cfg.reviewer && cfg.reviewer !== dev ? cfg.reviewer : peerOf(dev);
  return teamOf({ mode: 'custom', developer: dev, reviewer: rev });
}

/**
 * Short role tags for an agent in the header ("dev", "rev", "plan+dev+rev", "lead", "rival").
 * pair/architect/solo keep the classic dev/rev/idle wording.
 */
export function roleTags(agent: AgentId, cfg: Pick<SessionConfig, 'mode' | 'developer' | 'reviewer' | 'team'>): string {
  const mode: Mode = cfg.mode;
  if (mode === 'compete') return 'rival';
  if (mode === 'parallel') return agent === cfg.developer ? 'lead' : 'part';
  if (mode !== 'custom') return agent === cfg.developer ? 'dev' : mode === 'solo' || agent !== cfg.reviewer ? 'idle' : 'rev';
  const t = teamOf(cfg);
  const tags: string[] = [];
  if (t.planner === agent) tags.push('plan');
  if (t.planCritic === agent) tags.push('crit');
  if (t.developer === agent) tags.push('dev');
  if (t.reviewers.includes(agent)) tags.push('rev');
  return tags.length ? tags.join('+') : 'idle';
}

// ── completion ───────────────────────────────────────────────────────────────
/** Completions for the last token of a team spec ("plan=cl" → ["plan=claude"], "cr" → ["critic="]). */
export function teamTokenSuggestions(token: string, used: string[] = []): string[] {
  const comma = token.lastIndexOf(',');
  const head = token.slice(0, comma + 1);
  const seg = token.slice(comma + 1).toLowerCase();
  const usedKeys = new Set([...used, ...head.split(',')].map((t) => KEY_ALIASES[t.split('=')[0]?.toLowerCase() ?? '']).filter(Boolean));
  const eq = seg.indexOf('=');
  if (eq < 0) return TEAM_KEYS.filter((k) => k.startsWith(seg) && !usedKeys.has(k)).map((k) => `${head}${k}=`);
  const key = KEY_ALIASES[seg.slice(0, eq)];
  if (!key) return [];
  const partial = seg.slice(eq + 1);
  const values = key === 'dev' ? AGENT_LIST : key === 'review' ? [...AGENT_LIST, ...AGENT_IDS.flatMap(a => AGENT_IDS.filter(b => b !== a).map(b => `${a}+${b}`)), 'none'] : [...AGENT_LIST, 'none'];
  return values.filter((v) => v.startsWith(partial) && v !== partial).map((v) => `${head}${seg.slice(0, eq)}=${v}`);
}
