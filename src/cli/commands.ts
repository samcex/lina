// Non-interactive commands: sessions, projects, add, ui, models, doctor, daemon.
import { existsSync, statSync, openSync, readSync, closeSync, watch } from 'node:fs';
import { resolve } from 'node:path';
import { paths } from '../server/paths.js';
import { LinaApiError } from '../shared/client.js';
import type { DaemonInfo } from '../shared/protocol.js';
import type { AgentId, Effort, Project, Session, Settings } from '../shared/types.js';
import { MODE_LABEL, PHASE_LABEL } from '../shared/reducer.js';
import { LINA_VERSION } from '../shared/types.js';
import { bold, dim, fg, padAnsi, strWidth, truncateAnsi } from './ansi.js';
import type { ParsedArgs } from './args.js';
import { AGENTS, parseSettingValue } from './args.js';
import { formatTeamSpec, teamSummary } from './team.js';
import { baseUrl, clientFor, discoverDaemon, ensureDaemon, startDaemon, stopDaemon, tailFile, DaemonError } from './daemon-control.js';
import { formatAgo, modelLabel, shortId } from './layout.js';
import { C } from './theme.js';
import { doctorLines } from './tui/overlays.js';
import { expandHome, findProjectForPath, openBrowser, realpathOr, webUrl } from './util.js';
import { terminalQr } from './qr.js';

export class CliError extends Error {
  constructor(message: string, public hint?: string, public exitCode = 1) { super(message); }
}

const out = (s = '') => process.stdout.write(s + '\n');
const cols = () => process.stdout.columns || 100;

export async function connect(quiet = false): Promise<DaemonInfo> {
  try {
    return await ensureDaemon({ onStatus: (m) => { if (!quiet) process.stderr.write(dim(m) + '\n'); } });
  } catch (e) {
    if (e instanceof DaemonError) throw new CliError(e.message, e.hint);
    throw e;
  }
}

/** Resolves --project or the project containing cwd. */
export function resolveProject(projects: Project[], opt: string | undefined, cwd: string): Project | undefined {
  if (opt) {
    const p = realpathOr(resolve(cwd, expandHome(opt)));
    const exact = projects.find((x) => realpathOr(x.path) === p) ?? findProjectForPath(projects, p);
    if (!exact) {
      const byName = projects.find((x) => x.name === opt);
      if (byName) return byName;
      throw new CliError(`${p} is not a registered LINA project.`, `Register it with \`lina add ${opt}\` (see \`lina projects\`).`);
    }
    return exact;
  }
  return findProjectForPath(projects, cwd);
}

/** Matches a full id, an id prefix, or (exact) title. */
export function matchSession(sessions: Session[], q: string): Session {
  const exact = sessions.find((s) => s.id === q);
  if (exact) return exact;
  const pre = sessions.filter((s) => s.id.startsWith(q));
  if (pre.length === 1) return pre[0];
  if (pre.length > 1) throw new CliError(`Session id "${q}" is ambiguous (${pre.length} matches).`, 'Use more characters of the id — see `lina sessions --all`.');
  const byTitle = sessions.filter((s) => s.title === q);
  if (byTitle.length === 1) return byTitle[0];
  throw new CliError(`No session matches "${q}".`, 'See `lina sessions --all`.');
}

function table(rows: string[][], widths?: number[]): string[] {
  const n = Math.max(...rows.map((r) => r.length));
  const w = widths ?? Array.from({ length: n }, (_, i) => Math.max(...rows.map((r) => strWidth(r[i] ?? ''))));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : padAnsi(c ?? '', w[i]))).join('  '));
}

const STATUS_COLOR: Record<string, string> = { running: C.ok, paused: C.warn, awaiting_approval: C.lina, completed: C.ok, approved: C.ok, rejected: C.err, failed: C.err, cancelled: C.muted, interrupted: C.warn, idle: C.muted };

