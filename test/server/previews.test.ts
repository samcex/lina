import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeRepo, setupEnv, waitUntil } from './helpers.js';
import { TuiStore } from '../../src/cli/tui/store.js';

setupEnv();
const { startServer } = await import('../../src/server/daemon.js');
const { LinaClient } = await import('../../src/shared/client.js');
const { runProcess } = await import('../../src/server/agents/proc.js');
let srv: Awaited<ReturnType<typeof startServer>>;
let api: InstanceType<typeof LinaClient>;
beforeAll(async () => { srv = await startServer({ port: 0 }); api = new LinaClient({ baseUrl: `http://127.0.0.1:${srv.port}`, token: srv.token }); });
afterAll(async () => { await srv.close(); });
const serverCode = `const http = require('node:http'); const fs = require('node:fs');
console.log('preview booted');
const server = http.createServer((req,res) => res.end(fs.readFileSync('page.html')));
server.listen(Number(process.env.PORT), '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`;
async function ready(sid: string, id: string) {
  await waitUntil(async () => (await api.previews(sid)).find((p) => p.id === id)?.status === 'running', 10_000, 'preview listener');
}
async function reachable(url: string) { try { return (await fetch(url, { signal: AbortSignal.timeout(500) })).ok; } catch { return false; } }

describe('managed persistent previews', () => {
  it('does not signal a process with a mismatched saved identity, and kills stubborn preview descendants', async () => {
    const repo = makeRepo({ 'preview.cjs': serverCode.replace("process.on('SIGTERM', () => server.close(() => process.exit(0)));", "process.on('SIGTERM', () => {});"), 'page.html': 'stubborn preview' });
    const project = await api.addProject({ path: repo });
    const s = await api.createSession({ projectId: project.id, config: { mock: true } });
    const p = await api.startPreview(s.id, { command: 'node preview.cjs' });
    try {
      await ready(s.id, p.id);
      srv.manager.db.sql.prepare('UPDATE previews SET record = ? WHERE id = ?').run(JSON.stringify({ ...p, identity: 'different-process-start-time' }), p.id);
      await api.stopPreview(s.id, p.id);
      expect(await reachable(p.url)).toBe(true);
      srv.manager.db.sql.prepare('UPDATE previews SET record = ? WHERE id = ?').run(JSON.stringify({ ...p, status: 'running' }), p.id);
      await api.stopPreview(s.id, p.id);
      await waitUntil(async () => !await reachable(p.url), 5000, 'stubborn server killed');
    } finally { await api.deleteSession(s.id); }
  });
  it('serves live content across an agent turn and daemon restart, exposes logs, and stops on command', async () => {
    const repo = makeRepo({ 'preview.cjs': serverCode, 'page.html': '<h1>before</h1>' });
    const project = await api.addProject({ path: repo });
    const s = await api.createSession({ projectId: project.id, config: { mock: true } });
    const preview = await api.startPreview(s.id, { command: 'node preview.cjs' });
    try {
      await ready(s.id, preview.id);
      expect(await (await fetch(preview.url)).text()).toBe('<h1>before</h1>');
      expect((await api.previewLogs(s.id, preview.id)).output).toContain('preview booted');
      const terminal = new TuiStore(api, { project, live: false });
      await terminal.openSession(s.id);
      await terminal.preview('list');
      expect(terminal.getState().notices.at(-1)?.text).toContain(preview.url);
      await terminal.preview('logs', preview.id);
      expect(terminal.getState().notices.at(-1)?.text).toContain('preview booted');
      terminal.dispose();
      await api.send(s.id, 'What is this app?');
      await waitUntil(async () => (await api.session(s.id)).session.status === 'completed');
      // Ordinary agent processes still clean up their own groups; managed previews are independent.
      await runProcess({ cmd: process.execPath, args: ['-e', 'console.log("another turn ended")'], cwd: repo });
      expect(await reachable(preview.url)).toBe(true);
      writeFileSync(join(repo, 'page.html'), '<h1>live update</h1>');
      expect(await (await fetch(preview.url)).text()).toBe('<h1>live update</h1>');
      await srv.close();
      expect(await reachable(preview.url)).toBe(true);
      srv = await startServer({ port: 0 });
      api = new LinaClient({ baseUrl: `http://127.0.0.1:${srv.port}`, token: srv.token });
      const recovered = (await api.previews(s.id)).find((p) => p.id === preview.id)!;
      expect(recovered.pid).toBe(preview.pid);
      expect(recovered.status).toBe('running');
      expect((await api.previewLogs(s.id, preview.id)).output).toContain('preview booted');
      await api.stopPreview(s.id, preview.id);
      await waitUntil(async () => !await reachable(preview.url), 5000, 'stopped listener');
      expect((await api.previews(s.id))[0].status).toBe('stopped');
    } finally { await api.deleteSession(s.id); }
  });

  it('validates access/ports, records startup failures, scopes controls to a session, and cleans up on deletion', async () => {
    const project = await api.addProject({ path: makeRepo({ 'preview.cjs': serverCode, 'page.html': 'cleanup test' }) });
    const a = await api.createSession({ projectId: project.id, config: { mock: true } });
    const b = await api.createSession({ projectId: project.id, config: { mock: true } });
    try {
      await api.putSettings({ accessMode: 'restricted' });
      await expect(api.startPreview(a.id, { command: 'node preview.cjs' })).rejects.toMatchObject({ status: 403 });
      await api.putSettings({ accessMode: 'full' });
      await expect(api.startPreview(a.id, { command: '' })).rejects.toMatchObject({ status: 400 });
      await expect(api.startPreview(a.id, { command: 'node preview.cjs', port: -1 })).rejects.toMatchObject({ status: 400 });
      const p = await api.startPreview(a.id, { command: 'node preview.cjs' });
      await ready(a.id, p.id);
      await expect(api.startPreview(a.id, { command: 'node preview.cjs', port: p.port })).rejects.toMatchObject({ status: 409 });
      await expect(api.previewLogs(b.id, p.id)).rejects.toMatchObject({ status: 404 });
      await expect(api.stopPreview(b.id, p.id)).rejects.toMatchObject({ status: 404 });
      const fail = await api.startPreview(b.id, { command: 'echo startup-failed >&2; exit 7' });
      await waitUntil(async () => (await api.previews(b.id)).find((p) => p.id === fail.id)?.status === 'failed');
      expect((await api.previewLogs(b.id, fail.id)).output).toContain('startup-failed');
      await api.deleteSession(a.id);
      await waitUntil(async () => !await reachable(p.url));
    } finally {
      await api.putSettings({ accessMode: 'full' });
      if (srv.manager.db.getSession(a.id)) await api.deleteSession(a.id);
      await api.deleteSession(b.id);
    }
  });
});
