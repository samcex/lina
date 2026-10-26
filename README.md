# ◆ LINA

LINA runs **OpenAI Codex** and **Claude Code** as one engineering team. One agent implements,
the other reviews like a demanding senior engineer. They disagree with evidence, revise, and
make and verify changes directly in your project. You can watch and steer from the terminal or the
browser, and both show the same live session.

```
lina                                # interactive terminal UI for the current project
lina "Add rate limiting to the API" # start a task right away
lina ui                             # same live sessions in the browser
```

## Install

```bash
git clone https://github.com/samcex/lina.git
cd lina
bash scripts/install.sh   # builds and installs ~/.local/bin/lina
export PATH="$HOME/.local/bin:$PATH"
lina doctor --live                     # verify CLIs, logins, models, sandbox
```

You need Node ≥ 22.5, git, and the `codex` and `claude` CLIs logged in. LINA uses their own
authentication, so it runs on your existing subscriptions and needs no API keys.

## Use LINA from your phone

For Termius SSH, save **Home** (the PC's LAN address) and **Away** (its Tailscale
hostname), using the same SSH identity. Install `scripts/lina-phone` as
`~/.local/bin/lina-phone` (also installed by `scripts/install.sh`) and run
`~/.local/bin/lina-phone` after connecting to either host. Create both hosts
manually with **Hosts → + → New Host**, reusing the existing SSH credentials;
no paid import, cloud sync or startup snippet is required. The dedicated tmux terminal keeps the selected
conversation, draft and scroll position across SSH disconnects; the new connection
replaces a stale phone client. It requires `tmux` on the PC. Termius needs a tap
on the matching saved host when Tailscale is off at home; the Android app below
selects its route automatically.

### Native Android app

