import { MODE_DESCRIPTION, MODE_LABEL } from '../shared/reducer.js';
import { LINA_VERSION } from '../shared/types.js';
import { bold, dim, fg, padAnsi, wrapAnsi } from './ansi.js';
import { CLI_MODES } from './args.js';
import { TEAM_SPEC_EXAMPLE } from './team.js';
import { C } from './theme.js';

/** One block per mode: name, label and the shared description (wrapped under the name). */
export function modeHelpLines(width = 100, indent = '  '): string[] {
  const nameW = 11;
  const out: string[] = [];
  for (const m of CLI_MODES) {
    const body = wrapAnsi(`${bold(MODE_LABEL[m])} — ${MODE_DESCRIPTION[m]}`, Math.max(30, width - indent.length - nameW));
    body.forEach((l, i) => out.push(indent + (i === 0 ? padAnsi(fg(C.lina)(m), nameW) : ' '.repeat(nameW)) + l));
  }
  return out;
}

export function helpText(): string {
  const h = (s: string) => bold(fg(C.lina)(s));
  const c = (s: string) => fg(C.codex)(s);
  const k = (s: string) => fg(C.claudeSoft)(s);
  return `${bold(fg(C.lina)('◆ LINA'))} ${dim(`v${LINA_VERSION}`)} — Codex + Claude Code, working as one team

${h('Usage')}
  ${c('lina')}                              Open the interactive terminal UI for this project
  ${c('lina')} "Build a modern dashboard"   Start a new session with that task right away
  ${c('lina attach')} [sessionId]           Re-open a session (most recent if omitted)
  ${c('lina sessions')} [--all]             List sessions of this project (--all: every project)
  ${c('lina projects')}                     List registered projects
  ${c('lina add')} <path> [--create] [--init-git] [--name <n>]
                                    Register a directory (--create makes it, --init-git runs git init)
  ${c('lina ui')}                           Open the web UI in your browser (same live sessions)
  ${c('lina preview')} start "<command>" --session <id> [--port N]
                                    Start a persistent dev server ({port} is a free local port)
  ${c('lina preview')} list|logs|stop [previewId] --session <id>
                                    Inspect previews, read logs, or stop a managed server
  ${c('lina tailscale')} on [--port N] [--email you@…] [--qr] | off | status
  ${c('lina home')} on [--host LAN_IP] [--port N] | off | status [--json]
                                    Phone app over your tailnet: HTTPS, signed in by your Tailscale account
  ${c('lina notify')} setup telegram | test | events <list> | off
                                    Telegram message when a session needs you (approval, done, failed)
  ${c('lina ui --url')}                     Print the access URL without opening a browser
  ${c('lina ui --qr')}                      Print the access URL and a terminal QR code
  ${c('lina models')} [--refresh]           Show the models each agent can use
  ${c('lina models validate')} <codex|claude> <model>     Probe a model with a tiny live request
  ${c('lina models set')} <codex|claude> <model> [--effort low|medium|high|xhigh|max]
                                    Set the default model (and effort) for an agent
  ${c('lina settings')} [--json]          Show the defaults for new sessions (mode, team, sandboxes…)
  ${c('lina settings set')} <key> <value>   access (full|restricted) | mode | developer | max-rounds | team | test-sandbox | claude-sandbox
  ${c('lina doctor')} [--live]              Check CLIs, auth, sandbox, git (--live runs real probes)
  ${c('lina daemon')} start|stop|restart|status|run|logs [-f] [-n N]
                                    Manage the background daemon (agents keep running in it)

${h('Session options')} ${dim('(for lina, lina "<task>", lina attach)')}
  --project <path>        Use this registered project instead of the one containing $PWD
  --developer codex|claude  Which agent implements (the lead in parallel); the other one reviews
  --workspace direct|isolated  Edit the project directly (default), or work separately and approve
  --interaction chat|workflow  Natural conversation (direct default), or the structured playbook
  --mode <mode>           pair | architect | solo | parallel | compete | custom (see Modes below)
  --team <spec>           custom mode: who plans, critiques, builds and reviews (implies --mode custom)
                          e.g. ${TEAM_SPEC_EXAMPLE}
                          plan/critic: codex|claude|none · dev: codex|claude · review: codex, claude, codex+claude, none
  --max-rounds N          Review rounds before escalating to you (1–20)
  --codex-model <id>      e.g. gpt-6.1-sol        --codex-effort low|medium|high|xhigh|max
  --claude-model <id>     e.g. opus, sonnet        --claude-effort low|medium|high|xhigh|max
  --mock                  Scripted demo agents (no real Codex/Claude calls); badged in the UI
  -h, --help              Show this help          -v, --version   Show the version

${h('Modes')}
${modeHelpLines(100).join('\n')}

${h('In the TUI')}
  Enter send · Alt+Enter / Ctrl+J newline · ↑/↓ history · Tab completes ${k('@codex')} ${k('@claude')} and /commands
  /new /sessions /project /model /models /roles /mode /team /live /diff /changes /undo /preview /findings /tests /choose /approve /reject
  /pause /resume /cancel /retry /review /interrupt /ui /doctor /help /quit
  Compete: /diff codex|claude compares the versions · /choose <agent> picks one · /approve <agent> [strategy] picks and applies
  Ctrl+C cancel turn (twice to quit) · Ctrl+P pause/resume · Ctrl+T live · Ctrl+D diff · Ctrl+F findings
  Ctrl+O web UI · Ctrl+L sessions · Wheel/PgUp/PgDn scroll · F1 or ? help · Esc close

${dim('Quitting the TUI never stops the agents — they keep working in the daemon. `lina attach` to return.')}
${dim('Data lives in ~/.lina (override with LINA_HOME). Daemon port: 7077 (LINA_PORT).')}
`;
}
