// Phone notifications (Telegram) when a session needs the owner: awaiting approval, finished, or failed.
// Config lives in ~/.lina/notify.json (mode 0600), not in Settings, so the bot token never reaches
// /api/settings or the web UI. The token is part of every Bot API URL, so errors are scrubbed of it.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_LABEL, type Session } from '../shared/types.js';
import { log } from './log.js';
import { paths } from './paths.js';

export type NotifyOn = 'awaiting_approval' | 'completed' | 'failed';
export const NOTIFY_EVENTS: NotifyOn[] = ['awaiting_approval', 'completed', 'failed'];

export interface NotifyConfig {
  telegram?: { token: string; chatId: string; chatName?: string };
  /** Session statuses that trigger a message. Default: all of NOTIFY_EVENTS. */
  on?: NotifyOn[];
}

const configFile = () => join(paths.home, 'notify.json');

export function readNotifyConfig(): NotifyConfig {
  try { return JSON.parse(readFileSync(configFile(), 'utf8')) as NotifyConfig; } catch { return {}; }
}

export function writeNotifyConfig(cfg: NotifyConfig): void {
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  const tmp = `${configFile()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, configFile());
  chmodSync(configFile(), 0o600);
}

export function isTelegramToken(t: string): boolean { return /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/.test(t); }

/** Calls the Telegram Bot API. Never lets the token (part of the URL) into an error message. */
async function telegram<T>(token: string, method: string, body?: Record<string, unknown>): Promise<T> {
  const scrub = (s: string) => s.split(token).join('<token>');
  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new Error(`Telegram is unreachable: ${scrub(e instanceof Error ? e.message : String(e))}`);
  }
  const data = await res.json().catch(() => ({})) as { ok?: boolean; result?: T; description?: string };
  if (!res.ok || !data.ok) throw new Error(`Telegram ${method} failed: ${scrub(data.description ?? `HTTP ${res.status}`)}`);
  return data.result as T;
}

/** The chat of the most recent message sent to the bot (the owner messages the bot once during setup). */
export async function telegramFindChat(token: string): Promise<{ chatId: string; chatName: string } | undefined> {
  type Update = { message?: { chat: { id: number; type: string; username?: string; first_name?: string; title?: string } } };
  const updates = await telegram<Update[]>(token, 'getUpdates');
  const chat = updates.map((u) => u.message?.chat).filter((c) => c && c.type === 'private').pop();
  return chat ? { chatId: String(chat.id), chatName: chat.username ? `@${chat.username}` : chat.first_name ?? chat.title ?? String(chat.id) } : undefined;
}

export async function telegramBotName(token: string): Promise<string> {
  return `@${(await telegram<{ username: string }>(token, 'getMe')).username}`;
}

export async function sendNotification(cfg: NotifyConfig, text: string): Promise<void> {
  if (!cfg.telegram) throw new Error('No notification channel is set up');
  await telegram(cfg.telegram.token, 'sendMessage', { chat_id: cfg.telegram.chatId, text, disable_web_page_preview: true });
}

export function notificationText(s: Session, project: string | undefined, status: NotifyOn): string {
  const where = project ? ` · ${project}` : '';
  const what = status === 'awaiting_approval' ? 'is waiting for your approval.'
    : status === 'failed' ? 'stopped with an error.'
      : `is done — ${AGENT_LABEL[s.config.developer]} finished your request.`;
  return `LINA${where}\n“${s.title}” ${what}\nOpen it: lina attach ${s.id.slice(0, 8)}`;
}

/**
 * Watches session.updated events and sends one message per transition into a notify status.
 * Sessions seen for the first time are only recorded, so a daemon restart does not re-announce old states.
 */
export class Notifier {
  private last = new Map<string, string>();

  constructor(
    private projectName: (projectId: string) => string | undefined,
    private send: (cfg: NotifyConfig, text: string) => Promise<void> = sendNotification,
    private config: () => NotifyConfig = readNotifyConfig,
  ) {}

  onSession(s: Session): void {
    const prev = this.last.get(s.id);
    this.last.set(s.id, s.status);
    if (prev === undefined || prev === s.status) return;
    if (!NOTIFY_EVENTS.includes(s.status as NotifyOn)) return;
    const cfg = this.config();
    if (!cfg.telegram || !(cfg.on ?? NOTIFY_EVENTS).includes(s.status as NotifyOn)) return;
    this.send(cfg, notificationText(s, this.projectName(s.projectId), s.status as NotifyOn))
      .catch((e: unknown) => log.warn(`notification for session ${s.id} failed: ${e instanceof Error ? e.message : String(e)}`));
  }

  forget(sessionId: string): void { this.last.delete(sessionId); }
}
