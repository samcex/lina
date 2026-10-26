// Git operations for projects and isolated session workspaces.
// Everything goes through execFile('git', args) — never a shell string.
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { AGENT_IDS, type AgentId, type ApplyStrategy, type DiffFile, type TreeEntry, type Variant } from '../shared/types.js';
import { paths } from './paths.js';
import { LinaError } from './util.js';

export class GitError extends LinaError {}

export interface GitResult { code: number; stdout: string; stderr: string }

const SAFE_CONFIG = ['-c', 'core.quotePath=false', '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false', '-c', 'color.ui=false'];

function gitEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GIT_PAGER: 'cat', ...extra };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR', 'GIT_PREFIX']) {
    if (!extra || !(k in extra)) delete env[k];
  }
  return env;
}

/**
 * Agents can write anywhere in their workspace, including (for Claude) `.git/`. Every git call LINA makes inside a
 * workspace therefore ignores hooks and fsmonitor (command-line config beats repo config), and refuses to run if
 * `.git` was replaced by a symlink or a gitfile pointing outside the workspaces directory.
 */
const WORKSPACE_HARDENING = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

/** The workspace root containing `cwd`, or undefined when cwd is not inside a session workspace. */
function workspaceRootOf(cwd: string): string | undefined {
  const root = resolve(paths.workspaces);
  const abs = resolve(cwd);
  if (!abs.startsWith(root + sep)) return undefined;
  const first = abs.slice(root.length + 1).split(sep)[0];
  return first && !first.startsWith('.') ? join(root, first) : undefined;
}

const VARIANT_DIR_RE = /^(.+)--(codex|claude)$/;

function realOr(p: string): string { try { return realpathSync(p); } catch { return resolve(p); } }

/** The session's main workspace for a workspace path or one of its worktrees (`<id>--<agent>`). */
export function sessionWorkspaceOf(ws: string): string {
  const abs = resolve(ws);
  const m = VARIANT_DIR_RE.exec(basename(abs));
  return m && dirname(abs) === resolve(paths.workspaces) ? join(dirname(abs), m[1]) : abs;
}

/**
 * Throws when a workspace's `.git` is not a plain directory or a gitfile pointing back into the workspaces dir.
 * A worktree (`<id>--<agent>`) must point into its own session's `.git/worktrees/`, whose `commondir` must lead back
 * to that session's `.git` (so an edited gitfile cannot borrow another repository's config).
 */
export function assertWorkspaceGitDir(wsRoot: string): void {
  const dotGit = join(wsRoot, '.git');
  let st;
  try { st = lstatSync(dotGit); } catch { return; } // not created yet (clone in progress) — git will fail on its own
  if (st.isDirectory()) return;
  if (st.isFile()) {
    const m = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(dotGit, 'utf8'));
    const target = m ? resolve(wsRoot, m[1].trim()) : '';
    const main = sessionWorkspaceOf(wsRoot);
    if (main === resolve(wsRoot)) {
      if (target && target.startsWith(resolve(paths.workspaces) + sep)) return;
    } else if (target) {
      const t = realOr(target);
      let common = '';
      try { common = realOr(resolve(t, readFileSync(join(t, 'commondir'), 'utf8').trim())); } catch { /* missing */ }
      if (t.startsWith(join(realOr(main), '.git', 'worktrees') + sep) && common === join(realOr(main), '.git')) return;
    }
  }
  throw new GitError(`Workspace ${basename(wsRoot)}: .git was replaced (symlink or foreign gitfile); refusing to run git there`, 'git', 500);
}

export function git(cwd: string, args: string[], opts: { env?: Record<string, string>; timeoutMs?: number } = {}): Promise<GitResult> {
  const wsRoot = workspaceRootOf(cwd);
  if (wsRoot) {
    try { assertWorkspaceGitDir(wsRoot); } catch (e) { return Promise.resolve({ code: 128, stdout: '', stderr: (e as Error).message }); }
  }
  return new Promise((res) => {
    execFile('git', [...SAFE_CONFIG, ...(wsRoot ? WORKSPACE_HARDENING : []), ...args], {
      cwd, env: gitEnv(opts.env), maxBuffer: 256 * 1024 * 1024, timeout: opts.timeoutMs ?? 120_000, encoding: 'utf8',
    }, (err, stdout, stderr) => {
      let code = 0;
      if (err) code = typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1;
      res({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (err && code === 1 && !stderr ? err.message : '') });
    });
  });
}

