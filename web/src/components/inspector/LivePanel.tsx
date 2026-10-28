import { useMemo, useState } from 'react';
import type { AgentId } from '@shared/types';
import { AGENT_IDS } from '@shared/types';
import { STATUS_LABEL, type SessionView } from '@shared/reducer';
import { useNow } from '../../lib/hooks';
import { AGENT_NAME, cx, duration, tokens } from '../../lib/format';
import { Avatar } from '../ui/Glyphs';
import { AgentStatusIcon, isBusy } from '../ui/Status';
import { ActivityLegend, ActivityRow } from '../Activity';
import { VariantChip } from '../Variants';
import { lastTurns, roleLabel, worktreePhrase } from '../../lib/modes';
import type { LinaEvent } from '@shared/types';
import { useUI } from '../../lib/store';
import { useLina } from '../../lib/lina';

export function LivePanel({ view }: { view: SessionView }) {
  const selected = useUI((u) => u.liveAgent);
  const lina = useLina();
  const turns = useMemo(() => lastTurns(view.timeline), [view.timeline]);
  const allActive = AGENT_IDS.every((a) => isBusy(view.agents[a].status));
  return (
    <div className={cx('live', allActive && 'is-concurrent')}>
      <div className="seg" role="group" aria-label="Agent activity">
        <button className={cx('seg-item', selected === null && 'is-on')} aria-pressed={selected === null} onClick={() => lina.setUI({ liveAgent: null })}>All agents</button>
        {AGENT_IDS.map((agent) => <button key={agent} className={cx('seg-item', selected === agent && 'is-on')} aria-pressed={selected === agent} onClick={() => lina.inspectAgent(agent)}>{AGENT_NAME[agent]}</button>)}
      </div>
      {allActive && <div className="live-both">{AGENT_IDS.map((a) => <i key={a} data-agent={a} />)} All agents are working at the same time</div>}
      {AGENT_IDS.filter((a) => selected === null || a === selected).map((a) => <AgentPanel key={a} agent={a} view={view} turn={turns[a]} />)}
      <ActivityLegend />
    </div>
  );
}

type Filter = 'all' | 'observed' | 'narrated';

function AgentPanel({ agent, view, turn }: { agent: AgentId; view: SessionView; turn?: LinaEvent<'turn'> }) {
  const a = view.agents[agent];
  const cfg = view.session.config;
  const now = useNow(1000);
  const [filter, setFilter] = useState<Filter>('all');
  const busy = isBusy(a.status);
  const team = roleLabel(agent, cfg);
  // While a turn runs, show the role it runs as; otherwise the agent's place in the team.
  const roleText = busy && a.role ? (a.role === 'developer' ? 'Developer' : 'Reviewer') : team.label;
  const inTurn = turn?.data.state === 'start';
  const variant = turn?.data.variant;
  const model = a.model ?? cfg.models[agent].model;
  const u = view.session.usage[agent];
  const streams = Object.entries(view.streams).filter(([, stream]) => stream.agent === agent);
  const latestMessage = view.timeline.findLast((e) => e.type === 'message' && e.actor === agent);
  const list = a.activity.filter((x) => filter === 'all' || x.source === filter).slice().reverse();

  return (
    <section className={cx('agent-panel', busy && 'is-busy', `st-${a.status}`)} data-actor={agent} aria-label={`${AGENT_NAME[agent]} live status`}>
      <header className="ap-head">
        <Avatar actor={agent} size={34} live={busy} />
        <div className="ap-titles">
          <div className="ap-name">{AGENT_NAME[agent]} <span className={cx('role-tag', team.idle && !busy && 'is-idle')}>{roleText}</span></div>
          <div className="ap-model mono">{model}{cfg.models[agent].effort ? ` · ${cfg.models[agent].effort}` : ''}</div>
          {variant && (
            <div className="ap-wt">
              <VariantChip agent={variant} text={inTurn ? worktreePhrase(variant) : `last turn ${worktreePhrase(variant)}`}
                title={view.session.variants?.[variant]?.workspacePath} />
            </div>
          )}
        </div>
        {u && <div className="ap-usage mono" title="Input / output tokens this session">{tokens(u.inputTokens + u.outputTokens)} tok</div>}
      </header>
      <div className="ap-status" aria-live="polite">
        <AgentStatusIcon status={a.status} />
        <span className="ap-status-label">{STATUS_LABEL[a.status]}</span>
        {a.detail && <span className="ap-status-detail">{a.detail}</span>}
        <span className="ap-status-time mono" title="Time in this status">{duration(Math.max(0, now - a.since))}</span>
      </div>
      {(streams.length > 0 || latestMessage?.type === 'message') && (
        <div className="ap-updates" aria-label={`${AGENT_NAME[agent]} updates`}>
          <div className="panel-h">{streams.length ? 'Live update' : 'Latest update'}</div>
          {streams.length ? streams.map(([id, stream]) => <pre className="ap-update-text" key={id}>{stream.text || 'Waiting for output…'}</pre>)
            : latestMessage?.type === 'message' && <pre className="ap-update-text">{latestMessage.data.text}</pre>}
        </div>
      )}
      <div className="ap-filter seg seg-sm" role="radiogroup" aria-label="Activity filter">
        {(['all', 'observed', 'narrated'] as Filter[]).map((f) => (
          <button key={f} role="radio" aria-checked={filter === f} className={cx('seg-item', filter === f && 'is-on')} onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : f === 'observed' ? 'Observed' : 'Said'}
          </button>
        ))}
        <span className="ap-count">{a.activity.length}</span>
      </div>
      <ul className="act-list ap-feed">
        {list.length === 0 && <li className="ap-empty">{busy ? 'Waiting for the first event…' : 'No activity yet.'}</li>}
        {list.slice(0, 120).map((x) => <ActivityRow key={x.key} a={x} showTime />)}
      </ul>
    </section>
  );
}
