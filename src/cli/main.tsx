// `lina` entry point: argument parsing, command dispatch, and the interactive TUI.
import React from 'react';
import { render } from 'ink';
import { DEFAULT_SETTINGS, LINA_VERSION, type Session, type Settings } from '../shared/types.js';
import { bold, dim, fg } from './ansi.js';
import { ArgError, parseArgs, validateCommand, type ParsedArgs } from './args.js';
import { CliError, cmdAdd, cmdDaemon, cmdDoctor, cmdModels, cmdProjects, cmdSessions, cmdSettings, cmdUi, cmdPreview, connect, matchSession, resolveProject } from './commands.js';
import { cmdNotify } from './notify.js';
import { cmdTailscale } from './tailscale.js';
import { cmdHome } from './home.js';
import { clientFor } from './daemon-control.js';
import { helpText } from './help.js';
import { shortId } from './layout.js';
import { C } from './theme.js';
import { Root } from './tui/App.js';
import { loadInkInternals } from './tui/ink-internals.js';
import { installMouse } from './tui/mouse.js';
import { TuiStore, describeError } from './tui/store.js';
import { configFromFlags, gitRoot, openBrowser, webUrl } from './util.js';

function printError(msg: string, hint?: string) {
  process.stderr.write(`${fg(C.err)('✖')} ${msg}\n`);
  if (hint) process.stderr.write(dim(`  ${hint.replace(/\n/g, '\n  ')}`) + '\n');
}

async function runTui(a: ParsedArgs, cwd: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CliError('The interactive UI needs a terminal.', 'For scripts use `lina sessions`, `lina ui`, `lina doctor` … (see `lina --help`).');
  }
  const info = await connect();
  const client = clientFor(info);
  const settings: Settings = await client.getSettings().catch(() => DEFAULT_SETTINGS);
  const projects = await client.projects();
  let project = resolveProject(projects, a.global.project, cwd);

  let sessionId: string | undefined;
  if (a.command === 'attach') {
    const all = await client.sessions(project && !a.positionals[0] ? { projectId: project.id } : {});
    let target: Session | undefined;
    if (a.positionals[0]) target = matchSession(all, a.positionals[0]);
    else {
      const pool = all.length ? all : await client.sessions({});
      target = pool.sort((x, y) => y.updatedAt - x.updatedAt)[0];
      if (!target) throw new CliError('No sessions to attach to yet.', 'Start one with `lina "<task>"`.');
    }
    sessionId = target.id;
    project = projects.find((p) => p.id === target!.projectId) ?? project;
    const patch = configFromFlags(a.global, settings);
    if (Object.keys(patch).length) {
      try { await client.updateSession(sessionId, { config: patch }); } catch (e) { const d = describeError(e); printError(`Could not apply options to the session: ${d.text}`, d.hint); }
    }
  }

  const prompt = a.command === 'tui' && a.positionals.length ? a.positionals.join(' ') : undefined;
  let launch: { kind: 'register'; root: string } | { kind: 'picker'; intro?: string } | undefined;
  if (!project) {
    const root = gitRoot(cwd);
    launch = root ? { kind: 'register', root } : { kind: 'picker', intro: dim(`${cwd} is not inside a LINA project or git repository.`) };
  }

  await loadInkInternals();
  const store = new TuiStore(client, { project, settings, pendingConfig: configFromFlags(a.global, settings) }, (sid) => webUrl(info, sid));
  let quitting = false;
  const app = render(
    <Root store={store} cwd={cwd} launch={launch} initial={{ prompt, sessionId }} onQuit={() => { quitting = true; app.unmount(); }} openUrl={openBrowser} />,
    { exitOnCtrlC: false, alternateScreen: true, incrementalRendering: true, patchConsole: true, maxFps: 30 },
  );
  const restoreMouse = installMouse(process.stdin, process.stdout);
  try {
    await app.waitUntilExit();
  } finally {
    restoreMouse();
    store.dispose();
  }
  void quitting;
  const s = store.getState().view?.session;
  if (s) {
    const working = s.status === 'running' || s.status === 'paused';
    process.stdout.write(`${bold(fg(C.lina)('◆ LINA'))} ${dim('·')} ${s.title || 'session'} ${dim(`(${shortId(s.id)})`)}\n`);
    process.stdout.write(`${working ? 'Agents keep working' : 'The session is saved'} — ${fg(C.codex)(`lina attach ${shortId(s.id)}`)} to return, ${fg(C.codex)('lina ui')} to watch in the browser.\n`);
  } else {
    process.stdout.write(dim('Agents keep working — `lina attach` to return.') + '\n');
  }
}

export async function main(argv: string[]): Promise<number> {
  const cwd = process.cwd();
  let a: ParsedArgs;
  try {
    a = parseArgs(argv);
    if (a.version) { process.stdout.write(`lina ${LINA_VERSION}\n`); return 0; }
    if (a.help) { process.stdout.write(helpText()); return 0; }
    validateCommand(a);
  } catch (e) {
    if (e instanceof ArgError) { printError(e.message, e.hint); return 2; }
    throw e;
  }
  try {
    switch (a.command) {
      case 'tui': case 'attach': await runTui(a, cwd); break;
      case 'sessions': await cmdSessions(a, cwd); break;
      case 'projects': await cmdProjects(a, cwd); break;
      case 'add': await cmdAdd(a, cwd); break;
      case 'ui': await cmdUi(undefined, a.flags); break;
      case 'models': await cmdModels(a); break;
      case 'settings': await cmdSettings(a); break;
      case 'preview': await cmdPreview(a); break;
      case 'notify': await cmdNotify(a); break;
      case 'tailscale': await cmdTailscale(a); break;
      case 'home': await cmdHome(a); break;
      case 'doctor': await cmdDoctor(a); break;
      case 'daemon': await cmdDaemon(a); break;
      default: process.stdout.write(helpText());
    }
    return typeof process.exitCode === 'number' ? process.exitCode : 0;
  } catch (e) {
    if (e instanceof CliError) { printError(e.message, e.hint); return e.exitCode; }
    if (e instanceof ArgError) { printError(e.message, e.hint); return 2; }
    const d = describeError(e);
    printError(d.text, d.hint);
    if (process.env.LINA_DEBUG) console.error(e);
    return 1;
  }
}

// Run when executed as the entry (bundle or tsx), not when imported by tests.
const isEntry = (() => {
  const arg = process.argv[1] ?? '';
  return /(?:^|[/\\])(?:lina(?:\.js)?|main\.tsx?)$/.test(arg) || process.env.LINA_CLI_ENTRY === '1';
})();

if (isEntry) {
  // `lina sessions | head` closes the pipe early: exit quietly instead of crashing.
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (e: NodeJS.ErrnoException) => { if (e.code === 'EPIPE') process.exit(0); throw e; });
  }
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
      // `daemon run` keeps the loop alive on purpose. After the TUI, don't wait for idle
      // keep-alive sockets / reconnect timers.
      const cmd = process.argv.slice(2).find((x) => !x.startsWith('-'));
      if (cmd !== 'daemon') setTimeout(() => process.exit(code), 50).unref();
    },
    (e) => { printError((e as Error)?.message ?? String(e)); process.exit(1); },
  );
}
