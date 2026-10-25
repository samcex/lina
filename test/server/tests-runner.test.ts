import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectTestCommand, parseCounts, runTests } from '../../src/server/tests-runner.js';

const dir = (files: Record<string, string>) => {
  const d = mkdtempSync(join(tmpdir(), 'lina-tr-'));
  for (const [p, c] of Object.entries(files)) { mkdirSync(join(d, p, '..'), { recursive: true }); writeFileSync(join(d, p), c); }
  return d;
};

describe('detectTestCommand', () => {
  it('honours config, including empty = disabled', async () => {
    expect(await detectTestCommand(dir({}), 'make check')).toMatchObject({ command: 'make check', source: 'config' });
    const off = await detectTestCommand(dir({ 'go.mod': '' }), '');
    expect(off.command).toBeUndefined();
    expect(off.source).toBe('none');
  });
  it('package.json: ignores npm default, skips when deps are not installed', async () => {
    expect((await detectTestCommand(dir({ 'package.json': '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}' }))).command).toBeUndefined();
    expect((await detectTestCommand(dir({ 'package.json': '{"scripts":{"test":"vitest run"}}' }))).command).toBe('npm test --silent');
    const skipped = await detectTestCommand(dir({ 'package.json': '{"scripts":{"test":"vitest run"},"devDependencies":{"vitest":"1"}}' }));
    expect(skipped.command).toBeUndefined();
    expect(skipped.reason).toMatch(/node_modules/);
  });
  it('go, cargo, Makefile', async () => {
    expect((await detectTestCommand(dir({ 'go.mod': 'module x' }))).command).toBe('go test ./...');
    expect((await detectTestCommand(dir({ 'Cargo.toml': '' }))).command).toBe('cargo test');
    expect((await detectTestCommand(dir({ Makefile: 'build:\n\ttrue\ntest:\n\ttrue\n' }))).command).toBe('make test');
    expect((await detectTestCommand(dir({ Makefile: 'build:\n\ttrue\n' }))).command).toBeUndefined();
  });
});

describe('parseCounts', () => {
  it('vitest', () => expect(parseCounts(' Test Files  1 passed (1)\n      Tests  1 failed | 4 passed (5)\n')).toEqual({ passed: 4, failed: 1 }));
  it('jest', () => expect(parseCounts('Tests:       2 failed, 7 passed, 9 total\n')).toEqual({ passed: 7, failed: 2 }));
  it('pytest', () => expect(parseCounts('==== 3 passed, 1 failed in 0.12s ====')).toEqual({ passed: 3, failed: 1 }));
  it('node:test tap/spec', () => {
    expect(parseCounts('# tests 2\n# pass 2\n# fail 0\n')).toEqual({ passed: 2, failed: 0 });
    expect(parseCounts('ℹ tests 3\nℹ pass 1\nℹ fail 2\n')).toEqual({ passed: 1, failed: 2 });
  });
  it('go', () => expect(parseCounts('--- PASS: TestA (0.00s)\n--- FAIL: TestB (0.00s)\n    --- PASS: TestB/sub\n')).toEqual({ passed: 2, failed: 1 }));
  it('cargo', () => expect(parseCounts('test result: ok. 3 passed; 0 failed;\ntest result: FAILED. 1 passed; 2 failed;')).toEqual({ passed: 4, failed: 2 }));
  it('unknown', () => expect(parseCounts('all good')).toEqual({}));
});

describe('runTests', () => {
  it('runs in the workspace, captures output, redacts secrets', async () => {
    const d = dir({});
    const ok = await runTests(d, 'echo "3 passed"; echo "token=supersecretvalue123" 1>&2');
    expect(ok).toMatchObject({ ok: true, exitCode: 0, passed: 3, failed: 0, sandboxed: false });
    expect(ok.output).not.toContain('supersecretvalue123');
    const bad = await runTests(d, 'echo "1 failed"; exit 3');
    expect(bad).toMatchObject({ ok: false, exitCode: 3, failed: 1 });
  });
  it('honours abort and timeout', async () => {
    const d = dir({});
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const t0 = Date.now();
    const r = await runTests(d, 'sleep 30', { signal: ac.signal });
    expect(r.aborted).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5000);
    const t = await runTests(d, 'sleep 30', { timeoutMs: 200 });
    expect(t.ok).toBe(false);
    expect(t.output).toMatch(/timed out/);
  });
});
