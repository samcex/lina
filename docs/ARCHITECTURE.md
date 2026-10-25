# LINA — Architecture

LINA coordinates real coding agents (OpenAI Codex CLI, Anthropic Claude Code) that work
together like a small engineering team: one implements, one reviews, they argue with
evidence, and edits appear directly in the project by default.

## Big picture

```
 ┌──────────── lina (Ink TUI) ───┐      ┌──── Browser (React SPA) ────┐
 │ LinaClient (src/shared/client)│      │ LinaClient (same file)      │
 └──────────────┬────────────────┘      └─────────────┬───────────────┘
                │ REST + WebSocket (127.0.0.1, bearer token)          │
 ┌──────────────┴──────────────────────────────────────┴──────────────┐
 │ linad — daemon (src/server)                                        │
 │  http.ts/ws ── api routes ── SessionManager ── Runner (playbooks)  │
 │                  │                │                 │              │
 │            EventStore (SQLite + FTS5, append-only)   AgentAdapters │
 │                  │                                  claude / codex │
 │            git workspaces (~/.lina/workspaces/<session>)   / mock  │
 └────────────────────────────────────────────────────────────────────┘
```

* **One daemon, many clients.** `lina` auto-starts the daemon (detached) if
  `~/.lina/daemon.json` is missing/stale. Agents keep running when the TUI closes. The web UI
  is served by the daemon itself at `http://127.0.0.1:<port>/`.
* **Event-sourced sessions.** Every observable fact is an event (`src/shared/types.ts`,
  `EventDataMap`). Persisted events get a per-session monotonic `seq`. Clients fetch a
  snapshot then stream live events; on reconnect they resubscribe with `since=<lastSeq>`.
  Both UIs fold events with the same pure reducer (`src/shared/reducer.ts`), so the
  TUI and the GUI can never disagree.
* **Observed vs narrated.** Activity events carry `source: 'observed'` when they come
  from a real process event (tool call JSON from the CLI stream, LINA-run tests, git) and
  `'narrated'` when they are words the agent wrote. UIs must render them differently.
  LINA never invents activity, and never exposes hidden reasoning (thinking blocks are
  dropped; only a "thinking" status is shown).

## Runtime layout

| Path | Purpose |
|---|---|
| `~/lina` | source + build (`dist/lina.js`, `dist/web/`) |
| `~/.local/bin/lina` | symlink to `~/lina/bin/lina` |
| `~/.lina/` (`LINA_HOME` overrides) | data dir, mode 0700 |
| `~/.lina/lina.db` | SQLite (node:sqlite) |
| `~/.lina/daemon.json` | `{pid, port, token, version, startedAt}` mode 0600 |
| `~/.lina/daemon.log` | daemon log (redacted) |
| `~/.lina/workspaces/<sessionId>/` | isolated git clone per session |
| `~/.lina/attachments/<sessionId>/` | uploaded files |

Default port 7077 (`LINA_PORT` overrides; if busy, pick a free port and record it).

## Agents (src/server/agents)

Both providers are driven through their official CLIs so the user's existing
subscriptions/auth are used. Prompts are passed on **stdin** (Claude's `--allowedTools`
is variadic and would swallow a positional prompt).

**Claude Code** — `claude -p --output-format stream-json --verbose --include-partial-messages
--model <m> [--effort <e>] [--resume <session_id>] --permission-prompts none
--strict-mcp-config --append-system-prompt <role>`
* developer: `--permission-mode acceptEdits`, Bash allowed, deny-list
  (`Bash(git push:*)`, `Bash(git remote:*)`, `Bash(sudo:*)`, …); OS sandbox
  (`--settings {"sandbox":{"enabled":true,...}}`) when `lina doctor` confirmed bwrap works.
* reviewer: `--tools Read,Grep,Glob,Bash` with only read-only Bash patterns allowed
  (`git diff/log/show/status`, `ls`); everything else denied (no prompts in -p mode).
* stream: `system/init` (session_id, model), `stream_event` text deltas,
  `assistant` (text / tool_use blocks), `user` (tool_result), `rate_limit_event`
  (subscription utilization windows), `result` (`is_error`, `api_error_status`, usage,
  `total_cost_usd`). Fixture: `test/fixtures/claude-stream.jsonl`.

**Codex** — `codex exec --json -s workspace-write|read-only -m <m>
-c model_reasoning_effort=<e> -C <cwd> -c sandbox_workspace_write.network_access=<bool> -`
and `codex exec resume <thread_id> --json … -` (resume has no -s/-C: use `-c sandbox_mode=…` and
process cwd). **Always pass the sandbox explicitly**: the user's global config is
`danger-full-access`. Stdin must be provided/closed.
* stream: `thread.started`, `turn.started`, `item.started|completed` with item types
  `command_execution` (command, aggregated_output, exit_code), `file_change` (changes[]),
  `agent_message` (text), `reasoning` (dropped), `error`; `turn.completed` (usage),
  `turn.failed`. Fixtures: `test/fixtures/codex-exec*.jsonl`.