Install [lina.apk](https://github.com/samcex/lina/releases/latest/download/lina.apk) on Android 8 or newer. The app has native conversation,
message, activity and connection screens; these work independently of Android System
WebView. **Menu → Connection** accepts the address from `lina tailscale on`, or the
localhost URL with its token from `lina ui --url` when using an SSH tunnel.
**Open web interface** provides the shared web interface as an optional advanced view.

Build the APK with `npm run build:android` (JDK 17+ and Android SDK 36), then run
`npm run build:web` to update the download served at `/lina.apk`. See
[android/README.md](android/README.md) for connection and build details.

On the host running LINA, run `lina ui --url` to print the access URL, or
`lina ui --qr` to print it as a terminal QR code. Neither opens a browser;
`--qr` also prints the URL for copying.

### Over Tailscale (no tunnel app, no token)

If the host and the phone are on the same tailnet (MagicDNS and HTTPS certificates
enabled), run on the host:

```bash
lina tailscale on --qr        # → https://<host>.<tailnet>.ts.net:7077/
```

Open the printed address in Chrome on the phone (Tailscale app connected), then
**Install app**. No token is needed: you are signed in by your Tailscale account.
`lina tailscale on` allows the account that owns the host; `--email you@example.com`
allows another login, and `--port N` picks another HTTPS port (ports already served are
refused). `lina tailscale` shows the status; `lina tailscale off` removes it.

`tailscale serve` (tailnet only, not Funnel) terminates HTTPS and proxies to the daemon's
owner-only unix socket `~/.lina/tailnet.sock`, setting `Tailscale-User-Login` itself.
LINA trusts that login **only on that socket**; the 127.0.0.1 port still requires the
token, so local programs cannot fake the identity. Anyone signed in to Tailscale as an
allowed account gets **full control of LINA**, including running code on the host.

### Home Wi-Fi with Tailscale off (native Android)

Enable the private home connection on the host:

```bash
lina home on                    # chooses the sole physical LAN IPv4 address
lina home on --host 192.168.1.100 # choose explicitly if there are several
lina home status                # shows the address and listener status
lina home off                   # stops home access without interrupting sessions
```

Open the native Android app over Tailscale once to pair. The app remembers the
home address, server identity, certificate pin and a private home credential, then
can connect over home Wi-Fi with the phone's Tailscale switched off. Pairing
survives daemon restarts. Home access is disabled until `lina home on` and binds
only the chosen physical interface's private IPv4 address, using HTTPS. It never
opens a wildcard listener or trusts a Tailscale identity header from the LAN.

Home credentials and TLS material live in the owner-only `~/.lina/home-access/`
directory, separate from settings. The home credential grants full control of
LINA. `lina home off` stops home connections; **Forget** on a phone removes only
that phone's saved connection and does not revoke a copied credential. Keep the
certificate and identity files when upgrading so paired phones remain connected.

### Over an SSH tunnel

On your Android phone, install Termux and open an SSH tunnel to that host:

```bash
ssh -N -L 7077:127.0.0.1:7077 user@host
```

The **local port must equal the daemon port**, because LINA validates the Host
header (and Origin). If the URL printed by LINA uses a port other than 7077,
replace **both** occurrences of 7077 in the command with that port. Keep the
printed `127.0.0.1` address: on the phone it reaches the tunnel, not the host's LAN IP.

Keep the Termux session running while using LINA. For automatic reconnection,
use `autossh` with the same forwarding arguments (for example
`autossh -M 0 -N -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L 7077:127.0.0.1:7077 user@host`).
Termux:Boot can start your tunnel script after a phone restart; configure SSH keys
and connect manually once first. Disable Android battery optimisation for Termux
and use `termux-wake-lock` if Android suspends the tunnel.

Open the printed URL, including `#token=…`, in Chrome on the phone. You can also
scan the QR code from another screen. After LINA loads, choose Chrome's
**Install app** (or **Add to Home screen → Install**) menu action. Launch the
installed app from its icon; the localhost token survives relaunch, and the
fragment is removed from the address bar. Use the same address and port on each
visit: `localhost` and `127.0.0.1` have separate browser storage. The SSH tunnel
must be running for live sessions, even though the app shell can load offline.

The daemon **stays bound to 127.0.0.1**. SSH provides authentication and encryption
between the phone and host; no public daemon listener is needed. The access token
saved in the phone's browser grants **full control of LINA**, including running
code on the host. Treat the URL and QR code as secrets. On a shared phone, use
**Settings → Forget this device** to remove the saved token from that browser.
This clears local access; it does not rotate the daemon token or revoke copies
saved elsewhere.

## Natural chat

### Terminal interface

The original colorful header, rounded agent cards and composer remain. Agent panels
show live response text, recent commands and their output on phones and wide terminals.
Tap a Codex or Claude panel to open its full activity; tap a command to expand its
recorded output and files. **[Back]** returns without losing the draft.
`/menu` or Ctrl+K with an empty composer opens navigation and tools. Ctrl+K while
typing still deletes to the end of the line.

Swipe/wheel or empty-composer arrows scroll. **[Read]** / **[Scroll]**, Ctrl+G or
`/scroll` lets you scroll while keeping a draft; Esc returns to writing. **[End]** /
**[Latest]** follows new messages again. The header shows connection and session
status; the composer keeps the send/newline hints close to the message.

Use **`/history`** to open saved conversations from all projects. **`/resume`**
resumes the current stopped session, or opens the saved-conversation picker.
**`/resume last`** reopens the most recent conversation directly; `/resume <id>`
accepts a session ID or unique prefix. Completed conversations reopen without
repeating their work. For older messages inside the open conversation, use
`/history earlier` or `/history <event number>`.

After updating, exit the old TUI with `/quit`, then run `~/.local/bin/lina-phone`
or `lina attach` to load the new view. Send or copy an unsent draft before exiting
that old process. Agent work continues in the daemon. Reconnecting to an existing
phone tmux pane otherwise restores that pane's already-running version.

New direct sessions use conversational chat. Ask a question and the developer answers it
without a forced planning/build/review cycle. Ask for code and it edits the project, runs
relevant checks, and can request independent review. Keep chatting to refine the result.
The selected team controls the default reviewers for coding changes. A developer can skip
unnecessary automated tests/review for small documentation edits; Lina records that decision. In chat,
reviewer replies automatically start a developer response, including approval notes and
minor feedback. Edits and claimed fixes go back through review within the round limit;
at the limit the final response is read-only. Direct `@developer` coding requests use
the same test/review loop. Simple acknowledgments do not start extra work or polling.

Requests addressing both agents also route proposals before file edits. For example,
`@claude Implement Remember Me, @codex review the plan before implementation` runs
proposal → reviewer approval → implementation → code review → developer response.
The developer can request a peer handoff for a proposal or question without waiting
for another user message. Rejected proposals remain read-only until approval, and
repeated proposal exchanges stop at the handoff limit.

When a provider hits a rate or usage limit, LINA automatically continues the same step
with the other provider, preserving partial edits and the current workspace. If both
are limited, it saves the pending step and resumes automatically after the earliest
provider reset. Reported reset timestamps and timezone-aware reset messages are honored;
unknown times use a bounded 5/10/20/40/60-minute backoff. The conversation shows the
next retry time.

Fallback work also receives a deferred independent review when the other provider
returns. Separate contributions remain queued if the providers trade roles. Reviewer
fallback stays read-only, and checks by the same provider that wrote the code are
labeled as self-review. Deferred reviews wait for an independent provider rather than
repeatedly self-reviewing. Scheduled retries/reviews and active fallback work survive
daemon restarts. Pause, Cancel and Undo stop automatic follow-ups; Resume re-enables
paused work. Normal review round limits and project permissions still apply.

Choose `lina --interaction workflow "…"` or **Structured workflow** in the new-session
options for the explicit playbook below. A direct session's **Chat / Workflow** header
button switches between these behaviors while idle. Isolated sessions retain the playbook.

## Goals in the terminal

Use `/goal <objective>` to start a dedicated structured task in the selected project.
The objective is saved with the conversation. LINA implements, tests and reviews it,
then independently checks the full objective and automatically continues remaining work.
Minor/nit findings, failed checks and review-format errors are repaired automatically;
review-round limits start another repair cycle. Only genuinely missing input or
external prerequisites pause the goal;
Usage-limit failover and scheduled recovery work as for other tasks.
Active goals also resume automatically after a daemon restart. `/goal` shows
its objective and status. `/goal status`, `/goal resume`, `/goal pause` and
`/goal cancel` also control the saved goal; they never create a new objective.
Use `/pause`, `/resume` and `/cancel` for the current conversation.
Completed goals display an independently verified completion status; remaining work
and pending independent reviews continue automatically without another message.
Explicit Pause/Cancel, project constraints and isolated-workspace approvals still apply.
Goals sharing a project queue durably and continue when it becomes available.
Before pausing for input, LINA checks a proposed blocker against the approved plan.
Routine diagnostics and bounded local repro attempts continue automatically. If
local investigation is exhausted and future evidence is needed, the goal schedules
an automatic recheck with a 15–60 minute backoff; Pause/Cancel stop that timer.
Only a specific fact, credential, scope decision or constraint override requiring
the owner pauses for input. The server rejects control words such as `resume` as
new objectives, including requests from older terminal versions.

## REA tools

To use an existing REA MCP registration from Codex or Claude Code:

```bash
lina settings set rea on
# Disable again: lina settings set rea off
```

This applies to both agents from their next turn. LINA inherits only the `rea`
server; other personal MCP servers and plugins stay disabled. In Full access, both agents get the
REA toolset. Restricted access uses static inspection tools,
including opening binaries/APKs and reading decompilation evidence. Target changes,
target execution, exports and REA settings writes stay outside that analysis profile. REA
launches with the daemon's Node runtime rather than a different version from a
shell PATH. For REA 6.8, use Node 22.23.4+, 24.22.1+ or 26.12.1+ in its supported
release lines. Enabling this setting does not install REA or analysis engines.

## Inspect and undo writing turns

In the web inspector's **Changes** tab, select a writing turn to inspect its exact diff,
then use **Undo turn**. In the terminal, use `/changes`, `/changes <turn>`, and `/undo [turn]`.
Undo restores that turn's previous project files and preserves the staging area and unrelated
edits. It refuses to overwrite later changes to the affected files. History survives restarts.
Cancelled/failed turns also retain any recorded changes. If a hard crash prevented the final
snapshot, Lina retains the initial snapshot but refuses to guess an automatic undo.

Undo covers tracked and non-ignored files in the project. It does not undo external service
side effects, database mutations, ignored artifacts, or changes outside the project.

## Persistent previews

Ask the developer to start a preview, or use the inspector's **Previews** tab. Preview servers
keep running between messages and daemon restarts. You can open the URL, inspect logs, and
stop the server. Deleting the session stops its previews.

```bash
lina preview start 'npm run dev -- --host 127.0.0.1 --port {port}' --session <session-id>
lina preview list --session <session-id>
lina preview logs <preview-id> --session <session-id>
lina preview stop <preview-id> --session <session-id>
```

`{port}` is replaced with a free local port, also available as PORT. Commands run in the
session's working directory and must stay in the foreground. Terminal chat also supports
`/preview`, `/preview start <command>`, `/preview logs <id>`, and `/preview stop <id>`.
Preview startup requires Full access and does not ask for permission. Existing servers are
reused when suitable; ask the developer to inspect the current previews before starting another.
URLs bind to localhost; for phone/remote use, forward the preview's port in your SSH tunnel.

## How a structured task flows (pair mode)

1. **Plan.** The developer drafts a short plan without touching files.
2. **Implement.** The developer edits your project directly. Changes appear immediately and stay uncommitted.
3. **Test.** LINA runs the project's tests itself and shows "verified by LINA", not the agent's claim.
4. **Review.** The reviewer works read-only. It inspects the real diff and returns structured findings
   (blocker / major / minor / nit, file:line).
5. **Revise.** The developer answers *every* finding: **fixed** or **disputed** with reasoning.
   The reviewer then confirms the fix, withdraws the finding, or maintains it.
6. **Loop**, bounded by `--max-rounds`. If a finding is disputed and maintained twice, or the same
   blocking set repeats, LINA escalates it to **you** instead of looping forever.
7. **Verify and summarize.** LINA reruns the tests and writes a summary from facts. This costs no
   extra tokens.
8. **Continue chatting.** The session finishes as **Completed**, with no approval or merge step.
   Send another message to continue working in the same project.

You can talk at any time. While agents work, your message is queued and delivered at the next
turn boundary. Use `/interrupt <msg>` to cut in immediately. `@codex …` and `@claude …` address
one agent directly.

## Workspace choices

New pair, architect, solo and custom sessions edit the project folder directly, including
existing uncommitted work as context. LINA leaves your branch, commit history and staging
area unchanged. Cancelling or deleting a session leaves edits in place. Only one direct
session can run in a project at a time.

Use `lina --workspace isolated "…"`, or select **Use an isolated workspace** in the web
new-session dialog, for the separate-copy workflow. These sessions create checkpoints and
wait for **Approve & squash**, **Merge**, **Branch only**, or **Reject**. Existing sessions
keep their original workspace behavior. Start a new session to use direct editing.

Parallel and compete sessions use isolated workspaces because each agent builds an
independent branch. They still require approval to apply the result.

## Modes

Pick a mode with `--mode`, `/mode` in the terminal UI, or the mode menu in the web header.

| Mode | What happens |
|---|---|
| `pair` (default) | One agent implements, the other reviews; they iterate as above. `--developer claude` swaps the roles. |
| `architect` | Like pair, but the reviewer critiques the plan before any code is written. |
| `solo` | One agent implements and LINA verifies the tests. No review. |
| `parallel` | The lead plans and splits the task into two parts. Both agents build their part **at the same time**, each in its own git worktree. LINA merges the branches; if they conflict, the lead resolves the conflicts and LINA checks that no markers remain. Each agent then reviews the other's part, and each fixes the findings on its own part. |
| `compete` | Both agents build the whole task independently in separate worktrees. LINA tests each version, and each agent reviews the other's. You get a side-by-side comparison (tests, diff size, findings, cost) and pick the winner: `/choose codex`, or `/approve claude squash` to pick and apply in one step. |
| `custom` | You choose who plans, who critiques the plan, who implements and who reviews, e.g. `--team plan=claude,critic=codex,dev=claude,review=codex+claude`. A developer can also review its own work, in a separate read-only session. |

`lina settings set team …` saves a default custom team, and `lina settings` shows all defaults.

## Models

Each agent's model is chosen independently: `--codex-model`, `--claude-model`, `/model` in the
TUI, or the selectors in the web header. `/model` and `/models` open the terminal picker
at your developer's current model. Tap an agent tab, optionally choose an effort,
then tap a model to apply it and return to your conversation. You can also use
arrows and Enter. `/` or **Search** filters the list; Esc clears the search.
`/models claude` and `/models codex` open an agent directly. For a quick change,
use `/model claude sonnet` or `/models codex <model-id> high`.
Changes apply next turn in the current conversation, or to the next conversation
if none is open. `lina models set` saves defaults across conversations.

The available models come from the providers themselves:

* **Codex** comes from `codex debug models`, the official catalog for your account.
* **Claude** comes from the aliases documented by `claude --help` (opus, sonnet, haiku, fable),
  plus models observed in real runs, plus any custom id you type.

Nothing is marked available until a live probe succeeds (`lina models validate …` or the
**Validate** button). A model change applies from the next turn. `lina models set` saves your
defaults.

## Safety model

* **Workspaces.** Direct sessions edit your repository and leave changes uncommitted.
  Isolated sessions get a clone in `~/.lina/workspaces/<id>` with its git remote **removed**.
  Their results are applied on approval; squash and merge refuse to run over uncommitted work.
* **Full access (default).** Both agents and LINA's tests run with your user account's
  filesystem, command and network permissions, without permission prompts. Codex uses
  `--yolo` with `danger-full-access` and `approval_policy=never`; Claude uses
  `--dangerously-skip-permissions` with its OS sandbox disabled. This applies to both new and existing sessions from the next turn.
  This includes planning, review and resumed turns. Reviewer instructions retain independent
  review responsibilities; Full access does not enforce a read-only runtime.
* **Access settings.** Choose **Settings → Developer access → Restricted**, or run
  `lina settings set access restricted`, to use the previous provider sandboxes and command
  restrictions. `lina settings set access full` restores full access. In Restricted mode,
  Codex uses `workspace-write`, session settings control network access, and the Claude/test
  sandbox settings apply. Full access takes precedence over those sandbox/network settings.
* **Restricted-mode tests.** LINA can use bubblewrap, with a read-only filesystem except the
  workspace and private `/tmp`. With `testSandbox: auto`, it falls back to an unsandboxed run
  when bubblewrap is unavailable; the run is labelled accordingly.
* **Isolated workspace git protection.** Git commands LINA runs in an isolated workspace ignore hooks and
  fsmonitor. LINA also refuses to run git there if `.git` was swapped for a link to another repo.
  `.git/config` is sealed when the workspace is created and restored after every agent turn, so an
  agent can't plant filters, diff drivers or `include.path` for LINA to execute.
* **Personal customizations stay out.** Your personal Claude plugins, hooks, skills and MCP
  servers are excluded from agent runs; the project's own CLAUDE.md is kept. Codex runs with
  your MCP servers and plugins disabled, except explicitly enabled REA above. This saves tokens and avoids side effects.
* **Daemon access.** It listens on 127.0.0.1 only, with a bearer token in
  `~/.lina/daemon.json` (mode 0600), plus Host and Origin checks.
* **Redaction.** Logs and stored tool output pass through a secret redactor.
* **Timeouts.** Turns have a total timeout (30 min) and an idle timeout (10 min). Cancelling
  kills the agent's whole process group.
* **Activity labels.** Each item is either **Observed** (a real tool, git or test event) or
  **Said** (the agent's own words). Hidden reasoning is never shown.

## Architecture

TypeScript on Node 22, with one daemon and two clients. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

```
src/shared   contract: types, REST/WS protocol, client, event reducer (used by both UIs)
src/server   daemon: SQLite event log (node:sqlite + FTS5), git isolation, runner, HTTP/WS
src/server/agents   Claude Code + Codex drivers (stream parsers), models, doctor, mock agent
src/cli      `lina` command + Ink terminal UI
web          React web UI (served by the daemon)
```

Every state change is an append-only event. Clients replay from a cursor, then stream live.
That is why the terminal and the browser always agree, and why a session survives a daemon
restart: it comes back `interrupted`, and `/resume` continues it.

## Development

```bash
npm test            # vitest: unit + integration (mock agents)
LINA_LIVE=1 npx vitest run test/agents/live.test.ts   # real CLI checks (uses tokens)
npm run build       # dist/lina.js + dist/web
npm run verify:ui   # rendered controls, DOM interaction and asynchronous UI regressions
npm run verify:cli  # actual 80×24 terminal, isolated mock daemon and restart recovery
npm run build:android
npm run verify:android -- --serial emulator-5562  # disposable booted emulator; resets Lina app data
lina --mock "…"     # scripted demo agents, no tokens
```

The release is checked with unit/integration tests, TypeScript checks and production builds.

## Known limitations (v0.1)

* **Claude sandbox in Restricted mode.** Claude's OS sandbox depends on bwrap/user namespaces. Run
  `lina doctor --live`; if it fails, Claude falls back to the permission deny-list. Idle autofs
  mounts (e.g. `/mnt/network-share`) can make bwrap fail; LINA reports this as a `sandbox` error.
* **Restricted-mode tests may run unsandboxed.** This happens when bubblewrap can't start on this machine; the run is
  labelled. A sandboxed test can't write to `$HOME` caches outside `/tmp` (npm, Go and pip caches are
  redirected there). Set `testSandbox: off` if a project's tests need more.
* **Use managed previews for dev servers.** Other background children of an agent still stop
  at turn end; `lina preview` processes have their own lifetime and explicit stop controls.
* **Codex's sandbox and Node tests.** In Codex's own sandbox, `node --test` can't report from its per-file
  subprocesses, so test files may show as passing or failing without having run. LINA tells developers to
  use `--experimental-test-isolation=none`, and LINA's verification runs in its own sandbox, which doesn't
  have this problem.
* **Worktrees and git in tests.** In parallel and compete, sandboxed test runs inside an agent's worktree
  can't see the shared git directory, so tests that call `git` there fail. Tests in the session workspace
  are not affected.
* **Integration conflicts.** Parallel conflicts are resolved by the lead agent. If markers remain, LINA aborts
  the merge and the session stops at a failed step for you to retry; it never commits markers.
