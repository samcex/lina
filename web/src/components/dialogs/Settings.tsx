import { useEffect, useState } from 'react';
import { CircleCheck, CircleX, RefreshCw, Settings2, Stethoscope, TriangleAlert, Cpu, SlidersHorizontal, Moon, Sun } from 'lucide-react';
import type { DoctorCheck, Settings } from '@shared/types';
import { AGENT_IDS, DEFAULT_SETTINGS } from '@shared/types';
import { MODE_DESCRIPTION } from '@shared/reducer';
import { useApp } from '../../lib/store';
import { useLina, asApiErr } from '../../lib/lina';
import { AGENT_NAME, cx } from '../../lib/format';
import { Modal, Skeleton, Spinner } from '../ui/Overlay';
import { Glyph } from '../ui/Glyphs';
import { ModelChooser } from '../ModelPicker';
import { MODES, defaultTeam } from '../../lib/modes';
import { TeamEditor } from '../TeamEditor';
import { forgetToken } from '../../lib/auth';

type Tab = 'general' | 'models' | 'doctor';

export function SettingsDialog() {
  const lina = useLina();
  const which = useApp((s) => s.ui.settings);
  const settings = useApp((s) => s.settings);
  const theme = useApp((s) => s.ui.theme);
  const open = which !== false;
  const [tab, setTab] = useState<Tab>('general');
  const [draft, setDraft] = useState<Settings>(settings ?? DEFAULT_SETTINGS);
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (open) { setTab(which || 'general'); setDraft(settings ?? DEFAULT_SETTINGS); } }, [open]); // eslint-disable-line
  const close = () => lina.setUI({ settings: false });
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings ?? DEFAULT_SETTINGS);
  const save = async () => {
    setSaving(true);
    const ok = await lina.saveSettings(draft);
    setSaving(false);
    if (ok) lina.toast({ tone: 'ok', title: 'Settings saved', detail: 'Access changes apply from the next turn; other defaults apply to new sessions.' });
  };
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const TABS: { id: Tab; label: string; icon: typeof Cpu }[] = [
    { id: 'general', label: 'Defaults', icon: SlidersHorizontal },
    { id: 'models', label: 'Models', icon: Cpu },
    { id: 'doctor', label: 'Doctor', icon: Stethoscope },
  ];

  return (
    <Modal open={open} onClose={close} title="Settings" subtitle="Global defaults for new sessions, model validation and environment health." icon={<Settings2 size={18} />} width={720} className="settings"
      footer={tab !== 'doctor' ? <>
        {!settings && <span className="foot-hint">Settings could not be loaded from the daemon.</span>}
        <button className="btn btn-ghost" onClick={close}>Close</button>
        <button className="btn btn-primary" disabled={!dirty || saving || !settings} onClick={() => void save()}>{saving && <Spinner size={13} />} Save defaults</button>
      </> : undefined}>
      <div className="settings-tabs seg" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={cx('seg-item', tab === t.id && 'is-on')} onClick={() => setTab(t.id)}>
            <t.icon size={13} /> {t.label}
          </button>
        ))}
      </div>

      {tab === 'general' && (
        <div className="form">
          <div className="field">
            <span className="field-label">This device</span>
            <button className="btn btn-ghost" type="button" onClick={() => { forgetToken(); window.location.replace('/'); }}>Forget this device</button>
            <span className="field-hint">Remove this browser's saved access token and disconnect from LINA.</span>
          </div>
          <div className="field">
            <span className="field-label">Default mode</span>
            <div className="seg seg-modes" role="radiogroup" aria-label="Default mode">
              {MODES.map((m) => (
                <button key={m.id} type="button" role="radio" aria-checked={draft.defaultMode === m.id} className={cx('seg-item', draft.defaultMode === m.id && 'is-on')} onClick={() => set('defaultMode', m.id)} title={m.desc}><m.icon size={13} /> {m.label}</button>
              ))}
            </div>
            <span className="field-hint">{MODE_DESCRIPTION[draft.defaultMode]}</span>
          </div>
          <div className="field-row">
            <div className="field">
              <span className="field-label">Default developer</span>
              <div className="seg">
                {AGENT_IDS.map((a) => (
                  <button key={a} type="button" className={cx('seg-item', draft.developer === a && 'is-on')} data-agent={a} onClick={() => set('developer', a)}>
                    <Glyph actor={a} size={13} /> {AGENT_NAME[a]}
                  </button>
                ))}
              </div>
              <span className="field-hint">The other agent reviews. In Parallel mode the developer leads.</span>
            </div>
            <div className="field">
              <span className="field-label">Default custom team</span>
              <TeamEditor compact showPipeline={false} team={draft.team ?? defaultTeam(draft.developer)} onChange={(t) => set('team', t)} />
            </div>
          </div>
          <div className="field-row field-row-3">
            <label className="field"><span className="field-label">Max review rounds</span>
              <input className="input" type="number" min={1} max={10} value={draft.maxRounds} onChange={(e) => set('maxRounds', Math.max(1, Math.min(10, +e.target.value || 1)))} /></label>
            <label className="field"><span className="field-label">Turn timeout <em>min</em></span>
              <input className="input" type="number" min={1} max={240} value={Math.round(draft.turnTimeoutMs / 60000)} onChange={(e) => set('turnTimeoutMs', Math.max(1, +e.target.value || 1) * 60000)} /></label>
            <label className="field"><span className="field-label">Idle timeout <em>min</em></span>
              <input className="input" type="number" min={1} max={120} value={Math.round(draft.idleTimeoutMs / 60000)} onChange={(e) => set('idleTimeoutMs', Math.max(1, +e.target.value || 1) * 60000)} /></label>
          </div>
          <label className="field">
            <span className="field-label">Developer access</span>
            <select className="input" value={draft.accessMode} onChange={(e) => set('accessMode', e.target.value as Settings['accessMode'])}>
              <option value="full">Full access</option>
              <option value="restricted">Restricted</option>
            </select>
            <span className="field-hint">Full access runs developers and tests with your user account's filesystem, command and network permissions, without approval prompts. Applies from the next turn in existing and new sessions. Reviewers remain read-only.</span>
          </label>
          <div className="field sbx-setting">
            <span className="field-label">Test sandbox</span>
            <div className="seg" role="radiogroup" aria-label="Test sandbox">
              {(['auto', 'on', 'off'] as const).map((v) => (
                <button key={v} type="button" disabled={draft.accessMode === 'full'} role="radio" aria-checked={draft.testSandbox === v} className={cx('seg-item', draft.testSandbox === v && 'is-on')} onClick={() => set('testSandbox', v)}>
                  {v === 'auto' ? 'Auto' : v === 'on' ? 'On' : 'Off'}
                </button>
              ))}
            </div>
            <p className="field-hint sbx-explain">
              In Restricted mode, LINA can run your project's tests inside a <b>bubblewrap</b> sandbox: the filesystem is read-only except the workspace, and there is no network unless the session allows it. Full access runs tests without this sandbox.{' '}
              {draft.testSandbox === 'auto' ? <><b>Auto</b> uses the sandbox when it works on this machine and otherwise runs the tests unsandboxed — those runs are labelled <em>Not sandboxed</em>.</>
                : draft.testSandbox === 'on' ? <><b>On</b> never runs tests unsandboxed: if the sandbox cannot start, the tests are not run.</>
                : <><b>Off</b> runs every test command with your normal permissions; each run is labelled <em>Not sandboxed</em>.</>}
            </p>
          </div>
          <div className="field-row">
            <div className="field">
              <span className="field-label">Claude OS sandbox</span>
              <div className="seg">
                {(['auto', 'on', 'off'] as const).map((v) => (
                  <button key={v} type="button" disabled={draft.accessMode === 'full'} className={cx('seg-item', draft.claudeSandbox === v && 'is-on')} onClick={() => set('claudeSandbox', v)}>{v === 'auto' ? 'Auto' : v === 'on' ? 'On' : 'Off'}</button>
                ))}
              </div>
              <span className="field-hint">Used in Restricted mode. Auto uses the sandbox when the doctor confirmed it works.</span>
            </div>
            <div className="field">
              <span className="field-label">Theme</span>
              <div className="seg">
                <button type="button" className={cx('seg-item', theme === 'dark' && 'is-on')} onClick={() => { lina.setTheme('dark'); set('theme', 'dark'); }}><Moon size={13} /> Dark</button>
                <button type="button" className={cx('seg-item', theme === 'light' && 'is-on')} onClick={() => { lina.setTheme('light'); set('theme', 'light'); }}><Sun size={13} /> Light</button>
              </div>
              <span className="field-hint">Applies instantly.</span>
            </div>
          </div>
        </div>
      )}

      {tab === 'models' && (
        <div className="settings-models">
          <p className="field-hint">Default models for new sessions. LINA never assumes a model is available — use <b>Validate</b> to run a tiny real request.</p>
          <div className="settings-models-grid">
            {AGENT_IDS.map((a) => (
              <div key={a} className="settings-model-card" data-agent={a}>
                <ModelChooser agent={a} value={draft.models[a]} onChange={(c) => set('models', { ...draft.models, [a]: c })} />
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'doctor' && <Doctor />}
    </Modal>
  );
}

function Doctor() {
  const lina = useLina();
  const [checks, setChecks] = useState<DoctorCheck[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const run = async (live = false) => {
    setLoading(true); setError(null);
    try { setChecks((await lina.client.doctor(live)).checks); } catch (e) { setError(asApiErr(e).message); } finally { setLoading(false); }
  };
  useEffect(() => { void run(); }, []); // eslint-disable-line
  const bad = checks?.filter((c) => !c.ok && !c.warn).length ?? 0;
  const warn = checks?.filter((c) => c.warn).length ?? 0;
  return (
    <div className="doctor">
      <div className="doctor-head">
        <div className={cx('doctor-verdict', bad ? 'is-bad' : warn ? 'is-warn' : checks ? 'is-ok' : '')}>
          {!checks ? 'Running checks…' : bad ? `${bad} problem${bad === 1 ? '' : 's'} found` : warn ? `Healthy, ${warn} warning${warn === 1 ? '' : 's'}` : 'All systems healthy'}
        </div>
        <button className="btn btn-sm btn-ghost" onClick={() => void run(true)} disabled={loading} data-tip="Also runs tiny real requests against both CLIs">Live probe</button>
        <button className="btn btn-sm" onClick={() => void run()} disabled={loading}>{loading ? <Spinner size={12} /> : <RefreshCw size={13} />} Re-run</button>
      </div>
      {error && <div className="callout is-bad"><TriangleAlert size={16} /><div><b>{error}</b></div></div>}
      {!checks && !error && <div className="panel-skel">{[70, 55, 80, 62].map((w, i) => <Skeleton key={i} w={`${w}%`} h={14} />)}</div>}
      <ul className="checks">
        {checks?.map((c) => (
          <li key={c.id} className={cx('check-row', c.ok && !c.warn ? 'is-ok' : c.warn ? 'is-warn' : 'is-bad')}>
            <span className="check-icon">{c.ok && !c.warn ? <CircleCheck size={16} /> : c.warn ? <TriangleAlert size={16} /> : <CircleX size={16} />}</span>
            <div className="check-main">
              <div className="check-label">{c.label}</div>
              <div className="check-detail">{c.detail}</div>
              {c.hint && <div className="check-hint">{c.hint}</div>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
