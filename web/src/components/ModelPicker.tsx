import { useState } from 'react';
import { Check, ChevronDown, CircleCheck, CircleX, RefreshCw, ShieldQuestion, TriangleAlert } from 'lucide-react';
import type { AgentId, AgentModelChoice, Effort, ModelInfo, ModelValidation } from '@shared/types';
import { useApp } from '../lib/store';
import { useLina } from '../lib/lina';
import { AGENT_NAME, EFFORT_LABEL, cx, relTime } from '../lib/format';
import { Popover } from './ui/Popover';
import { Glyph } from './ui/Glyphs';
import { Spinner } from './ui/Overlay';

const SOURCE_LABEL: Record<ModelInfo['source'], string> = { catalog: 'Catalog', alias: 'Aliases', observed: 'Seen in runs', custom: 'Custom' };
const SOURCE_ORDER: ModelInfo['source'][] = ['catalog', 'alias', 'observed', 'custom'];

export function useValidation(agent: AgentId, model: string, info?: ModelInfo): { checking: boolean; result?: ModelValidation } {
  const v = useApp((s) => s.validations[`${agent}:${model}`]);
  if (v?.state === 'checking') return { checking: true };
  if (v?.state === 'done') return { checking: false, result: v.result };
  return { checking: false, result: info?.validation };
}

export function ValidationBadge({ agent, model, info, compact }: { agent: AgentId; model: string; info?: ModelInfo; compact?: boolean }) {
  const { checking, result } = useValidation(agent, model, info);
  if (checking) return <span className="vbadge is-checking"><Spinner size={11} />{!compact && ' Validating…'}</span>;
  if (!result) return <span className="vbadge is-none" title="Availability has not been checked">{compact ? '·' : 'not validated'}</span>;
  if (result.ok) {
    return (
      <span className="vbadge is-ok" title={`Validated ${relTime(result.checkedAt)}${result.resolvedModel ? ` → ${result.resolvedModel}` : ''}`}>
        <CircleCheck size={12} />{!compact && (result.resolvedModel && result.resolvedModel !== model ? ` ${result.resolvedModel}` : ' available')}
      </span>
    );
  }
  return <span className="vbadge is-bad" title={result.error}><CircleX size={12} />{!compact && ' unavailable'}</span>;
}

