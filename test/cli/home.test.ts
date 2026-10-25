import { describe, expect, it } from 'vitest';
import { parseArgs, validateCommand } from '../../src/cli/args.js';
import { formatHome } from '../../src/cli/home.js';

describe('home CLI', () => {
  it('parses and validates the live home listener commands', () => {
    const args = parseArgs(['home', 'on', '--host', '192.168.1.100', '--port', '7443', '--json']);
    expect(args).toMatchObject({ command: 'home', positionals: ['on'], flags: { host: '192.168.1.100', port: 7443, json: true } });
    validateCommand(args);
    for (const argv of [['home'], ['home', 'off'], ['home', 'status', '--json']]) expect(() => validateCommand(parseArgs(argv))).not.toThrow();
    for (const argv of [['home', 'up'], ['home', 'off', '--port', '7443'], ['home', 'status', '--host', '192.168.1.100'], ['home', 'on', 'extra'], ['home', 'on', '--port', '0']]) expect(() => validateCommand(parseArgs(argv))).toThrow();
  });
  it('explains pairing and disabling without printing any token', () => {
    expect(formatHome({ enabled: true, active: true, url: 'https://192.168.1.100:7077', addresses: [] })).toContain('Tailscale once');
    expect(formatHome({ enabled: false, active: false, addresses: [{ interface: 'eno1', address: '192.168.1.100' }] })).toContain('lina home on --host 192.168.1.100');
  });
});
