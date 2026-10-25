import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, File, FileCode2, Folder, FolderOpen, RefreshCw, Search, Copy } from 'lucide-react';
import type { AgentId, TreeEntry } from '@shared/types';
import type { SessionView } from '@shared/reducer';
import { useLina, asApiErr } from '../../lib/lina';
import { useUI } from '../../lib/store';
import { basename, bytes, cx, langFromPath } from '../../lib/format';
import { highlightLines } from '../../lib/highlight';
import { copyText } from '../../lib/hooks';
import { Empty, Skeleton, Spinner } from '../ui/Overlay';
import { VariantChip, WorktreeSwitcher, useWorktree } from '../Variants';

interface Node { name: string; path: string; type: 'file' | 'dir'; size?: number; changed?: boolean; children: Node[] }

function buildTree(entries: TreeEntry[]): Node {
  const root: Node = { name: '', path: '', type: 'dir', children: [] };
  const dirs = new Map<string, Node>([['', root]]);
  const ensureDir = (path: string): Node => {
    const hit = dirs.get(path);
    if (hit) return hit;
    const i = path.lastIndexOf('/');
    const parent = ensureDir(i >= 0 ? path.slice(0, i) : '');
    const node: Node = { name: i >= 0 ? path.slice(i + 1) : path, path, type: 'dir', children: [] };
    parent.children.push(node);
    dirs.set(path, node);
    return node;
  };
  for (const e of entries) {
    if (e.type === 'dir') { const d = ensureDir(e.path.replace(/\/$/, '')); d.changed ||= e.changed; continue; }
    const i = e.path.lastIndexOf('/');
    const parent = ensureDir(i >= 0 ? e.path.slice(0, i) : '');
    parent.children.push({ name: basename(e.path), path: e.path, type: 'file', size: e.size, changed: e.changed, children: [] });
  }
  const sort = (n: Node): boolean => {
    let changed = !!n.changed;
    n.children.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    for (const c of n.children) if (sort(c)) changed = true;
    if (n.type === 'dir') n.changed = changed;
    return changed;
  };
  sort(root);
  return root;
}

export function FilesPanel({ view }: { view: SessionView }) {
  const lina = useLina();
  const filePath = useUI((u) => u.filePath);
  const wt = useWorktree(view.session);
  const [entries, setEntries] = useState<TreeEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [q, setQ] = useState('');
  const [tick, setTick] = useState(0);
  const sid = view.session.id;
  const checkpoints = useMemo(() => view.timeline.filter((e) => e.type === 'checkpoint').length, [view.timeline]);
  const direct = view.session.config.workspaceMode === 'direct';
  const status = view.session.status;

  useEffect(() => {
    if (!direct || status !== 'running') return;
    const timer = setInterval(() => setTick((t) => t + 1), 1500);
    return () => clearInterval(timer);
  }, [direct, status]);

  useEffect(() => {
    let alive = true;
    lina.client.tree(sid, wt ?? undefined).then((t) => { if (alive) { setEntries(t); setError(null); } }, (e) => { if (alive) setError(asApiErr(e).message); });
    return () => { alive = false; };
  }, [lina, sid, checkpoints, tick, wt, status]);

  // Reveal the selected file's folders.
  useEffect(() => {
    if (!filePath) return;
    const parts = filePath.split('/');
    setOpen((o) => { const n = { ...o }; for (let i = 1; i < parts.length; i++) n[parts.slice(0, i).join('/')] = true; return n; });
  }, [filePath]);

  const tree = useMemo(() => (entries ? buildTree(entries) : null), [entries]);
  const flat = useMemo(() => (entries && q ? entries.filter((e) => e.type === 'file' && e.path.toLowerCase().includes(q.toLowerCase())).slice(0, 200) : null), [entries, q]);
  const changedCount = entries?.filter((e) => e.type === 'file' && e.changed).length ?? 0;

  if (filePath) return <FileViewer sid={sid} path={filePath} variant={wt ?? undefined} refresh={direct ? `${tick}:${status}` : `${checkpoints}`} onBack={() => lina.setUI({ filePath: null })} />;

  return (
    <div className="files" data-agent={wt ?? undefined}>
      <WorktreeSwitcher session={view.session} className="panel-wt" />
      <div className="panel-toolbar">
        <label className="filter filter-grow">
          <Search size={13} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find file…" aria-label="Find file in workspace" />
        </label>
        {changedCount > 0 && <span className="panel-stat"><i className="changed-dot" /> {changedCount} changed</span>}
        <button className="icon-btn icon-btn-sm" onClick={() => setTick((t) => t + 1)} aria-label="Refresh tree" data-tip="Refresh"><RefreshCw size={13} /></button>
      </div>
      {error ? <Empty icon={<Folder size={22} />} title="Could not load files">{error}</Empty>
        : !tree ? <div className="panel-skel">{[50, 66, 42, 70, 58, 46].map((w, i) => <Skeleton key={i} w={`${w}%`} h={11} />)}</div>
        : flat ? (
          <ul className="tree">
            {flat.map((e) => (
              <li key={e.path}><button className="tree-item" onClick={() => lina.setUI({ filePath: e.path })}>
                <FileCode2 size={13} /><span className="tree-name">{e.path}</span>{e.changed && <i className="changed-dot" />}
              </button></li>
            ))}
            {!flat.length && <li className="ap-empty">No files match.</li>}
          </ul>
        ) : (
          <ul className="tree" role="tree" aria-label="Workspace files">
            {tree.children.map((n) => <TreeNode key={n.path} n={n} depth={0} open={open} setOpen={setOpen} />)}
          </ul>
        )}
    </div>
  );
}

