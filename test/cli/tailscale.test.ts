import { describe, expect, it } from 'vitest';
import { parseArgs, validateCommand } from '../../src/cli/args.js';
import { servedOn, tailnetLogin, tailnetName, tailnetOrigin } from '../../src/cli/tailscale.js';

const serve = JSON.stringify({
  TCP: { 8443: { HTTPS: true }, 7077: { HTTPS: true } },
  Web: { 'me.t.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } }, 'me.t.ts.net:7077': { Handlers: { '/': { Proxy: 'http://127.0.0.1:7077' } } } },
  Foreground: { abc: { TCP: { 443: { HTTPS: true } }, Web: { 'me.t.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:44191' } } } } } },
});

describe('lina tailscale helpers', () => {
  it('reads the MagicDNS name and refuses a stopped or nameless node', () => {
    expect(tailnetName(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'me.t.ts.net.' } }))).toBe('me.t.ts.net');
    expect(() => tailnetName(JSON.stringify({ BackendState: 'Stopped', Self: { DNSName: 'me.t.ts.net.' } }))).toThrow(/stopped/);
    expect(() => tailnetName(JSON.stringify({ BackendState: 'Running', Self: {} }))).toThrow(/MagicDNS/);
  });

  it('reads the login that owns this machine', () => {
    expect(tailnetLogin(JSON.stringify({ Self: { UserID: 42 }, User: { 42: { LoginName: 'Me@Example.com' } } }))).toBe('me@example.com');
    expect(tailnetLogin(JSON.stringify({ Self: { UserID: 1 }, User: { 1: { LoginName: 'tagged-devices' } } }))).toBeUndefined();
  });

  it('finds what serves a port, including foreground serves', () => {
    expect(servedOn(serve, 7077)).toEqual({ proxy: 'http://127.0.0.1:7077', foreground: false });
    expect(servedOn(serve, 8443)?.proxy).toBe('http://127.0.0.1:3000');
    expect(servedOn(serve, 443)).toEqual({ proxy: 'http://127.0.0.1:44191', foreground: true });
    expect(servedOn(serve, 9000)).toBeUndefined();
    expect(servedOn('', 443)).toBeUndefined();
  });

  it('builds origins and parses the command', () => {
    expect(tailnetOrigin('me.t.ts.net', 443)).toBe('https://me.t.ts.net');
    expect(tailnetOrigin('me.t.ts.net', 7077)).toBe('https://me.t.ts.net:7077');
    const a = parseArgs(['tailscale', 'on', '--port', '7443', '--qr', '--email', 'me@example.com']);
    expect(a).toMatchObject({ command: 'tailscale', positionals: ['on'], flags: { port: 7443, qr: true, email: 'me@example.com' } });
    expect(() => validateCommand(a)).not.toThrow();
    expect(() => validateCommand(parseArgs(['tailscale', 'up']))).toThrow();
  });
});
