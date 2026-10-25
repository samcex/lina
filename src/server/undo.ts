// Working-file history, independent of the user's branch and index.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, renameSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { AgentId, Phase, TurnChange } from '../shared/types.js';
import type { Db } from './db.js';
import * as git from './git.js';
import { LinaError, rid } from './util.js';

function ref(sid: string, turn: number, side: string): string { return `refs/lina/turns/${sid}/${turn}/${side}`; }

export class TurnHistory {
  constructor(private db: Db) {}
  list(sid: string): TurnChange[] {
    return this.db.sql.prepare('SELECT record FROM turn_changes WHERE session_id = ? ORDER BY turn_no DESC').all(sid)
      .map((r) => JSON.parse(String(r.record)) as TurnChange);
  }
  private save(sid: string, change: TurnChange): void {
    this.db.sql.prepare('INSERT OR REPLACE INTO turn_changes(session_id,turn_no,record) VALUES (?,?,?)').run(sid, change.turn, JSON.stringify(change));
  }
  async begin(sid: string, ws: string, turn: number, agent: AgentId, phase: Phase): Promise<TurnChange> {
    const change: TurnChange = { turn, agent, phase, createdAt: Date.now(), status: 'recording', before: await git.snapshot(ws, ref(sid, turn, 'before')), files: [] };
    this.save(sid, change);
    return change;
  }
  async finish(sid: string, ws: string, change: TurnChange): Promise<TurnChange> {
    change.after = await git.snapshot(ws, ref(sid, change.turn, 'after'));
    change.files = (await git.diff(ws, change.before, change.after)).flatMap(({ path, oldPath, status, additions, deletions }) =>
      oldPath ? [{ path: oldPath, status: 'deleted', additions: 0, deletions }, { path, status: 'added', additions, deletions: 0 }] : [{ path, status, additions, deletions }]);
    change.status = 'ready';
    this.save(sid, change);
    return change;
  }
  async diff(sid: string, ws: string, turn: number) {
    const c = this.list(sid).find((c) => c.turn === turn);
    if (!c) throw new LinaError('Unknown writing turn', 'not_found', 404);
    if (!c.after) throw new LinaError('This turn has no completed after-snapshot; inspect the current project before recovering it manually', 'incomplete_snapshot', 409);
    return { base: c.before, head: c.after, files: await git.diff(ws, c.before, c.after) };
  }
  async undo(sid: string, ws: string, turn?: number): Promise<TurnChange> {
    const records = this.list(sid);
    const change = turn === undefined ? records.find((c) => c.status === 'ready' && c.files.length) : records.find((c) => c.turn === turn);
    if (!change) throw new LinaError('No writing turn to undo', 'not_found', 404);
    if (change.status !== 'ready' || !change.after) throw new LinaError('This turn is not available for undo', 'bad_state', 409);
    const before = await git.snapshotFiles(ws, change.before);
    const after = await git.snapshotFiles(ws, change.after);
    const checkRef = `refs/lina/turns/${sid}/undo-check`;
    try {
      const current = await git.snapshotFiles(ws, await git.snapshot(ws, checkRef));
      const conflicts = change.files.filter((f) => {
        const a = after.get(f.path), b = current.get(f.path);
        return a?.object !== b?.object || a?.mode !== b?.mode;
      });
      if (conflicts.length) throw new LinaError(`Undo would overwrite later edits: ${conflicts.map((f) => f.path).join(', ')}`, 'undo_conflict', 409, 'Keep or copy those edits before undoing this turn. No files were changed.');
      for (const f of change.files) this.safePath(ws, f.path);
      // Materialize all blobs before touching project files; failed reads cannot leave a partial undo.
      const restore = await this.materialize(ws, before, change.files.map((f) => f.path));
      const rollback = await this.materialize(ws, after, change.files.map((f) => f.path));
      const affected = new Set(change.files.map((f) => f.path));
      // Recheck actual bytes immediately before synchronous writes, after asynchronous blob reads.
      for (const e of rollback) {
        const path = this.safePath(ws, e.path);
        let matches = false;
        try {
          const st = lstatSync(path);
          const bytes = st.isSymbolicLink() ? Buffer.from(readlinkSync(path)) : st.isFile() ? readFileSync(path) : undefined;
          const mode = st.isSymbolicLink() ? '120000' : (st.mode & 0o111) ? '100755' : '100644';
          matches = st.isDirectory() && !e.bytes
            ? this.directoryRemovable(ws, e.path, affected)
            : !!e.bytes && !!bytes && e.bytes.equals(bytes) && e.mode === mode;
        } catch (err) { if (['ENOENT', 'ENOTDIR'].includes((err as NodeJS.ErrnoException).code ?? '')) matches = !e.bytes; else throw err; }
        if (!matches) throw new LinaError(`Undo would overwrite later edits: ${e.path}`, 'undo_conflict', 409);
      }
      try { this.restore(ws, restore); } catch (e) { this.restore(ws, rollback); throw e; }
      change.status = 'undone';
      change.undoneAt = Date.now();
      this.save(sid, change);
      return change;
    } finally { await git.git(ws, ['update-ref', '-d', checkRef]); }
  }
  private safePath(ws: string, path: string): string {
    const root = resolve(ws), full = resolve(root, path);
    if (!full.startsWith(root + sep) || relative(root, full).split(sep).includes('.git')) throw new LinaError('Unsafe undo path', 'forbidden', 403);
    for (let p = dirname(full); p !== root; p = dirname(p)) {
      try { if (lstatSync(p).isSymbolicLink()) throw new LinaError(`Undo path has a symlink parent: ${path}`, 'undo_conflict', 409); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
    return full;
  }
  private directoryRemovable(ws: string, path: string, affected: Set<string>): boolean {
    // Git snapshots omit ignored files and empty directories; those must not be destroyed.
    for (const name of readdirSync(this.safePath(ws, path))) {
      const child = `${path}/${name}`;
      const st = lstatSync(this.safePath(ws, child));
      if (st.isDirectory()) {
        if (![...affected].some((p) => p.startsWith(child + '/')) || !this.directoryRemovable(ws, child, affected)) return false;
      } else if (!affected.has(child)) return false;
    }
    return true;
  }
  private async materialize(ws: string, tree: Map<string, git.SnapshotFile>, files: string[]) {
    return Promise.all(files.map(async (path) => {
      const info = tree.get(path);
      if (info && !['100644', '100755', '120000'].includes(info.mode)) throw new LinaError(`Undo does not support this entry type: ${path}`, 'undo_conflict', 409);
      return { path, mode: info?.mode, bytes: info ? await git.blob(ws, info.object) : undefined };
    }));
  }
  private restore(ws: string, entries: { path: string; mode?: string; bytes?: Buffer }[]): void {
    for (const e of [...entries].sort((a, b) => b.path.length - a.path.length)) {
      const p = this.safePath(ws, e.path);
      try { if (lstatSync(p).isDirectory()) rmdirSync(p); else rmSync(p); } catch (err) { if (!['ENOENT', 'ENOTDIR'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err; }
      if (!e.bytes) {
        for (let d = dirname(p); d !== resolve(ws); d = dirname(d)) { try { rmdirSync(d); } catch { break; } }
      }
    }
    for (const e of [...entries].sort((a, b) => a.path.length - b.path.length)) {
      if (!e.bytes) continue;
      const p = this.safePath(ws, e.path);
      mkdirSync(dirname(p), { recursive: true });
      const tmp = join(dirname(p), `.lina-undo-${rid()}`);
      try {
        if (e.mode === '120000') symlinkSync(e.bytes.toString(), tmp);
        else { writeFileSync(tmp, e.bytes); chmodSync(tmp, e.mode === '100755' ? 0o755 : 0o644); }
        renameSync(tmp, p);
      } finally { rmSync(tmp, { force: true }); }
    }
  }
  async remove(sid: string, ws: string): Promise<void> {
    if (existsSync(ws)) {
      const refs = (await git.gitOk(ws, ['for-each-ref', '--format=%(refname)', `refs/lina/turns/${sid}/`])).trim().split('\n').filter(Boolean);
      for (const r of refs) await git.gitOk(ws, ['update-ref', '-d', r]);
    }
    this.db.sql.prepare('DELETE FROM turn_changes WHERE session_id = ?').run(sid);
  }
}
