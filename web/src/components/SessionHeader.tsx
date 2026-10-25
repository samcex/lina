import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeftRight, BarChart3, Check, ChevronDown, FlaskRound, GitBranch, PanelLeft, PanelRight, Pause, Play, RotateCcw, Square, Menu,
} from 'lucide-react';
import type { AgentId, Mode, Session, SessionConfig } from '@shared/types';
import { AGENT_IDS, teamOf } from '@shared/types';
import type { SessionView } from '@shared/reducer';
import { useApp, useUI } from '../lib/store';
import { useLina } from '../lib/lina';
import { AGENT_NAME, SESSION_STATUS_LABEL, cx, relTime, tokens, usd, windowLabel } from '../lib/format';
import { modKey } from '../lib/hooks';
import { PhaseRail } from './PhaseRail';
import { AgentModelPill } from './ModelPicker';
import { Popover } from './ui/Popover';
import { Glyph } from './ui/Glyphs';
import { isBusy } from './ui/Status';
import { MODES, configForTeam, roleLabel } from '../lib/modes';
import { TeamEditor } from './TeamEditor';
import { VariantChip } from './Variants';

export function SessionHeader({ view }: { view: SessionView }) {
  const lina = useLina();
  const conn = useApp((s) => s.conn);
  const settings = useApp((s) => s.settings);
  const sidebarOpen = useUI((u) => u.sidebarOpen);
  const inspectorOpen = useUI((u) => u.inspectorOpen);
  const { session, project } = view;
  const cfg = session.config;
  const mode = MODES.find((m) => m.id === cfg.mode) ?? MODES[0];

  return (
    <header className="shead">
      <div className="shead-row">
        {!sidebarOpen && (
          <button className="icon-btn" onClick={() => lina.toggleSidebar()} aria-label="Show sidebar" data-tip={`Sidebar (${modKey}+B)`}>
            <PanelLeft size={17} className="only-wide" /><Menu size={17} className="only-narrow" />
          </button>
        )}
        <div className="shead-titles">
          <TitleEditor session={session} />
          <div className="shead-sub">
            <span className="shead-project" title={project.path}>{project.name}</span>
            <span className="sep">/</span>
            <span className="shead-branch mono" title={`${cfg.workspaceMode === 'direct' ? 'Working directly in' : 'Isolated workspace:'} ${session.workspacePath}`}><GitBranch size={12} /> {cfg.workspaceMode === 'direct' ? 'Direct · ' : ''}{session.branch}</span>
            <span className="sep">·</span>
            <span className="shead-status" data-status={session.status}>{SESSION_STATUS_LABEL[session.status]}</span>
            {cfg.workspaceMode === 'direct' && <button className="tag" disabled={session.status === 'running'} title="Switch between natural chat and the structured playbook" onClick={() => void lina.updateConfig({ interactionMode: cfg.interactionMode === 'workflow' ? 'chat' : 'workflow' })}>{cfg.interactionMode === 'workflow' ? 'Workflow' : 'Chat'}</button>}
            {settings && <span className="tag" title="Developer access; reviewers remain read-only">{settings.accessMode === 'full' ? 'Full access' : 'Restricted'}</span>}
            {session.pendingMessages > 0 && <span className="tag tag-iris">{session.pendingMessages} queued</span>}
            {session.chosenVariant && <VariantChip agent={session.chosenVariant} text={`${session.chosenVariant === 'codex' ? 'Codex' : 'Claude'}'s version chosen`} />}
          </div>
        </div>
        <div className="shead-right">
          {(session.mock || cfg.mock) && (
            <span className="tag tag-warn mock-badge" data-tip="Scripted mock agents — no real Codex/Claude calls"><FlaskRound size={12} /> Mock</span>
          )}
          <span className={cx('conn', `is-${conn}`)} data-tip={conn === 'open' ? 'Live connection to the LINA daemon' : conn === 'connecting' ? 'Connecting…' : 'Disconnected — retrying'}>
            <i />{conn === 'open' ? 'Live' : conn === 'connecting' ? 'Connecting' : 'Offline'}
          </span>
          <UsageMeter view={view} />
          <Controls session={session} />
          <button className={cx('icon-btn', inspectorOpen && 'is-on')} onClick={() => lina.toggleInspector()} aria-label="Toggle inspector" aria-pressed={inspectorOpen} data-tip={`Inspector (${modKey}+I)`}>
            <PanelRight size={17} />
          </button>
        </div>
      </div>

      <div className="shead-row shead-row2">
        <Popover
          trigger={({ open, toggle }) => (
            <button className={cx('mode-chip', open && 'is-open')} onClick={toggle} aria-haspopup="menu" aria-expanded={open} aria-label={`Mode: ${mode.label}`}>
              <mode.icon size={13} /> {mode.label} <ChevronDown size={12} />
            </button>
          )}
          width={340}
        >
          {(close) => (
            <div className="menu mode-menu" role="menu">
              <div className="menu-label">Collaboration mode</div>
              {MODES.map((m) => (
                <button key={m.id} role="menuitemradio" aria-checked={m.id === cfg.mode}
                  className={cx('menu-item', m.id === cfg.mode && 'is-active')}
                  onClick={() => {
                    if (m.id === cfg.mode) { if (m.id !== 'custom') close(); return; }
                    if (m.id !== 'custom') close();
                    void lina.updateConfig(modePatch(m.id, cfg, settings?.team), `Mode set to ${m.label}`);
                  }}>
                  <m.icon size={15} />
                  <span className="menu-item-main"><span>{m.label}</span><small>{m.desc}</small></span>
                  {m.id === cfg.mode ? <Check size={14} /> : null}
                </button>
              ))}
              {cfg.mode === 'custom' && (
                <div className="menu-team">
                  <div className="menu-label">Team</div>
                  <TeamEditor compact team={teamOf(cfg)} onChange={(t) => void lina.updateConfig(configForTeam(t))} />
                </div>
              )}
              <div className="menu-note">Applies from the next task or turn.</div>
            </div>
          )}
        </Popover>

        <PhaseRail phase={view.phase} status={session.status} cfg={cfg} round={view.round} timeline={view.timeline} />

        <div className="agent-pair">
          {AGENT_IDS.map((a, i) => {
            const r = roleLabel(a, cfg);
            const swappable = cfg.mode !== 'custom' && cfg.mode !== 'compete';
            return (
              <div key={a} className="agent-pair-slot">
                {i === 1 && (swappable ? (
                  <button className="swap-btn" onClick={() => lina.swapRoles()} aria-label={cfg.mode === 'parallel' ? 'Swap the lead' : 'Swap developer and reviewer roles'}
                    data-tip={cfg.mode === 'parallel' ? `Swap lead · ${AGENT_NAME[cfg.reviewer]} leads` : `Swap roles · ${AGENT_NAME[cfg.reviewer]} develops`}>
                    <ArrowLeftRight size={13} />
                  </button>
                ) : <span className="swap-gap" aria-hidden="true">{cfg.mode === 'compete' ? 'vs' : '+'}</span>)}
                <AgentModelPill
                  agent={a} role={r.label} value={cfg.models[a]} dim={r.idle} live={isBusy(view.agents[a].status)}
                  onInspect={() => lina.inspectAgent(a)}
                  onChange={(c) => void lina.updateConfig({ models: { ...cfg.models, [a]: c } as Session['config']['models'] }, `${AGENT_NAME[a]} → ${c.model}${c.effort ? ` · ${c.effort}` : ''}`)}
                />
              </div>
            );
          })}
        </div>
      </div>
    </header>
  );
}

