import { Check } from 'lucide-react';
import type { AnyLinaEvent, Phase, SessionConfig, SessionStatus } from '@shared/types';
import { teamOf } from '@shared/types';
import { PHASE_LABEL, pipelineFor } from '@shared/reducer';
import { cx } from '../lib/format';
import { actorForPhase } from '../lib/modes';

const SHORT: Partial<Record<Phase, string>> = {
  planning: 'Plan', plan_review: 'Critique', implementing: 'Build', testing: 'Test', reviewing: 'Review',
  revising: 'Revise', integrating: 'Merge', verifying: 'Verify', awaiting_approval: 'Approve',
};

export function PhaseRail({
  phase, status, cfg, round, timeline,
}: {
  phase: Phase; status: SessionStatus; cfg: SessionConfig; round: number; timeline: AnyLinaEvent[];
}) {
  const steps = pipelineFor(cfg);
  let effective: Phase = phase;
  if (!steps.includes(phase)) {
    // terminal/off-pipeline: anchor on the last pipeline phase we saw
    for (let i = timeline.length - 1; i >= 0; i--) {
      const e = timeline[i];
      if (e.type === 'phase' && steps.includes(e.data.phase)) { effective = e.data.phase; break; }
    }
  }
  const approved = phase === 'approved' || phase === 'completed';
  const idx = approved ? steps.length : steps.indexOf(effective);
  const halted = ['failed', 'cancelled', 'interrupted', 'rejected', 'paused'].includes(status) || ['failed', 'cancelled', 'interrupted', 'rejected'].includes(phase);
  const running = status === 'running';
  const pct = idx < 0 ? 0 : Math.min(100, ((idx + (approved ? 0 : 0.5)) / steps.length) * 100);
  const curActor = idx >= 0 && idx < steps.length ? actorForPhase(steps[idx], cfg) : 'lina';
  const reviews = cfg.mode === 'parallel' || cfg.mode === 'compete' || teamOf(cfg).reviewers.length > 0;

  return (
    <div className={cx('rail', running && 'is-running', halted && 'is-halted')} role="group" aria-label={`Workflow: ${PHASE_LABEL[phase]}`}>
      <ol className="rail-steps">
        {steps.map((p, i) => {
          const state = i < idx ? 'done' : i === idx ? 'current' : 'todo';
          return (
            <li key={p} className={cx('rail-step', `is-${state}`)} data-actor={state === 'current' ? curActor : undefined} aria-current={state === 'current' ? 'step' : undefined}>
              <span className="rail-node">{state === 'done' ? <Check size={10} strokeWidth={3} /> : null}</span>
              <span className="rail-label" title={PHASE_LABEL[p]}>{SHORT[p] ?? PHASE_LABEL[p]}</span>
              {i < steps.length - 1 && <span className="rail-link" />}
            </li>
          );
        })}
      </ol>
      <div className="rail-compact" aria-hidden="true">
        <span className="rail-compact-label" data-actor={curActor}>{PHASE_LABEL[phase]}</span>
        <span className="rail-compact-bar"><i style={{ width: `${pct}%` }} /></span>
      </div>
      {round > 0 && reviews && (
        <span className="rail-round" data-tip={`Review round ${round} of at most ${cfg.maxRounds}`}>
          <b>{round}</b>/{cfg.maxRounds}
        </span>
      )}
    </div>
  );
}