function TreeNode({ n, depth, open, setOpen }: { n: Node; depth: number; open: Record<string, boolean>; setOpen: (f: (o: Record<string, boolean>) => Record<string, boolean>) => void }) {
  const lina = useLina();
  const isOpen = !!open[n.path];
  if (n.type === 'dir') {
    return (
      <li role="treeitem" aria-expanded={isOpen}>
        <button className="tree-item is-dir" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => setOpen((o) => ({ ...o, [n.path]: !o[n.path] }))}>
          <ChevronRight size={12} className={cx('chev', isOpen && 'is-open')} />
          {isOpen ? <FolderOpen size={13} /> : <Folder size={13} />}
          <span className="tree-name">{n.name}</span>
          {n.changed && <i className="changed-dot" title="Contains changed files" />}
        </button>
        {isOpen && <ul role="group">{n.children.map((c) => <TreeNode key={c.path} n={c} depth={depth + 1} open={open} setOpen={setOpen} />)}</ul>}
      </li>
    );
  }
  return (
    <li role="treeitem">
      <button className={cx('tree-item', n.changed && 'is-changed')} style={{ paddingLeft: 22 + depth * 14 }} onClick={() => lina.setUI({ filePath: n.path })}>
        <File size={13} />
        <span className="tree-name">{n.name}</span>
        {n.changed && <i className="changed-dot" title="Changed in this session" />}
        {n.size != null && <span className="tree-size">{bytes(n.size)}</span>}
      </button>
    </li>
  );
}

function FileViewer({ sid, path, variant, refresh, onBack }: { sid: string; path: string; variant?: AgentId; refresh: string; onBack: () => void }) {
  const lina = useLina();
  const [data, setData] = useState<{ content: string; truncated: boolean; binary: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setError(null);
    lina.client.file(sid, path, variant).then((d) => alive && setData(d), (e) => alive && setError(asApiErr(e).message));
    return () => { alive = false; };
  }, [lina, sid, path, variant, refresh]);
  const lines = useMemo(() => (data && !data.binary ? highlightLines(data.content.replace(/\n$/, ''), langFromPath(path)) : []), [data, path]);
  return (
    <div className="fileview">
      <div className="panel-toolbar">
        <button className="icon-btn icon-btn-sm" onClick={onBack} aria-label="Back to files"><ChevronLeft size={15} /></button>
        <span className="mono fileview-path" title={path}>{path}</span>
        {variant && <VariantChip agent={variant} />}
        {data && !data.binary && (
          <button className="icon-btn icon-btn-sm" onClick={() => void copyText(data.content).then(() => lina.toast({ tone: 'ok', title: 'Copied file contents' }))} aria-label="Copy file" data-tip="Copy">
            <Copy size={13} />
          </button>
        )}
      </div>
      {error ? <Empty title="Could not open file">{error}</Empty>
        : !data ? <div className="panel-skel"><Spinner size={14} /></div>
        : data.binary ? <Empty title="Binary file">Preview not available.</Empty>
        : (
          <div className="code-view" role="region" aria-label={`Contents of ${path}`}>
            {lines.map((l, i) => (
              <div key={i} className="cv-line"><span className="cv-no">{i + 1}</span><span className="cv-code hljs" dangerouslySetInnerHTML={{ __html: l || '&nbsp;' }} /></div>
            ))}
            {data.truncated && <div className="cv-trunc">File truncated (1 MB limit).</div>}
          </div>
        )}
    </div>
  );
}