* model catalog: `codex debug models` (JSON `{models:[{slug, display_name, visibility,
  supported_reasoning_levels, default_reasoning_level, priority}]}`; show `visibility=="list"`).

**Mock** (`mock.ts`) — deterministic scripted agent that really edits files in the
workspace; used by tests and by `LINA_MOCK=1` demo mode. Mock sessions are flagged
`session.mock = true` and visibly badged in both UIs.

## Developer access

`Settings.accessMode` defaults to `full`, independently of workspace placement. Each write
turn receives `fullAccess: true` and `network: true`; Codex explicitly uses
`danger-full-access` plus `approval_policy=never` on both new and resumed turns. Claude uses
`--dangerously-skip-permissions`, explicitly disables its OS sandbox and includes its web
tools, without LINA's restricted command allow/deny lists. LINA's test runner also skips
bubblewrap in full mode. Review turns never receive full access: Codex remains read-only,
and Claude retains its read-tool allow-list and edit denials.

`lina settings set access restricted` (or Settings → Developer access) restores restricted
launches. Sandbox/network settings take effect in restricted mode. Access changes are global
and apply to the next turn/test in existing and new sessions; active subprocesses keep the
permissions they were launched with. Full access uses the daemon's OS user, without granting
root or changing system permissions. Provider integrations remain separately configured.

## Conversational turns, history and previews

Direct sessions default to `interactionMode: chat`; isolated sessions use `workflow`.
The `chat` runner step sends the current message to the developer's resumed conversation.
Before/after snapshots establish whether files actually changed. An ordinary answer ends
at `completed`; changes enter test/review/verify according to the selected team and optional
`lina-chat` disposition (`test`, `review` booleans). Review compares against the current
request's initial snapshot, including partial edits left by interruption. Plain queued
messages start the next chat request; explicitly interrupted messages steer the current one.

`TurnHistory` persists per-write-turn records in the v3 `turn_changes` table. Git objects
are pinned under `refs/lina/turns/<session>/<turn>/{before,after}`. Snapshots never touch HEAD
or the real index, and retain raw file bytes/modes rather than applying clean/EOL filters.
Undo rejects later edits to affected paths and leaves unrelated files and index state alone.
Incomplete after-snapshots cannot be auto-undone. Undo invalidates cached verification and
informs the next developer turn that prior summaries no longer describe the working files.

`PreviewManager` stores independently owned process groups in the v3 `previews` table.
Stdout/stderr point to per-preview log files, stdin is ignored, and children are detached and
unrefed. Provider group cleanup remains unchanged. Process start identity is saved and checked
before signalling; stop uses TERM then KILL for stubborn descendants. Daemon shutdown releases
monitoring without stopping previews; session deletion stops and removes them. TCP readiness
marks the advertised local port running, and logs are redacted/capped when returned to clients.
Preview startup uses Full access only; `lina preview` and the inspector expose lifecycle controls.

## Workspace lifecycle

`SessionConfig.workspaceMode` is `direct` by default for new team sessions. `workspacePath`
then points to the project directory. Direct sessions never checkpoint or apply a branch:
verification ends at `done`, with status/phase `completed`, and further messages start a
revision cycle using the same provider conversations. Test results are rerun after writing
and during final verification because HEAD does not change.

A dirty initial working tree is snapshotted using a temporary Git index and `commit-tree`;
HEAD and the real index remain untouched. A private `refs/lina/baselines/<sessionId>` ref
retains the baseline across GC/restarts, and is removed on session deletion. Diffs, review
prompts and summaries compare this baseline with current files, including untracked files.
Existing owner edits are excluded from that comparison. Direct session deletion removes
session data and the baseline ref, never the project or its edits. Direct project config is
not sealed/restored. The manager prevents concurrent direct sessions in the same project.

`workspaceMode: isolated` retains the clone/checkpoint/approval workflow. Missing values in
persisted legacy configs mean isolated. Parallel/compete sessions default to isolated and
reject direct mode. Workspace mode cannot change after session creation.

## Isolation & safety (isolated sessions)

* Each isolated session works in `~/.lina/workspaces/<id>`: `git clone --local` of the project at
  its HEAD, branch `lina/<shortid>`, **origin remote removed** (nothing to push to),
  local `.git/info/exclude` for heavy dirs (node_modules, .venv, …). LINA commits a
  checkpoint after every writing turn — agents never need to commit.
