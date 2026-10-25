import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const fixtures: string[] = [];
const mode = (file: string) => statSync(file).mode & 0o777;

// Stub only the external SDK/JDK tools. The production script creates the keys,
// changes permissions, validates existing files, and distributes the APK itself.
const tool = `#!/usr/bin/env bash
set -euo pipefail
case "$(basename "$0")" in
  aapt2)
    while [ "$#" -gt 0 ]; do
      if [ "$1" = -o ]; then printf resources > "$2"; break; fi
      shift
    done ;;
  d8)
    while [ "$#" -gt 0 ]; do
      if [ "$1" = --output ]; then printf dex > "$2/classes.dex"; break; fi
      shift
    done ;;
  jar)
    if [ "$1" = --create ]; then printf jar > "$3"; fi ;;
  javac) : ;;
  zipalign)
    if [ "$1" = -f ]; then cp "\${@: -2:1}" "\${@: -1}"; fi ;;
  keytool)
    [ "$(umask)" = 0077 ] || exit 70
    while [ "$1" != -keystore ]; do shift; done
    [ "$(stat -c %a "$(dirname "$2")")" = 700 ] || exit 71
    printf fake-private-key > "$2" ;;
  apksigner)
    if [ "$1" = sign ]; then
      shift
      while [ "$#" -gt 0 ]; do
        case "$1" in
          --ks) fixture_key="$2"; shift 2 ;;
          --out) fixture_apk="$2"; shift 2 ;;
          *) shift ;;
        esac
      done
      [ "$(stat -c %a "$fixture_key")" = 600 ] || exit 72
      [ "$(stat -c %a "$(dirname "$fixture_key")")" = 700 ] || exit 73
      printf '600 700' > "$LINA_TEST_TRACE"
      printf signed-apk > "$fixture_apk"
    fi ;;
esac
`;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'lina-signing-'));
  fixtures.push(dir);
  for (const rel of ['scripts', 'bin', 'android/src/app/lina/android', 'web/public', 'sdk/build-tools/36.0.0', 'sdk/platforms/android-36']) {
    mkdirSync(join(dir, rel), { recursive: true });
  }
  const script = join(dir, 'scripts/build-android.sh');
  copyFileSync(join(root, 'scripts/build-android.sh'), script);
  writeFileSync(join(dir, 'android/src/app/lina/android/Stub.java'), 'class Stub {}');
  writeFileSync(join(dir, 'sdk/platforms/android-36/android.jar'), '');
  for (const name of ['aapt2', 'd8', 'zipalign', 'apksigner', 'javac', 'jar', 'keytool']) {
    const file = join(dir, ['aapt2', 'd8', 'zipalign', 'apksigner'].includes(name) ? 'sdk/build-tools/36.0.0' : 'bin', name);
    writeFileSync(file, tool, { mode: 0o755 });
  }
  const env: NodeJS.ProcessEnv = { ...process.env, ANDROID_HOME: join(dir, 'sdk'), PATH: `${join(dir, 'bin')}:/usr/bin:/bin`,
    LINA_ANDROID_BUILD_TOOLS: '36.0.0', LINA_ANDROID_API: '36', LINA_ANDROID_STORE_PASSWORD: 'fixture-password', LINA_TEST_TRACE: join(dir, 'trace') };
  delete env.LINA_ANDROID_KEYSTORE;
  const run = (extra: Record<string, string> = {}) => execFileSync('/bin/bash',
    ['-c', 'umask 000; exec bash "$1"', 'lina-signing-test', script], { env: { ...env, ...extra }, encoding: 'utf8', stdio: 'pipe' });
  return { dir, run, key: join(dir, 'android/.local/lina.keystore') };
}

afterEach(() => { for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('Android signing key permissions', () => {
  it('generates a private key under caller umask 000 and distributes a readable root APK', () => {
    const f = fixture();
    mkdirSync(join(f.dir, 'dist/web'), { recursive: true });
    f.run();
    expect(mode(dirname(f.key))).toBe(0o700);
    expect(mode(f.key)).toBe(0o600);
    expect(readFileSync(join(f.dir, 'trace'), 'utf8')).toBe('600 700');
    for (const rel of ['lina.apk', 'dist/android/lina.apk', 'web/public/lina.apk', 'dist/web/lina.apk']) {
      expect(readFileSync(join(f.dir, rel), 'utf8')).toBe('signed-apk');
      expect(mode(join(f.dir, rel))).toBe(0o644);
    }
  });
  it('restricts an existing 0775 directory and 0664 key before signing, preserving its identity', () => {
    const f = fixture();
    mkdirSync(dirname(f.key)); chmodSync(dirname(f.key), 0o775);
    writeFileSync(f.key, 'existing-private-key'); chmodSync(f.key, 0o664);
    f.run();
    expect(mode(dirname(f.key))).toBe(0o700);
    expect(mode(f.key)).toBe(0o600);
    expect(readFileSync(f.key, 'utf8')).toBe('existing-private-key');
    expect(readFileSync(join(f.dir, 'trace'), 'utf8')).toBe('600 700');
  });
  it('rejects a symlink key without touching its target or signing', () => {
    const f = fixture();
    mkdirSync(dirname(f.key));
    const target = join(f.dir, 'other-key');
    writeFileSync(target, 'other'); chmodSync(target, 0o644);
    symlinkSync(target, f.key);
    expect(() => f.run()).toThrow(/Refusing a symlink/);
    expect(mode(target)).toBe(0o644);
    expect(existsSync(join(f.dir, 'trace'))).toBe(false);
  });
  it('rejects a symlink key directory', () => {
    const f = fixture();
    const target = join(f.dir, 'other-directory');
    mkdirSync(target); chmodSync(target, 0o775);
    symlinkSync(target, dirname(f.key));
    expect(() => f.run()).toThrow(/Refusing a symlink/);
    expect(mode(target)).toBe(0o775);
    expect(existsSync(join(f.dir, 'trace'))).toBe(false);
  });
  it('requires a private directory for a custom keystore', () => {
    const f = fixture();
    const key = join(f.dir, 'custom/key');
    mkdirSync(dirname(key)); chmodSync(dirname(key), 0o755);
    writeFileSync(key, 'custom');
    expect(() => f.run({ LINA_ANDROID_KEYSTORE: key })).toThrow(/mode 0700/);
    expect(existsSync(join(f.dir, 'trace'))).toBe(false);
    chmodSync(dirname(key), 0o700);
    f.run({ LINA_ANDROID_KEYSTORE: key });
    expect(mode(key)).toBe(0o600);
    expect(readFileSync(key, 'utf8')).toBe('custom');
  });
});
