// Small shared helpers for the daemon.
import { randomBytes } from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Random lowercase alphanumeric id (not time-ordered). */
export function rid(len = 10): string {
  const b = randomBytes(len);
  let s = '';
  for (const x of b) s += ALPHABET[x % 36];
  return s;
}

/** Error carrying a machine-readable code and an HTTP status. */
export class LinaError extends Error {
  constructor(message: string, public code: string, public status = 400, public hint?: string) {
    super(message);
  }
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + '…';
}

export function firstLine(s: string, max = 120): string {
  const line = s.trim().split('\n').find((l) => l.trim()) ?? '';
  return truncate(line.trim(), max);
}

export function titleFrom(text: string, max = 60): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return truncate(t, max) || 'New session';
}

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