/** Config patch for switching mode from the header (custom needs a team). */
function modePatch(mode: Mode, cfg: SessionConfig, defaultTeam?: SessionConfig['team']): Partial<SessionConfig> {
  if (mode === 'custom') return configForTeam(cfg.team ?? defaultTeam ?? teamOf(cfg));
  return { mode };
}

function TitleEditor({ session }: { session: Session }) {
  const lina = useLina();
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(session.title);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!editing) setVal(session.title); }, [session.title, editing]);
  useEffect(() => { if (editing) { ref.current?.focus(); ref.current?.select(); } }, [editing]);
  const commit = () => { setEditing(false); if (val.trim() && val.trim() !== session.title) void lina.rename(val.trim()); };
  if (editing) {
    return (
      <input
        ref={ref} className="shead-title-input" value={val} onChange={(e) => setVal(e.target.value)} aria-label="Session title"
        onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { e.stopPropagation(); setVal(session.title); setEditing(false); } }}
        maxLength={140}
      />
    );
  }
  return (
    <h1 className="shead-title">
      <button onClick={() => setEditing(true)} title="Rename session">{session.title || 'Untitled session'}</button>
    </h1>
  );
}

function Controls({ session }: { session: Session }) {
  const lina = useLina();
  const [confirmCancel, setConfirmCancel] = useState(false);
  useEffect(() => { if (!confirmCancel) return; const t = setTimeout(() => setConfirmCancel(false), 3500); return () => clearTimeout(t); }, [confirmCancel]);
  const st = session.status;
  const canResume = st === 'paused' || st === 'interrupted' || st === 'failed' || st === 'cancelled';
  return (
    <div className="controls">
      {st === 'running' && (
        <button className="btn btn-sm" onClick={() => void lina.control('pause')} data-tip="Stop at the next turn boundary"><Pause size={13} /> Pause</button>
      )}
      {canResume && (
        <button className="btn btn-sm btn-accent" onClick={() => void lina.control('resume')} data-tip="Continue from the last step"><Play size={13} /> Resume</button>
      )}
      {st === 'failed' && (
        <button className="btn btn-sm" onClick={() => void lina.control('retry')} data-tip="Re-run the failed step"><RotateCcw size={13} /> Retry</button>
      )}
      {(st === 'running' || st === 'paused') && (
        <button className={cx('btn btn-sm', confirmCancel ? 'btn-danger' : 'btn-ghost')}
          onClick={() => { if (confirmCancel) { setConfirmCancel(false); void lina.control('cancel'); } else setConfirmCancel(true); }}
          data-tip="Kill the running turn now and stop">
          <Square size={12} /> {confirmCancel ? 'Confirm cancel' : 'Cancel'}
        </button>
      )}
    </div>
  );
}

