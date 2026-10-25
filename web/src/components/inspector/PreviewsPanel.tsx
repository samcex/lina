import { useEffect, useState } from 'react';
import { ExternalLink, Play, Square, Terminal } from 'lucide-react';
import type { Preview } from '@shared/types';
import type { SessionView } from '@shared/reducer';
import { useLina, asApiErr } from '../../lib/lina';
import { useApp } from '../../lib/store';

export function PreviewsPanel({ view }: { view: SessionView }) {
  const lina = useLina();
  const settings = useApp((s) => s.settings);
  const sid = view.session.id;
  const [previews, setPreviews] = useState<Preview[]>([]);
  const [command, setCommand] = useState('npm run dev -- --host 127.0.0.1 --port {port}');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [logId, setLogId] = useState<string | null>(null);
  const [logs, setLogs] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => { const timer = setInterval(() => setTick((t) => t + 1), 2000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    let alive = true;
    lina.client.previews(sid).then((p) => { if (alive) setPreviews(p); }, (e) => { if (alive) setError(asApiErr(e).message); });
    return () => { alive = false; };
  }, [lina, sid, tick]);
  useEffect(() => {
    let alive = true;
    if (logId) lina.client.previewLogs(sid, logId).then((p) => { if (alive) setLogs(p.output); }, (e) => { if (alive) setError(asApiErr(e).message); });
    return () => { alive = false; };
  }, [lina, sid, logId, tick]);
  const start = async () => {
    setBusy(true); setError('');
    try { await lina.client.startPreview(sid, { command }); setTick((t) => t + 1); }
    catch (e) { setError(asApiErr(e).message); }
    finally { setBusy(false); }
  };
  return <div className="preview-panel">
    <p className="field-hint">Preview servers stay running between messages and daemon restarts. Deleting the session stops them.</p>
    <form className="form" onSubmit={(e) => { e.preventDefault(); void start(); }}>
      <label className="field"><span className="field-label">Preview command</span>
        <input className="input mono" value={command} onChange={(e) => setCommand(e.target.value)} aria-label="Preview command" /></label>
      <span className="field-hint">Use {'{port}'} or the PORT environment variable for an available local port. Keep the server in the foreground.</span>
      <button className="btn btn-sm btn-accent" disabled={busy || !command.trim() || settings?.accessMode !== 'full'}><Play size={13} /> {busy ? 'Starting…' : 'Start preview'}</button>
      {settings?.accessMode === 'restricted' && <span className="field-hint">Enable Full access in Settings to start previews.</span>}
    </form>
    {error && <p role="alert" className="text-bad">{error}</p>}
    {!previews.length && <p className="field-hint">No preview yet. Ask the agent to start one, or enter the project's dev command above.</p>}
    {previews.map((p) => <section key={p.id} className="preview-card">
      <div className="preview-heading"><b>{p.status}</b><span className="mono text-dim">{p.id}</span></div>
      <p className="mono">{p.command}</p>
      <div className="preview-actions">
        {p.status === 'running' && <a className="btn btn-sm" href={p.url} target="_blank" rel="noreferrer"><ExternalLink size={13} /> Open preview</a>}
        <button className="btn btn-sm" onClick={() => { setLogId(p.id); setLogs(''); }}><Terminal size={13} /> Logs</button>
        {['starting', 'running'].includes(p.status) && <button className="btn btn-sm" onClick={() => {
          void lina.client.stopPreview(sid, p.id).then(() => setTick((t) => t + 1), (e) => setError(asApiErr(e).message));
        }}><Square size={12} /> Stop</button>}
      </div>
      <p className="mono text-dim">{p.url}</p>
      {p.error && <p className="text-bad">{p.error}</p>}
      {logId === p.id && <pre className="preview-logs" aria-label="Preview logs">{logs || 'No output yet.'}</pre>}
    </section>)}
  </div>;
}