// ── sessions / projects / add ──────────────────────────────────────────────
export async function cmdSessions(a: ParsedArgs, cwd: string) {
  const info = await connect();
  const client = clientFor(info);
  const projects = await client.projects();
  const project = a.flags.all ? undefined : resolveProject(projects, a.global.project, cwd);
  const list = (await client.sessions(project ? { projectId: project.id } : {})).sort((x, y) => y.updatedAt - x.updatedAt);
  if (a.flags.json) { out(JSON.stringify(list, null, 2)); return; }
  const scope = project ? `in ${bold(project.name)} ${dim(project.path)}` : dim('across all projects');
  if (!list.length) {
    out(`No sessions ${scope}.`);
    out(dim(project ? 'Start one with `lina "<task>"` — or `lina sessions --all`.' : 'Start one with `lina "<task>"` inside a project.'));
    return;
  }
  out(`${bold(fg(C.lina)('◆'))} ${list.length} session${list.length === 1 ? '' : 's'} ${scope}`);
  out();
  const byId = new Map(projects.map((p) => [p.id, p.name]));
  const rows = list.map((s) => [
    fg(C.muted)(shortId(s.id)),
    fg(STATUS_COLOR[s.status] ?? C.muted)(s.status.replace('_', ' ')),
    dim(PHASE_LABEL[s.phase] ?? s.phase),
    ...(project ? [] : [fg(C.codexSoft)(byId.get(s.projectId) ?? '?')]),
    dim(formatAgo(s.updatedAt)),
    (s.mock ? fg(C.warn)('[mock] ') : '') + (s.config?.mode && s.config.mode !== 'pair' ? dim(`[${s.config.mode}] `) : '') + (s.title || dim('Untitled')),
  ]);
  for (const l of table(rows)) out('  ' + truncateAnsi(l, cols() - 2));
  out();
  out(dim('Re-open one with `lina attach <id>` (a unique prefix is enough).'));
}

export async function cmdProjects(a: ParsedArgs, cwd: string) {
  const client = clientFor(await connect());
  const list = (await client.projects()).sort((x, y) => x.name.localeCompare(y.name));
  if (a.flags.json) { out(JSON.stringify(list, null, 2)); return; }
  if (!list.length) { out('No projects registered yet.'); out(dim('Run `lina` inside a git repository, or `lina add <path>`.')); return; }
  const here = findProjectForPath(list, cwd);
  out(`${bold(fg(C.lina)('◆'))} ${list.length} project${list.length === 1 ? '' : 's'}`);
  out();
  for (const l of table(list.map((p) => [p.id === here?.id ? fg(C.lina)('●') : ' ', bold(p.name), dim(p.path), dim(`${p.settings.defaultMode} · ${p.settings.maxRounds} rounds`)]))) out('  ' + truncateAnsi(l, cols() - 2));
}

export async function cmdAdd(a: ParsedArgs, cwd: string) {
  const path = resolve(cwd, expandHome(a.positionals[0]));
  if (!existsSync(path) && !a.flags.create) throw new CliError(`${path} does not exist.`, 'Add --create to create it (and --init-git to initialize a repository).');
  if (existsSync(path) && !statSync(path).isDirectory()) throw new CliError(`${path} is not a directory.`);
  if (existsSync(path) && !existsSync(resolve(path, '.git')) && !a.flags.initGit) {
    throw new CliError(`${path} is not a git repository.`, 'LINA needs git to isolate and checkpoint work. Add --init-git to run `git init` there.');
  }
  const client = clientFor(await connect());
  try {
    const p = await client.addProject({ path, ...(a.flags.name ? { name: a.flags.name } : {}), ...(a.flags.create ? { create: true } : {}), ...(a.flags.initGit ? { initGit: true } : {}) });
    out(`${fg(C.ok)('✔')} Registered ${bold(p.name)} ${dim(p.path)}`);
    out(dim(`Start working: cd ${p.path} && lina "<task>"`));
  } catch (e) {
    if (e instanceof LinaApiError && e.code === 'not_git') throw new CliError(`${path} is not a git repository.`, 'Add --init-git to run `git init` there.');
    throw e;
  }
}

