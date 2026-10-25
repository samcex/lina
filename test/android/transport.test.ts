import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const javaAvailable = spawnSync('javac', ['-version']).status === 0 && spawnSync('java', ['-version']).status === 0;
const keytoolAvailable = spawnSync('keytool', ['-help']).status === 0;

describe.skipIf(!javaAvailable)('Native Android API transport', () => {
  it('uses authenticated UTF-8 HTTP without redirecting credentials or retrying mutations', () => {
    const classes = mkdtempSync(join(tmpdir(), 'lina-android-http-'));
    const root = resolve(import.meta.dirname, '../..');
    try {
      execFileSync('javac', ['--release', '8', '-d', classes,
        join(root, 'android/src/app/lina/android/Connection.java'),
        join(root, 'android/src/app/lina/android/ApiClient.java'),
        join(root, 'test/android/ApiClientTest.java')], { stdio: 'pipe', timeout: 15_000 });
      const output = execFileSync('java', ['-cp', classes, 'app.lina.android.ApiClientTest'], { encoding: 'utf8', timeout: 15_000 });
      expect(output).toContain('Android API transport passed');
    } finally { rmSync(classes, { recursive: true, force: true }); }
  });

  it.skipIf(!keytoolAvailable)('pins a self-signed home leaf before sending credentials, bounds probes, and never replays mutations', () => {
    const classes = mkdtempSync(join(tmpdir(), 'lina-android-tls-'));
    const root = resolve(import.meta.dirname, '../..');
    try {
      const keystore = join(classes, 'home.p12');
      execFileSync('keytool', ['-genkeypair', '-alias', 'home', '-keyalg', 'RSA', '-keysize', '2048',
        '-validity', '2', '-dname', 'CN=paired-home-certificate', '-storetype', 'PKCS12',
        '-keystore', keystore, '-storepass', 'test-password', '-keypass', 'test-password', '-noprompt'],
      { stdio: 'pipe', timeout: 15_000 });
      execFileSync('javac', ['--release', '8', '-d', classes,
        join(root, 'android/src/app/lina/android/Connection.java'),
        join(root, 'android/src/app/lina/android/ApiClient.java'),
        join(root, 'test/android/PinnedApiClientTest.java')], { stdio: 'pipe', timeout: 15_000 });
      const output = execFileSync('java', ['-cp', classes, 'app.lina.android.PinnedApiClientTest', keystore],
        { encoding: 'utf8', timeout: 15_000 });
      expect(output).toContain('Android pinned TLS transport passed');
    } finally { rmSync(classes, { recursive: true, force: true }); }
  }, 30_000);

  it('disconnects health/profile trickles by a total deadline, frees probe workers and caps control responses', () => {
    const classes = mkdtempSync(join(tmpdir(), 'lina-android-deadline-'));
    const root = resolve(import.meta.dirname, '../..');
    try {
      execFileSync('javac', ['--release', '8', '-d', classes,
        join(root, 'android/src/app/lina/android/Connection.java'),
        join(root, 'android/src/app/lina/android/ApiClient.java'),
        join(root, 'test/android/DeadlineApiClientTest.java')], { stdio: 'pipe', timeout: 15_000 });
      const output = execFileSync('java', ['-cp', classes, 'app.lina.android.DeadlineApiClientTest'],
        { encoding: 'utf8', timeout: 10_000 });
      expect(output).toContain('Android control read deadlines passed');
    } finally { rmSync(classes, { recursive: true, force: true }); }
  }, 20_000);
});