* The user's repo is only touched on explicit approval:
  `squash` | `merge` | `branch` (just creates `lina/<id>` in the project). Squash/merge
  refuse if the user's working tree is dirty; conflicts abort cleanly and leave the branch.
* Only one agent writes to a given worktree at a time; reviewers are read-only. parallel/compete give each
  agent its own git worktree, so concurrent writers never share files.
* No push, no deploy, ever. Workspace deletion only on explicit session delete.
* Secrets: daemon log and persisted outputs pass through `redact()`; token file 0600;
  127.0.0.1 only; Host/Origin checks.
* Timeouts: per-turn (default 30 min) and idle (no output, default 10 min); process
  groups are killed (SIGTERM → SIGKILL).

## Collaboration (Runner / playbooks)

`pair` (Developer + Reviewer) steps, persisted after every step so a crash/restart
can resume (`status=interrupted` → `resume`):

1. **planning** – developer, read-only: short plan.
2. **plan_review** (architect mode only) – reviewer critiques the plan; developer gets the critique.
3. **implementing** – developer, write. Checkpoint commit in isolated sessions only.
4. **testing** – LINA runs the test command itself (configured or auto-detected).
5. **reviewing** – reviewer, read-only, returns prose + a fenced ```` ```lina-review ```` JSON block:
   `{verdict, summary, findings:[{id?, severity, title, detail, file?, line?, suggestion?}], resolved:[ids], withdrawn:[{id, reason}]}`.
6. **revising** – developer answers every open finding with a ```` ```lina-response ```` block
   `{items:[{id, action: fixed|disputed|deferred, note}]}` and edits code. Tests run again; isolated sessions also checkpoint.
7. Loop 5–6 until no open blocker/major findings, or `maxRounds` reached.
   A finding disputed by the developer and maintained by the reviewer twice becomes
   **escalated** – the human decides (no infinite loops). Same open-finding set two rounds
   in a row also escalates.
8. **verifying** – final test run, summary composed by LINA from facts (no extra LLM call).
9. **completed** in direct sessions: edits are already present; another message continues the work.
   Isolated sessions enter **awaiting_approval**: human approves (apply), requests changes
   (any message → revision cycle), or rejects.

