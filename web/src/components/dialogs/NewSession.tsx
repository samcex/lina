import { useEffect, useRef, useState } from 'react';
import { ArrowLeftRight, ChevronRight, FolderPlus, Sparkles } from 'lucide-react';
import type { AgentId, AgentModelChoice, Mode, TeamConfig } from '@shared/types';
import { AGENT_IDS, DEFAULT_SETTINGS, IMPLEMENTED_MODES } from '@shared/types';
import { useApp } from '../../lib/store';
import { useLina, asApiErr } from '../../lib/lina';
import { AGENT_NAME, EFFORT_LABEL, cx, other } from '../../lib/format';
import { Modal, Spinner } from '../ui/Overlay';
import { Glyph } from '../ui/Glyphs';
import { MODES, configForTeam, defaultTeam, roleLabel } from '../../lib/modes';
import { ValidationBadge } from '../ModelPicker';
import { TeamEditor } from '../TeamEditor';

export function NewSessionDialog() {
  const lina = useLina();
  const ns = useApp((s) => s.ui.newSession);
  const projects = useApp((s) => s.projects);
  const settings = useApp((s) => s.settings) ?? DEFAULT_SETTINGS;
  const models = useApp((s) => s.models);
  const currentProject = useApp((s) => s.view?.project.id);
  const open = ns !== false;

  const [projectId, setProjectId] = useState('');
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<Mode>('pair');
  const [developer, setDeveloper] = useState<AgentId>('codex');
  const [team, setTeam] = useState<TeamConfig>(() => defaultTeam('codex'));
  const [choice, setChoice] = useState<Record<AgentId, AgentModelChoice>>(DEFAULT_SETTINGS.models);
  const [advanced, setAdvanced] = useState(false);
  const [isolated, setIsolated] = useState(false);
  const [workflow, setWorkflow] = useState(false);
  const needsIsolation = mode === 'parallel' || mode === 'compete';
  const [maxRounds, setMaxRounds] = useState(3);
  const [network, setNetwork] = useState(false);
  const [testCommand, setTestCommand] = useState('');
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const pid = (ns && ns.projectId) || currentProject || projects[0]?.id || '';
    setProjectId(pid);
    const proj = projects.find((p) => p.id === pid);
    setWorkflow(false); setIsolated(false); setTitle(''); setPrompt(''); setError(null); setBusy(false); setAdvanced(false);
    setMode(proj?.settings.defaultMode && IMPLEMENTED_MODES.includes(proj.settings.defaultMode) ? proj.settings.defaultMode : settings.defaultMode);
    setDeveloper(settings.developer);
    setTeam(settings.team ?? defaultTeam(settings.developer));
    setChoice(settings.models);
    setMaxRounds(proj?.settings.maxRounds ?? settings.maxRounds);
    setNetwork(proj?.settings.network ?? false);
    setTestCommand(proj?.settings.testCommand ?? '');
  }, [open]);

  const close = () => lina.setUI({ newSession: false });
  const submit = async () => {
    if (!projectId || submitting.current) return;
    submitting.current = true;
    setBusy(true); setError(null);
    try {
      await lina.createSession({
        projectId, title: title.trim() || undefined, prompt: prompt.trim() || undefined,
        config: {
          ...(mode === 'custom' ? configForTeam(team) : { mode, developer, reviewer: other(developer) }),
          workspaceMode: needsIsolation || isolated ? 'isolated' : 'direct',
          interactionMode: needsIsolation || isolated || workflow ? 'workflow' : 'chat',
          models: choice, maxRounds, network, ...(testCommand.trim() ? { testCommand: testCommand.trim() } : {}),
        },
      });
      close();
    } catch (e) { setError(asApiErr(e).message); } finally { submitting.current = false; setBusy(false); }
  };

  return (
    <Modal open={open} onClose={close} title="New session" subtitle={needsIsolation || isolated ? "Agents work separately; approve to apply the result." : "Work directly in your project. Changes appear immediately and stay uncommitted."} icon={<Sparkles size={18} />} width={620}
      footer={<>
        <span className="foot-hint"><kbd>Ctrl</kbd>+<kbd>Enter</kbd> to start</span>
        <button className="btn btn-ghost" onClick={close}>Cancel</button>
        <button className="btn btn-primary" disabled={!projectId || busy} onClick={() => void submit()}>{busy ? <Spinner size={13} /> : <Sparkles size={14} />} {prompt.trim() ? 'Start session' : 'Create session'}</button>
      </>}>
      {projects.length === 0 ? (
        <div className="callout is-iris"><FolderPlus size={16} /><div><b>Add a project first.</b><p>Sessions run against a git project on this machine.</p>
          <button className="btn btn-sm" onClick={() => lina.setUI({ newSession: false, addProject: true })}>Add project</button></div></div>
      ) : (
        <form className="form" onSubmit={(e) => { e.preventDefault(); void submit(); }} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(); } }}>
          <div className="field-row">
            <label className="field">
              <span className="field-label">Project</span>
              <select className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            <label className="field">
              <span className="field-label">Title <em>optional</em></span>
              <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Derived from the task" />
            </label>
          </div>
          <label className="field">
            <span className="field-label">Task <em>optional — you can also write it in the chat</em></span>
            <textarea className="input textarea" rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="e.g. Add rate limiting to the /login endpoint with tests" data-autofocus />
          </label>

          <div className="field">
            <span className="field-label">Mode</span>
            <div className="mode-grid" role="radiogroup" aria-label="Collaboration mode">
              {MODES.map((m) => (
                <button type="button" key={m.id} role="radio" className={cx('mode-card', mode === m.id && 'is-on')} onClick={() => setMode(m.id)} aria-checked={mode === m.id}>
                  <m.icon size={15} /><b>{m.label}</b><small>{m.desc}</small>
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <span className="field-label">Team{mode === 'parallel' && <em>the first agent leads and splits the task</em>}</span>
            <div className="team">
              {(mode === 'custom' ? AGENT_IDS : [developer, other(developer)]).map((a, i) => {
                const cfg = mode === 'custom' ? configForTeam(team) : { mode, developer, reviewer: other(developer) };
                const r = roleLabel(a, cfg);
                const swappable = i === 1 && mode !== 'custom' && mode !== 'compete';
                return (
                  <div key={a} className="team-cell">
                    {i === 1 && (swappable
                      ? <button type="button" className="swap-btn swap-lg" onClick={() => setDeveloper(other(developer))} aria-label={mode === 'parallel' ? 'Swap lead' : 'Swap roles'} data-tip={mode === 'parallel' ? 'Swap lead' : 'Swap roles'}><ArrowLeftRight size={14} /></button>
                      : <span className="team-gap" aria-hidden="true">{mode === 'compete' ? 'vs' : ''}</span>)}
                    <div className={cx('team-slot', r.idle && 'is-dim')} data-agent={a}>
                      <div className="team-role">{r.label}</div>
                      <div className="team-agent"><Glyph actor={a} size={16} /> {AGENT_NAME[a]}</div>
                      <ModelSelect agent={a} value={choice[a]} onChange={(c) => setChoice((x) => ({ ...x, [a]: c }))} models={models?.[a]?.models ?? []} />
                    </div>
                  </div>
                );
              })}
            </div>
            {mode === 'custom' && <TeamEditor team={team} onChange={setTeam} />}
          </div>

          <button type="button" className="disclosure" onClick={() => setAdvanced((a) => !a)} aria-expanded={advanced}>
            <ChevronRight size={13} className={cx('chev', advanced && 'is-open')} /> Advanced
          </button>
          <label className="check check-inline">
            <input type="checkbox" checked={needsIsolation || isolated} disabled={needsIsolation} onChange={(e) => setIsolated(e.target.checked)} /><span className="check-box" />
            <span><b>Use an isolated workspace</b>{needsIsolation ? ' · required for this mode' : ' · review and approve before applying'}</span>
          </label>
          {advanced && (
            <div className="field-row">
              <label className="check check-inline">
                <input type="checkbox" checked={needsIsolation || isolated || workflow} disabled={needsIsolation || isolated} onChange={(e) => setWorkflow(e.target.checked)} /><span className="check-box" />
                <span><b>Structured workflow</b> · separate planning, implementation and review steps</span>
              </label>
              <label className="field"><span className="field-label">Max review rounds</span>
                <input className="input" type="number" min={1} max={10} value={maxRounds} onChange={(e) => setMaxRounds(Math.max(1, Math.min(10, +e.target.value || 1)))} /></label>
              <label className="field"><span className="field-label">Test command <em>blank = auto-detect</em></span>
                <input className="input mono" value={testCommand} onChange={(e) => setTestCommand(e.target.value)} placeholder="npm test" /></label>
              <label className="check check-inline">
                <input type="checkbox" disabled={settings.accessMode === 'full'} checked={settings.accessMode === 'full' || network} onChange={(e) => setNetwork(e.target.checked)} /><span className="check-box" />
                <span>{settings.accessMode === 'full' ? <><b>Full access</b> · filesystem, commands and network enabled</> : <><b>Allow network</b> for agent commands</>}</span>
              </label>
            </div>
          )}
          {error && <div className="callout is-bad"><div><b>{error}</b></div></div>}
          <button type="submit" hidden />
        </form>
      )}
    </Modal>
  );
}

