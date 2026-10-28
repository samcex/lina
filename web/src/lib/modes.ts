// Mode / team / variant helpers shared by the header, dialogs, timeline and inspector.
import { Columns2, Compass, Puzzle, Swords, User, Users } from 'lucide-react';
import type { AgentId, AnyLinaEvent, LinaEvent, Mode, Phase, SessionConfig, TeamConfig } from '@shared/types';
import { AGENT_IDS, IMPLEMENTED_MODES, teamOf } from '@shared/types';
import { MODE_DESCRIPTION, MODE_LABEL } from '@shared/reducer';
import { AGENT_NAME, other } from './format';

export const MODE_ICON: Record<Mode, typeof Users> = {
  pair: Users, architect: Compass, solo: User, parallel: Columns2, compete: Swords, custom: Puzzle,
};

export const MODES: { id: Mode; label: string; desc: string; icon: typeof Users }[] = (
  ['pair', 'architect', 'solo', 'parallel', 'compete', 'custom'] as Mode[]
).filter((m) => IMPLEMENTED_MODES.includes(m)).map((id) => ({ id, label: MODE_LABEL[id], desc: MODE_DESCRIPTION[id], icon: MODE_ICON[id] }));

export const isTeamMode = (m: Mode) => m === 'pair' || m === 'architect' || m === 'solo' || m === 'custom';
export const isVariantMode = (m: Mode) => m === 'parallel' || m === 'compete';

/** "Codex's" */
export const poss = (a: AgentId) => `${AGENT_NAME[a]}'s`;

/** Architect-like default used when nothing better is known. */
export function defaultTeam(developer: AgentId): TeamConfig {
  const rev = other(developer);
  return { planner: developer, planCritic: rev, developer, reviewers: [rev] };
}

/** Keep config.developer/reviewer consistent with a custom team (the daemon mirrors them the same way). */
export function configForTeam(team: TeamConfig): Pick<SessionConfig, 'mode' | 'team' | 'developer' | 'reviewer'> {
  return { mode: 'custom', team, developer: team.developer, reviewer: team.reviewers[0] ?? other(team.developer) };
}

/** Short role label for an agent in a session configuration ("Develops", "Plans · Reviews", "Competes"…). */
export function roleLabel(agent: AgentId, cfg: Pick<SessionConfig, 'mode' | 'developer' | 'reviewer' | 'team'>): { label: string; idle: boolean } {
  switch (cfg.mode) {
    case 'compete': return { label: 'Competes', idle: false };
    case 'parallel': return { label: agent === cfg.developer ? 'Leads · builds' : 'Builds', idle: false };
    case 'solo': return agent === cfg.developer ? { label: 'Develops', idle: false } : { label: 'Standby', idle: true };
    case 'pair':
    case 'architect': return { label: agent === cfg.developer ? 'Develops' : 'Reviews', idle: false };
    default: {
      const t = teamOf(cfg);
      const parts: string[] = [];
      if (t.planner === agent) parts.push('Plans');
      if (t.planCritic === agent) parts.push('Critiques');
      if (t.developer === agent) parts.push('Develops');
      if (t.reviewers.includes(agent)) parts.push('Reviews');
      return parts.length ? { label: parts.join(' · '), idle: false } : { label: 'Standby', idle: true };
    }
  }
}

/** Who is "on stage" for a phase: tints rail nodes and phase dividers. 'lina' = both agents / LINA itself. */
export function actorForPhase(phase: Phase, cfg: Pick<SessionConfig, 'mode' | 'developer' | 'reviewer' | 'team'>): AgentId | 'lina' | 'user' {
  if (phase === 'awaiting_approval') return 'user';
  if (cfg.mode === 'compete') return 'lina';
  if (cfg.mode === 'parallel') return phase === 'planning' || phase === 'integrating' ? cfg.developer : 'lina';
  const t = teamOf(cfg);
  if (phase === 'planning') return t.planner ?? t.developer;
  if (phase === 'plan_review') return t.planCritic ?? cfg.reviewer;
  if (phase === 'implementing' || phase === 'revising') return t.developer;
  if (phase === 'reviewing') return t.reviewers.length === 1 ? t.reviewers[0] : t.reviewers.length ? 'lina' : cfg.reviewer;
  return 'lina';
}

/** One sentence describing who does what, for empty states. */
export function teamSentence(cfg: Pick<SessionConfig, 'mode' | 'developer' | 'reviewer' | 'team'>): string {
  const D = AGENT_NAME[cfg.developer], R = AGENT_NAME[cfg.reviewer];
  switch (cfg.mode) {
    case 'compete': return `${AGENT_IDS.map((a) => AGENT_NAME[a]).join(' and ')} each build it independently, then review each other. You pick the winner.`;
    case 'parallel': return `${D} splits the task; the agents build their parts at the same time and review each other's.`;
    case 'solo': return `${D} develops; LINA verifies the tests.`;
    case 'custom': {
      const t = teamOf(cfg);
      const bits = [t.planner && `${AGENT_NAME[t.planner]} plans`, t.planCritic && `${AGENT_NAME[t.planCritic]} critiques`, `${AGENT_NAME[t.developer]} develops`,
        t.reviewers.length ? `${t.reviewers.map((a) => AGENT_NAME[a]).join(' and ')} review${t.reviewers.length === 1 ? 's' : ''}` : 'no review'];
      return bits.filter(Boolean).join(', ') + '.';
    }
    default: return `${D} develops, ${R} reviews.`;
  }
}

/** Latest `turn` event per agent (to know which worktree an agent is working in right now). */
export function lastTurns(timeline: AnyLinaEvent[]): Partial<Record<AgentId, LinaEvent<'turn'>>> {
  const out: Partial<Record<AgentId, LinaEvent<'turn'>>> = {};
  for (let i = timeline.length - 1; i >= 0 && Object.keys(out).length < AGENT_IDS.length; i--) {
    const e = timeline[i];
    if (e.type === 'turn' && !out[e.data.agent]) out[e.data.agent] = e;
  }
  return out;
}

/** Text for an agent's activity in a worktree: "in Claude's worktree". */
export function worktreePhrase(variant: AgentId) { return `in ${poss(variant)} worktree`; }

/** "reviewing Claude's version" / "Codex's version" — the line of work a message or review is about. */
export function variantPhrase(actor: string, variant: AgentId, kind?: string, mode?: Mode): string {
  const noun = mode === 'parallel' ? 'part' : 'version';
  if (kind === 'review' && actor !== variant) return `reviewing ${poss(variant)} ${noun}`;
  if (actor === variant) return `on its own ${noun}`;
  return `about ${poss(variant)} ${noun}`;
}
