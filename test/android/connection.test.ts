import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const javaAvailable = spawnSync('javac', ['-version']).status === 0 && spawnSync('java', ['-version']).status === 0;

describe.skipIf(!javaAvailable)('Android connection origin policy', () => {
  it('preserves fragment credentials, stores only the origin, and rejects foreign URLs', () => {
    const classes = mkdtempSync(join(tmpdir(), 'lina-android-policy-'));
    const root = resolve(import.meta.dirname, '../..');
    try {
      execFileSync('javac', ['--release', '8', '-d', classes,
        join(root, 'android/src/app/lina/android/Connection.java'),
        join(root, 'android/src/app/lina/android/ConnectionRoutes.java'), join(root, 'test/android/ConnectionTest.java')], { stdio: 'pipe' });
      const output = execFileSync('java', ['-cp', classes, 'app.lina.android.ConnectionTest'], { encoding: 'utf8' });
      expect(output).toContain('Android connection policy passed');
    } finally { rmSync(classes, { recursive: true, force: true }); }
  });
});
