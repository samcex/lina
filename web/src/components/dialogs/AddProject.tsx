import { useEffect, useState } from 'react';
import { FolderGit2, FolderPlus, GitBranchPlus, TriangleAlert } from 'lucide-react';
import { useApp } from '../../lib/store';
import { useLina, asApiErr, type ApiErr } from '../../lib/lina';
import { Modal, Spinner } from '../ui/Overlay';

export function AddProjectDialog() {
  const lina = useLina();
  const open = useApp((s) => s.ui.addProject);
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [create, setCreate] = useState(false);
  const [initGit, setInitGit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiErr | null>(null);

  useEffect(() => { if (open) { setPath(''); setName(''); setCreate(false); setInitGit(false); setErr(null); } }, [open]);
  const close = () => lina.setUI({ addProject: false });
  const notGit = err?.code === 'not_git';
  const notFound = err && (err.code === 'not_found' || err.code === 'enoent' || /no such|does not exist|not exist/i.test(err.message));

  const submit = async (forceInit = false) => {
    if (!path.trim()) return;
    const init = forceInit || initGit;
    setBusy(true); setErr(null);
    try {
      const p = await lina.addProject({ path: path.trim(), name: name.trim() || undefined, create: create || undefined, initGit: init || undefined });
      lina.toast({ tone: 'ok', title: `Added ${p.name}`, detail: p.path });
      lina.setUI({ addProject: false, newSession: { projectId: p.id } });
    } catch (e) {
      setErr(asApiErr(e));
    } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={close} title="Add a project" subtitle="Register a local directory. New sessions edit your project directly by default." icon={<FolderGit2 size={18} />}
      footer={<>
        <button className="btn btn-ghost" onClick={close}>Cancel</button>
        <button className="btn btn-primary" onClick={() => void submit()} disabled={!path.trim() || busy}>{busy ? <Spinner size={13} /> : <FolderPlus size={14} />} Add project</button>
      </>}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <label className="field">
          <span className="field-label">Directory path</span>
          <input className="input mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/home/you/code/my-app" data-autofocus spellCheck={false} autoComplete="off" />
          <span className="field-hint">Absolute path on the machine running the LINA daemon.</span>
        </label>
        <label className="field">
          <span className="field-label">Display name <em>optional</em></span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Defaults to the folder name" />
        </label>

        <div className="consents">
          <label className={`check ${notFound && !create ? 'is-attn' : ''}`}>
            <input type="checkbox" checked={create} onChange={(e) => setCreate(e.target.checked)} />
            <span className="check-box" />
            <span><b>Create the directory</b> if it doesn't exist <small>Changes your filesystem</small></span>
          </label>
          <label className={`check ${notGit && !initGit ? 'is-attn' : ''}`}>
            <input type="checkbox" checked={initGit} onChange={(e) => setInitGit(e.target.checked)} />
            <span className="check-box" />
            <span><b>Initialize a git repository</b> if it isn't one <small>Runs <code>git init</code> in that directory</small></span>
          </label>
        </div>

        {err && (
          notGit ? (
            <div className="callout is-iris">
              <GitBranchPlus size={16} />
              <div>
                <b>This folder isn't a git repository.</b>
                <p>LINA needs git to track changes and provide session diffs. Tick “Initialize a git repository” above to consent, then add again.</p>
                {!initGit && <button type="button" className="btn btn-sm" onClick={() => { setInitGit(true); void submit(true); }}>Initialize git and continue</button>}
              </div>
            </div>
          ) : (
            <div className="callout is-bad">
              <TriangleAlert size={16} />
              <div><b>{err.message}</b>{err.hint && <p>{err.hint}</p>}{notFound && !create && <p>Tick “Create the directory” to have LINA create it.</p>}</div>
            </div>
          )
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
