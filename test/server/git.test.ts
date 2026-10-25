import { existsSync, readFileSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeRepo, setupEnv, sh } from './helpers.js';

setupEnv();
const git = await import('../../src/server/git.js');
const { paths, ensureHome } = await import('../../src/server/paths.js');

beforeAll(() => ensureHome());

async function freshWorkspace(files: Record<string, string> = {}) {
  const project = makeRepo({ 'src/a.txt': 'one\ntwo\nthree\n', ...files });
  const id = 'ws' + Math.random().toString(36).slice(2, 10);
  const ws = await git.createWorkspace({ path: project }, id);
  return { project, id, ws };
}

describe('ensureRepo', () => {
  it('rejects non-git directories unless initGit, and creates an initial commit for empty repos', async () => {
    const dir = join(paths.home, 'plain-' + Date.now());
    mkdirSync(dir);
    await expect(git.ensureRepo(dir)).rejects.toMatchObject({ code: 'not_git' });
    const r = await git.ensureRepo(dir, { initGit: true });
    expect(r.initialized).toBe(true);
    expect(r.initialCommit).toMatch(/^[0-9a-f]{40}$/);
    const again = await git.ensureRepo(dir);
    expect(again.initialCommit).toBeUndefined();
    await expect(git.ensureRepo(join(dir, 'nope'))).rejects.toMatchObject({ code: 'not_found' });
    const created = await git.ensureRepo(join(paths.home, 'new-' + Date.now()), { create: true, initGit: true });
    expect(created.initialized).toBe(true);
    // a subdirectory of a repo resolves to the repo top level
    mkdirSync(join(dir, 'sub'));
    expect((await git.ensureRepo(join(dir, 'sub'))).path).toBe(r.path);
  });
});

describe('workspace lifecycle', () => {
  it('clones in isolation with branch, no remote, excludes, and LINA identity', async () => {
    const { project, ws, id } = await freshWorkspace();
    expect(ws.path).toBe(paths.workspace(id));
    expect(ws.branch).toBe(`lina/${id.slice(0, 8)}`);
    expect(ws.baseCommit).toBe(sh(project, 'git', ['rev-parse', 'HEAD']).trim());
    expect(sh(ws.path, 'git', ['remote']).trim()).toBe('');
    expect(sh(ws.path, 'git', ['branch', '--show-current']).trim()).toBe(ws.branch);
    expect(readFileSync(join(ws.path, '.git/info/exclude'), 'utf8')).toContain('node_modules/');
    expect(sh(ws.path, 'git', ['config', 'user.name']).trim()).toBe('LINA');
    expect(ws.projectDirty).toBe(false);

    writeFileSync(join(ws.path, 'src/a.txt'), 'one\nTWO\nthree\n');
    writeFileSync(join(ws.path, 'new.txt'), 'hi\n');
    mkdirSync(join(ws.path, 'node_modules'));
    writeFileSync(join(ws.path, 'node_modules/x.js'), 'ignored');
    // project untouched
    expect(readFileSync(join(project, 'src/a.txt'), 'utf8')).toBe('one\ntwo\nthree\n');
    expect(existsSync(join(project, 'new.txt'))).toBe(false);

    const wt = await git.diff(ws.path, ws.baseCommit, 'worktree');
    expect(wt.map((f) => [f.path, f.status]).sort()).toEqual([['new.txt', 'added'], ['src/a.txt', 'modified']]);

    const cp = await git.checkpoint(ws.path, 'cp1');
    expect(cp?.files.map((f) => [f.path, f.additions, f.deletions, f.status]).sort()).toEqual([['new.txt', 1, 0, 'added'], ['src/a.txt', 1, 1, 'modified']]);
    expect(await git.checkpoint(ws.path, 'cp2')).toBeNull();
    expect(sh(project, 'git', ['log', '--oneline']).trim().split('\n')).toHaveLength(1);

    sh(ws.path, 'git', ['mv', 'new.txt', 'renamed.txt']);
    writeFileSync(join(ws.path, 'bin.dat'), Buffer.from([0, 1, 2, 3, 0, 255]));
    await git.checkpoint(ws.path, 'cp3');
    const d = await git.diff(ws.path, ws.baseCommit, 'HEAD');
    const byPath = Object.fromEntries(d.map((f) => [f.path, f]));
    expect(byPath['renamed.txt'].status).toBe('added');
    expect(byPath['bin.dat'].binary).toBe(true);
    expect(byPath['src/a.txt'].patch).toContain('+TWO');
    const d2 = await git.diff(ws.path, cp!.commit, 'HEAD');
    const ren = d2.find((f) => f.path === 'renamed.txt')!;
    expect(ren.status).toBe('renamed');
    expect(ren.oldPath).toBe('new.txt');

    const tree = await git.tree(ws.path, ws.baseCommit);
    expect(tree.find((e) => e.path === 'src/a.txt')?.changed).toBe(true);
    expect(tree.find((e) => e.path === 'src')?.type).toBe('dir');
    expect(tree.find((e) => e.path === 'README.md')?.changed).toBeUndefined();
    expect(tree.some((e) => e.path.startsWith('node_modules'))).toBe(false);
    expect((await git.projectTree(project)).map((e) => e.path)).toContain('src/a.txt');

    git.removeWorkspace(id);
    expect(existsSync(ws.path)).toBe(false);
  });

  it('warns when the project tree is dirty', async () => {
    const project = makeRepo();
    writeFileSync(join(project, 'README.md'), 'dirty\n');
    const ws = await git.createWorkspace({ path: project }, 'dirty' + Date.now());
    expect(ws.projectDirty).toBe(true);
    expect(readFileSync(join(ws.path, 'README.md'), 'utf8')).toBe('# demo\n');
  });

  it('readFile refuses traversal and escaping symlinks', async () => {
    const { ws } = await freshWorkspace();
    expect(git.readFile(ws.path, 'src/a.txt').content).toBe('one\ntwo\nthree\n');
    expect(() => git.readFile(ws.path, '../../etc/passwd')).toThrow(/escapes/);
    expect(() => git.readFile(ws.path, '/etc/passwd')).toThrow(/escapes/);
    symlinkSync('/etc/hostname', join(ws.path, 'link'));
    expect(() => git.readFile(ws.path, 'link')).toThrow(/escapes/);
    expect(() => git.readFile(ws.path, 'missing.txt')).toThrow(/not found/);
    writeFileSync(join(ws.path, 'b.bin'), Buffer.from([1, 0, 2]));
    expect(git.readFile(ws.path, 'b.bin').binary).toBe(true);
  });

  it('removeWorkspace refuses ids that escape the workspaces dir', () => {
    expect(() => git.removeWorkspace('../x')).toThrow();
    expect(() => git.removeWorkspace('')).toThrow();
  });
});

