// Model discovery (what each CLI offers) and validation (does it really work for this account).
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentId, AgentModels, Effort, ModelInfo, ModelValidation } from '../../shared/types.js';
import type { DiscoverModels, ValidateModel } from './types.js';
import { paths } from '../paths.js';
import { agentEnv, execText, runProcess, which } from './proc.js';
import { classifyError } from './errors.js';
import { createCodexParser, codexIsolationArgs } from './codex.js';
import { CLAUDE_ISOLATION_ARGS } from './claude.js';
import { discoverFreebuffModels, validateFreebuffModel } from './freebuff.js';

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const DISCOVERY_TTL_MS = 10 * 60_000;
const VALIDATION_TIMEOUT_MS = 90_000;
const VALIDATION_PROMPT = 'Reply with exactly: OK';

/** Aliases confirmed to work beyond the ones `claude --help` names (haiku: real run resolved to claude-haiku-5-5). */
const EXTRA_CLAUDE_ALIASES = ['haiku'];

// ───────────────────────── small JSON stores in paths.cache ─────────────────────────

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(readFileSync(file, 'utf8')) as T; } catch { return fallback; }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(paths.cache, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

const observedFile = () => join(paths.cache, 'observed-models.json');
const validationsFile = () => join(paths.cache, 'model-validations.json');

type ObservedStore = Partial<Record<AgentId, Record<string, { resolved: string; seenAt: number }>>>;
let observedMem: ObservedStore | null = null;

/** Records that `alias` resolved to concrete model `resolved` in a real run. */
export function recordObservedModel(agent: AgentId, alias: string, resolved: string): void {
  if (!alias || !resolved) return;
  if (!observedMem) observedMem = readJson<ObservedStore>(observedFile(), {});
  const byAgent = (observedMem[agent] ??= {});
  const prev = byAgent[alias];
  // Avoid rewriting the file every turn: only on change or once a day.
  if (prev && prev.resolved === resolved && Date.now() - prev.seenAt < 24 * 3600_000) return;
  byAgent[alias] = { resolved, seenAt: Date.now() };
  try { writeJson(observedFile(), observedMem); } catch { /* cache dir not writable: keep in memory */ }
}

export function getObservedModels(agent: AgentId): Record<string, { resolved: string; seenAt: number }> {
  if (!observedMem) observedMem = readJson<ObservedStore>(observedFile(), {});
  return { ...(observedMem[agent] ?? {}) };
}

function validationKey(agent: AgentId, model: string) { return `${agent}:${model}`; }

export function getValidations(): Record<string, ModelValidation> {
  return readJson<Record<string, ModelValidation>>(validationsFile(), {});
}

function saveValidation(agent: AgentId, model: string, v: ModelValidation): void {
  const all = getValidations();
  all[validationKey(agent, model)] = v;
  try { writeJson(validationsFile(), all); } catch { /* ignore */ }
}

// ───────────────────────────────── discovery ─────────────────────────────────

const discoveryCache = new Map<AgentId, { at: number; value: AgentModels }>();

export const discoverModels: DiscoverModels = async (agent, opts) => {
  const cached = discoveryCache.get(agent);
  let value: AgentModels;
  if (!opts?.refresh && cached && Date.now() - cached.at < DISCOVERY_TTL_MS) value = cached.value;
  else {
    value = agent === 'codex' ? await discoverCodex() : agent === 'freebuff' ? await discoverFreebuffModels() : await discoverClaude();
    discoveryCache.set(agent, { at: Date.now(), value });
  }
  return attachValidations(value);
};

function attachValidations(m: AgentModels): AgentModels {
  const all = getValidations();
  const models = m.models.map((mi) => {
    const v = all[validationKey(m.agent, mi.id)];
    return v ? { ...mi, validation: v } : { ...mi };
  });
  // Models validated by the user that are not in any list show up as custom.
  for (const [key, v] of Object.entries(all)) {
    const [agent, ...rest] = key.split(':');
    const id = rest.join(':');
    if (agent !== m.agent || models.some((x) => x.id === id)) continue;
    models.push({ id, label: id, source: 'custom', validation: v });
  }
  return { ...m, models };
}

function versionOf(s: string): string | undefined {
  return /(\d+\.\d+\.\d+(?:[-+.][\w.]+)?)/.exec(s)?.[1];
}

/** Parses `codex debug models` JSON into list-visible models sorted by priority. */
export function parseCodexCatalog(json: string): ModelInfo[] {
  const data = JSON.parse(json);
  const list: any[] = Array.isArray(data?.models) ? data.models : Array.isArray(data) ? data : [];
  return list
    .filter((m) => m && typeof m.slug === 'string' && m.visibility === 'list')
    .sort((a, b) => (a.priority ?? 1e9) - (b.priority ?? 1e9))
    .map((m): ModelInfo => {
      const efforts = (Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : [])
        .map((l: any) => (typeof l === 'string' ? l : l?.effort))
        .filter((e: any): e is Effort => EFFORTS.includes(e));
      const def = EFFORTS.includes(m.default_reasoning_level) ? (m.default_reasoning_level as Effort) : undefined;
      return {
        id: m.slug,
        label: m.display_name || m.slug,
        ...(m.description ? { description: m.description } : {}),
        ...(efforts.length ? { efforts } : {}),
        ...(def ? { defaultEffort: def } : {}),
        source: 'catalog',
      };
    });
}

/** Reads only the top-level `model = "…"` key from Codex's config.toml. Never touches auth.json. */
export function readCodexConfigModel(file = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml')): string | undefined {
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return undefined; }
  for (const line of text.split('\n')) {
    if (/^\s*\[/.test(line)) break; // top-level keys only
    const m = /^\s*model\s*=\s*"([^"]+)"\s*(?:#.*)?$/.exec(line) ?? /^\s*model\s*=\s*'([^']+)'\s*(?:#.*)?$/.exec(line);
    if (m) return m[1];
  }
  return undefined;
}

