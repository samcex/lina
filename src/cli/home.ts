// Manage the optional TLS home listener through the live daemon, without disrupting sessions.
import type { HomeStatus } from '../shared/protocol.js';
import { bold, dim, fg } from './ansi.js';
import type { ParsedArgs } from './args.js';
import { CliError, connect } from './commands.js';
import { clientFor } from './daemon-control.js';
import { C } from './theme.js';

export function formatHome(status: HomeStatus): string {
  const lines = [status.active ? `${fg(C.ok)('●')} ${bold('Home Wi-Fi access is on')}\n  Address  ${fg(C.info)(status.url ?? '')}` : `${dim('○')} Home Wi-Fi access is ${status.enabled ? 'unavailable' : 'off'}.`];
  if (status.error) lines.push(`  ${status.error}`);
  if (status.active) lines.push('  Open Lina over Tailscale once to pair this home connection.', '  The Android app then connects at home with Tailscale off.', dim('  `lina home off` stops home access. Forget on a phone only removes its saved connection.'));
  else if (status.addresses.length) lines.push(`  Enable: lina home on --host ${status.host ?? status.addresses[0].address}`);
  return lines.join('\n');
}

export async function cmdHome(a: ParsedArgs): Promise<void> {
  const [action = 'status'] = a.positionals;
  const client = clientFor(await connect());
  let status: HomeStatus;
  try {
    status = action === 'on' ? await client.putHome({ enabled: true, ...(a.flags.host ? { host: a.flags.host } : {}), ...(a.flags.port ? { port: a.flags.port } : {}) })
      : action === 'off' ? await client.putHome({ enabled: false }) : await client.home();
  } catch (e) {
    if ((e as { status?: number }).status === 404) throw new CliError('The running daemon does not support home access yet', 'Restart it with the current build when sessions are idle, then run this again.');
    throw e;
  }
  process.stdout.write((a.flags.json ? JSON.stringify(status, null, 2) : formatHome(status)) + '\n');
}