// ── ui ──────────────────────────────────────────────────────────────────────
export async function cmdUi(sessionId?: string, flags: { url?: boolean; qr?: boolean } = {}) {
  const info = await connect();
  const url = webUrl(info, sessionId);
  if (flags.url || flags.qr) {
    out(url);
    if (flags.qr) out(terminalQr(url));
    return;
  }
  out(`${bold(fg(C.lina)('◆ LINA'))} web UI: ${fg(C.info)(`http://127.0.0.1:${info.port}/`)}`);
  const ok = await openBrowser(url);
  if (ok) out(dim('Opened in your browser (the access token is passed in the URL fragment).'));
  else { out(dim('Could not launch a browser. Open this URL:')); out(url); }
}

// ── models ──────────────────────────────────────────────────────────────────
export async function cmdModels(a: ParsedArgs) {
  const client = clientFor(await connect());
  const [sub, agentArg, model] = a.positionals;
  if (sub === 'validate') {
    const agent = agentArg as AgentId;
    out(dim(`Probing ${agent} with ${model} (a tiny live request)…`));
    const v = await client.validateModel(agent, model);
    if (v.ok) out(`${fg(C.ok)('✔')} ${bold(model)} works for ${agent}${v.resolvedModel && v.resolvedModel !== model ? dim(` → ${v.resolvedModel}`) : ''}`);
    else throw new CliError(`${model} did not work for ${agent}: ${v.error ?? 'unknown error'}${v.code ? ` (${v.code})` : ''}`, v.code === 'auth' ? `Log in to the ${agent} CLI first.` : `See \`lina models\` for available models.`);
    return;
  }
  if (sub === 'set') {
    const agent = agentArg as AgentId;
    const settings = await client.getSettings();
    const effort: Effort | undefined = a.flags.effort ?? (settings.models[agent]?.model === model ? settings.models[agent]?.effort : undefined);
    const next = await client.putSettings({ models: { ...settings.models, [agent]: { model, ...(effort ? { effort } : {}) } } });
    out(`${fg(C.ok)('✔')} ${agent} default model → ${bold(modelLabel(next.models[agent]))}`);
    out(dim(`Applies to new sessions. Check it works with \`lina models validate ${agent} ${model}\`.`));
    return;
  }
  const [catalog, settings] = await Promise.all([client.models(!!a.flags.refresh), client.getSettings().catch(() => undefined)]);
  if (a.flags.json) { out(JSON.stringify(catalog, null, 2)); return; }
  for (const agent of AGENTS) {
    const c = catalog[agent];
    const color = agent === 'codex' ? C.codex : C.claude;
    const cur = settings?.models[agent];
    out(`${bold(fg(color)(agent === 'codex' ? 'Codex' : 'Claude'))} ${c?.installed ? dim(`installed${c.version ? ' ' + c.version : ''}`) : fg(C.err)('not installed')}  ${dim(`current: `)}${fg(C.text)(modelLabel(cur))}  ${dim(`via ${c?.discoveredVia ?? '?'}`)}`);
    if (c?.error) out('  ' + fg(C.err)(c.error));
    const rows = (c?.models ?? []).map((m) => {
      const mark = m.validation ? (m.validation.ok ? fg(C.ok)('✔') : fg(C.err)('✖')) : dim('·');
      const isCur = cur?.model === m.id;
      return [
        `${isCur ? fg(color)('●') : ' '} ${mark}`,
        bold(m.id) + (m.id === c.defaultModel ? dim(' (default)') : ''),
        dim(m.label && m.label !== m.id ? m.label : ''),
        m.efforts?.length ? m.efforts.map((e) => (isCur && cur?.effort === e ? fg(color)(e) : dim(e))).join(dim('/')) : '',
        dim(m.source),
      ];
    });
    for (const l of table(rows)) out('  ' + truncateAnsi(l, cols() - 2));
    out();
  }
  out(dim('✔ validated · ✖ failed validation · · not checked.  `lina models validate <agent> <model>` · `lina models set <agent> <model> [--effort e]`'));
}

// ── settings ────────────────────────────────────────────────────────────────
const SANDBOX_HINT: Record<Settings['testSandbox'], string> = {
  auto: 'sandboxed when bubblewrap works here, else unsandboxed and labelled',
  on: 'always sandboxed (tests fail to start if the sandbox is unavailable)',
  off: 'never sandboxed',
};

/** Human view of the daemon settings (defaults for new sessions). */
export function settingsLines(s: Settings): string[] {
  const k = (key: string, v: string, note = '') => `  ${padAnsi(fg(C.lina)(key), 16)}${v}${note ? '  ' + dim(note) : ''}`;
  const name = (a: AgentId) => fg(a === 'codex' ? C.codex : C.claude)(a);
  return [
    k('mode', bold(s.defaultMode), MODE_LABEL[s.defaultMode] ?? ''),
    k('developer', name(s.developer), 'implements in pair/architect/solo; leads in parallel'),
    k('max-rounds', String(s.maxRounds)),
    k('team', s.team ? fg(C.text)(formatTeamSpec(s.team)) : dim('(not set)'), s.team ? teamSummary(s.team) : 'custom sessions default to: dev plans, the other agent critiques and reviews'),
    k('rea', s.reaEnabled ? 'on' : 'off', 'configured REA MCP for both agents; reviewers get read-only evidence tools'),
    k('access', bold(s.accessMode), 'developer filesystem, commands and network; applies from the next turn'),
    k('test-sandbox', bold(s.testSandbox ?? 'auto'), s.accessMode === 'full' ? 'inactive with full access' : SANDBOX_HINT[s.testSandbox ?? 'auto']),
    k('claude-sandbox', bold(s.claudeSandbox ?? 'auto'), s.accessMode === 'full' ? 'inactive for full-access developer turns' : 'OS sandbox for Claude\'s Bash tool'),
    k('models', `${name('codex')} ${modelLabel(s.models?.codex)}  ${name('claude')} ${modelLabel(s.models?.claude)}`, '`lina models set` to change'),
    k('timeouts', dim(`turn ${Math.round(s.turnTimeoutMs / 60000)}m · idle ${Math.round(s.idleTimeoutMs / 60000)}m`)),
  ];
}

export async function cmdSettings(a: ParsedArgs) {
  const client = clientFor(await connect());
  if (a.positionals[0] === 'set') {
    const { key, patch } = parseSettingValue(a.positionals[1], a.positionals.slice(2).join(' '));
    const next = await client.putSettings(patch as Partial<Settings>);
    const ignored = Object.entries(patch).filter(([k, v]) => JSON.stringify((next as unknown as Record<string, unknown>)[k]) !== JSON.stringify(v));
    if (ignored.length) {
      throw new CliError(`The daemon did not store ${key}.`, `It may be older than this CLI — run \`lina daemon restart\` when no session is running, then try again.`);
    }
    out(`${fg(C.ok)('✔')} ${key} saved — ${['access', 'rea'].includes(key) ? 'applies from the next agent turn' : 'applies to new sessions'}.`);
    out();
    for (const l of settingsLines(next)) out(l);
    return;
  }
  const s = await client.getSettings();
  if (a.flags.json) { out(JSON.stringify(s, null, 2)); return; }
  out(`${bold(fg(C.lina)('◆ LINA settings'))} ${dim('· defaults for new sessions')}`);
  out();
  for (const l of settingsLines(s)) out(l);
  out();
  out(dim('Change one with `lina settings set <key> <value>`, e.g. `lina settings set team plan=claude,dev=codex,review=claude`.'));
}

export async function cmdPreview(a: ParsedArgs) {
  const client = clientFor(await connect());
  const sid = a.flags.session || process.env.LINA_SESSION_ID;
  if (!sid) throw new CliError('A session is required', 'Pass --session <id>, or run this command from a LINA agent turn.');
  const [action, ...rest] = a.positionals;
  if (action === 'logs') { out((await client.previewLogs(sid, rest[0])).output); return; }
  if (action === 'stop') {
    const p = await client.stopPreview(sid, rest[0]);
    out(a.flags.json ? JSON.stringify(p) : `Stopped preview ${p.id}`); return;
  }
  if (action === 'start') {
    let p = await client.startPreview(sid, { command: rest.join(' '), port: a.flags.port });
    const deadline = Date.now() + 10_000;
    while (p.status === 'starting' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      p = (await client.previews(sid)).find((x) => x.id === p.id)!;
    }
    if (p.status === 'failed' || p.status === 'stopped') throw new CliError(p.error || 'Preview exited before becoming ready', `lina preview logs ${p.id} --session ${sid}`);
    out(a.flags.json ? JSON.stringify(p) : `Preview ${p.id} · ${p.status}\n${p.url}\nSurvives agent turns and daemon restarts. Stop: lina preview stop ${p.id} --session ${sid}`); return;
  }
  const list = await client.previews(sid);
  if (a.flags.json) out(JSON.stringify(list, null, 2));
  else if (!list.length) out('No previews for this session.');
  else for (const p of list) out(`${p.id} · ${p.status} · ${p.url}\n  ${p.command}`);
}

// ── doctor ──────────────────────────────────────────────────────────────────
export async function cmdDoctor(a: ParsedArgs) {
  const info = await connect();
  if (a.flags.live && !a.flags.json) out(dim('Running live probes (real CLI calls with tiny prompts)…'));
  const { checks } = await clientFor(info).doctor(!!a.flags.live);
  const bad = checks.filter((c) => !c.ok).length;
  if (bad) process.exitCode = 1;
  if (a.flags.json) { out(JSON.stringify(checks, null, 2)); return; }
  out(`${bold(fg(C.lina)('◆ LINA doctor'))} ${dim(`v${LINA_VERSION} · daemon pid ${info.pid} · port ${info.port}${a.flags.live ? ' · live' : ''}`)}`);
  out();
  for (const l of doctorLines(checks, cols() - 4)) out('  ' + l);
  const warn = checks.filter((c) => c.ok && c.warn).length;
  out();
  out(bad ? fg(C.err)(`${bad} problem${bad === 1 ? '' : 's'} found.`) + (warn ? dim(` ${warn} warning${warn === 1 ? '' : 's'}.`) : '') : fg(C.ok)('All checks passed.') + (warn ? dim(` ${warn} warning${warn === 1 ? '' : 's'}.`) : ''));
  if (!a.flags.live) out(dim('Run `lina doctor --live` to probe real model access (uses a few tokens).'));
}

// ── daemon ──────────────────────────────────────────────────────────────────
export async function cmdDaemon(a: ParsedArgs) {
  const sub = a.positionals[0];
  switch (sub) {
    case 'run': {
      process.title = 'linad';
      const mod = (await import('../server/daemon.js')) as unknown as { runDaemon: () => Promise<unknown> };
      await mod.runDaemon();
      return;
    }
    case 'start': {
      const d = await discoverDaemon();
      if (d.state === 'running') { out(`${fg(C.ok)('●')} Daemon already running ${dim(`(pid ${d.info.pid}, port ${d.info.port})`)}`); return; }
      const info = await connect(true);
      out(`${fg(C.ok)('●')} Daemon started ${dim(`(pid ${info.pid}, port ${info.port})`)}`);
      return;
    }
    case 'restart': {
      const r = await stopDaemon();
      if (r !== 'not_running') out(dim(`Stopped the old daemon${r === 'killed' ? ' (forced)' : ''}.`));
      try {
        const info = await startDaemon();
        out(`${fg(C.ok)('●')} Daemon started ${dim(`(pid ${info.pid}, port ${info.port})`)}`);
      } catch (e) {
        if (e instanceof DaemonError) throw new CliError(e.message, e.hint);
        throw e;
      }
      return;
    }
    case 'stop': {
      const r = await stopDaemon();
      if (r === 'not_running') out(dim('Daemon is not running.'));
      else out(`${fg(C.ok)('✔')} Daemon stopped${r === 'killed' ? dim(' (did not exit on SIGTERM; killed)') : ''}. ${dim('Running agent turns were stopped; sessions resume with /resume.')}`);
      return;
    }
    case 'status': {
      const d = await discoverDaemon();
      if (d.state === 'absent') { out(`${dim('○')} Daemon not running ${dim(`(no ${paths.daemonInfo})`)}`); process.exitCode = 3; return; }
      if (d.state === 'stale') {
        out(`${fg(C.warn)('◌')} Daemon ${d.reason === 'dead_pid' ? `not running (stale pid ${d.info.pid})` : `pid ${d.info.pid} is alive but not answering on port ${d.info.port}`}`);
        out(dim('`lina daemon start` will restart it.'));
        process.exitCode = 3;
        return;
      }
      const h = await fetch(`${baseUrl(d.info)}/api/health`, { headers: { authorization: `Bearer ${d.info.token}` } }).then((r) => r.json() as Promise<{ uptimeMs?: number; version?: string }>).catch(() => ({} as { uptimeMs?: number; version?: string }));
      out(`${fg(C.ok)('●')} Daemon running ${dim(`pid ${d.info.pid} · port ${d.info.port} · v${h.version ?? d.info.version}${h.uptimeMs !== undefined ? ` · up ${Math.round(h.uptimeMs / 60000)}m` : ''}`)}`);
      if (h.version && h.version !== LINA_VERSION) out(fg(C.warn)(`  Version differs from this CLI (v${LINA_VERSION}). Run \`lina daemon restart\` after idle sessions finish.`));
      out(dim(`  home ${paths.home} · log ${paths.daemonLog}`));
      return;
    }
    case 'logs': {
      const n = a.flags.lines ?? 60;
      if (!existsSync(paths.daemonLog)) { out(dim(`No daemon log yet (${paths.daemonLog}).`)); return; }
      for (const l of tailFile(paths.daemonLog, n)) out(l);
      if (a.flags.follow) await follow(paths.daemonLog);
      return;
    }
  }
}

async function follow(file: string): Promise<void> {
  let pos = statSync(file).size;
  const read = () => {
    try {
      const size = statSync(file).size;
      if (size < pos) pos = 0; // truncated/rotated
      if (size === pos) return;
      const fd = openSync(file, 'r');
      const buf = Buffer.alloc(size - pos);
      readSync(fd, buf, 0, buf.length, pos);
      closeSync(fd);
      pos = size;
      process.stdout.write(buf.toString('utf8'));
    } catch { /* ignore */ }
  };
  const w = watch(file, () => read());
  const t = setInterval(read, 1000);
  await new Promise<void>((res) => process.once('SIGINT', () => { w.close(); clearInterval(t); res(); }));
}

