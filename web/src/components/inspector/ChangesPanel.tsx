import { useEffect, useMemo, useState } from 'react';
import { FileDiff, RefreshCw, Search, X, ChevronLeft } from 'lucide-react';
import type { DiffFile, TurnChange } from '@shared/types';
import type { SessionView } from '@shared/reducer';
import { useLina, asApiErr } from '../../lib/lina';
import { useUI } from '../../lib/store';
import { basename, cx, dirname, langFromPath, shortSha } from '../../lib/format';
import { highlight } from '../../lib/highlight';
import { DiffBar } from '../timeline/Cards';
import { Empty, Skeleton, Spinner } from '../ui/Overlay';
import { WorktreeSwitcher, useWorktree } from '../Variants';
import { poss } from '../../lib/modes';

interface DiffState { loading: boolean; error?: string; base?: string; head?: string; files: DiffFile[] }

export function ChangesPanel({ view }: { view: SessionView }) {
  const lina = useLina();
  const range = useUI((u) => u.diffRange);
  const wt = useWorktree(view.session);
  const [state, setState] = useState<DiffState>({ loading: true, files: [] });
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<string | null>(range?.focusPath ?? null);
  const [tick, setTick] = useState(0);
  const [turns, setTurns] = useState<TurnChange[]>([]);
  const [undoing, setUndoing] = useState(false);
  const sid = view.session.id;
  const checkpoints = useMemo(() => view.timeline.filter((e) => e.type === 'checkpoint').length, [view.timeline]);
  const direct = view.session.config.workspaceMode === 'direct';
  const status = view.session.status;
  useEffect(() => {
    let alive = true;
    if (direct) lina.client.turnChanges(sid).then((t) => { if (alive) setTurns(t); }, () => {});
    return () => { alive = false; };
  }, [lina, sid, direct, status, tick, view.session.updatedAt]);
  const selectedTurn = turns.find((t) => t.before === range?.from && t.after === range?.to);
  const undoTarget = selectedTurn ?? turns.find((t) => t.status === 'ready' && t.files.length);
  const undo = async () => {
    if (!undoTarget) return;
    setUndoing(true);
    try {
      await lina.client.undo(sid, undoTarget.turn);
      lina.setUI({ diffRange: null }); setTick((t) => t + 1);
      lina.toast({ tone: 'ok', title: `Undid turn ${undoTarget.turn}`, detail: 'Other files and staged changes were kept.' });
    } catch (e) { lina.toast({ tone: 'error', title: 'Could not undo this turn', detail: asApiErr(e).message }); }
    finally { setUndoing(false); }
  };

  useEffect(() => {
    if (!direct || status !== 'running' || range) return;
    const timer = setInterval(() => setTick((t) => t + 1), 1500);
    return () => clearInterval(timer);
  }, [direct, status, range]);

  useEffect(() => { if (range?.focusPath) setSelected(range.focusPath); }, [range]);

  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    const q = { ...(range ? { from: range.from, to: range.to } : {}), ...(wt ? { variant: wt } : {}) };
    lina.client.diff(sid, q).then(
      (d) => { if (alive) { setState({ loading: false, base: d.base, head: d.head, files: d.files }); setSelected((cur) => cur && d.files.some((f) => f.path === cur) ? cur : d.files[0]?.path ?? null); } },
      (e) => { if (alive) setState({ loading: false, files: [], error: asApiErr(e).message }); },
    );
    return () => { alive = false; };
  }, [lina, sid, range, checkpoints, tick, wt, status]);

  const files = state.files.filter((f) => !filter || f.path.toLowerCase().includes(filter.toLowerCase()));
  const file = state.files.find((f) => f.path === selected);
  const add = state.files.reduce((n, f) => n + f.additions, 0);
  const del = state.files.reduce((n, f) => n + f.deletions, 0);

  return (
    <div className={cx('changes', file && 'has-file')} data-agent={wt ?? undefined}>
      {direct && <div className="turn-history">
        <label className="field"><span className="field-label">Writing turns</span>
          <select className="input" aria-label="Inspect writing turn" value={selectedTurn?.turn ?? ''} onChange={(e) => {
            const t = turns.find((t) => t.turn === Number(e.target.value));
            lina.setUI({ diffRange: t?.after ? { from: t.before, to: t.after, label: `Turn ${t.turn} · ${t.agent}` } : null });
          }}>
            <option value="">All session changes</option>
            {turns.map((t) => <option key={t.turn} value={t.turn} disabled={!t.after}>Turn {t.turn} · {t.agent} · {t.files.length} files · {t.status}</option>)}
          </select>
        </label>
        <button className="btn btn-sm" disabled={undoing || status === 'running' || !undoTarget || undoTarget.status !== 'ready'} onClick={() => void undo()}>
          {undoing ? 'Undoing…' : `Undo ${undoTarget ? `turn ${undoTarget.turn}` : 'last turn'}`}
        </button>
        <p className="field-hint">Undo preserves existing work and refuses to overwrite later edits to the same files.</p>
      </div>}
      <WorktreeSwitcher session={view.session} className="panel-wt" />
      <div className="panel-toolbar">
        {range ? (
          <span className="range-chip" title={`${range.from ? shortSha(range.from) : 'base'}..${shortSha(range.to)}`}>
            {range.label ?? 'Range'}
            <button className="icon-btn icon-btn-xs" onClick={() => lina.setUI({ diffRange: null })} aria-label="Show all changes"><X size={11} /></button>
          </span>
        ) : (
          <span className="range-chip is-all">{wt ? `${poss(wt)} changes` : 'All changes'} <span className="mono text-dim">{state.base ? `${shortSha(state.base)}..${shortSha(state.head)}` : ''}</span></span>
        )}
        <span className="panel-stat"><span className="text-ok">+{add}</span> <span className="text-bad">−{del}</span></span>
        <button className="icon-btn icon-btn-sm" onClick={() => setTick((t) => t + 1)} aria-label="Refresh diff" data-tip="Refresh">
          {state.loading ? <Spinner size={12} /> : <RefreshCw size={13} />}
        </button>
      </div>

      {state.error ? (
        <Empty icon={<FileDiff size={22} />} title="Could not load the diff">{state.error}</Empty>
      ) : state.loading && !state.files.length ? (
        <div className="panel-skel">{[80, 64, 72, 50].map((w, i) => <Skeleton key={i} w={`${w}%`} h={12} />)}</div>
      ) : !state.files.length ? (
        <Empty icon={<FileDiff size={22} />} title="No changes yet">{direct ? 'Live edits appear here as the agents work.' : wt ? `Nothing committed in ${poss(wt)} worktree yet.` : 'Checkpoints appear here after each writing turn.'}</Empty>
      ) : (
        <>
          <div className="filelist-wrap">
            <label className="filter">
              <Search size={13} />
              <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Filter ${state.files.length} files`} aria-label="Filter changed files" />
            </label>
            <ul className="filelist">
              {files.map((f) => (
                <li key={f.path}>
                  <button className={cx('filelist-item', f.path === selected && 'is-active')} onClick={() => setSelected(f.path)} title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
                    <span className={cx('fstatus', `is-${f.status}`)}>{f.status[0].toUpperCase()}</span>
                    <span className="filelist-name"><b>{basename(f.path)}</b> <span className="text-dim">{dirname(f.path)}</span></span>
                    <DiffBar add={f.additions} del={f.deletions} />
                  </button>
                </li>
              ))}
              {!files.length && <li className="ap-empty">No files match.</li>}
            </ul>
          </div>
          {file && (
            <div className="diffview-wrap">
              <div className="diffview-head">
                <button className="icon-btn icon-btn-sm only-narrow-insp" onClick={() => setSelected(null)} aria-label="Back to file list"><ChevronLeft size={14} /></button>
                <span className="mono diffview-path">{file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ` : ''}{file.path}</span>
                <DiffBar add={file.additions} del={file.deletions} />
              </div>
              <DiffViewer file={file} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

interface DLine { t: 'hunk' | 'add' | 'del' | 'ctx' | 'meta'; o?: number; n?: number; text: string }

export function parsePatch(patch: string): DLine[] {
  const out: DLine[] = [];
  let o = 0, n = 0;
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('diff --git') || raw.startsWith('index ') || raw.startsWith('--- ') || raw.startsWith('+++ ') || raw.startsWith('new file') || raw.startsWith('deleted file') || raw.startsWith('similarity') || raw.startsWith('rename ')) continue;
    const h = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (h) { o = +h[1]; n = +h[2]; out.push({ t: 'hunk', text: raw }); continue; }
    if (raw.startsWith('\\')) { out.push({ t: 'meta', text: raw.slice(2) }); continue; }
    const c = raw[0];
    if (c === '+') out.push({ t: 'add', n: n++, text: raw.slice(1) });
    else if (c === '-') out.push({ t: 'del', o: o++, text: raw.slice(1) });
    else if (c === ' ' || raw === '') { if (raw === '' && out.length && out[out.length - 1].t === 'hunk') continue; out.push({ t: 'ctx', o: o++, n: n++, text: raw.slice(1) }); }
  }
  while (out.length && out[out.length - 1].t === 'ctx' && out[out.length - 1].text === '') out.pop();
  return out;
}