function UsageMeter({ view }: { view: SessionView }) {
  const usage = view.session.usage;
  const total = AGENT_IDS.reduce((n, a) => n + (usage[a]?.inputTokens ?? 0) + (usage[a]?.outputTokens ?? 0), 0);
  const cost = AGENT_IDS.reduce((n, a) => n + (usage[a]?.costUsd ?? 0), 0);
  const claudeRl = view.rateLimits.claude;
  const windows = claudeRl ? Object.entries(claudeRl.windows) : [];
  const brief = windows.slice(0, 2).map(([k, w]) => `${windowLabel(k)} ${Math.round(w.utilization * 100)}%`).join(' · ');
  return (
    <Popover
      align="end" width={340}
      trigger={({ open, toggle }) => (
        <button className={cx('usage-btn', open && 'is-open')} onClick={toggle} aria-label="Usage details" aria-expanded={open}>
          <BarChart3 size={13} />
          <span className="mono">{tokens(total)}</span>
          {brief && <span className="usage-rl" data-agent="claude">{brief}</span>}
        </button>
      )}
    >
      <div className="usage">
        <div className="usage-title">Usage this session</div>
        {AGENT_IDS.map((a) => <UsageRow key={a} agent={a} view={view} />)}
        <div className="usage-total">
          <span>Total</span><span className="mono">{tokens(total)} tokens</span>
          <span className="usage-cost" title="What these tokens would cost on the pay-as-you-go API. Subscription users are not billed this.">≈ {usd(cost)} API-equivalent</span>
        </div>
        {AGENT_IDS.map((a) => {
          const rl = view.rateLimits[a];
          if (!rl || !Object.keys(rl.windows).length) return null;
          return (
            <div key={a} className="usage-rl-block" data-agent={a}>
              <div className="usage-sub"><Glyph actor={a} size={12} /> {AGENT_NAME[a]} subscription windows <span className="text-dim">· {relTime(rl.observedAt)}</span></div>
              {Object.entries(rl.windows).map(([k, w]) => {
                const pct = Math.round(w.utilization * 100);
                return (
                  <div key={k} className="meter-row">
                    <span className="meter-label">{windowLabel(k)}</span>
                    <span className={cx('meter', pct >= 90 ? 'is-bad' : pct >= 70 && 'is-warn')}><i style={{ width: `${Math.min(100, pct)}%` }} /></span>
                    <span className="meter-val mono">{pct}%</span>
                    {w.resetsAt && <span className="meter-reset">resets {new Date(w.resetsAt * (w.resetsAt < 1e12 ? 1000 : 1)).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </Popover>
  );
}

function UsageRow({ agent, view }: { agent: AgentId; view: SessionView }) {
  const u = view.session.usage[agent];
  if (!u) return null;
  return (
    <div className="usage-row" data-agent={agent}>
      <span className="usage-agent"><Glyph actor={agent} size={13} /> {AGENT_NAME[agent]}</span>
      <span className="usage-nums mono">
        <span title="Input tokens">↑ {tokens(u.inputTokens)}</span>
        <span title="Output tokens">↓ {tokens(u.outputTokens)}</span>
        {u.cachedInputTokens > 0 && <span title="Cached input tokens" className="text-dim">⟳ {tokens(u.cachedInputTokens)}</span>}
      </span>
      <span className="usage-turns">{u.turns} turn{u.turns === 1 ? '' : 's'}</span>
    </div>
  );
}
