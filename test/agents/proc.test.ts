import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { agentEnv, execText, runProcess, which } from '../../src/server/agents/proc.js';

const dir = mkdtempSync(join(tmpdir(), 'lina-proc-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe('runProcess', () => {
  it('delivers stdin and splits lines (incl. partial final line)', async () => {
    const lines: string[] = [];
    const r = await runProcess({ cmd: 'cat', args: [], cwd: dir, stdin: 'a\nb\r\nc', onLine: (l) => lines.push(l) });
    expect(r.exitCode).toBe(0);
    expect(lines).toEqual(['a', 'b', 'c']);
  });

  it('closes stdin even when none is given', async () => {
    const r = await runProcess({ cmd: 'cat', args: [], cwd: dir, turnTimeoutMs: 5000 });
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBeNull();
  });

  it('handles lines split across chunks and huge lines', async () => {
    const lines: string[] = [];
    const script = 'process.stdout.write("x".repeat(3_000_000)); setTimeout(() => { process.stdout.write("y\\nsecond\\n"); }, 20);';
    const r = await runProcess({ cmd: process.execPath, args: ['-e', script], cwd: dir, onLine: (l) => lines.push(l) });
    expect(r.exitCode).toBe(0);
    expect(lines).toHaveLength(2);
    expect(lines[0].length).toBe(3_000_001);
    expect(lines[1]).toBe('second');
  });

  it('keeps a stderr tail and reports exit codes', async () => {
    const r = await runProcess({ cmd: 'sh', args: ['-c', 'echo oops >&2; exit 3'], cwd: dir });
    expect(r.exitCode).toBe(3);
    expect(r.stderrTail).toContain('oops');
  });

  it('caps stderr at ~16KB', async () => {
    const r = await runProcess({ cmd: process.execPath, args: ['-e', 'process.stderr.write("e".repeat(100000) + "END")'], cwd: dir });
    expect(r.stderrTail.length).toBeLessThanOrEqual(16 * 1024);
    expect(r.stderrTail.endsWith('END')).toBe(true);
  });

  it('reports spawn errors', async () => {
    const r = await runProcess({ cmd: 'definitely-not-a-command-lina', args: [], cwd: dir });
    expect(r.spawnError).toBe('ENOENT');
    expect(r.exitCode).toBeNull();
  });

  it('turn timeout kills the process', async () => {
    const t0 = Date.now();
    const r = await runProcess({ cmd: 'sleep', args: ['30'], cwd: dir, turnTimeoutMs: 300 });
    expect(r.timedOut).toBe('turn');
    expect(r.signal).toBe('SIGTERM');
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('idle timeout fires without output and is reset by output', async () => {
    const r1 = await runProcess({ cmd: 'sleep', args: ['30'], cwd: dir, idleTimeoutMs: 300 });
    expect(r1.timedOut).toBe('idle');
    // Prints every 100ms for ~800ms: never idle for 400ms.
    const r2 = await runProcess({ cmd: 'sh', args: ['-c', 'for i in 1 2 3 4 5 6 7 8; do echo $i; sleep 0.1; done'], cwd: dir, idleTimeoutMs: 400 });
    expect(r2.timedOut).toBeNull();
    expect(r2.exitCode).toBe(0);
  });

  it('abort kills the whole process group, including children', async () => {
    const pidFile = join(dir, 'child.pid');
    const ac = new AbortController();
    const p = runProcess({
      cmd: 'sh', args: ['-c', `sleep 60 & echo $! > ${pidFile}; echo started; wait`], cwd: dir, signal: ac.signal,
      onLine: (l) => { if (l === 'started') setTimeout(() => ac.abort(), 50); },
    });
    const r = await p;
    expect(r.aborted).toBe(true);
    const childPid = Number(readFileSync(pidFile, 'utf8').trim());
    await new Promise((res) => setTimeout(res, 200));
    expect(alive(childPid)).toBe(false);
  });

  it('escalates to SIGKILL when SIGTERM is ignored', async () => {
    const r = await runProcess({ cmd: 'sh', args: ['-c', "trap '' TERM; echo ready; sleep 30"], cwd: dir, turnTimeoutMs: 200, killGraceMs: 300 });
    expect(r.timedOut).toBe('turn');
    expect(r.exitCode === null || r.signal === 'SIGKILL' || r.signal === 'SIGTERM').toBe(true);
  }, 10_000);

  it('does not hang when a background grandchild keeps stdout open', async () => {
    const t0 = Date.now();
    const r = await runProcess({ cmd: 'sh', args: ['-c', 'sleep 30 & echo done'], cwd: dir });
    expect(r.exitCode).toBe(0);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('kills stubborn background descendants after a normal exit even when their pipes are closed', async () => {
    const lines: string[] = [];
    const descendant = 'process.on("SIGTERM", () => {}); console.log(process.pid); setInterval(() => {}, 1000)';
    // Wait for the child to install its handler before closing the parent's pipes.
    const parent = `const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','pipe','ignore']}); c.stdout.once('data',b=>{process.stdout.write(b); c.stdout.destroy(); c.unref();});`;
    await runProcess({ cmd: process.execPath, args: ['-e', parent], cwd: dir, killGraceMs: 100, onLine: (line) => lines.push(line) });
    const pid = Number(lines[0]);
    expect(pid).toBeGreaterThan(0);
    try {
      const deadline = Date.now() + 2000;
      while (alive(pid) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 25));
      expect(alive(pid)).toBe(false);
    } finally { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  });

  it('pre-aborted signal resolves immediately', async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await runProcess({ cmd: 'sleep', args: ['5'], cwd: dir, signal: ac.signal });
    expect(r.aborted).toBe(true);
  });
});

describe('which / execText / agentEnv', () => {
  it('which finds sh and not junk', async () => {
    expect(await which('sh')).toMatch(/\/sh$/);
    expect(await which('definitely-not-a-command-lina')).toBeNull();
  });
  it('execText collects output and input', async () => {
    const r = await execText('sh', ['-c', 'read x; echo "got $x"; echo err >&2'], { input: 'hello\n' });
    expect(r).toMatchObject({ code: 0, stdout: 'got hello', stderr: 'err\n' });
    const t = await execText('sleep', ['10'], { timeoutMs: 200 });
    expect(t.timedOut).toBe(true);
  });
  it('agentEnv strips parent agent session variables', () => {
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_EFFORT = 'max';
    const env = agentEnv({ FOO: 'bar' });
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_EFFORT).toBeUndefined();
    expect(env.FOO).toBe('bar');
    expect(env.PATH).toBe(process.env.PATH);
  });
});