/** Full model chooser body (used in the header popover and in Settings). */
export function ModelChooser({ agent, value, onChange, note }: {
  agent: AgentId; value: AgentModelChoice; onChange: (c: AgentModelChoice) => void; note?: string;
}) {
  const lina = useLina();
  const catalog = useApp((s) => s.models?.[agent]);
  const loading = useApp((s) => s.modelsLoading);
  const modelsError = useApp((s) => s.modelsError);
  const [custom, setCustom] = useState('');
  const models = catalog?.models ?? [];
  const selected = models.find((m) => m.id === value.model);
  const { checking, result } = useValidation(agent, value.model, selected);
  const efforts = selected?.efforts ?? [];

  const groups = SOURCE_ORDER.map((src) => ({ src, list: models.filter((m) => m.source === src) })).filter((g) => g.list.length);

  return (
    <div className="mc" data-agent={agent}>
      <div className="mc-head">
        <span className="mc-agent"><Glyph actor={agent} size={15} /> {AGENT_NAME[agent]}</span>
        <span className="mc-cli">
          {catalog ? (catalog.installed ? `CLI ${catalog.version ?? 'installed'}` : <span className="text-bad">CLI not found</span>) : null}
        </span>
        <button className="icon-btn icon-btn-sm" onClick={() => void lina.loadModels(true)} data-tip="Re-discover models" aria-label="Refresh model list" disabled={loading}>
          {loading ? <Spinner size={12} /> : <RefreshCw size={13} />}
        </button>
      </div>
      {catalog?.error && <div className="mc-warn"><TriangleAlert size={13} /> {catalog.error}</div>}
      {modelsError && !catalog && <div className="mc-warn"><TriangleAlert size={13} /> {modelsError}</div>}

      <div className="mc-list" role="listbox" aria-label={`${AGENT_NAME[agent]} models`}>
        {!catalog && loading && <div className="mc-loading"><Spinner size={13} /> Discovering models…</div>}
        {groups.map((g) => (
          <div key={g.src} className="mc-group">
            <div className="mc-group-label">{SOURCE_LABEL[g.src]}</div>
            {g.list.map((m) => {
              const active = m.id === value.model;
              return (
                <button
                  key={m.id} role="option" aria-selected={active} className={cx('mc-item', active && 'is-active')}
                  onClick={() => onChange({ model: m.id, effort: m.efforts?.includes(value.effort as Effort) ? value.effort : m.defaultEffort })}
                >
                  <span className="mc-check">{active && <Check size={13} />}</span>
                  <span className="mc-item-main">
                    <span className="mc-item-label">{m.label}{m.id === catalog?.defaultModel && <em className="tag">default</em>}</span>
                    <span className="mc-item-id">{m.id}</span>
                    {m.description && <span className="mc-item-desc">{m.description}</span>}
                  </span>
                  <ValidationBadge agent={agent} model={m.id} info={m} compact />
                </button>
              );
            })}
          </div>
        ))}
        {!selected && value.model && (
          <div className="mc-group">
            <div className="mc-group-label">Current</div>
            <div className="mc-item is-active"><span className="mc-check"><Check size={13} /></span>
              <span className="mc-item-main"><span className="mc-item-label">{value.model}</span><span className="mc-item-id">custom id</span></span>
              <ValidationBadge agent={agent} model={value.model} compact />
            </div>
          </div>
        )}
      </div>

      {efforts.length > 0 && (
        <div className="mc-effort">
          <span className="mc-sub">Reasoning effort</span>
          <div className="seg" role="radiogroup" aria-label="Reasoning effort">
            {efforts.map((e) => (
              <button key={e} role="radio" aria-checked={(value.effort ?? selected?.defaultEffort) === e}
                className={cx('seg-item', (value.effort ?? selected?.defaultEffort) === e && 'is-on')}
                onClick={() => onChange({ ...value, effort: e })}>
                {EFFORT_LABEL[e]}
              </button>
            ))}
          </div>
        </div>
      )}

      <form className="mc-custom" onSubmit={(e) => { e.preventDefault(); if (custom.trim()) { onChange({ model: custom.trim() }); setCustom(''); } }}>
        <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Custom model id…" aria-label="Custom model id" spellCheck={false} className="input input-sm mono" />
        <button className="btn btn-sm" type="submit" disabled={!custom.trim()}>Use</button>
      </form>

      <div className="mc-validate">
        <div className="mc-validate-state">
          {checking ? <><Spinner size={12} /> Probing <code>{value.model}</code>…</>
            : result ? (result.ok
              ? <span className="text-ok"><CircleCheck size={13} /> Available{result.resolvedModel ? <> → <code>{result.resolvedModel}</code></> : null}</span>
              : <span className="text-bad"><CircleX size={13} /> {result.error ?? 'Unavailable'}{result.code === 'model_unavailable' && <em className="mc-hint"> Pick another model or check your plan.</em>}{result.code === 'auth' && <em className="mc-hint"> Log in with the provider CLI, then retry.</em>}</span>)
            : <span className="text-dim"><ShieldQuestion size={13} /> <code>{value.model}</code> not validated</span>}
        </div>
        <button className="btn btn-sm" disabled={checking || !value.model} onClick={() => void lina.validateModel(agent, value.model)} data-tip="Runs a tiny real request (costs a few tokens)">
          Validate
        </button>
      </div>
      {note && <p className="mc-note">{note}</p>}
    </div>
  );
}

/** Agent activity shortcut with a separate model chooser. */
export function AgentModelPill({ agent, role, value, onChange, onInspect, dim, live }: {
  agent: AgentId; role: string; value: AgentModelChoice; onChange: (c: AgentModelChoice) => void;
  onInspect: () => void; dim?: boolean; live?: boolean;
}) {
  return (
    <div className={cx('apill', dim && 'is-dim', live && 'is-live')} data-agent={agent}>
      <button className="apill-main" onClick={onInspect} aria-label={`View ${AGENT_NAME[agent]} activity`} title={`See what ${AGENT_NAME[agent]} is working on`}>
        <span className="apill-glyph"><Glyph actor={agent} size={14} /></span>
        <span className="apill-text">
          <span className="apill-role">{AGENT_NAME[agent]} · {role}</span>
          <span className="apill-model">{value.model}{value.effort && <i> · {EFFORT_LABEL[value.effort]}</i>}</span>
        </span>
      </button>
      <Popover
        align="end" width={380}
        trigger={({ open, toggle }) => (
          <button className={cx('apill-settings', open && 'is-open')} onClick={toggle} aria-haspopup="dialog" aria-expanded={open}
            aria-label={`${AGENT_NAME[agent]} model settings`} title="Model settings">
            <ChevronDown size={13} className="apill-chev" />
          </button>
        )}
      >
        <ModelChooser agent={agent} value={value} onChange={onChange} note="Changes apply from the next turn." />
      </Popover>
    </div>
  );
}
