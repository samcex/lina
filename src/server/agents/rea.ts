// Selectively inherit the user's REA registration, never unrelated personal MCPs.
import { readFile, realpath, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, delimiter, join, basename } from 'node:path';
import { execText, which } from './proc.js';
import type { AgentId } from '../../shared/types.js';
export interface ReaServer { command: string; args: string[]; env?: Record<string, string>; cwd?: string }
// REA 6.8 declares these operations readOnlyHint=true in tools/list. Other tools
// may create analysis artifacts, change settings or control targets.
export const REA_READ_TOOLS = ['inspect_analysis_settings', 'gdb_session_status', 'evaluate_reconstruction_coverage', 'get_evidence_bundle', 'list_unknowns', 'verify_unknown_resolution'];
export async function normalizeRea(server: ReaServer): Promise<ReaServer> {
  const command = await which(server.command);
  if (!command) throw new Error('Configured REA executable was not found. Check the REA MCP registration.');
  const path = await realpath(command);
  const handle = await open(path, 'r');
  const bytes = Buffer.alloc(150);
  try { await handle.read(bytes, 0, bytes.length, 0); } finally { await handle.close(); }
  const firstLine = bytes.toString().split('\n')[0];
  const script = /^#!.*\bnode\b/.test(firstLine);
  const node = ['node', 'nodejs'].includes(basename(command));
  const env = { ...server.env, PATH: [dirname(process.execPath), server.env?.PATH ?? process.env.PATH ?? ''].join(delimiter) };
  // Avoid whichever unsupported Node happens to appear first in a shell PATH.
  return { ...server, command: script || node ? process.execPath : command, args: script ? [path, ...server.args] : server.args, env };
}
export async function configuredRea(agent: AgentId, codexBin = process.env.LINA_CODEX_BIN || 'codex'): Promise<ReaServer> {
  let raw: any;
  if (agent === 'claude') {
    try { raw = JSON.parse(await readFile(join(homedir(), '.claude.json'), 'utf8')).mcpServers?.rea; } catch { /* try Codex registration below */ }
  }
  if (!raw) {
    const r = await execText(codexBin, ['mcp', 'get', 'rea', '--json'], { timeoutMs: 15000, cwd: homedir() });
    if (r.code === 0) {
      const value = JSON.parse(r.stdout);
      if (value.enabled !== false) raw = value.transport;
    }
  }
  if (!raw || typeof raw.command !== 'string' || !Array.isArray(raw.args) || raw.args.some((v: unknown) => typeof v !== 'string')) {
    throw new Error('REA is enabled in LINA but no usable stdio REA registration was found. Configure REA in Codex or Claude Code first.');
  }
  const env: Record<string,string> = {};
  for (const [key,value] of Object.entries(raw.env ?? {})) if (typeof value === 'string') env[key] = value;
  for (const key of raw.env_vars ?? []) if (typeof key === 'string' && process.env[key] !== undefined) env[key] = process.env[key]!;
  return normalizeRea({ command: raw.command, args: raw.args, env, ...(typeof raw.cwd === 'string' ? { cwd: raw.cwd } : {}) });
}
export function reaCodexArgs(server: ReaServer, readOnly: boolean): string[] {
  const values: Record<string,unknown> = { enabled: true, command: server.command, args: server.args, enabled_tools: readOnly ? REA_READ_TOOLS : [], startup_timeout_sec: 45, tool_timeout_sec: 180 };
  // An empty enabled_tools means no tools on some Codex versions; omit for developers.
  if (!readOnly) delete values.enabled_tools;
  if (server.cwd) values.cwd = server.cwd;
  return [...Object.entries(values).flatMap(([key,value]) => ['-c', `mcp_servers.rea.${key}=${JSON.stringify(value)}`]),
    ...Object.entries(server.env ?? {}).flatMap(([key,value]) => ['-c', `mcp_servers.rea.env.${JSON.stringify(key)}=${JSON.stringify(value)}`])];
}