describe('apply', () => {
  it('branch strategy only creates the branch', async () => {
    const { project, ws } = await freshWorkspace();
    writeFileSync(join(ws.path, 'feature.txt'), 'f\n');
    await git.checkpoint(ws.path, 'feat');
    const r = await git.apply(project, ws.path, ws.branch, 'branch', 'msg');
    expect(r.branch).toBe(ws.branch);
    expect(sh(project, 'git', ['branch', '--list', ws.branch]).trim()).toContain(ws.branch);
    expect(existsSync(join(project, 'feature.txt'))).toBe(false);
    expect(sh(project, 'git', ['branch', '--show-current']).trim()).toBe('main');
  });

  it('squash creates one commit on the current branch', async () => {
    const { project, ws } = await freshWorkspace();
    writeFileSync(join(ws.path, 'feature.txt'), 'f\n');
    await git.checkpoint(ws.path, 'cp1');
    writeFileSync(join(ws.path, 'feature2.txt'), 'g\n');
    await git.checkpoint(ws.path, 'cp2');
    const r = await git.apply(project, ws.path, ws.branch, 'squash', 'Add features');
    expect(r.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(sh(project, 'git', ['log', '--format=%s']).trim().split('\n')).toEqual(['Add features', 'init']);
    expect(readFileSync(join(project, 'feature2.txt'), 'utf8')).toBe('g\n');
    expect(sh(project, 'git', ['status', '--porcelain']).trim()).toBe('');
  });

  it('merge creates a merge commit preserving checkpoints', async () => {
    const { project, ws } = await freshWorkspace();
    writeFileSync(join(ws.path, 'feature.txt'), 'f\n');
    await git.checkpoint(ws.path, 'cp1');
    // diverge the project so --no-ff is a real merge
    writeFileSync(join(project, 'other.txt'), 'o\n');
    sh(project, 'git', ['add', '-A']);
    sh(project, 'git', ['commit', '-q', '-m', 'other']);
    await git.apply(project, ws.path, ws.branch, 'merge', 'Merge LINA work');
    const log = sh(project, 'git', ['log', '--format=%s']).trim().split('\n');
    expect(log[0]).toBe('Merge LINA work');
    expect(log).toContain('cp1');
    expect(sh(project, 'git', ['rev-list', '--parents', '-n1', 'HEAD']).trim().split(' ')).toHaveLength(3);
  });

  it('refuses a dirty working tree and detached HEAD', async () => {
    const { project, ws } = await freshWorkspace();
    writeFileSync(join(ws.path, 'feature.txt'), 'f\n');
    await git.checkpoint(ws.path, 'cp1');
    writeFileSync(join(project, 'README.md'), 'local edit\n');
    await expect(git.apply(project, ws.path, ws.branch, 'squash', 'm')).rejects.toMatchObject({ code: 'dirty_worktree' });
    await expect(git.apply(project, ws.path, ws.branch, 'merge', 'm')).rejects.toMatchObject({ code: 'dirty_worktree' });
    expect(readFileSync(join(project, 'README.md'), 'utf8')).toBe('local edit\n');
    sh(project, 'git', ['checkout', '-q', '--', 'README.md']);
    sh(project, 'git', ['checkout', '-q', '--detach']);
    await expect(git.apply(project, ws.path, ws.branch, 'squash', 'm')).rejects.toMatchObject({ code: 'detached_head' });
  });

  it('aborts conflicts cleanly and keeps the branch', async () => {
    for (const strategy of ['squash', 'merge'] as const) {
      const { project, ws } = await freshWorkspace();
      writeFileSync(join(ws.path, 'src/a.txt'), 'one\nWORKSPACE\nthree\n');
      await git.checkpoint(ws.path, 'ws change');
      writeFileSync(join(project, 'src/a.txt'), 'one\nPROJECT\nthree\n');
      sh(project, 'git', ['commit', '-qam', 'project change']);
      const head = sh(project, 'git', ['rev-parse', 'HEAD']).trim();
      await expect(git.apply(project, ws.path, ws.branch, strategy, 'm')).rejects.toMatchObject({ code: 'conflict' });
      expect(sh(project, 'git', ['status', '--porcelain']).trim()).toBe('');
      expect(sh(project, 'git', ['rev-parse', 'HEAD']).trim()).toBe(head);
      expect(readFileSync(join(project, 'src/a.txt'), 'utf8')).toBe('one\nPROJECT\nthree\n');
      expect(sh(project, 'git', ['branch', '--list', ws.branch]).trim()).toContain(ws.branch);
    }
  });
});

describe('worktrees (parallel / compete)', () => {
  it('adds one worktree per agent on its own branch, reusable on retry', async () => {
    const { ws, id } = await freshWorkspace();
    const v = await git.createVariant(ws.path, id, 'codex', ws.baseCommit);
    expect(v).toEqual({ agent: 'codex', branch: `lina/${id.slice(0, 8)}-codex`, workspacePath: `${ws.path}--codex`, baseCommit: ws.baseCommit });
    expect(sh(v.workspacePath, 'git', ['branch', '--show-current']).trim()).toBe(v.branch);
    expect(readFileSync(join(v.workspacePath, '.git'), 'utf8')).toMatch(/^gitdir: /);
    expect(sh(v.workspacePath, 'git', ['remote']).trim()).toBe('');
    writeFileSync(join(v.workspacePath, 'w.txt'), 'w\n');
    const cp = await git.checkpoint(v.workspacePath, 'variant work');
    expect(cp).not.toBeNull();
    expect(await git.createVariant(ws.path, id, 'codex', ws.baseCommit)).toEqual(v); // retry keeps it
    expect(sh(ws.path, 'git', ['log', '--format=%s', '-1', v.branch]).trim()).toBe('variant work'); // shared repo
    await expect(git.createVariant(ws.path, 'other', 'codex', ws.baseCommit)).rejects.toThrow(/does not belong/);
  });

  it('seals per session: a config change made from a worktree is restored in the main clone', async () => {
    const { ws, id } = await freshWorkspace();
    const v = await git.createVariant(ws.path, id, 'claude', ws.baseCommit);
    sh(v.workspacePath, 'git', ['config', 'core.pager', 'evil']);
    expect(sh(ws.path, 'git', ['config', 'core.pager']).trim()).toBe('evil'); // shared config
    expect(git.restoreWorkspaceConfig(v.workspacePath)).toBe(true);
    expect(() => sh(ws.path, 'git', ['config', '--get', 'core.pager'])).toThrow();
    expect(existsSync(join(paths.workspaces, '.seal', `${id}--claude.config`))).toBe(false);
    expect(git.restoreWorkspaceConfig(v.workspacePath)).toBe(false);
  });

  it("refuses a worktree whose gitfile points at another session's repository", async () => {
    const a = await freshWorkspace();
    const b = await freshWorkspace();
    const v = await git.createVariant(a.ws.path, a.id, 'codex', a.ws.baseCommit);
    writeFileSync(join(v.workspacePath, '.git'), `gitdir: ${join(b.ws.path, '.git')}\n`);
    await expect(git.checkpoint(v.workspacePath, 'x')).rejects.toThrow(/\.git was replaced/);
    expect(() => git.restoreWorkspaceConfig(v.workspacePath)).toThrow(/\.git was replaced/);
  });

  it('removeWorkspace deletes the worktrees and the seal too, and refuses ambiguous ids', async () => {
    const { ws, id } = await freshWorkspace();
    const vs = await Promise.all((['codex', 'claude'] as const).map((a) => git.createVariant(ws.path, id, a, ws.baseCommit)));
    git.removeWorkspace(id);
    expect(existsSync(ws.path)).toBe(false);
    expect(vs.some((v) => existsSync(v.workspacePath))).toBe(false);
    expect(existsSync(join(paths.workspaces, '.seal', `${id}.config`))).toBe(false);
    expect(() => git.removeWorkspace(`${id}--codex`)).toThrow(/Invalid session id/);
  });

  it('merges branches, reports conflicts, checks markers, aborts and commits a resolution', async () => {
    const { ws, id } = await freshWorkspace();
    const a = await git.createVariant(ws.path, id, 'codex', ws.baseCommit);
    const b = await git.createVariant(ws.path, id, 'claude', ws.baseCommit);
    writeFileSync(join(a.workspacePath, 'src/a.txt'), 'one\nCODEX\nthree\n');
    writeFileSync(join(a.workspacePath, 'only-a.txt'), 'a\n');
    await git.checkpoint(a.workspacePath, 'a');
    writeFileSync(join(b.workspacePath, 'src/a.txt'), 'one\nCLAUDE\nthree\n');
    await git.checkpoint(b.workspacePath, 'b');
    const m1 = await git.mergeBranch(ws.path, a.branch, 'merge a');
    expect(m1.state).toBe('merged');
    expect(sh(ws.path, 'git', ['rev-list', '--parents', '-n1', 'HEAD']).trim().split(' ')).toHaveLength(3); // --no-ff
    expect((await git.mergeBranch(ws.path, a.branch, 'again')).state).toBe('up_to_date');
    const m2 = await git.mergeBranch(ws.path, b.branch, 'merge b');
    expect(m2).toEqual({ state: 'conflict', conflicts: ['src/a.txt'] });
    expect(await git.mergeInProgress(ws.path)).toBe(true);
    expect(git.filesWithConflictMarkers(ws.path, ['src/a.txt', 'missing.txt'])).toEqual(['src/a.txt']);
    await git.abortMerge(ws.path);
    expect(await git.mergeInProgress(ws.path)).toBe(false);
    expect(sh(ws.path, 'git', ['status', '--porcelain']).trim()).toBe('');
    expect((await git.mergeBranch(ws.path, b.branch, 'merge b')).state).toBe('conflict');
    writeFileSync(join(ws.path, 'src/a.txt'), 'one\nCODEX\nCLAUDE\nthree\n');
    expect(git.filesWithConflictMarkers(ws.path, ['src/a.txt'])).toEqual([]);
    const commit = await git.commitMerge(ws.path, 'resolved');
    expect(commit).toBe(sh(ws.path, 'git', ['rev-parse', 'HEAD']).trim());
    expect(await git.unmergedPaths(ws.path)).toEqual([]);
    // reset the session branch to a candidate's head (compete: choose)
    const head = sh(b.workspacePath, 'git', ['rev-parse', 'HEAD']).trim();
    writeFileSync(join(ws.path, 'junk.txt'), 'x\n');
    await git.resetBranch(ws.path, head);
    expect(sh(ws.path, 'git', ['rev-parse', 'HEAD']).trim()).toBe(head);
    expect(existsSync(join(ws.path, 'junk.txt'))).toBe(false);
    await expect(git.resetBranch(ws.path, '--hard')).rejects.toThrow(/Invalid commit/);
  });
});
