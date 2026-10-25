// Daemon log: append-only text file in LINA_HOME, redacted, rotated at ~5 MB.
import { appendFileSync, renameSync, statSync } from 'node:fs';
import { paths } from './paths.js';
import { redact } from './agents/redact.js';

const MAX_BYTES = 5 * 1024 * 1024;
let toStderr = false;
let checkedAt = 0;

export function logToStderr(on: boolean): void { toStderr = on; }

function rotateIfNeeded(file: string): void {
  const now = Date.now();
  if (now - checkedAt < 10_000) return;
  checkedAt = now;
  try {
    if (statSync(file).size > MAX_BYTES) renameSync(file, file + '.1');
  } catch { /* missing file is fine */ }
}

function write(level: string, msg: string, meta?: unknown): void {
  let line = `${new Date().toISOString()} ${level} ${msg}`;
  if (meta !== undefined) {
    try { line += ' ' + (meta instanceof Error ? meta.stack ?? meta.message : JSON.stringify(meta)); } catch { /* unserializable */ }
  }
  line = redact(line) + '\n';
  if (toStderr) process.stderr.write(line);
  try {
    const file = paths.daemonLog;
    rotateIfNeeded(file);
    appendFileSync(file, line, { mode: 0o600 });
  } catch { /* logging must never crash the daemon */ }
}

export const log = {
  info: (msg: string, meta?: unknown) => write('INFO', msg, meta),
  warn: (msg: string, meta?: unknown) => write('WARN', msg, meta),
  error: (msg: string, meta?: unknown) => write('ERROR', msg, meta),
};
