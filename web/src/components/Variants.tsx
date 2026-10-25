import { GitBranch, ShieldCheck, ShieldOff } from 'lucide-react';
import type { AgentId, Session } from '@shared/types';
import { AGENT_IDS } from '@shared/types';
import { useLina } from '../lib/lina';
import { useUI, type Worktree } from '../lib/store';
import { AGENT_NAME, cx } from '../lib/format';
import { poss } from '../lib/modes';
import { Glyph } from './ui/Glyphs';

/** Agents that have a worktree in this session (parallel/compete). */
export function variantAgents(session: Session): AgentId[] {
  const v = session.variants;
  return v ? AGENT_IDS.filter((a) => v[a]) : [];
}

/** The worktree the workspace views should show (ignores a stale choice if the session has no such worktree). */
export function useWorktree(session: Session): Worktree {
  const wt = useUI((u) => u.worktree);
  return wt && session.variants?.[wt] ? wt : null;
}

/** Small agent-coloured chip naming a worktree / candidate: "Codex's worktree", "reviewing Claude's version"… */
export function VariantChip({ agent, text, title }: { agent: AgentId; text?: string; title?: string }) {
  return (
    <span className="vchip" data-agent={agent} title={title}>
      <GitBranch size={11} />{text ?? `${poss(agent)} worktree`}
    </span>
  );
}

/** "Sandboxed" vs "Not sandboxed" for LINA's own test runs. */
export function SandboxBadge({ sandboxed, compact }: { sandboxed: boolean; compact?: boolean }) {
  return sandboxed ? (
    <span className="sbx is-on" title="LINA ran the tests in a bubblewrap sandbox: read-only filesystem except the workspace, no network unless allowed.">
      <ShieldCheck size={12} />{compact ? 'sandboxed' : 'Sandboxed'}
    </span>
  ) : (
    <span className="sbx is-off" title="This run was NOT sandboxed: the test command had normal access to your machine (sandbox off, or unavailable here with testSandbox=auto).">
      <ShieldOff size={12} />{compact ? 'not sandboxed' : 'Not sandboxed'}
    </span>
  );
}

/** Session / Codex's / Claude's — switches which worktree the files, diff and changed-file views show. */
export function WorktreeSwitcher({ session, className }: { session: Session; className?: string }) {
  const lina = useLina();
  const wt = useWorktree(session);
  const agents = variantAgents(session);
  if (!agents.length) return null;
  const set = (w: Worktree) => { if (w !== wt) lina.setUI({ worktree: w, diffRange: null, filePath: null }); };
  return (
    <div className={cx('seg seg-sm wt-switch', className)} role="radiogroup" aria-label="Worktree">
      <button role="radio" aria-checked={wt === null} className={cx('seg-item', wt === null && 'is-on')} onClick={() => set(null)}
        title={session.chosenVariant ? `Session branch (now ${poss(session.chosenVariant)} version)` : 'The session workspace (integrated / chosen result)'}>
        Session
      </button>
      {agents.map((a) => (
        <button key={a} role="radio" aria-checked={wt === a} data-agent={a} className={cx('seg-item', wt === a && 'is-on')} onClick={() => set(a)}
          title={`${poss(a)} worktree · ${session.variants?.[a]?.branch ?? ''}`}>
          <Glyph actor={a} size={11} /> {AGENT_NAME[a]}'s
        </button>
      ))}
    </div>
  );
}