export function DiffViewer({ file }: { file: DiffFile }) {
  const lines = useMemo(() => parsePatch(file.patch), [file.patch]);
  const lang = langFromPath(file.path);
  if (file.binary) return <Empty title="Binary file">Contents not shown.</Empty>;
  if (!lines.length) return <Empty title="No textual changes">{file.status === 'renamed' ? 'File was renamed.' : 'Empty diff.'}</Empty>;
  return (
    <div className="diff" role="table" aria-label={`Diff of ${file.path}`}>
      {lines.map((l, i) => l.t === 'hunk' ? (
        <div key={i} className="dl is-hunk" role="row"><span className="dl-hunk mono">{l.text}</span></div>
      ) : l.t === 'meta' ? (
        <div key={i} className="dl is-meta" role="row"><span className="dl-no" /><span className="dl-no" /><span className="dl-sign" /><span className="dl-code">{l.text}</span></div>
      ) : (
        <div key={i} className={cx('dl', `is-${l.t}`)} role="row">
          <span className="dl-no">{l.o ?? ''}</span>
          <span className="dl-no">{l.n ?? ''}</span>
          <span className="dl-sign">{l.t === 'add' ? '+' : l.t === 'del' ? '−' : ''}</span>
          <span className="dl-code hljs" dangerouslySetInnerHTML={{ __html: highlight(l.text, lang) || '&nbsp;' }} />
        </div>
      ))}
      {/* patch may be truncated by the daemon */}
      {file.patch.length > 0 && file.patch.endsWith('\n...') && <div className="dl is-meta">diff truncated</div>}
    </div>
  );
}
