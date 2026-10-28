// Small CLI helpers: project resolution, git detection, browser opening, URLs.
import { spawn } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import type { DaemonInfo } from '../shared/protocol.js';
import { AGENT_IDS, byAgent, peerOf, type AgentId, type AgentModelChoice, type Project, type SessionConfig, type Settings } from '../shared/types.js';
import type { GlobalOptions } from './args.js';
import { defaultTeam, rolesForTeam } from './team.js';

export function realpathOr(p: string): string {
  try { return realpathSync(p); } catch { return resolve(p); }
}

/** Registered project whose path contains `dir` (deepest match wins). */
export function findProjectForPath(projects: Project[], dir: string): Project | undefined {
  const d = realpathOr(dir);
  let best: Project | undefined;
  for (const p of projects) {
    const pp = realpathOr(p.path);
    if (d === pp || d.startsWith(pp.endsWith(sep) ? pp : pp + sep)) {
      if (!best || pp.length > realpathOr(best.path).length) best = p;
    }
  }
  return best;
}

/** Root of the git work tree containing `dir`, if any (walks up looking for .git). */
export function gitRoot(dir: string): string | undefined {
  let d = realpathOr(dir);
  for (;;) {
    if (existsSync(resolve(d, '.git'))) return d;
    const up = dirname(d);
    if (up === d) return undefined;
    d = up;
  }
}

export function isDirectory(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

export function expandHome(p: string): string {
  if (p === '~') return process.env.HOME ?? p;
  if (p.startsWith('~/')) return (process.env.HOME ?? '~') + p.slice(1);
  return p;
}

export function webUrl(info: Pick<DaemonInfo, 'port' | 'token'>, sessionId?: string): string {
  return `http://127.0.0.1:${info.port}/#token=${encodeURIComponent(info.token)}${sessionId ? `&session=${encodeURIComponent(sessionId)}` : ''}`;
}

/** Opens a URL in the user's browser. Resolves false if no opener could be started. */
export function openBrowser(url: string): Promise<boolean> {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  return new Promise((res) => {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      child.on('error', () => res(false));
      child.on('spawn', () => { child.unref(); res(true); });
    } catch {
      res(false);
    }
  });
}

/** Session config from saved settings + command-line flags. */
export function configFromFlags(g: GlobalOptions, settings?: Settings): Partial<SessionConfig> {
  const cfg: Partial<SessionConfig> = {};
  const base: Record<AgentId, AgentModelChoice> = settings?.models ? byAgent((a) => ({ ...settings.models[a] })) : byAgent(() => ({ model: '' }));
  let modelsChanged = false;
  if (g.codexModel) { base.codex = { model: g.codexModel, ...(g.codexEffort ? { effort: g.codexEffort } : {}) }; modelsChanged = true; }
  else if (g.codexEffort) { base.codex = { ...base.codex, effort: g.codexEffort }; modelsChanged = true; }
  if (g.claudeModel) { base.claude = { model: g.claudeModel, ...(g.claudeEffort ? { effort: g.claudeEffort } : {}) }; modelsChanged = true; }
  else if (g.claudeEffort) { base.claude = { ...base.claude, effort: g.claudeEffort }; modelsChanged = true; }
  if (modelsChanged) {
    // fill blanks from settings defaults so we never send an empty model id
    for (const a of AGENT_IDS) if (!base[a].model) delete (base as Partial<typeof base>)[a];
    cfg.models = base;
  }
  if (g.developer) { cfg.developer = g.developer; cfg.reviewer = peerOf(g.developer); }
  if (g.agents?.length) {
    // parallel: the first named agent leads (unless --developer says otherwise); everyone builds a part.
    const lead = g.developer ?? g.agents[0];
    cfg.mode = 'parallel';
    cfg.developer = lead;
    cfg.reviewer = g.agents.find((a) => a !== lead) ?? peerOf(lead);
    cfg.participants = [lead, ...g.agents.filter((a) => a !== lead)];
  }
  if (g.mode) cfg.mode = g.mode;
  if (g.workspaceMode) cfg.workspaceMode = g.workspaceMode;
  if (g.interactionMode) cfg.interactionMode = g.interactionMode;
  if (g.team) cfg.mode = 'custom';
  // custom mode always carries an explicit team: --team, else the saved default, else architect-like.
  if (cfg.mode === 'custom') {
    const dev = cfg.developer ?? settings?.developer ?? 'codex';
    cfg.team = g.team ?? defaultTeam({ developer: dev, reviewer: peerOf(dev) }, g.developer ? undefined : settings?.team);
    Object.assign(cfg, rolesForTeam(cfg.team));
  }
  if (g.maxRounds) cfg.maxRounds = g.maxRounds;
  if (g.mock) cfg.mock = true;
  return cfg;
}
