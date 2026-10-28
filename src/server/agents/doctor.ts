// `lina doctor`: environment checks, plus live sandbox probes with { live: true }.
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { DoctorCheck } from '../../shared/types.js';
import type { RunDoctor } from './types.js';
import { ensureHome, paths } from '../paths.js';
import { agentEnv, execText, runProcess, which } from './proc.js';
import { classifyError } from './errors.js';
import { redact } from './redact.js';
import { CLAUDE_ISOLATION_ARGS, CLAUDE_SANDBOX_SETTINGS, createClaudeParser } from './claude.js';
import { freebuffBin, freebuffConfigDir, freebuffLoggedIn, readFreebuffSettings } from './freebuff.js';

export interface SandboxProbe { ok: boolean; checkedAt: number; error?: string; /** ErrorCode of the failure ('sandbox' = bwrap/seccomp itself failed). */ code?: string }
export interface SandboxStatus { claude?: SandboxProbe; codex?: SandboxProbe; /** LINA's own bubblewrap sandbox for test runs. */ tests?: SandboxProbe }

const sandboxFile = () => join(paths.cache, 'sandbox.json');
const PROBE_MARKER = 'lina-sandbox-ok';

/** Last persisted sandbox probe results (from `lina doctor --live`). */
export function getSandboxStatus(): SandboxStatus {
  try { return JSON.parse(readFileSync(sandboxFile(), 'utf8')) as SandboxStatus; } catch { return {}; }
}

