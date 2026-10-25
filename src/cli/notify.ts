// `lina notify`: set up and test phone notifications (Telegram). Works without the daemon; the daemon
// rereads ~/.lina/notify.json for every message, so changes apply immediately.
import { createInterface } from 'node:readline';
import {
  NOTIFY_EVENTS, isTelegramToken, readNotifyConfig, sendNotification, telegramBotName, telegramFindChat, writeNotifyConfig,
  type NotifyOn,
} from '../server/notify.js';
import { bold, dim } from './ansi.js';
import type { ParsedArgs } from './args.js';
import { CliError } from './commands.js';

const out = (s = '') => process.stdout.write(s + '\n');

const EVENT_LABEL: Record<NotifyOn, string> = {
  awaiting_approval: 'waiting for your approval', completed: 'done with a request', failed: 'stopped by an error',
};

async function readToken(given?: string): Promise<string> {
  const fromEnv = process.env.LINA_TELEGRAM_TOKEN;
  let token = (given ?? fromEnv ?? '').trim();
  if (!token) {
    if (!process.stdin.isTTY) token = (await new Promise<string>((r) => { let d = ''; process.stdin.on('data', (c) => { d += c; }).on('end', () => r(d)); })).trim();
    else {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      token = (await new Promise<string>((r) => rl.question('Bot token from @BotFather: ', r))).trim();
      rl.close();
    }
  }
  if (!isTelegramToken(token)) throw new CliError('That does not look like a Telegram bot token', 'It looks like 123456789:AA… — get it from @BotFather (/newbot or /token).');
  return token;
}

export async function cmdNotify(a: ParsedArgs) {
  const [action = 'status', ...rest] = a.positionals;
  const cfg = readNotifyConfig();
  switch (action) {
    case 'setup': {
      if (rest[0] && rest[0] !== 'telegram') throw new CliError(`Unknown channel: ${rest[0]}`, 'Only telegram is supported: lina notify setup telegram');
      const token = await readToken(rest[1]);
      const bot = await telegramBotName(token).catch((e: Error) => { throw new CliError(e.message, 'Check the token with @BotFather.'); });
      const chat = await telegramFindChat(token);
      if (!chat) throw new CliError(`${bot} has no messages yet`, `Open ${bot} in Telegram, send it any message (e.g. "hi"), then run this again.`);
      const next = { ...cfg, telegram: { token, chatId: chat.chatId, chatName: chat.chatName } };
      await sendNotification(next, `✅ LINA notifications are on. You'll get a message here when a session is ${NOTIFY_EVENTS.map((e) => EVENT_LABEL[e]).join(', ')}.`);
      writeNotifyConfig(next);
      out(`${bold('✔ Telegram notifications are on')} — ${bot} → ${chat.chatName}. A test message was sent.`);
      out(dim('Stored in ~/.lina/notify.json (owner-only). `lina notify off` turns them off.'));
      return;
    }
    case 'test':
      if (!cfg.telegram) throw new CliError('Notifications are not set up', 'lina notify setup telegram');
      await sendNotification(cfg, '🔔 Test message from LINA.');
      out('✔ Sent a test message.');
      return;
    case 'off':
      writeNotifyConfig({ ...cfg, telegram: undefined });
      out('✔ Notifications are off (the bot token was removed).');
      return;
    case 'events': {
      const list = (rest[0] ?? '').split(',').map((s) => s.trim()).filter(Boolean) as NotifyOn[];
      const bad = list.filter((e) => !NOTIFY_EVENTS.includes(e));
      if (!list.length || bad.length) throw new CliError(`Unknown event: ${bad[0] ?? '(none)'}`, `Choose from ${NOTIFY_EVENTS.join(', ')} — e.g. lina notify events awaiting_approval,failed`);
      writeNotifyConfig({ ...cfg, on: list });
      out(`✔ Notifying when a session is ${list.map((e) => EVENT_LABEL[e]).join(', ')}.`);
      return;
    }
    case 'status':
      if (!cfg.telegram) { out('Notifications are off. Set them up with: lina notify setup telegram'); return; }
      out(`Telegram → ${cfg.telegram.chatName ?? cfg.telegram.chatId}`);
      out(`When a session is ${(cfg.on ?? NOTIFY_EVENTS).map((e) => EVENT_LABEL[e]).join(', ')}.`);
      return;
    default:
      throw new CliError(`Unknown notify command: ${action}`, 'lina notify [status] | setup telegram [token] | test | events <list> | off');
  }
}
