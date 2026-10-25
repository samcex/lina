// Optional pinned HTTPS access on one explicitly selected physical home-LAN address.
// Credentials stay private and survive daemon restarts; this listener never trusts proxy identity headers.
import { execFileSync } from 'node:child_process';
import { createPrivateKey, randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import type { Socket } from 'node:net';
import { createServer, type Server, type TLSSocket } from 'node:tls';
import type { ConnectionBundle, HomeConfig, HomeStatus } from '../shared/protocol.js';
import { paths } from './paths.js';
import { LinaError } from './util.js';

export function isPrivateIPv4(address: string): boolean {
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some((p) => !/^(0|[1-9]\d{0,2})$/.test(p) || Number(p) > 255)) return false;
  const [a, b] = parts.map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function homeAddresses(): { interface: string; address: string }[] {
  return Object.entries(networkInterfaces()).flatMap(([name, addresses]) => {
    if (/^(lo|tailscale|docker|br-|virbr|veth|tun|tap|wg|podman)/i.test(name)) return [];
    // Linux exposes a device link for physical (including PCI/USB Wi-Fi) interfaces.
    if (process.platform === 'linux' && !existsSync(`/sys/class/net/${name}/device`)) return [];
    return (addresses ?? []).filter((a) => a.family === 'IPv4' && !a.internal && isPrivateIPv4(a.address))
      .map((a) => ({ interface: name, address: a.address }));
  });
}

function securePath(path: string, directory = false): void {
  const st = lstatSync(path);
  if (st.isSymbolicLink() || (directory ? !st.isDirectory() : !st.isFile()) || (st.mode & 0o077) !== 0 ||
      (process.getuid && st.uid !== process.getuid())) throw new Error(`Unsafe permissions or owner on ${path}; require owner-only ${directory ? 'directory (0700)' : 'file (0600)'}`);
}

function pathExists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}

function privateJson(path: string, value: unknown): void {
  if (pathExists(path)) securePath(path);
  const tmp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try { writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' }); renameSync(tmp, path); }
  finally { rmSync(tmp, { force: true }); }
}

function readPrivate(path: string): string { securePath(path); return readFileSync(path, 'utf8'); }

function validConfig(value: unknown): HomeConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LinaError('Home configuration must be an object', 'invalid');
  const c = value as Record<string, unknown>;
  if (typeof c.enabled !== 'boolean' || (c.host !== undefined && (typeof c.host !== 'string' || !isPrivateIPv4(c.host))) ||
      (c.port !== undefined && (!Number.isInteger(c.port) || Number(c.port) < 1 || Number(c.port) > 65535)) ||
      Object.keys(c).some((k) => !['enabled', 'host', 'port'].includes(k))) throw new LinaError('Use enabled:boolean, a private LAN IPv4 host, and port 1–65535', 'invalid');
  return { enabled: c.enabled, ...(c.host !== undefined ? { host: c.host as string } : {}), ...(c.port !== undefined ? { port: c.port as number } : {}) };
}

