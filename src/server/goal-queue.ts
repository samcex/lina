import type { GoalDeferredIssue } from '../shared/types.js';

export interface GoalTask { key: string; task: string; evidence: string }
export interface GoalQueueDecision {
  next: GoalTask | null;
  waiting: { key: string; reason: string; kind?: 'evidence' | 'owner' }[];
  resolved: { key: string; evidence: string }[];
  complete: boolean;
}

/** A deferred issue must be retained or explicitly resolved, never silently dropped. */
export function parseGoalQueue(text: string, previous: GoalDeferredIssue[]): GoalQueueDecision {
  const blocks = [...text.matchAll(/```lina-goal-queue\s*\n([\s\S]*?)```/g)];
  if (blocks.length !== 1) throw new Error('Expected one lina-goal-queue block');
  const d = JSON.parse(blocks[0][1]);
  const value = (s: unknown, max = 4000): s is string => typeof s === 'string' && !!s.trim() && s.length <= max;
  const key = (s: unknown): s is string => typeof s === 'string' && /^[a-z0-9][a-z0-9_-]{0,79}$/.test(s);
  if (!d || typeof d.complete !== 'boolean' || !Array.isArray(d.waiting) || !Array.isArray(d.resolved) || d.waiting.length > 24 || d.resolved.length > 24) throw new Error('Invalid queue schema');
  if (d.next !== null && (!d.next || !key(d.next.key) || !value(d.next.task, 10000) || !value(d.next.evidence))) throw new Error('Next task needs scope evidence');
  if (d.waiting.some((w: any) => !w || !key(w.key) || !value(w.reason) || (w.kind !== undefined && !['evidence','owner'].includes(w.kind))) || d.resolved.some((r: any) => !r || !key(r.key) || !value(r.evidence))) throw new Error('Invalid deferred issue or resolution');
  const keys = [...d.waiting, ...d.resolved, ...(d.next ? [d.next] : [])].map((x) => x.key);
  if (new Set(keys).size !== keys.length) throw new Error('Queue items have conflicting or duplicate keys');
  const covered = new Set([...d.waiting, ...d.resolved, ...(d.next ? [d.next] : [])].map((x) => x.key));
  if (previous.some((p) => !covered.has(p.key))) throw new Error('A deferred issue was silently dropped');
  if (d.resolved.some((r: any) => !previous.some((p) => p.key === r.key))) throw new Error('Resolution references an unknown deferred issue');
  if (d.complete ? d.next !== null || d.waiting.length > 0 : !d.next && !d.waiting.length) throw new Error('Completion contradicts remaining work');
  return d;
}

export function deferredIssues(decision: GoalQueueDecision, previous: GoalDeferredIssue[], now: number): GoalDeferredIssue[] {
  const issues: GoalDeferredIssue[] = decision.waiting.map(({ key, reason, kind }) => {
    const prior = previous.find((p) => p.key === key);
    const attempts = (prior?.attempts ?? 0) + 1;
    return { key, reason, kind: kind ?? prior?.kind ?? 'evidence', attempts, retryAt: now + Math.min(60 * 60_000, 15 * 60_000 * 2 ** Math.min(2, attempts - 1)) };
  });
  const promoted = previous.find((p) => p.key === decision.next?.key);
  if (promoted) issues.push({ ...promoted, active: true });
  return issues;
}