User messages while running are queued and prepended to the next agent prompt
("Message from the project owner: …"); `interrupt: true` cancels the current turn and
re-runs it with the message. `@codex …` / `@claude …` address one agent directly
(a consult turn with that agent's role permissions).

`solo` = developer only (implement → test → verify → approval).

## Modes v2: custom, parallel, compete

All six modes run in the same `SessionRunner` state machine. The shared contract is in
`src/shared/types.ts` (`TeamConfig`, `teamOf`, `WorkPart`, `Variant`, `Candidate`, the `split` /
`integration` / `session.deleted` events, `variant`/`owner` fields) and `pipelineFor()` in the reducer.

### Common machinery

* **Team pipeline.** `pair`, `architect`, `solo` and `custom` are one pipeline driven by `teamOf(config)`:
  plan (planner, if any) → plan review (planCritic, if any) → implement (developer) → test →
  review (each reviewer, concurrently, read-only) → revise (developer) → … → verify → approval.
* **Provider sessions are keyed by agent + role + worktree** (`codex:developer@main`,
  `claude:reviewer@codex`, …). One agent can hold several roles (a self-reviewing developer in custom
  mode, a competitor that also reviews its rival) without resuming the wrong conversation. Claude
  stores sessions per cwd, so a session from one worktree is never resumed in another.
  Older persisted state, keyed by agent only, is migrated on load.
* **Concurrent turns.** Steps that involve both agents (compete implement/revise/review, parallel
  implement, multi-reviewer review) run their turns concurrently with `Promise.allSettled`. Every turn
  has its own AbortController; pause/cancel/interrupt/shutdown apply to all of them. If one turn
  fails, the others finish. LINA records which agents completed the step (`state.done`), so a retry
  re-runs only the failed ones. Agent status shows "waiting" only for an agent with no turn of its own.
* **Several reviewers.** Each reviewer sees the whole ledger but judges only the findings it raised:
  its `resolved` and `withdrawn` lists, implicit resolution when it omits a finding, and `approve`
  resolving its open findings all apply to its own findings. The developer answers every open
  finding. The escalation rules are unchanged, applied to the whole blocking set.
* **Worktrees (parallel/compete).** `git worktree add` from the session clone:
  `~/.lina/workspaces/<id>--<agent>` on branch `lina/<short>-<agent>`, from the session base commit.
  The `.git` gitfile there points back into `<id>/.git/worktrees/…`, which `assertWorkspaceGitDir`
  allows. The `.git/config` seal is per session (main clone), so restoring after a turn in a worktree
  restores the shared config. Deleting a session removes its worktrees. Every git call goes through
  `git.ts`. Diff/tree/file endpoints accept `?variant=`.
* **Tests per worktree.** LINA tests each worktree separately (sequentially, to avoid port clashes).
  The `tests` event and `TestRun` carry `variant`.

### custom

`config.team: TeamConfig` is required in custom mode (default: `settings.team`, else architect-like
`{planner: dev, planCritic: rev, developer: dev, reviewers: [rev]}`). Validation: the agent ids exist,
`reviewers` has 0–2 distinct agents, and planner/planCritic are an agent or null. `config.developer`
mirrors `team.developer`, and `config.reviewer` is the first reviewer (or the other agent when there
are none), so code that reads them keeps working. A developer listed as a reviewer reviews in its own
read-only provider session (`<agent>:reviewer@main`).

### parallel (divide and conquer)

1. **planning**: the lead (`config.developer`), read-only, writes a plan and a ```` ```lina-split ````
   block: `{"parts":[{"agent":"codex","title":…,"scope":…,"files":[…]},{"agent":"claude",…}]}`,
   with exactly one part per agent and non-overlapping file ownership where possible. One repair prompt
   if it doesn't parse. If it still fails, a notice explains and the session continues as `pair` with
   the lead (no variants). Emits `split` and a `plan` message.
2. **implementing**: create both worktrees. Both agents implement their part concurrently (write
   access). Each prompt includes the whole plan, its own part, and the other agent's part ("do not
   edit files the other part owns"). Each worktree gets a checkpoint (`checkpoint.variant`).
3. **integrating**: in the main workspace, `git merge --no-ff` the lead's branch, then the other's.
   On a conflict, LINA leaves the conflicted working tree, emits `integration{state:'conflict', conflicts}`,
   and runs a lead turn (write, phase integrating) asking it to resolve the markers without running
   git. LINA then requires no unmerged paths and no `<<<<<<<`/`>>>>>>>` markers in those files. If that
   holds it commits the merge (`integration{state:'resolved'}`); otherwise it aborts the merge, emits
   `integration{state:'failed'}`, and the step fails (retry re-runs integration). A clean merge emits
   `integration{state:'merged', commit}`.
4. **testing** on the main workspace, then **reviewing**: cross-review. Both agents review the
   integrated diff concurrently, each focused on the other's part. A finding's owner is
   `finding.owner` if the reviewer sets `"owner"` in its JSON, else the agent whose part the reviewer
   was asked to check.
5. **revising**: each agent with open findings it owns fixes them, one after the other, in the main
   workspace (lead first). Checkpoint after each. Then test → review (next round). maxRounds and
   escalation as usual.
6. **verifying** and approval, as in pair.

### compete

1. **implementing**: create both worktrees. Both agents implement the whole task independently and
   concurrently. They don't see each other's work. Checkpoint each.
2. **testing**: LINA tests each worktree.
3. **reviewing**: each agent reviews the *other's* worktree concurrently (read-only, cwd = that
   worktree). Its findings get `variant` = that candidate and `owner` = its author. The `review` event
   carries `variant`, and the review `message` carries `variant` too.
4. **revising**: each candidate with blocking findings is revised by its author (concurrently, in its own
   worktree), then test → cross-review (next round). Stops when no candidate has blocking findings, or
   at maxRounds. Escalation is per candidate.
5. **verifying**: LINA composes a comparison summary from facts (tests, diff size, findings, usage per
   candidate) and requests approval with `candidates`.
6. **You choose**: `approval{decision:'choose', variant}` resets the main workspace branch to that
   candidate's head, drops the other candidate's findings, and switches the session to `pair` with
   the winner as developer and the rival as reviewer, still awaiting approval. `approve` with `variant`
   chooses and applies in one step. `approve` without a chosen candidate fails with `choose_variant`.
   Before choosing, a request-changes message goes to both candidates (concurrent revise → test →
   cross-review → approval).

### session.deleted

`DELETE /api/sessions/:id` emits an ephemeral `session.deleted` event to the session's subscribers
and to global watchers. Clients drop the session from their lists. If it was open, they show that it
was deleted.

## Module ownership (v1 build)

| Area | Paths |
|---|---|
| shared contract | `src/shared/*` (types, protocol, client, reducer) |
| agent adapters | `src/server/agents/{claude,codex,classify,errors,models,doctor,proc,redact}.ts` |
| core daemon | `src/server/{db,events,git,tests-runner,prompts,review-parse,runner,sessions,http,daemon,paths,log,index}.ts`, `src/server/agents/mock.ts` |
| CLI / TUI | `src/cli/**` (entry `src/cli/main.tsx`) |
| web UI | `web/**` (built to `dist/web`) |
| tests | `test/<area>/*.test.ts` |
