import { describe, expect, it } from 'vitest';
import { setupEnv } from './helpers.js';
import type { Session } from '../../src/shared/types.js';

setupEnv();
const { Notifier, isTelegramToken, notificationText, readNotifyConfig, writeNotifyConfig } = await import('../../src/server/notify.js');
const { statSync } = await import('node:fs');
const { join } = await import('node:path');
const { paths } = await import('../../src/server/paths.js');

const session = (status: Session['status'], id = 'abcdefgh12') => ({
  id, projectId: 'p1', title: 'Phone access', status, config: { developer: 'codex' },
}) as unknown as Session;

const cfg = { telegram: { token: '123456:' + 'a'.repeat(35), chatId: '42' } };

describe('Notifier', () => {
  it('sends once per transition into a notify status, never for first sightings', async () => {
    const sent: string[] = [];
    const n = new Notifier(() => 'lina', async (_c, text) => { sent.push(text); }, () => cfg);
    n.onSession(session('awaiting_approval')); // first sighting (e.g. after a daemon restart)
    n.onSession(session('running'));
    n.onSession(session('running'));
    n.onSession(session('awaiting_approval'));
    n.onSession(session('awaiting_approval'));
    n.onSession(session('running'));
    n.onSession(session('failed'));
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain('“Phone access” is waiting for your approval.');
    expect(sent[0]).toContain('LINA · lina');
    expect(sent[0]).toContain('lina attach abcdefgh');
    expect(sent[1]).toContain('stopped with an error');
  });

  it('respects the configured events and does nothing without a channel', async () => {
    const sent: string[] = [];
    const only = new Notifier(() => undefined, async (_c, t) => { sent.push(t); }, () => ({ ...cfg, on: ['failed'] }));
    only.onSession(session('running')); only.onSession(session('completed')); only.onSession(session('failed'));
    const none = new Notifier(() => undefined, async (_c, t) => { sent.push(t); }, () => ({}));
    none.onSession(session('running')); none.onSession(session('failed'));
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('stopped with an error');
  });

  it('survives a failing channel', async () => {
    const n = new Notifier(() => undefined, async () => { throw new Error('boom'); }, () => cfg);
    n.onSession(session('running'));
    expect(() => n.onSession(session('completed'))).not.toThrow();
    await new Promise((r) => setImmediate(r));
  });
});

describe('notify config', () => {
  it('stores the token owner-only and validates token shape', () => {
    writeNotifyConfig(cfg);
    expect(readNotifyConfig()).toEqual(cfg);
    expect(statSync(join(paths.home, 'notify.json')).mode & 0o777).toBe(0o600);
    expect(isTelegramToken(cfg.telegram.token)).toBe(true);
    expect(isTelegramToken('nope')).toBe(false);
    expect(notificationText(session('completed'), undefined, 'completed')).toContain('Codex finished your request');
  });
});
