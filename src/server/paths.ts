// Filesystem locations for LINA's data. LINA_HOME overrides ~/.lina (used by tests).
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function linaHome(): string {
  return process.env.LINA_HOME || join(homedir(), '.lina');
}

export const paths = {
  get home() { return linaHome(); },
  get db() { return join(linaHome(), 'lina.db'); },
  get daemonInfo() { return join(linaHome(), 'daemon.json'); },
  get daemonLog() { return join(linaHome(), 'daemon.log'); },
  get workspaces() { return join(linaHome(), 'workspaces'); },
  get attachments() { return join(linaHome(), 'attachments'); },
  get cache() { return join(linaHome(), 'cache'); },
  get previews() { return join(linaHome(), 'previews'); },
  /** Unix socket only `tailscale serve` connects to (tailscaled runs as root; the home dir is 0700). */
  get tailnetSocket() { return join(linaHome(), 'tailnet.sock'); },
  get homeAccess() { return join(linaHome(), 'home-access'); },
  workspace(sessionId: string) { return join(linaHome(), 'workspaces', sessionId); },
  attachmentDir(sessionId: string) { return join(linaHome(), 'attachments', sessionId); },
};

/** Creates the data directories with owner-only permissions. */
export function ensureHome(): void {
  for (const d of [paths.home, paths.workspaces, paths.attachments, paths.cache, paths.previews]) mkdirSync(d, { recursive: true, mode: 0o700 });
}

export const DEFAULT_PORT = Number(process.env.LINA_PORT) || 7077;