/** Runs git and throws GitError on non-zero exit. Returns stdout. */
export async function gitOk(cwd: string, args: string[], opts: { env?: Record<string, string>; timeoutMs?: number; code?: string } = {}): Promise<string> {
  const r = await git(cwd, args, opts);
  if (r.code !== 0) {
    throw new GitError(`git ${args.filter((a) => !a.startsWith('-')).slice(0, 2).join(' ')} failed: ${(r.stderr || r.stdout).trim().slice(0, 800)}`, opts.code ?? 'git', 500);
  }
  return r.stdout;
}

// ── project repos ─────────────────────────────────────────────────────────

export interface EnsureRepoResult {
  /** Repository top-level directory. */
  path: string;
  /** git init was run (only with initGit). */
  initialized: boolean;
  /** An empty initial commit was created because the repo had no commits. */
  initialCommit?: string;
}

async function identityArgs(cwd: string): Promise<string[]> {
  const name = (await git(cwd, ['config', 'user.name'])).stdout.trim();
  const email = (await git(cwd, ['config', 'user.email'])).stdout.trim();
  return name && email ? [] : ['-c', 'user.name=LINA', '-c', 'user.email=lina@localhost'];
}

export async function ensureRepo(path: string, opts: { initGit?: boolean; create?: boolean } = {}): Promise<EnsureRepoResult> {
  const abs = resolve(path);
  if (!existsSync(abs)) {
    if (!opts.create) throw new LinaError(`Directory does not exist: ${abs}`, 'not_found', 404, 'Pass create: true to create it.');
    mkdirSync(abs, { recursive: true });
  }
  if (!statSync(abs).isDirectory()) throw new LinaError(`Not a directory: ${abs}`, 'invalid');
  let initialized = false;
  let top = await git(abs, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) {
    if (!opts.initGit) {
      throw new LinaError(`${abs} is not a git repository`, 'not_git', 400, 'LINA needs a git repository. Allow it to run `git init` (initGit: true).');
    }
    await gitOk(abs, ['init', '-q']);
    initialized = true;
    top = await git(abs, ['rev-parse', '--show-toplevel']);
  }
  const root = top.stdout.trim() || abs;
  const head = await git(root, ['rev-parse', '--verify', '-q', 'HEAD']);
  let initialCommit: string | undefined;
  if (head.code !== 0) {
    const id = await identityArgs(root);
    await gitOk(root, [...id, 'commit', '-q', '--allow-empty', '--no-verify', '-m', 'Initial commit (created by LINA)']);
    initialCommit = (await gitOk(root, ['rev-parse', 'HEAD'])).trim();
  }
  return { path: root, initialized, initialCommit };
}

export async function headCommit(cwd: string): Promise<string> {
  return (await gitOk(cwd, ['rev-parse', 'HEAD'])).trim();
}

export async function isDirty(cwd: string, includeUntracked = true): Promise<boolean> {
  const r = await gitOk(cwd, ['status', '--porcelain', includeUntracked ? '--untracked-files=normal' : '--untracked-files=no']);
  return r.trim().length > 0;
}

// ── workspaces ────────────────────────────────────────────────────────────

export const WORKSPACE_EXCLUDES = [
  'node_modules/', '.venv/', 'venv/', '__pycache__/', '.pytest_cache/', '.next/', '.turbo/', '.cache/', '*.pyc', '.DS_Store',
];

export interface Workspace { path: string; branch: string; baseCommit: string; projectDirty: boolean }

export function shortId(sessionId: string): string { return sessionId.slice(0, 8); }

/**
 * Clones the project at its HEAD into ~/.lina/workspaces/<id>.
 * Decision: a plain local-path clone (implicitly --local) hardlinks objects when possible and silently
 * falls back to copying across filesystems (an explicit --local would die instead). Git objects are
 * immutable, so hardlinks cannot leak workspace changes into the project.
 */