async function discoverCodex(): Promise<AgentModels> {
  const bin = process.env.LINA_CODEX_BIN || 'codex';
  const base: AgentModels = { agent: 'codex', installed: false, models: [], defaultModel: readCodexConfigModel() ?? 'gpt-6.1-sol', discoveredVia: 'codex debug models' };
  if (!(await which(bin))) return { ...base, error: 'codex CLI not found on PATH' };
  const [ver, cat] = await Promise.all([
    execText(bin, ['--version'], { timeoutMs: 15_000 }),
    execText(bin, ['debug', 'models'], { timeoutMs: 30_000, cwd: tmpdir() }),
  ]);
  const out: AgentModels = { ...base, installed: true, version: versionOf(ver.stdout) };
  if (cat.code !== 0) return { ...out, error: `codex debug models failed: ${(cat.stderr || cat.error || '').trim().split('\n').pop() ?? ''}` };
  try {
    out.models = parseCodexCatalog(cat.stdout);
  } catch (e: any) {
    return { ...out, error: `could not parse codex debug models output: ${e?.message ?? e}` };
  }
  if (!readCodexConfigModel() && out.models[0]) out.defaultModel = out.models[0].id;
  return out;
}

/** Extracts the aliases named in the `--model` paragraph of `claude --help`. */
export function parseClaudeHelpAliases(help: string): string[] {
  const lines = help.split('\n');
  const start = lines.findIndex((l) => /^\s*--model\b/.test(l));
  if (start < 0) return [];
  const para: string[] = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*-{1,2}[A-Za-z]/.test(lines[i])) break;
    para.push(lines[i]);
  }
  const text = para.join(' ');
  const out: string[] = [];
  for (const m of text.matchAll(/'([a-z][a-z0-9.\-]*)'/g)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

function readClaudeSettingsModel(): string | undefined {
  try {
    const s = JSON.parse(readFileSync(join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json'), 'utf8'));
    return typeof s?.model === 'string' && /^[A-Za-z0-9.\-_[\]]+$/.test(s.model) ? s.model : undefined;
  } catch { return undefined; }
}

const CLAUDE_EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

async function discoverClaude(): Promise<AgentModels> {
  const bin = process.env.LINA_CLAUDE_BIN || 'claude';
  const base: AgentModels = { agent: 'claude', installed: false, models: [], defaultModel: 'opus', discoveredVia: 'claude --help (aliases) + observed runs' };
  if (!(await which(bin))) return { ...base, error: 'claude CLI not found on PATH' };
  const [ver, help] = await Promise.all([
    execText(bin, ['--version'], { timeoutMs: 15_000 }),
    execText(bin, ['--help'], { timeoutMs: 15_000 }),
  ]);
  const out: AgentModels = { ...base, installed: true, version: versionOf(ver.stdout) };
  const aliases = parseClaudeHelpAliases(help.stdout);
  for (const a of EXTRA_CLAUDE_ALIASES) if (!aliases.includes(a)) aliases.push(a);
  const observed = getObservedModels('claude');
  for (const a of aliases) {
    const resolved = observed[a]?.resolved;
    out.models.push({
      id: a,
      label: a.charAt(0).toUpperCase() + a.slice(1),
      description: resolved ? `Alias for the latest ${a} model (last resolved to ${resolved})` : `Alias for the latest ${a} model`,
      efforts: CLAUDE_EFFORTS,
      source: 'alias',
    });
  }
  const seen = new Set(out.models.map((m) => m.id));
  for (const [alias, o] of Object.entries(observed)) {
    if (seen.has(o.resolved)) continue;
    seen.add(o.resolved);
    out.models.push({ id: o.resolved, label: o.resolved, description: `Seen in a real run (via "${alias}")`, efforts: CLAUDE_EFFORTS, source: 'observed' });
  }
  const pref = readClaudeSettingsModel();
  out.defaultModel = pref && (seen.has(pref) || /^claude-/.test(pref)) ? pref : seen.has('opus') ? 'opus' : out.models[0]?.id ?? 'opus';
  if (!help.stdout) out.error = 'could not read claude --help';
  return out;
}

// ───────────────────────────────── validation ─────────────────────────────────

export const validateModel: ValidateModel = async (agent, model) => {
  const dir = mkdtempSync(join(tmpdir(), 'lina-validate-'));
  let v: ModelValidation;
  try {
    v = agent === 'claude' ? await validateClaude(model, dir)
      : agent === 'freebuff' ? await validateFreebuffModel(model)
      : await validateCodex(model, dir);
  } catch (e: any) {
    v = { ok: false, checkedAt: Date.now(), error: String(e?.message ?? e), code: 'internal' };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  saveValidation(agent, model, v);
  if (v.ok && v.resolvedModel && v.resolvedModel !== model) {
    try { recordObservedModel(agent, model, v.resolvedModel); } catch { /* ignore */ }
  }
  discoveryCache.delete(agent);
  return v;
};

async function validateClaude(model: string, cwd: string): Promise<ModelValidation> {
  const bin = process.env.LINA_CLAUDE_BIN || 'claude';
  const lines: string[] = [];
  const r = await runProcess({
    cmd: bin,
    args: ['-p', '--output-format', 'json', '--model', model, '--tools', '', '--permission-prompts', 'none', '--no-session-persistence', ...CLAUDE_ISOLATION_ARGS],
    cwd, env: agentEnv(), stdin: VALIDATION_PROMPT, turnTimeoutMs: VALIDATION_TIMEOUT_MS,
    onLine: (l) => lines.push(l),
  });
  const checkedAt = Date.now();
  if (r.spawnError || r.timedOut) {
    const e = classifyError('claude', r.spawnError ?? '', { spawnError: r.spawnError, timedOut: r.timedOut });
    return { ok: false, checkedAt, error: e.message, code: e.code };
  }
  let result: any;
  for (const l of lines) {
    const s = l.trim();
    if (!s.startsWith('{') && !s.startsWith('[')) continue;
    try {
      const d = JSON.parse(s);
      const cand = Array.isArray(d) ? d.find((x) => x?.type === 'result') : d;
      if (cand?.type === 'result') result = cand;
    } catch { /* not JSON */ }
  }
  const nonJson = lines.filter((l) => l.trim() && !l.trim().startsWith('{')).join('\n');
  if (!result) {
    const e = classifyError('claude', nonJson || r.stderrTail || 'no result from claude', { exitCode: r.exitCode, stderr: r.stderrTail });
    return { ok: false, checkedAt, error: e.message, code: e.code };
  }
  const resolved = result.modelUsage && typeof result.modelUsage === 'object' ? Object.keys(result.modelUsage)[0] : undefined;
  if (result.is_error === true || (typeof result.subtype === 'string' && result.subtype.startsWith('error'))) {
    const e = classifyError('claude', String(result.result ?? nonJson ?? 'error'), { apiStatus: result.api_error_status ?? undefined, stderr: nonJson });
    return { ok: false, checkedAt, error: e.message, code: e.code, ...(resolved ? { resolvedModel: resolved } : {}) };
  }
  return { ok: true, checkedAt, ...(resolved ? { resolvedModel: resolved } : {}) };
}

async function validateCodex(model: string, cwd: string): Promise<ModelValidation> {
  const bin = process.env.LINA_CODEX_BIN || 'codex';
  const parser = createCodexParser(cwd, model);
  const isolation = await codexIsolationArgs(bin);
  const r = await runProcess({
    cmd: bin,
    args: ['exec', '--json', '--ephemeral', '-s', 'read-only', '--skip-git-repo-check', '-m', model, '-C', cwd, '-c', 'approval_policy="never"', ...isolation, '-'],
    cwd, env: agentEnv(), stdin: VALIDATION_PROMPT, turnTimeoutMs: VALIDATION_TIMEOUT_MS,
    onLine: (l) => { parser.push(l); },
  });
  const checkedAt = Date.now();
  const p = parser.result();
  if (r.spawnError || r.timedOut) {
    const e = classifyError('codex', r.spawnError ?? '', { spawnError: r.spawnError, timedOut: r.timedOut });
    return { ok: false, checkedAt, error: e.message, code: e.code };
  }
  if (p.turnCompleted && !p.turnFailed) return { ok: true, checkedAt, resolvedModel: model };
  const e = p.error ?? classifyError('codex', p.lastErrorMessage || r.stderrTail.trim().split('\n').pop() || 'codex did not complete the turn', { exitCode: r.exitCode, stderr: r.stderrTail });
  return { ok: false, checkedAt, error: e.message, code: e.code };
}