function saveSandboxStatus(update: SandboxStatus): void {
  const next = { ...getSandboxStatus(), ...update };
  try {
    mkdirSync(paths.cache, { recursive: true, mode: 0o700 });
    const tmp = `${sandboxFile()}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(tmp, sandboxFile());
  } catch { /* ignore */ }
}

function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

const firstLine = (s: string) => s.trim().split('\n')[0]?.trim() ?? '';
const scrubEmail = (s: string) => s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>');

function nodeCheck(): DoctorCheck {
  const v = process.versions.node;
  const ok = cmpVersion(v, '22.5.0') >= 0;
  return { id: 'node', label: 'Node.js ≥ 22.5', ok, detail: `v${v}`, ...(ok ? {} : { hint: 'LINA needs Node 22.5+ (node:sqlite). Install a newer Node.' }) };
}

async function gitChecks(): Promise<DoctorCheck[]> {
  const v = await execText('git', ['--version'], { timeoutMs: 10_000 });
  if (v.code !== 0) return [{ id: 'git', label: 'git installed', ok: false, detail: v.error ?? 'git not found', hint: 'Install git.' }];
  const out: DoctorCheck[] = [{ id: 'git', label: 'git installed', ok: true, detail: firstLine(v.stdout) }];
  const [name, email] = await Promise.all([
    execText('git', ['config', '--get', 'user.name'], { timeoutMs: 10_000, cwd: homedir() }),
    execText('git', ['config', '--get', 'user.email'], { timeoutMs: 10_000, cwd: homedir() }),
  ]);
  const configured = name.code === 0 && !!name.stdout.trim() && email.code === 0 && !!email.stdout.trim();
  out.push(configured
    ? { id: 'git-identity', label: 'git identity', ok: true, detail: 'user.name and user.email are set' }
    : { id: 'git-identity', label: 'git identity', ok: true, warn: true, detail: 'user.name / user.email not configured', hint: 'LINA will commit checkpoints as "LINA <lina@localhost>" in its workspaces. Set them with `git config --global user.name …` / `user.email …` to use your identity.' });
  return out;
}

async function codexChecks(): Promise<DoctorCheck[]> {
  const bin = process.env.LINA_CODEX_BIN || 'codex';
  const path = await which(bin);
  if (!path) return [{ id: 'codex', label: 'Codex CLI installed', ok: false, detail: 'codex not found on PATH', hint: 'Install with `npm install -g @openai/codex`.' }];
  const v = await execText(bin, ['--version'], { timeoutMs: 15_000 });
  const out: DoctorCheck[] = [{ id: 'codex', label: 'Codex CLI installed', ok: v.code === 0, detail: `${firstLine(v.stdout) || 'unknown version'} (${path})` }];
  const s = await execText(bin, ['login', 'status'], { timeoutMs: 20_000, cwd: tmpdir() });
  const text = scrubEmail(redact(`${s.stdout}\n${s.stderr}`)).trim();
  const loggedIn = s.code === 0 && /logged in/i.test(text) && !/not logged in/i.test(text);
  const line = text.split('\n').find((l) => /logged in/i.test(l)) ?? firstLine(text);
  out.push(loggedIn
    ? { id: 'codex-auth', label: 'Codex logged in', ok: true, detail: line }
    : { id: 'codex-auth', label: 'Codex logged in', ok: false, detail: line || 'not logged in', hint: 'Run `codex login`.' });
  return out;
}

async function claudeChecks(): Promise<DoctorCheck[]> {
  const bin = process.env.LINA_CLAUDE_BIN || 'claude';
  const path = await which(bin);
  if (!path) return [{ id: 'claude', label: 'Claude Code CLI installed', ok: false, detail: 'claude not found on PATH', hint: 'Install Claude Code (`npm install -g @anthropic-ai/claude-code` or the native installer).' }];
  const v = await execText(bin, ['--version'], { timeoutMs: 15_000 });
  const out: DoctorCheck[] = [{ id: 'claude', label: 'Claude Code CLI installed', ok: v.code === 0, detail: `${firstLine(v.stdout) || 'unknown version'} (${path})` }];
  const s = await execText(bin, ['auth', 'status', '--json'], { timeoutMs: 20_000, cwd: tmpdir(), env: agentEnv() });
  let info: any;
  try { info = JSON.parse(s.stdout); } catch { info = undefined; }
  if (info && typeof info === 'object') {
    // Only these three fields are reported: never echo email / org ids.
    const parts = [`loggedIn=${info.loggedIn === true}`];
    if (typeof info.authMethod === 'string') parts.push(`authMethod=${info.authMethod}`);
    if (typeof info.subscriptionType === 'string') parts.push(`subscription=${info.subscriptionType}`);
    out.push(info.loggedIn === true
      ? { id: 'claude-auth', label: 'Claude Code logged in', ok: true, detail: parts.join(', ') }
      : { id: 'claude-auth', label: 'Claude Code logged in', ok: false, detail: parts.join(', '), hint: 'Run `claude auth login`.' });
  } else {
    out.push({ id: 'claude-auth', label: 'Claude Code logged in', ok: false, detail: scrubEmail(redact(firstLine(s.stderr || s.stdout))) || 'could not read `claude auth status`', hint: 'Run `claude auth login`.' });
  }
  return out;
}

/** Freebuff is a TUI with no headless mode; the check is install + login + which chat mode it runs in. */
async function freebuffChecks(): Promise<DoctorCheck[]> {
  const bin = freebuffBin();
  const path = await which(bin);
  if (!path) return [{ id: 'freebuff', label: 'Freebuff CLI installed', ok: false, detail: 'freebuff not found on PATH', hint: 'Install with `npm install -g freebuff`.' }];
  const v = await execText(bin, ['--version'], { timeoutMs: 15_000 });
  const out: DoctorCheck[] = [{ id: 'freebuff', label: 'Freebuff CLI installed', ok: v.code === 0, detail: `${firstLine(v.stdout) || 'unknown version'} (${path})` }];
  const loggedIn = freebuffLoggedIn();
  out.push(loggedIn
    ? { id: 'freebuff-auth', label: 'Freebuff logged in', ok: true, detail: freebuffConfigDir() }
    : { id: 'freebuff-auth', label: 'Freebuff logged in', ok: false, detail: 'no credentials.json', hint: 'Run `freebuff login` in a terminal on this machine.' });
  const s = readFreebuffSettings();
  out.push({
    id: 'freebuff-headless', label: 'Freebuff runs through a terminal', ok: true, warn: true,
    detail: `interactive TUI (${s.mode ?? 'unknown'} mode${s.model ? `, ${s.model}` : ''}); no headless/JSON mode`,
    hint: 'LINA drives the TUI in a pseudo-terminal and reads freebuff\'s own chat log. Token usage is unavailable, model choice is the CLI\'s (/model), and reviewer turns cannot be sandboxed read-only.',
  });
  return out;
}

function dataDirCheck(): DoctorCheck {
  try {
    ensureHome();
    const probe = join(paths.home, `.write-probe-${process.pid}`);
    writeFileSync(probe, 'ok', { mode: 0o600 });
    unlinkSync(probe);
    return { id: 'data-dir', label: 'Data directory writable', ok: true, detail: paths.home };
  } catch (e: any) {
    return { id: 'data-dir', label: 'Data directory writable', ok: false, detail: `${paths.home}: ${e?.code ?? e?.message ?? e}`, hint: 'Fix permissions or set LINA_HOME to a writable directory.' };
  }
}

async function pathCheck(): Promise<DoctorCheck> {
  const localBin = join(homedir(), '.local', 'bin');
  const onPath = (process.env.PATH || '').split(delimiter).some((d) => d.replace(/\/+$/, '') === localBin);
  const lina = await which('lina');
  if (onPath && lina) return { id: 'path', label: '`lina` on PATH', ok: true, detail: lina };
  return {
    id: 'path', label: '`lina` on PATH', ok: true, warn: true,
    detail: !onPath ? `${localBin} is not on PATH` : '`lina` not found on PATH',
    hint: !onPath ? `Add \`export PATH="$HOME/.local/bin:$PATH"\` to your shell profile.` : 'Link it: `ln -sf ~/lina/bin/lina ~/.local/bin/lina`.',
  };
}