export async function createWorkspace(project: { path: string }, sessionId: string): Promise<Workspace> {
  const ws = paths.workspace(sessionId);
  assertInsideWorkspaces(ws);
  if (existsSync(ws)) throw new GitError(`Workspace already exists: ${ws}`, 'git', 409);
  mkdirSync(dirname(ws), { recursive: true, mode: 0o700 });
  const base = await headCommit(project.path);
  const projectDirty = await isDirty(project.path);
  const branch = `lina/${shortId(sessionId)}`;
  try {
    await gitOk(dirname(ws), ['-c', 'core.hooksPath=/dev/null', 'clone', '-q', '--no-checkout', project.path, ws], { timeoutMs: 600_000 });
    await gitOk(ws, ['config', 'user.name', 'LINA']);
    await gitOk(ws, ['config', 'user.email', 'lina@localhost']);
    await gitOk(ws, ['config', 'commit.gpgsign', 'false']);
    await gitOk(ws, ['config', 'tag.gpgsign', 'false']);
    await gitOk(ws, ['config', 'core.hooksPath', '.git/lina-no-hooks']);
    await gitOk(ws, ['checkout', '-q', '-b', branch, base]);
    await git(ws, ['remote', 'remove', 'origin']);
    const exclude = join(ws, '.git', 'info', 'exclude');
    mkdirSync(dirname(exclude), { recursive: true });
    const prev = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
    writeFileSync(exclude, prev + (prev.endsWith('\n') || !prev ? '' : '\n') + '# LINA workspace excludes\n' + WORKSPACE_EXCLUDES.join('\n') + '\n');
    sealWorkspaceConfig(ws);
  } catch (e) {
    try { removeWorkspace(sessionId); } catch { /* best effort */ }
    throw e;
  }
  return { path: ws, branch, baseCommit: base, projectDirty };
}

export interface FileStat { path: string; oldPath?: string; status: DiffFile['status']; additions: number; deletions: number; binary?: boolean }

/** Stages everything and commits if there are changes. Returns null when nothing changed. */
export async function checkpoint(ws: string, message: string): Promise<{ commit: string; files: FileStat[] } | null> {
  await gitOk(ws, ['add', '-A']);
  const staged = await git(ws, ['diff', '--cached', '--quiet']);
  if (staged.code === 0) return null;
  await gitOk(ws, ['commit', '-q', '--no-verify', '-m', message]);
  const commit = await headCommit(ws);
  const parent = await git(ws, ['rev-parse', '--verify', '-q', 'HEAD~1']);
  const files = parent.code === 0 ? await numstat(ws, ['HEAD~1', 'HEAD']) : [];
  return { commit, files };
}

function mapStatus(letter: string): DiffFile['status'] {
  switch (letter[0]) {
    case 'A': case 'C': return 'added';
    case 'D': return 'deleted';
    case 'R': return 'renamed';
    default: return 'modified';
  }
}

/** numstat + name-status for a diff spec (e.g. [from, to] or ['--cached', from]). */
export async function numstat(cwd: string, spec: string[], env?: Record<string, string>): Promise<FileStat[]> {
  const ns = await gitOk(cwd, ['diff', '--no-ext-diff', '-M', '--numstat', '-z', ...spec], { env });
  const st = await gitOk(cwd, ['diff', '--no-ext-diff', '-M', '--name-status', '-z', ...spec], { env });
  const out: FileStat[] = [];
  const a = ns.split('\0');
  for (let i = 0; i < a.length; i++) {
    const rec = a[i];
    if (!rec) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(rec);
    if (!m) continue;
    let path = m[3];
    let oldPath: string | undefined;
    if (path === '') { oldPath = a[++i]; path = a[++i]; }
    const binary = m[1] === '-' && m[2] === '-';
    out.push({ path, oldPath, status: oldPath ? 'renamed' : 'modified', additions: binary ? 0 : Number(m[1]), deletions: binary ? 0 : Number(m[2]), binary: binary || undefined });
  }
  const statusByPath = new Map<string, DiffFile['status']>();
  const b = st.split('\0');
  for (let i = 0; i < b.length; i++) {
    const letter = b[i];
    if (!letter) continue;
    if (letter[0] === 'R' || letter[0] === 'C') { i++; statusByPath.set(b[++i], mapStatus(letter)); }
    else statusByPath.set(b[++i], mapStatus(letter));
  }
  for (const f of out) {
    const s = statusByPath.get(f.path);
    if (s) f.status = s;
    if (f.status !== 'renamed') delete f.oldPath;
  }
  return out;
}

const PATCH_MAX = 100_000;
const PATCH_TOTAL_MAX = 3_000_000;

