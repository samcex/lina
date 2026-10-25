import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs, validateCommand } from '../../src/cli/args.js';
import { qrMatrix, terminalQr } from '../../src/cli/qr.js';
import { webUrl } from '../../src/cli/util.js';

vi.mock('../../src/cli/daemon-control.js', async (original) => ({
  ...await original<typeof import('../../src/cli/daemon-control.js')>(),
  ensureDaemon: vi.fn(async () => ({ pid: 123, port: 7077, token: 'a'.repeat(64) })),
}));
vi.mock('../../src/cli/util.js', async (original) => ({
  ...await original<typeof import('../../src/cli/util.js')>(),
  openBrowser: vi.fn(async () => true),
}));
import { cmdDoctor, cmdUi } from '../../src/cli/commands.js';
import { openBrowser } from '../../src/cli/util.js';

const url = webUrl({ port: 7077, token: 'a'.repeat(64) });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('lina ui output flags', () => {
  it('accepts only boolean ui-specific flags, including both together', () => {
    for (const flags of [['--url'], ['--qr'], ['--url', '--qr']]) {
      const args = parseArgs(['ui', ...flags]);
      expect(() => validateCommand(args)).not.toThrow();
      for (const flag of flags) expect(args.flags[flag.slice(2) as 'url' | 'qr']).toBe(true);
    }
    expect(() => parseArgs(['sessions', '--qr'])).toThrow(/not valid/);
    expect(() => parseArgs(['--url'])).toThrow(/not valid/);
    expect(() => parseArgs(['ui', '--url=yes'])).toThrow(/does not take a value/);
    expect(() => validateCommand(parseArgs(['ui', 'extra', '--url']))).toThrow(/Unexpected argument/);
  });
  it('--url writes only the exact token URL and never opens a browser', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.mocked(openBrowser).mockClear();
    await cmdUi(undefined, { url: true });
    expect(write.mock.calls.map(([s]) => s).join('')).toBe(url + '\n');
    expect(openBrowser).not.toHaveBeenCalled();
  });
  it.each([{ qr: true }, { qr: true, url: true }])('prints a QR for the same URL without opening a browser (%j)', async (flags) => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.mocked(openBrowser).mockClear();
    await cmdUi(undefined, flags);
    expect(write.mock.calls.map(([s]) => s).join('')).toBe(url + '\n' + terminalQr(url) + '\n');
    expect(openBrowser).not.toHaveBeenCalled();
  });
  it('retains browser opening without flags', async () => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.mocked(openBrowser).mockClear();
    await cmdUi();
    expect(openBrowser).toHaveBeenCalledWith(url);
  });
});

describe('zero-dependency QR encoder', () => {
  it('fits a full daemon URL at the largest port and contains finder patterns', () => {
    const grid = qrMatrix(webUrl({ port: 65535, token: 'f'.repeat(64) }));
    expect(grid).toHaveLength(37);
    expect(grid.every((row) => row.length === 37 && row.every((v) => typeof v === 'boolean'))).toBe(true);
    for (const [cx, cy] of [[3, 3], [33, 3], [3, 33]]) {
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        expect(grid[cy + dy][cx + dx]).toBe(Math.max(Math.abs(dx), Math.abs(dy)) !== 2);
      }
    }
  });
  it('renders a bounded square with quiet zones and explicit terminal colours', () => {
    const rendered = terminalQr(url);
    const rows = rendered.split('\n');
    expect(rows).toHaveLength(23);
    const plain = rows.map((r) => r.replace(/\x1b\[[0-9;]*m/g, ''));
    expect(plain.every((r) => r.length === 45 && /^[ █▀▄]+$/.test(r))).toBe(true);
    expect(plain[0]).toBe(' '.repeat(45));
    expect(plain[1]).toBe(' '.repeat(45));
    expect(plain.every((r) => r.startsWith('    ') && r.endsWith('    '))).toBe(true);
    expect(rendered).toContain('\x1b[30;107m');
  });
  it('selects smaller versions and rejects overflow, counting UTF-8 bytes', () => {
    expect(qrMatrix('hello')).toHaveLength(21);
    expect(qrMatrix('x'.repeat(106))).toHaveLength(37);
    expect(() => qrMatrix('x'.repeat(107))).toThrow(/106 bytes/);
    expect(() => qrMatrix('🌑'.repeat(27))).toThrow(/106 bytes/);
    expect(qrMatrix('hello')).not.toEqual(qrMatrix('world'));
  });
});


describe('doctor machine output', () => {
  it.each([true, false])('emits valid JSON for live probes and signals failed checks (ok=%s)', async (ok) => {
    const previousExit = process.exitCode;
    const checks = [{ id: 'codex-live', label: 'Codex', ok, detail: ok ? 'ready' : 'unavailable' }];
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const fetch = vi.fn(async (_url: string, _options?: unknown) => new Response(JSON.stringify({ checks }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    try {
      process.exitCode = 0;
      await cmdDoctor(parseArgs(['doctor', '--live', '--json']));
      expect(JSON.parse(write.mock.calls.map(([value]) => value).join(''))).toEqual(checks);
      expect(process.exitCode).toBe(ok ? 0 : 1);
      expect(fetch.mock.calls[0][0]).toContain('/api/doctor?live=1');
    } finally { process.exitCode = previousExit; }
  });
});
