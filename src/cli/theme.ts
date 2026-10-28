// LINA terminal visual identity. Hex colors are used both through Ink's color
// props (chalk degrades them) and through our own ANSI helpers (ansi.ts degrades).
import { AGENT_LABEL, type Actor, type ActivityKind, type AgentId, type Severity } from '../shared/types.js';

export const C = {
  lina: '#A78BFA',
  linaDeep: '#7C3AED',
  linaSoft: '#C4B5FD',
  codex: '#2DD4BF',
  codexDim: '#0F766E',
  codexSoft: '#99F6E4',
  claude: '#FB923C',
  claudeDim: '#9A4A1F',
  claudeSoft: '#FDBA74',
  freebuff: '#A3E635',
  freebuffDim: '#4D7C0F',
  freebuffSoft: '#D9F99D',
  user: '#F4F4F5',
  text: '#E4E4E7',
  muted: '#8B8B96',
  faint: '#52525B',
  border: '#3F3F46',
  ok: '#4ADE80',
  err: '#F87171',
  warn: '#FBBF24',
  info: '#60A5FA',
  codeFg: '#E9D5FF',
  blocker: '#EF4444',
  major: '#F97316',
  minor: '#EAB308',
  nit: '#9CA3AF',
  ink: '#18181B',
} as const;

export const AGENT_NAME: Record<AgentId, string> = AGENT_LABEL;

export function actorColor(a: Actor | 'lina'): string {
  switch (a) {
    case 'codex': return C.codex;
    case 'claude': return C.claude;
    case 'freebuff': return C.freebuff;
    case 'lina': return C.lina;
    default: return C.user;
  }
}

export function actorDim(a: Actor): string {
  return a === 'codex' ? C.codexDim : a === 'claude' ? C.claudeDim : a === 'freebuff' ? C.freebuffDim : a === 'lina' ? C.linaDeep : C.faint;
}

export function actorName(a: Actor): string {
  return a === 'user' ? 'You' : a === 'lina' ? 'LINA' : AGENT_NAME[a];
}

export const SEVERITY_COLOR: Record<Severity, string> = { blocker: C.blocker, major: C.major, minor: C.minor, nit: C.nit };
export const SEVERITY_ORDER: Severity[] = ['blocker', 'major', 'minor', 'nit'];

export const ACTIVITY_ICON: Record<ActivityKind, string> = {
  command: '$', read: '▸', search: '⌕', edit: '✎', write: '✚', web: '⌁', tool: '⊞', test: '⚑', git: '⎇', note: '•',
};

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
