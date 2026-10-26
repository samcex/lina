import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { expect, it } from 'vitest';
import { normalizeRea, reaCodexArgs, REA_READ_TOOLS } from '../../src/server/agents/rea.js';
import { buildClaudeArgs } from '../../src/server/agents/claude.js';
import { parseSettingValue } from '../../src/cli/args.js';
it('pins Node-based REA launches to the daemon runtime and preserves configured arguments/env', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lina-rea-test-')); const command = join(dir, 'rea');
  try {
    writeFileSync(command, '#!/usr/bin/env node\nconsole.log(process.version)\n');chmodSync(command,0o755);
    const server = await normalizeRea({ command, args: ['mcp'], env: { REA_EXAMPLE:'value', PATH:'/unsupported/runtime/bin' } });
    expect(server.command).toBe(process.execPath);
    expect(server.args).toEqual([command,'mcp']);
    expect(server.env?.PATH?.split(':')[0]).toBe(dirname(process.execPath));
    expect(server.env?.REA_EXAMPLE).toBe('value');
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
it('generates scalar TOML overrides and confines Codex reviewers to static analysis REA tools', () => {
  const server={command:'/node',args:['/rea.mjs','mcp'],env:{PATH:'/bin','EXAMPLE.KEY':'quoted " value'}};
  const args=reaCodexArgs(server,true);
  expect(args).toContain('mcp_servers.rea.enabled=true');
  expect(REA_READ_TOOLS).toContain('binary_session');
  expect(REA_READ_TOOLS).toContain('open_binary');
  expect(REA_READ_TOOLS).toContain('inspect_android_package');
  expect(REA_READ_TOOLS).toContain('inspect_android_method');
  expect(REA_READ_TOOLS).not.toContain('install_adb_package');
  expect(REA_READ_TOOLS).not.toContain('decompile_all');
  expect(REA_READ_TOOLS).not.toContain('update_analysis_settings');
  expect(REA_READ_TOOLS).not.toContain('start_frida_session');
  expect(args).toContain('mcp_servers.rea.tools.binary_session.approval_mode="approve"');
  expect(args).toContain('mcp_servers.rea.env."EXAMPLE.KEY"="quoted \\" value"');
  expect(args).toContain('mcp_servers.rea.enabled_tools='+JSON.stringify(REA_READ_TOOLS));
  expect(args.some(a=>a.startsWith('mcp_servers.rea.env='))).toBe(false);
  expect(reaCodexArgs(server,false).some(a=>a.includes('enabled_tools'))).toBe(false);
});
it('loads only REA for Claude and adds read-only tool permissions without replacing Bash/Read restrictions', () => {
  const opts={model:'opus',access:'read' as const,network:false};
  const server={command:'/node',args:['/rea.mjs','mcp']};
  const args=buildClaudeArgs(opts,server);
  expect(JSON.parse(args[args.indexOf('--mcp-config')+1])).toEqual({mcpServers:{rea:server}});
  expect(args).toContain('--strict-mcp-config');
  expect(args.filter(a=>a==='--allowedTools')).toHaveLength(1);
  expect(args).toContain('mcp__rea__get_evidence_bundle');
  expect(args).not.toContain('mcp__rea__*');
  expect(args).toContain('Bash(git diff:*)');
  expect(args).toContain('--disallowedTools');
  expect(buildClaudeArgs({...opts,access:'write',fullAccess:true},server)).toContain('mcp__rea__*');
  expect(buildClaudeArgs({...opts,access:'read',fullAccess:true},server)).toContain('mcp__rea__*');
  expect(buildClaudeArgs({...opts,access:'write',fullAccess:false},server)).not.toContain('mcp__rea__*');
  expect(buildClaudeArgs(opts)).not.toContain('--mcp-config');
});
it('accepts explicit REA on/off settings and rejects misspellings',()=>{
  expect(parseSettingValue('rea','on').patch).toEqual({reaEnabled:true});
  expect(parseSettingValue('rea','off').patch).toEqual({reaEnabled:false});
  expect(()=>parseSettingValue('rea','yes')).toThrow();
});