/** Runs a tiny Claude haiku turn with the OS sandbox on; success iff the sandboxed Bash call succeeds. */
export async function probeClaudeSandbox(): Promise<SandboxProbe> {
  const bin = process.env.LINA_CLAUDE_BIN || 'claude';
  const dir = mkdtempSync(join(tmpdir(), 'lina-sbx-claude-'));
  const parser = createClaudeParser(dir);
  const bashResults: { state: string; output?: string }[] = [];
  try {
    const r = await runProcess({
      cmd: bin,
      args: ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'haiku', '--permission-prompts', 'none', '--no-session-persistence',
        ...CLAUDE_ISOLATION_ARGS, '--settings', JSON.stringify(CLAUDE_SANDBOX_SETTINGS), '--tools', 'Bash', '--allowedTools', 'Bash'],
      cwd: dir, env: agentEnv(),
      stdin: `Use the Bash tool to run exactly this command once: echo ${PROBE_MARKER}\nThen reply with the single word DONE.`,
      turnTimeoutMs: 120_000, idleTimeoutMs: 90_000,
      onLine: (l) => {
        for (const e of parser.push(l)) if (e.t === 'tool' && e.state !== 'running') bashResults.push({ state: e.state, output: e.output });
      },
    });
    const p = parser.result();
    const checkedAt = Date.now();
    if (r.spawnError || r.timedOut) return { ok: false, checkedAt, error: classifyError('claude', '', { spawnError: r.spawnError, timedOut: r.timedOut }).message };
    if (bashResults.some((b) => b.state === 'ok' && b.output?.includes(PROBE_MARKER))) return { ok: true, checkedAt };
    const failed = bashResults.find((b) => b.state === 'error');
    if (failed) {
      const e = classifyError('claude', failed.output ?? 'sandboxed command failed');
      return { ok: false, checkedAt, code: e.code, error: e.code === 'sandbox' ? e.message : `sandboxed command failed: ${failed.output?.slice(0, 500) ?? ''}` };
    }
    if (p.error) return { ok: false, checkedAt, code: p.error.code, error: `probe turn failed (${p.error.code}): ${p.error.message}` };
    return { ok: false, checkedAt, code: 'internal', error: 'inconclusive: the probe turn did not run the command' };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** Runs a command under Codex's Linux sandbox (`codex sandbox -c sandbox_mode=… -- cmd`), no model call. */
export async function probeCodexSandbox(): Promise<SandboxProbe> {
  const bin = process.env.LINA_CODEX_BIN || 'codex';
  const dir = mkdtempSync(join(tmpdir(), 'lina-sbx-codex-'));
  try {
    const script = `echo ${PROBE_MARKER} > probe.txt && cat probe.txt`;
    // No -C: in 0.163 `codex sandbox -C` demands --permission-profile. The process cwd is the workspace root.
    const r = await execText(bin, ['sandbox', '-c', 'sandbox_mode="workspace-write"', '--', '/bin/sh', '-c', script], { cwd: dir, timeoutMs: 60_000 });
    const checkedAt = Date.now();
    if (r.code === 0 && r.stdout.includes(PROBE_MARKER)) return { ok: true, checkedAt };
    if (r.error || r.timedOut) return { ok: false, checkedAt, error: classifyError('codex', r.error ?? '', { spawnError: r.error, timedOut: r.timedOut ? 'turn' : null }).message };
    const raw = redact(`${r.stdout}\n${r.stderr}`).trim();
    const e = classifyError('codex', raw.split('\n').filter(Boolean).slice(-3).join(' | ') || `exit code ${r.code}`, { exitCode: r.code });
    return { ok: false, checkedAt, code: e.code, error: e.code === 'sandbox' ? e.message : `sandbox probe failed (exit ${r.code}): ${raw.slice(-500)}` };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

const SANDBOX_RECHECK_MS = 24 * 60 * 60_000;
let testSandboxCheck: Promise<boolean> | undefined;

/** Whether LINA's bubblewrap test sandbox works here (cached for a day; the probe makes no model call). */
export function testSandboxUsable(): Promise<boolean> {
  const cached = getSandboxStatus().tests;
  if (cached && Date.now() - cached.checkedAt < SANDBOX_RECHECK_MS) return Promise.resolve(cached.ok);
  testSandboxCheck ??= probeTests()
    .then((p) => p.ok)
    .finally(() => { testSandboxCheck = undefined; });
  return testSandboxCheck;
}

async function probeTests(): Promise<SandboxProbe> {
  const { probeTestSandbox } = await import('../tests-runner.js');
  const r = await probeTestSandbox().catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  const p: SandboxProbe = r.ok ? { ok: true, checkedAt: Date.now() } : { ok: false, checkedAt: Date.now(), code: 'sandbox', error: r.error };
  saveSandboxStatus({ tests: p });
  return p;
}

const SANDBOX_HINT = 'bubblewrap could not create the sandbox. If LINA itself runs inside a sandbox/container, nested user namespaces are usually blocked ("apply-seccomp … nested userns"). Automount points under /mnt (e.g. an idle autofs NAS mount) can also break bwrap\'s bind mounts. Without a working sandbox LINA runs Claude without the OS sandbox and Codex commands will fail.';

function probeHint(p: SandboxProbe): string {
  if (p.code === 'sandbox') return SANDBOX_HINT;
  if (p.code === 'auth') return 'The probe could not run because the CLI is not logged in; fix the login check above and retry.';
  return 'The probe itself could not run (not necessarily a sandbox problem). Retry `lina doctor --live`; if it persists, check the CLI version.';
}

export const runDoctor: RunDoctor = async (opts) => {
  const checks: DoctorCheck[] = [nodeCheck()];
  const [git, codex, claude, freebuff, path] = await Promise.all([gitChecks(), codexChecks(), claudeChecks(), freebuffChecks(), pathCheck()]);
  checks.push(...git, ...codex, ...claude, ...freebuff, dataDirCheck(), path);
  const tests = await probeTests();
  checks.push({
    id: 'test-sandbox', label: 'Test sandbox (bubblewrap) works', ok: tests.ok, ...(tests.ok ? {} : { warn: true }),
    detail: tests.ok ? 'LINA runs project tests read-only outside the workspace, without network' : tests.error ?? 'failed',
    ...(tests.ok ? {} : { hint: 'Install bubblewrap (sudo apt install bubblewrap). Until it works, LINA runs tests unsandboxed and labels them so (setting testSandbox: auto).' }),
  });
  if (opts?.live) {
    const codexInstalled = codex.some((c) => c.id === 'codex' && c.ok);
    const claudeInstalled = claude.some((c) => c.id === 'claude' && c.ok);
    const [cx, cl] = await Promise.all([
      codexInstalled ? probeCodexSandbox() : Promise.resolve<SandboxProbe | null>(null),
      claudeInstalled ? probeClaudeSandbox() : Promise.resolve<SandboxProbe | null>(null),
    ]);
    const update: SandboxStatus = {};
    if (cx) {
      update.codex = cx;
      checks.push({ id: 'codex-sandbox', label: 'Codex sandbox (bwrap) works', ok: cx.ok, detail: cx.ok ? 'sandboxed command ran' : cx.error ?? 'failed', ...(cx.ok ? {} : { hint: probeHint(cx) }) });
    }
    if (cl) {
      update.claude = cl;
      checks.push({
        id: 'claude-sandbox', label: 'Claude Code OS sandbox works', ok: cl.ok, ...(cl.ok ? {} : { warn: true }),
        detail: cl.ok ? 'sandboxed Bash ran' : cl.error ?? 'failed',
        ...(cl.ok ? {} : { hint: probeHint(cl) }),
      });
    }
    saveSandboxStatus(update);
  }
  return checks;
};