export class HomeAccess {
  readonly serverId: string;
  readonly token: string;
  private config: HomeConfig;
  private listener?: { server: Server; sockets: Set<Socket> };
  private active?: { url: string; certificateSha256: string };
  private error?: string;
  private readonly dir: string;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly accept: (socket: TLSSocket) => void, private readonly daemonPort: () => number) {
    this.dir = paths.homeAccess;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    securePath(this.dir, true);
    const identityPath = join(this.dir, 'identity.json');
    if (!pathExists(identityPath)) privateJson(identityPath, { serverId: randomUUID(), token: randomBytes(32).toString('hex') });
    const identity = JSON.parse(readPrivate(identityPath)) as { serverId?: unknown; token?: unknown };
    if (typeof identity.serverId !== 'string' || !/^[0-9a-f-]{36}$/.test(identity.serverId) || typeof identity.token !== 'string' || !/^[0-9a-f]{64}$/.test(identity.token)) throw new Error('Malformed home identity; refusing to replace paired credentials');
    this.serverId = identity.serverId;
    this.token = identity.token;
    const configPath = join(this.dir, 'config.json');
    this.config = pathExists(configPath) ? validConfig(JSON.parse(readPrivate(configPath))) : { enabled: false };
  }

  status(): HomeStatus {
    return { ...this.config, active: !!this.listener, ...(this.active ?? {}), ...(this.error ? { error: this.error } : {}), addresses: homeAddresses() };
  }
  origin(): string | undefined { return this.active?.url; }

  bundle(tailnetUrl?: string): ConnectionBundle {
    return { version: 1, serverId: this.serverId, ...(tailnetUrl ? { tailnetUrl } : {}), ...(this.active ? { home: { ...this.active } } : {}), token: this.token };
  }

  /** A missing home interface at boot leaves normal localhost/Tailscale operation available. */
  async start(): Promise<void> {
    if (!this.config.enabled) return;
    try { await this.apply(this.config, false); }
    catch (e) { this.error = (e as Error).message; }
  }

  configure(value: unknown): Promise<HomeStatus> {
    // Serialize requests: an overlapping off must never leave an unrecorded listener alive.
    const next = this.pending.then(async () => { await this.apply(validConfig(value), true); return this.status(); });
    this.pending = next.catch(() => undefined);
    return next;
  }

  private certificate(): { key: string; cert: string; pin: string } {
    const keyPath = join(this.dir, 'key.pem'), certPath = join(this.dir, 'cert.pem');
    if (pathExists(keyPath) !== pathExists(certPath)) throw new Error('Incomplete home TLS certificate; refusing to replace paired certificate');
    if (!pathExists(keyPath)) {
      const tmp = join(this.dir, `tls-${randomBytes(8).toString('hex')}`);
      mkdirSync(tmp, { mode: 0o700 });
      try {
        execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-noenc',
          '-keyout', join(tmp, 'key.pem'), '-out', join(tmp, 'cert.pem'), '-days', '3650', '-subj', `/CN=Lina ${this.serverId}`,
          '-addext', 'basicConstraints=critical,CA:FALSE', '-addext', 'keyUsage=critical,digitalSignature', '-addext', 'extendedKeyUsage=serverAuth'],
        { timeout: 20_000, stdio: ['ignore', 'ignore', 'pipe'] });
        // OpenSSL respects umask for cert files; explicitly copy into exclusive owner-only files.
        writeFileSync(keyPath, readFileSync(join(tmp, 'key.pem')), { mode: 0o600, flag: 'wx' });
        writeFileSync(certPath, readFileSync(join(tmp, 'cert.pem')), { mode: 0o600, flag: 'wx' });
      } finally { rmSync(tmp, { recursive: true, force: true }); }
    }
    const key = readPrivate(keyPath), cert = readPrivate(certPath);
    const parsed = new X509Certificate(cert);
    if (!parsed.checkPrivateKey(createPrivateKey(key))) throw new Error('Home TLS certificate does not match its private key');
    if (Date.parse(parsed.validTo) <= Date.now() || Date.parse(parsed.validFrom) > Date.now()) throw new Error('Home TLS certificate is outside its validity period');
    return { key, cert, pin: parsed.fingerprint256.replace(/:/g, '').toLowerCase() };
  }

  private async apply(config: HomeConfig, persist: boolean): Promise<void> {
    if (!config.enabled) {
      const next = { ...this.config, ...config, enabled: false };
      if (persist) privateJson(join(this.dir, 'config.json'), next);
      this.config = next;
      this.error = undefined;
      await this.stopListener();
      return;
    }
    const addresses = homeAddresses();
    const host = config.host ?? this.config.host ?? (addresses.length === 1 ? addresses[0].address : undefined);
    if (!host || !addresses.some((a) => a.address === host)) throw new LinaError('Choose an assigned physical home-LAN IPv4 address with --host', 'invalid', 400);
    const port = config.port ?? this.config.port ?? this.daemonPort();
    const next = { enabled: true, host, port };
    const origin = `https://${host}:${port}`;
    if (this.listener && this.active?.url === origin) {
      if (persist) privateJson(join(this.dir, 'config.json'), next);
      this.config = next; this.error = undefined; return;
    }
    const { key, cert, pin } = this.certificate();
    const sockets = new Set<Socket>();
    const srv = createServer({ key, cert, minVersion: 'TLSv1.2', handshakeTimeout: 10_000 }, this.accept);
    // Include clients that have not completed TLS so off cannot wait on an idle handshake.
    srv.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    // TLS failures are connection-local. Never print handshake payloads or credentials.
    srv.on('tlsClientError', () => {});
    srv.on('error', (e) => { if (this.listener?.server === srv) this.error = e.message; });
    try {
      await new Promise<void>((resolve, reject) => {
        const fail = (e: Error) => { srv.off('listening', ready); reject(e); };
        const ready = () => { srv.off('error', fail); resolve(); };
        srv.once('error', fail); srv.once('listening', ready); srv.listen(port, host);
      });
      if (persist) privateJson(join(this.dir, 'config.json'), next);
    } catch (e) { srv.close(); throw e; }
    await this.stopListener();
    this.listener = { server: srv, sockets };
    this.active = { url: origin, certificateSha256: pin };
    this.config = next; this.error = undefined;
  }

  private async stopListener(): Promise<void> {
    const listener = this.listener;
    this.listener = undefined; this.active = undefined;
    if (!listener) return;
    const closed = new Promise<void>((resolve) => listener.server.close(() => resolve()));
    for (const socket of listener.sockets) socket.destroy();
    listener.sockets.clear();
    await closed;
  }

  async close(): Promise<void> { await this.pending; await this.stopListener(); }
}
