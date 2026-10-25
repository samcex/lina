import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeRepo, setupEnv, sh } from './helpers.js';
import { buildClaudeArgs } from '../../src/server/agents/claude.js';

setupEnv();
const git = await import('../../src/server/git.js');
const { ensureHome, paths } = await import('../../src/server/paths.js');
const { probeTestSandbox, runTests, sandboxedTestArgv } = await import('../../src/server/tests-runner.js');

beforeAll(() => ensureHome());
const sandboxUsable = (await probeTestSandbox()).ok;

async function freshWorkspace() {
  const project = makeRepo({ 'a.txt': 'one\n' });
  const id = 'hd' + Math.random().toString(36).slice(2, 10);
  const ws = await git.createWorkspace({ path: project }, id);
  return { project, id, ws: ws.path };
}

describe('workspace git hardening', () => {
  it('ignores hooks an agent installs, even if it points core.hooksPath at them', async () => {
    const { ws } = await freshWorkspace();
    const marker = join(mkdtempSync(join(tmpdir(), 'lina-hook-')), 'ran');
    const hook = join(ws, '.git', 'hooks', 'post-commit');
    mkdirSync(join(ws, '.git', 'hooks'), { recursive: true });
    writeFileSync(hook, `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(hook, 0o755);
    sh(ws, 'git', ['config', 'core.hooksPath', '.git/hooks']);
    writeFileSync(join(ws, 'a.txt'), 'two\n');
    expect(await git.checkpoint(ws, 'cp')).not.toBeNull();
    expect(existsSync(marker)).toBe(false);
  });

  it('restores a tampered .git/config so filter drivers cannot run during checkpoints', async () => {
    const { ws } = await freshWorkspace();
    const marker = join(mkdtempSync(join(tmpdir(), 'lina-filter-')), 'ran');
    sh(ws, 'git', ['config', 'filter.evil.clean', `sh -c 'touch ${marker}; cat'`]);
    writeFileSync(join(ws, '.gitattributes'), '* filter=evil\n');
    // control: a plain git add in the tampered repo really runs the driver
    sh(ws, 'git', ['add', '-A']);
    expect(existsSync(marker)).toBe(true);
    sh(ws, 'git', ['reset', '-q']);
    rmSync(marker);
    expect(git.restoreWorkspaceConfig(ws)).toBe(true);
    expect(() => sh(ws, 'git', ['config', '--get', 'filter.evil.clean'])).toThrow(); // exit 1: key absent
    writeFileSync(join(ws, 'a.txt'), 'three\n');
    expect(await git.checkpoint(ws, 'cp')).not.toBeNull();
    expect(existsSync(marker)).toBe(false);
    expect(git.restoreWorkspaceConfig(ws)).toBe(false);
  });

  it('refuses to run git when .git was swapped for a symlink to another repo', async () => {
    const { ws } = await freshWorkspace();
    const other = makeRepo({ 'x.txt': 'x\n' });
    renameSync(join(ws, '.git'), join(ws, '.git-orig'));
    symlinkSync(join(other, '.git'), join(ws, '.git'));
    writeFileSync(join(ws, 'a.txt'), 'four\n');
    await expect(git.checkpoint(ws, 'cp')).rejects.toThrow(/\.git was replaced/);
    expect(() => git.restoreWorkspaceConfig(ws)).toThrow(/\.git was replaced/);
    expect(sh(other, 'git', ['log', '--oneline']).trim().split('\n')).toHaveLength(1);
  });

  it('removes the seal together with the workspace', async () => {
    const { id, ws } = await freshWorkspace();
    const seal = join(paths.workspaces, '.seal', `${id}.config`);
    expect(existsSync(seal)).toBe(true);
    git.removeWorkspace(id);
    expect(existsSync(ws)).toBe(false);
    expect(existsSync(seal)).toBe(false);
  });
});

describe('reviewer permissions', () => {
  it('denies git --output (which can write files anywhere) for read-only turns', () => {
    const args = buildClaudeArgs({ model: 'opus', access: 'read', network: false });
    const deny = args.slice(args.indexOf('--disallowedTools') + 1);
    expect(deny).toEqual(expect.arrayContaining(['Bash(git * --output*)', 'Bash(git *--output=*)']));
  });
});

describe('sandboxed tests', () => {
  it('builds a bwrap argv: read-only root, writable workspace with read-only .git, no network unless allowed', async () => {
    const { ws } = await freshWorkspace();
    const a = sandboxedTestArgv('npm test', ws, false);
    expect(a.cmd).toMatch(/bwrap$/);
    const s = a.args.join(' ');
    expect(s).toContain('--ro-bind / /');
    expect(s).toContain(`--bind ${ws} ${ws}`);
    expect(s).toContain(`--ro-bind ${ws}/.git ${ws}/.git`);
    expect(a.args).toContain('--unshare-net');
    expect(a.args.slice(-3)).toEqual(['bash', '-lc', 'npm test']);
    expect(sandboxedTestArgv('x', ws, true).args).not.toContain('--unshare-net');
  });

  it.skipIf(!sandboxUsable)('runs real tests inside the sandbox, keeps failures, and blocks writes outside the workspace', async () => {
    const { ws } = await freshWorkspace();
    writeFileSync(join(ws, 't.test.js'), "const t=require('node:test');t('a',()=>{});t('b',()=>{});\n");
    const ok = await runTests(ws, 'node --test', { sandbox: { network: false } });
    expect(ok).toMatchObject({ ok: true, passed: 2, failed: 0, sandboxed: true });
    writeFileSync(join(ws, 't.test.js'), "const t=require('node:test');t('a',()=>{throw new Error('x')});\n");
    const bad = await runTests(ws, 'node --test', { sandbox: { network: false } });
    expect(bad).toMatchObject({ ok: false, failed: 1, sandboxed: true });
    const target = join(homedir(), `lina-escape-${Date.now()}.txt`);
    const esc = await runTests(ws, `echo x > ${target}`, { sandbox: { network: false } });
    expect(esc.ok).toBe(false);
    expect(existsSync(target)).toBe(false);
    const git = await runTests(ws, 'echo x > .git/probe', { sandbox: { network: false } });
    expect(git.ok).toBe(false);
  });
});
