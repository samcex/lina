import { ArrowRight } from 'lucide-react';
import type { AgentId, TeamConfig } from '@shared/types';
import { AGENT_IDS } from '@shared/types';
import { PHASE_LABEL, pipelineFor } from '@shared/reducer';
import { AGENT_NAME, cx } from '../lib/format';
import { Glyph } from './ui/Glyphs';

type Slot = 'planner' | 'planCritic' | 'developer';

const ROWS: { key: Slot | 'reviewers'; label: string; hint: string; optional: boolean }[] = [
  { key: 'planner', label: 'Planner', hint: 'Drafts the plan before any code', optional: true },
  { key: 'planCritic', label: 'Plan critic', hint: 'Critiques the plan before coding', optional: true },
  { key: 'developer', label: 'Developer', hint: 'Writes the code and answers findings', optional: false },
  { key: 'reviewers', label: 'Reviewers', hint: '0–2, review concurrently, read-only', optional: true },
];

/** Compact editor for a custom team: who plans, who critiques, who implements, who reviews. */
export function TeamEditor({ team, onChange, showPipeline = true, compact }: {
  team: TeamConfig; onChange: (t: TeamConfig) => void; showPipeline?: boolean; compact?: boolean;
}) {
  const setSlot = (k: Slot, v: AgentId | null) => onChange({ ...team, [k]: v } as TeamConfig);
  const toggleReviewer = (a: AgentId) => {
    const has = team.reviewers.includes(a);
    const next = has ? team.reviewers.filter((x) => x !== a) : [...team.reviewers, a];
    onChange({ ...team, reviewers: AGENT_IDS.filter((x) => next.includes(x)).slice(0, 2) });
  };
  const steps = pipelineFor({ mode: 'custom', developer: team.developer, reviewer: team.reviewers[0] ?? team.developer, team });
  const selfReview = team.reviewers.includes(team.developer);
  return (
    <div className={cx('team-editor', compact && 'is-compact')}>
      {ROWS.map((r) => (
        <div key={r.key} className="te-row">
          <div className="te-label"><b>{r.label}</b>{!compact && <small>{r.hint}</small>}</div>
          {r.key === 'reviewers' ? (
            <div className="seg seg-sm" role="group" aria-label="Reviewers">
              {AGENT_IDS.map((a) => {
                const on = team.reviewers.includes(a);
                return (
                  <button key={a} type="button" aria-pressed={on} data-agent={a} className={cx('seg-item te-multi', on && 'is-on')} onClick={() => toggleReviewer(a)}>
                    <span className="te-box" aria-hidden="true" /><Glyph actor={a} size={12} /> {AGENT_NAME[a]}
                  </button>
                );
              })}
              {!team.reviewers.length && <span className="te-none">No review</span>}
            </div>
          ) : (
            <div className="seg seg-sm" role="radiogroup" aria-label={r.label}>
              {AGENT_IDS.map((a) => (
                <button key={a} type="button" role="radio" aria-checked={team[r.key as Slot] === a} data-agent={a}
                  className={cx('seg-item', team[r.key as Slot] === a && 'is-on')} onClick={() => setSlot(r.key as Slot, a)}>
                  <Glyph actor={a} size={12} /> {AGENT_NAME[a]}
                </button>
              ))}
              {r.optional && (
                <button type="button" role="radio" aria-checked={team[r.key as Slot] === null} className={cx('seg-item', team[r.key as Slot] === null && 'is-on')}
                  onClick={() => setSlot(r.key as Slot, null)}>None</button>
              )}
            </div>
          )}
        </div>
      ))}
      {selfReview && <p className="te-note">{AGENT_NAME[team.developer]} also reviews its own code — in a separate, read-only session.</p>}
      {showPipeline && (
        <ol className="te-pipeline" aria-label="Resulting workflow">
          {steps.map((p, i) => (
            <li key={p}>{i > 0 && <ArrowRight size={10} />}<span>{PHASE_LABEL[p].replace('Awaiting your approval', 'Your approval')}</span></li>
          ))}
        </ol>
      )}
    </div>
  );
}
