// `lina tailscale`: reach the daemon from the phone app over your tailnet. `tailscale serve` terminates HTTPS
// on this machine and proxies to the daemon's owner-only unix socket, adding the visitor's Tailscale login.
// LINA signs in the allowed login(s) without the token, only on that socket; the TCP port still needs the token.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { paths } from '../server/paths.js';
import { bold, dim, fg } from './ansi.js';
import type { ParsedArgs } from './args.js';
import { CliError, connect } from './commands.js';
import { clientFor } from './daemon-control.js';
import { terminalQr } from './qr.js';
import { C } from './theme.js';

const out = (s = '') => process.stdout.write(s + '\n');

export type Run = (args: string[]) => Promise<string>;

const runTailscale: Run = (args) => new Promise((res, rej) => {
  execFile('tailscale', args, { timeout: 20_000 }, (err, stdout, stderr) => {
    if (err) rej(Object.assign(new Error((stderr || err.message).trim()), { code: (err as NodeJS.ErrnoException).code }));
    else res(stdout);
  });
});

interface ServeConfig {
  TCP?: Record<string, { HTTPS?: boolean }>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
  Foreground?: Record<string, ServeConfig>;
}

/** This machine's MagicDNS name, without the trailing dot. */
export function tailnetName(statusJson: string): string {
  const s = JSON.parse(statusJson) as { BackendState?: string; Self?: { DNSName?: string }; CurrentTailnet?: { MagicDNSEnabled?: boolean } };
  if (s.BackendState && s.BackendState !== 'Running') throw new CliError(`Tailscale is ${s.BackendState.toLowerCase()}`, 'Run `tailscale up` and try again.');
  const name = (s.Self?.DNSName ?? '').replace(/\.$/, '');
  if (!name || s.CurrentTailnet?.MagicDNSEnabled === false) throw new CliError('This machine has no MagicDNS name', 'Enable MagicDNS and HTTPS certificates in the Tailscale admin console (DNS page).');
  return name;
}

/** What already serves HTTPS on `port` (background or foreground), or undefined when the port is free. */
export function servedOn(serveJson: string, port: number): { proxy?: string; foreground: boolean } | undefined {
  const cfg = (serveJson.trim() ? JSON.parse(serveJson) : {}) as ServeConfig;
  const look = (c: ServeConfig, foreground: boolean) => {
    if (!c.TCP?.[String(port)]) return undefined;
    const web = Object.entries(c.Web ?? {}).find(([hp]) => hp.endsWith(`:${port}`))?.[1];
    return { proxy: web?.Handlers?.['/']?.Proxy, foreground };
  };
  return look(cfg, false) ?? Object.values(cfg.Foreground ?? {}).map((c) => look(c, true)).find(Boolean);
}

/** The Tailscale login (email) that owns this machine. */
export function tailnetLogin(statusJson: string): string | undefined {
  const s = JSON.parse(statusJson) as { Self?: { UserID?: number }; User?: Record<string, { LoginName?: string }> };
  const login = s.User?.[String(s.Self?.UserID)]?.LoginName;
  return login?.includes('@') ? login.toLowerCase() : undefined;
}

export function tailnetOrigin(name: string, port: number): string {
  return port === 443 ? `https://${name}` : `https://${name}:${port}`;
}

export async function cmdTailscale(a: ParsedArgs, run: Run = runTailscale) {
  const [action = 'status'] = a.positionals;
  const info = await connect();
  const client = clientFor(info);
  const target = `unix:${paths.tailnetSocket}`;
  const legacy = `http://127.0.0.1:${info.port}`; // token-only setup from before sign-in by email
  const port = a.flags.port ?? info.port;
  const status = await run(['status', '--json']).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') throw new CliError('The tailscale command is not installed', 'Install Tailscale on this machine: https://tailscale.com/download');
    throw new CliError(`tailscale status failed: ${e.message}`, 'Is tailscaled running? Try `tailscale up`.');
  });
  const name = tailnetName(status);
  const origin = tailnetOrigin(name, port);
  const settings = await client.getSettings();
  const origins = settings.remoteOrigins ?? [];
  const users = settings.tailnetUsers ?? [];
  const current = servedOn(await run(['serve', 'status', '--json']), port);
  let ours = current?.proxy === target;

  if (action === 'on') {
    const email = (a.flags.email ?? tailnetLogin(status))?.trim().toLowerCase();
    if (!email) throw new CliError('Could not tell which Tailscale account owns this machine', 'Name it: `lina tailscale on --email you@example.com`.');
    if (!existsSync(paths.tailnetSocket)) throw new CliError('The running daemon has no tailnet socket yet', 'Restart it with the current build: `lina daemon restart`, then run this again.');
    if (current && !ours && current.proxy !== legacy) {
      throw new CliError(`HTTPS port ${port} on ${name} already serves ${current.proxy ?? 'something else'}${current.foreground ? ' (a foreground `tailscale serve`)' : ''}`,
        'Pick another port, e.g. `lina tailscale on --port 7443`.');
    }
    if (!ours) await run(['serve', '--bg', `--https=${port}`, target]).catch((e: Error) => {
      throw new CliError(`tailscale serve failed: ${e.message}`, 'If it asks for permission, run once: `sudo tailscale set --operator=$USER`. HTTPS certificates must be enabled for the tailnet.');
    });
    ours = true;
    const next = await client.putSettings({ remoteOrigins: [...origins.filter((o) => o !== origin), origin], tailnetUsers: [...users.filter((u) => u !== email), email] });
    if (!next.remoteOrigins?.includes(origin) || !next.tailnetUsers?.includes(email)) throw new CliError('The running daemon does not support Tailscale sign-in yet', 'Restart it with the current build: `lina daemon restart`, then run this again.');
    settings.tailnetUsers = next.tailnetUsers;
    out(`${fg(C.ok)('✔')} ${bold('LINA is on your tailnet')} ${dim(`(tailscale serve :${port} → LINA's socket, tailnet only)`)}`);
  } else if (action === 'off') {
    if (ours) await run(['serve', `--https=${port}`, 'off']);
    const left = origins.filter((o) => o !== origin);
    await client.putSettings({ remoteOrigins: left, ...(left.length ? {} : { tailnetUsers: [] }) });
    out(`${fg(C.ok)('✔')} Stopped serving LINA on ${origin}`);
    return;
  }

  const active = ours && (action === 'on' || origins.includes(origin));
  if (!active) {
    const hint = current?.proxy === legacy ? dim(' (an older token-only setup is active)') : current && !ours ? dim(` (port ${port} serves ${current.proxy ?? 'something else'})`) : '';
    out(`${dim('○')} Not on your tailnet${hint}. Run ${fg(C.codex)('lina tailscale on')}${a.flags.port ? ` --port ${port}` : ''} to enable it.`);
    return;
  }
  const url = `${origin}/`;
  if (action !== 'on') out(`${fg(C.ok)('●')} ${bold('On your tailnet')} ${dim(`(tailscale serve :${port} → LINA's socket)`)}`);
  out(`  Address  ${fg(C.info)(url)}`);
  out(`  Sign-in  ${(settings.tailnetUsers ?? []).join(', ') || dim('nobody (token only)')} ${dim('— by Tailscale account, no token')}`);
  if (a.flags.qr) out(terminalQr(url));
  out(dim('  Anyone signed in to Tailscale as these accounts gets full control of LINA, including running code here.'));
}