/** Runs fn with a throwaway index containing the full working tree (untracked included). */
async function withWorktreeIndex<T>(ws: string, fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'lina-idx-'));
  const env = { GIT_INDEX_FILE: join(dir, 'index') };
  try {
    await gitOk(ws, ['read-tree', 'HEAD'], { env });
    await gitOk(ws, ['add', '-A'], { env });
    return await fn(env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Exact working-file content, including untracked files; leaves HEAD and the real index untouched. */
export async function worktreeTree(ws: string): Promise<string> {
  const hash = (await headCommit(ws)).length === 64 ? 'sha256' : 'sha1';
  return (await withWorktreeIndex(ws, async (env) => {
    // Git clean filters/EOL conversion must not alter the bytes kept for undo.
    const entries = (await gitOk(ws, ['ls-files', '--stage', '-z'], { env })).split('\0').filter(Boolean);
    const updates: string[] = [];
    for (const entry of entries) {
      const m = /^(\d+) ([a-f0-9]+) 0\t([\s\S]+)$/.exec(entry);
      if (!m || m[1] === '160000') continue;
      const file = join(ws, m[3]);
      let st;
      try { st = lstatSync(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
      const bytes = st.isSymbolicLink() ? Buffer.from(readlinkSync(file)) : readFileSync(file);
      const mode = st.isSymbolicLink() ? '120000' : (st.mode & 0o111) ? '100755' : '100644';
      const object = createHash(hash).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      if (object !== m[2]) await gitInput(ws, ['hash-object', '-w', '--no-filters', '--stdin'], bytes);
      if (object !== m[2] || mode !== m[1]) updates.push(`${mode} ${object}\t${m[3]}\0`);
    }
    if (updates.length) await gitInput(ws, ['update-index', '-z', '--index-info'], Buffer.from(updates.join('')), env);
    return gitOk(ws, ['write-tree'], { env });
  })).trim();
}

/** Private snapshot object; never moves HEAD or touches the user's real index. */
export async function snapshot(ws: string, ref: string): Promise<string> {
  const tree = await worktreeTree(ws);
  const commit = (await gitOk(ws, [...await identityArgs(ws), 'commit-tree', tree, '-m', 'LINA: working files snapshot'])).trim();
  await gitOk(ws, ['update-ref', ref, commit]);
  return commit;
}

function gitInput(ws: string, args: string[], input: Buffer, env?: Record<string, string>): Promise<Buffer> {
  return new Promise((res, rej) => {
    const child = execFile('git', args, { cwd: ws, env: gitEnv(env), encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, timeout: 120_000 }, (err, out) => err ? rej(err) : res(out));
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}

export interface SnapshotFile { mode: string; object: string }
export async function snapshotFiles(ws: string, commit: string): Promise<Map<string, SnapshotFile>> {
  const out = await gitOk(ws, ['ls-tree', '-r', '-z', commit]);
  const files = new Map<string, SnapshotFile>();
  for (const rec of out.split('\0')) {
    const m = /^(\d+) \w+ ([a-f0-9]+)\t([\s\S]+)$/.exec(rec);
    if (m) files.set(m[3], { mode: m[1], object: m[2] });
  }
  return files;
}

export function blob(ws: string, object: string): Promise<Buffer> {
  if (!/^[a-f0-9]{40,64}$/.test(object)) throw new GitError('Invalid blob object', 'git', 500);
  return new Promise((res, rej) => execFile('git', ['cat-file', 'blob', object], {
    cwd: ws, env: gitEnv(), encoding: 'buffer', maxBuffer: 256 * 1024 * 1024,
  }, (err, out) => err ? rej(err) : res(out)));
}

/** Snapshot the initial files without touching HEAD, branches or the user's index. */
export async function directWorkspace(project: { path: string }, sessionId: string): Promise<Workspace> {
  const head = await headCommit(project.path);
  const projectDirty = await isDirty(project.path);
  let baseCommit = head;
  if (projectDirty) {
    const tree = await withWorktreeIndex(project.path, (env) => gitOk(project.path, ['write-tree'], { env }));
    baseCommit = (await gitOk(project.path, [...await identityArgs(project.path), 'commit-tree', tree.trim(), '-p', head, '-m', 'LINA: initial working files'])).trim();
  }
  // A private ref keeps a dirty baseline available across restarts and git GC. It is not a branch.
  await gitOk(project.path, ['update-ref', `refs/lina/baselines/${sessionId}`, baseCommit]);
  const branch = (await git(project.path, ['symbolic-ref', '--short', '-q', 'HEAD'])).stdout.trim() || 'HEAD';
  return { path: project.path, branch, baseCommit, projectDirty };
}

/** Diff between two commits, or `to = 'worktree'` for the current working tree (incl. untracked). */
export async function diff(ws: string, from: string, to: string): Promise<DiffFile[]> {
  if (to === 'worktree') return withWorktreeIndex(ws, (env) => diffSpec(ws, ['--cached', from], env));
  return diffSpec(ws, [from, to]);
}

async function diffSpec(ws: string, spec: string[], env?: Record<string, string>): Promise<DiffFile[]> {
  const stats = await numstat(ws, spec, env);
  if (!stats.length) return [];
  const patch = await gitOk(ws, ['diff', '--no-ext-diff', '--no-color', '-M', ...spec], { env });
  const chunks = patch.split(/^(?=diff --git )/m).filter((c) => c.startsWith('diff --git '));
  let total = 0;
  return stats.map((f, i) => {
    let p = chunks.length === stats.length ? chunks[i] : (chunks.find((c) => c.includes(` b/${f.path}\n`)) ?? '');
    if (p.length > PATCH_MAX) p = p.slice(0, PATCH_MAX) + '\n… (patch truncated)\n';
    if (total > PATCH_TOTAL_MAX) p = '… (patch omitted: diff too large)\n';
    total += p.length;
    const d: DiffFile = { path: f.path, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.binary ? '' : p };
    if (f.oldPath) d.oldPath = f.oldPath;
    if (f.binary || /^Binary files /m.test(p)) d.binary = true;
    return d;
  });
}

export async function diffStat(ws: string, from: string, to = 'HEAD'): Promise<string> {
  return (await gitOk(ws, ['diff', '--no-ext-diff', '--stat=100', '-M', from, to])).trim();
}

const TREE_MAX = 20_000;

function splitZ(s: string): string[] { return s.split('\0').filter(Boolean); }

function withDirs(files: { path: string; size?: number; changed?: boolean }[]): TreeEntry[] {
  const dirs = new Map<string, boolean>();
  for (const f of files) {
    const parts = f.path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join('/');
      dirs.set(d, (dirs.get(d) ?? false) || !!f.changed);
    }
  }
  const out: TreeEntry[] = [];
  for (const [d, changed] of dirs) out.push(changed ? { path: d, type: 'dir', changed } : { path: d, type: 'dir' });
  for (const f of files) {
    const e: TreeEntry = { path: f.path, type: 'file' };
    if (f.size !== undefined) e.size = f.size;
    if (f.changed) e.changed = true;
    out.push(e);
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Workspace files (tracked + untracked non-ignored), marking those changed vs `base`. */
export async function tree(ws: string, base?: string, direct = false): Promise<TreeEntry[]> {
  const tracked = splitZ(await gitOk(ws, ['ls-files', '-z']));
  const untracked = splitZ(await gitOk(ws, ['ls-files', '-z', '--others', '--exclude-standard']));
  const changed = new Set<string>(direct ? [] : untracked);
  if (base && direct) for (const f of await diff(ws, base, 'worktree')) changed.add(f.path);
  else if (base) for (const p of splitZ(await gitOk(ws, ['diff', '--no-ext-diff', '--name-only', '-z', base]))) changed.add(p);
  const all = [...new Set([...tracked, ...untracked])].slice(0, TREE_MAX);
  const files: { path: string; size?: number; changed?: boolean }[] = [];
  for (const p of all) {
    let size: number | undefined;
    try { const s = lstatSync(join(ws, p)); if (!s.isFile()) { if (!s.isSymbolicLink()) continue; } else size = s.size; } catch { continue; }
    files.push({ path: p, size, changed: changed.has(p) });
  }
  return withDirs(files);
}

/** Files of the project's committed HEAD. */
export async function projectTree(projectPath: string): Promise<TreeEntry[]> {
  const out = await gitOk(projectPath, ['ls-tree', '-r', '-l', '-z', 'HEAD']);
  const files: { path: string; size?: number }[] = [];
  for (const rec of splitZ(out).slice(0, TREE_MAX)) {
    const m = /^\d+ (\w+) [0-9a-f]+\s+(-|\d+)\t(.*)$/s.exec(rec);
    if (!m || m[1] !== 'blob') continue;
    files.push({ path: m[3], size: m[2] === '-' ? undefined : Number(m[2]) });
  }
  return withDirs(files);
}

const FILE_MAX = 1024 * 1024;

/** Reads a workspace file; refuses paths (or symlinks) resolving outside the workspace. */
export function readFile(ws: string, rel: string): { path: string; content: string; truncated: boolean; binary: boolean } {
  if (!rel || rel.includes('\0')) throw new LinaError('Invalid path', 'invalid');
  const root = realpathSync(ws);
  const full = resolve(root, rel);
  if (full !== root && !full.startsWith(root + sep)) throw new LinaError('Path escapes the workspace', 'forbidden', 403);
  let real: string;
  try { real = realpathSync(full); } catch { throw new LinaError(`File not found: ${rel}`, 'not_found', 404); }
  if (!real.startsWith(root + sep)) throw new LinaError('Path escapes the workspace', 'forbidden', 403);
  const st = statSync(real);
  if (!st.isFile()) throw new LinaError(`Not a file: ${rel}`, 'invalid');
  const len = Math.min(st.size, FILE_MAX);
  const buf = Buffer.alloc(len);
  const fd = openSync(real, 'r');
  try { readSync(fd, buf, 0, len, 0); } finally { closeSync(fd); }
  const binary = buf.subarray(0, 8000).includes(0);
  return { path: rel, content: binary ? '' : buf.toString('utf8'), truncated: st.size > FILE_MAX, binary };
}

// ── apply to the user's project ───────────────────────────────────────────

export interface ApplyResult { strategy: ApplyStrategy; branch: string; commit?: string; message: string }

/**
 * Brings the workspace branch into the project repo. Never pushes.
 * branch: only creates/updates lina/<short>. squash/merge: require a clean (tracked) working tree
 * and a non-detached HEAD; conflicts are aborted cleanly and reported as code 'conflict'.
 */
export async function apply(projectPath: string, ws: string, branch: string, strategy: ApplyStrategy, message: string): Promise<ApplyResult> {
  if (strategy !== 'branch' && strategy !== 'squash' && strategy !== 'merge') throw new LinaError(`Unknown strategy: ${strategy}`, 'invalid');
  const localBranch = branch.startsWith('lina/') ? branch : `lina/${branch}`;
  if (strategy !== 'branch') {
    if (await isDirty(projectPath, false)) {
      throw new LinaError('The project has uncommitted changes', 'dirty_worktree', 409, 'Commit or stash your changes, or approve with strategy "branch".');
    }
    const sym = await git(projectPath, ['symbolic-ref', '-q', 'HEAD']);
    if (sym.code !== 0) throw new LinaError('The project HEAD is detached', 'detached_head', 409, 'Check out a branch first, or approve with strategy "branch".');
    const cur = sym.stdout.trim();
    if (cur === `refs/heads/${localBranch}`) throw new LinaError(`The project currently has ${localBranch} checked out`, 'invalid', 409);
  }
  // Fetch the workspace branch into the project (force: the lina/* branch is LINA-owned).
  await gitOk(projectPath, ['fetch', '-q', '--no-tags', ws, `+refs/heads/${branch}:refs/heads/${localBranch}`], { timeoutMs: 600_000 });
  if (strategy === 'branch') {
    const commit = (await gitOk(projectPath, ['rev-parse', localBranch])).trim();
    return { strategy, branch: localBranch, commit, message: `Created branch ${localBranch} at ${commit.slice(0, 8)}` };
  }
  const id = await identityArgs(projectPath);
  if (strategy === 'squash') {
    const m = await git(projectPath, ['merge', '--squash', '-q', localBranch]);
    if (m.code !== 0) {
      await git(projectPath, ['reset', '-q', '--merge']);
      throw conflictError(localBranch, m);
    }
    const staged = await git(projectPath, ['diff', '--cached', '--quiet']);
    if (staged.code === 0) {
      return { strategy, branch: localBranch, message: `Nothing to apply: the project already contains these changes (branch ${localBranch} kept)` };
    }
    const c = await git(projectPath, [...id, 'commit', '-q', '-m', message]);
    if (c.code !== 0) {
      await git(projectPath, ['reset', '-q', '--merge']);
      throw new GitError(`Commit failed: ${(c.stderr || c.stdout).trim().slice(0, 800)}`, 'git', 500);
    }
  } else {
    const m = await git(projectPath, [...id, 'merge', '-q', '--no-ff', '-m', message, localBranch]);
    if (m.code !== 0) {
      const abort = await git(projectPath, ['merge', '--abort']);
      if (abort.code !== 0) await git(projectPath, ['reset', '-q', '--merge']);
      throw conflictError(localBranch, m);
    }
  }
  const commit = await headCommit(projectPath);
  return { strategy, branch: localBranch, commit, message: `${strategy === 'squash' ? 'Squashed' : 'Merged'} into ${(await currentBranch(projectPath)) ?? 'HEAD'} as ${commit.slice(0, 8)} (branch ${localBranch} kept)` };
}

function conflictError(branch: string, r: GitResult): LinaError {
  const out = (r.stdout + '\n' + r.stderr).trim();
  const conflict = /conflict/i.test(out);
  return new LinaError(
    conflict ? `Merge conflict; nothing was changed in your project. Branch ${branch} is available to merge manually.` : `Merge failed: ${out.slice(0, 600)}`,
    conflict ? 'conflict' : 'git', 409,
    conflict ? `Resolve manually: git merge ${branch}` : undefined,
  );
}

export async function currentBranch(cwd: string): Promise<string | undefined> {
  const r = await git(cwd, ['symbolic-ref', '-q', '--short', 'HEAD']);
  return r.code === 0 ? r.stdout.trim() : undefined;
}

function assertInsideWorkspaces(p: string): void {
  const root = resolve(paths.workspaces);
  const abs = resolve(p);
  if (!abs.startsWith(root + sep) || abs === root) throw new LinaError(`Refusing to touch ${abs}: not inside ${root}`, 'forbidden', 500);
}

// ── .git/config seal ──────────────────────────────────────────────────────
// An agent that rewrites .git/config can make LINA's own git calls run programs (filters, textconv, diff drivers,
// include.path, core.sshCommand…). LINA keeps a copy outside the workspace and restores it after every agent turn.

// The seal is per session: worktrees share the main clone's .git/config, so a path inside a worktree maps to it.

function sealPath(ws: string): string { return join(resolve(paths.workspaces), '.seal', `${basename(sessionWorkspaceOf(ws))}.config`); }

/** Records the session's current .git/config as the trusted version (ws: the workspace or one of its worktrees). */
export function sealWorkspaceConfig(ws: string): void {
  assertInsideWorkspaces(ws);
  const seal = sealPath(ws);
  mkdirSync(dirname(seal), { recursive: true, mode: 0o700 });
  writeFileSync(seal, readFileSync(join(sessionWorkspaceOf(ws), '.git', 'config')), { mode: 0o600 });
}

/**
 * Restores the session's .git/config from the seal if it changed. Returns true when it had to be restored.
 * Works for the main workspace and its worktrees. Workspaces created before the seal existed get sealed now.
 */
export function restoreWorkspaceConfig(ws: string): boolean {
  assertInsideWorkspaces(ws);
  assertWorkspaceGitDir(ws);
  const main = sessionWorkspaceOf(ws);
  if (main !== resolve(ws)) { assertInsideWorkspaces(main); assertWorkspaceGitDir(main); }
  const cfg = join(main, '.git', 'config');
  const seal = sealPath(ws);
  if (!existsSync(seal)) { if (existsSync(cfg)) sealWorkspaceConfig(ws); return false; }
  const trusted = readFileSync(seal);
  let current: Buffer | undefined;
  try { current = readFileSync(cfg); } catch { /* deleted */ }
  if (current && current.equals(trusted)) return false;
  rmSync(cfg, { force: true }); // also replaces a symlink instead of writing through it
  writeFileSync(cfg, trusted);
  return true;
}

/**
 * Deletes a session workspace, its worktrees (`<id>--<agent>`) and its seal. Only ever deletes inside paths.workspaces.
 * The worktrees' admin dirs live in the main clone's .git, so removing the clone prunes them too.
 */
export function removeWorkspace(sessionId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId) || sessionId.includes('--')) throw new LinaError('Invalid session id', 'invalid');
  const ws = paths.workspace(sessionId);
  assertInsideWorkspaces(ws);
  if (basename(ws) !== sessionId) throw new LinaError('Invalid workspace path', 'forbidden', 500);
  for (const agent of AGENT_IDS) {
    const wt = variantPath(sessionId, agent);
    assertInsideWorkspaces(wt);
    if (basename(wt) !== `${sessionId}--${agent}` || dirname(wt) !== dirname(ws)) throw new LinaError('Invalid worktree path', 'forbidden', 500);
    rmSync(wt, { recursive: true, force: true });
  }
  rmSync(ws, { recursive: true, force: true });
  rmSync(sealPath(ws), { force: true });
}

// ── worktrees (parallel / compete) ────────────────────────────────────────

export function variantPath(sessionId: string, agent: AgentId): string { return `${paths.workspace(sessionId)}--${agent}`; }
export function variantBranch(sessionId: string, agent: AgentId): string { return `lina/${shortId(sessionId)}-${agent}`; }

/**
 * Adds (or, on a retry, reuses) the agent's worktree of the session clone: ~/.lina/workspaces/<id>--<agent> on
 * branch lina/<short>-<agent>, starting at `base`.
 */
export async function createVariant(sessionWs: string, sessionId: string, agent: AgentId, base: string): Promise<Variant> {
  if (!AGENT_IDS.includes(agent)) throw new LinaError(`Unknown agent: ${String(agent)}`, 'invalid');
  if (resolve(sessionWs) !== resolve(paths.workspace(sessionId))) throw new LinaError('Workspace does not belong to the session', 'forbidden', 500);
  const path = variantPath(sessionId, agent);
  assertInsideWorkspaces(path);
  const branch = variantBranch(sessionId, agent);
  const variant: Variant = { agent, branch, workspacePath: path, baseCommit: base };
  if (existsSync(path)) {
    const cur = existsSync(join(path, '.git')) ? await git(path, ['symbolic-ref', '-q', '--short', 'HEAD']) : undefined;
    if (cur?.code === 0 && cur.stdout.trim() === branch) return variant;
    rmSync(path, { recursive: true, force: true });
  }
  await git(sessionWs, ['worktree', 'prune']);
  const exists = (await git(sessionWs, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`])).code === 0;
  await gitOk(sessionWs, exists ? ['worktree', 'add', '-q', path, branch] : ['worktree', 'add', '-q', '-b', branch, path, base]);
  return variant;
}

// ── integration (parallel) ────────────────────────────────────────────────

export type MergeOutcome = { state: 'merged' | 'up_to_date'; commit: string } | { state: 'conflict'; conflicts: string[] };

/** `git merge --no-ff` of `branch` into the current branch. A conflict leaves the conflicted tree in place. */
export async function mergeBranch(ws: string, branch: string, message: string): Promise<MergeOutcome> {
  const r = await git(ws, ['merge', '--no-ff', '--no-edit', '-m', message, branch]);
  if (r.code === 0) return { state: /Already up[ -]to[ -]date/i.test(r.stdout) ? 'up_to_date' : 'merged', commit: await headCommit(ws) };
  const conflicts = await unmergedPaths(ws);
  if (conflicts.length) return { state: 'conflict', conflicts };
  if (await mergeInProgress(ws)) await abortMerge(ws);
  throw new GitError(`git merge ${branch} failed: ${(r.stderr || r.stdout).trim().slice(0, 800)}`, 'git', 500);
}

export async function unmergedPaths(ws: string): Promise<string[]> {
  return [...new Set(splitZ(await gitOk(ws, ['diff', '--name-only', '--diff-filter=U', '-z'])))];
}

export async function mergeInProgress(ws: string): Promise<boolean> {
  return (await git(ws, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).code === 0;
}

export async function abortMerge(ws: string): Promise<void> {
  const r = await git(ws, ['merge', '--abort']);
  if (r.code !== 0) await gitOk(ws, ['reset', '-q', '--merge']);
}

const MARKER_RE = /^(<{7}|>{7})(?: |$)/m;

/** Files (of `files`, relative to ws) that still contain `<<<<<<<` / `>>>>>>>` conflict markers. Missing files have none. */
export function filesWithConflictMarkers(ws: string, files: string[]): string[] {
  return files.filter((f) => {
    try { const r = readFile(ws, f); return !r.binary && MARKER_RE.test(r.content); } catch (e) { return !(e instanceof LinaError && e.code === 'not_found'); }
  });
}

/** Stages the resolved tree and commits the merge in progress. Refuses while paths are still unmerged. */
export async function commitMerge(ws: string, message: string): Promise<string> {
  await gitOk(ws, ['add', '-A']);
  const left = await unmergedPaths(ws);
  if (left.length) throw new GitError(`Unmerged paths remain: ${left.join(', ')}`, 'git', 500);
  await gitOk(ws, ['commit', '-q', '--no-verify', '--no-edit', '-m', message]);
  return headCommit(ws);
}

/** Points the workspace's current branch at `commit` (compete: adopt the chosen candidate) and cleans the tree. */
export async function resetBranch(ws: string, commit: string): Promise<void> {
  if (!/^[0-9a-f]{7,64}$/.test(commit)) throw new LinaError('Invalid commit', 'invalid');
  await gitOk(ws, ['reset', '-q', '--hard', commit]);
  await gitOk(ws, ['clean', '-fdq']);
}