function ModelSelect({ agent, value, onChange, models }: { agent: AgentId; value: AgentModelChoice; onChange: (c: AgentModelChoice) => void; models: { id: string; label: string; efforts?: string[]; defaultEffort?: string }[] }) {
  const known = models.some((m) => m.id === value.model);
  const sel = models.find((m) => m.id === value.model);
  return (
    <div className="msel">
      <select className="input input-sm" value={value.model} onChange={(e) => {
        const m = models.find((x) => x.id === e.target.value);
        onChange({ model: e.target.value, effort: (m?.efforts?.includes(value.effort ?? '') ? value.effort : m?.defaultEffort) as AgentModelChoice['effort'] });
      }} aria-label={`${AGENT_NAME[agent]} model`}>
        {!known && <option value={value.model}>{value.model}</option>}
        {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
      </select>
      {sel?.efforts?.length ? (
        <select className="input input-sm" value={value.effort ?? sel.defaultEffort ?? ''} onChange={(e) => onChange({ ...value, effort: e.target.value as AgentModelChoice['effort'] })} aria-label={`${AGENT_NAME[agent]} effort`}>
          {sel.efforts.map((e) => <option key={e} value={e}>{EFFORT_LABEL[e as keyof typeof EFFORT_LABEL] ?? e}</option>)}
        </select>
      ) : null}
      <ValidationBadge agent={agent} model={value.model} compact />
    </div>
  );
}

