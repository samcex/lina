import { AGENT_LABEL, peerOf, type Actor, type AgentId, type Effort, type SessionStatus } from '@shared/types';

export const AGENT_NAME: Record<Actor, string> = { user: 'You', lina: 'LINA', ...AGENT_LABEL };
export const other = (a: AgentId): AgentId => peerOf(a);

export function relTime(ts: number, now = Date.now()): string {
  const d = Math.max(0, now - ts);
  const s = Math.round(d / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
export function fullTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function duration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export function tokens(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function usd(n: number): string {
  if (n === 0) return '$0';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(n < 10 ? 2 : 1)}`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const EFFORT_LABEL: Record<Effort, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'X-High', max: 'Max', ultra: 'Ultra' };

/** "five_hour" → "5h", "seven_day" → "7d", "seven_day_opus" → "7d opus" */
export function windowLabel(key: string): string {
  const words: Record<string, string> = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', twelve: '12', thirty: '30' };
  const m = key.match(/^([a-z]+|\d+)_(hour|day|week|month|minute)s?(?:_(.+))?$/);
  if (!m) return key.replace(/_/g, ' ');
  const n = words[m[1]] ?? m[1];
  const unit = { hour: 'h', day: 'd', week: 'w', month: 'mo', minute: 'm' }[m[2] as 'hour'];
  return `${n}${unit}${m[3] ? ' ' + m[3].replace(/_/g, ' ') : ''}`;
}

export const SESSION_STATUS_LABEL: Record<SessionStatus, string> = {
  idle: 'Ready', running: 'Running', paused: 'Paused', awaiting_approval: 'Awaiting approval', completed: 'Completed', approved: 'Approved',
  rejected: 'Rejected', cancelled: 'Cancelled', failed: 'Failed', interrupted: 'Interrupted',
};

export function shortSha(c?: string) { return c ? c.slice(0, 7) : ''; }

export function basename(p: string) { const i = p.replace(/\/+$/, '').lastIndexOf('/'); return i >= 0 ? p.slice(i + 1) : p; }
export function dirname(p: string) { const i = p.lastIndexOf('/'); return i > 0 ? p.slice(0, i) : ''; }

export function cx(...parts: (string | false | null | undefined)[]): string { return parts.filter(Boolean).join(' '); }

export function langFromPath(path: string): string | undefined {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  const name = basename(path).toLowerCase();
  if (name === 'dockerfile') return 'dockerfile';
  if (name === 'makefile') return 'makefile';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    json: 'json', jsonl: 'json', md: 'markdown', mdx: 'markdown', py: 'python', sh: 'bash', bash: 'bash', zsh: 'bash', css: 'css', scss: 'css',
    html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', go: 'go', rs: 'rust', sql: 'sql',
    diff: 'diff', patch: 'diff',
  };
  return map[ext];
}
