# Autonomous goals

Give LINA `/goal <objective>` in the project you want changed. The saved full
objective remains authoritative through planning, implementation, tests, review,
provider handoffs and daemon restarts. An ordinary agent reply does not end a goal.

LINA continues unfinished approved work until an evidence audit verifies every
requirement. A proposed completion starts a separate review of the implementation
and verification artifacts. The audit saves stable requirement keys, the original
requirement wording, observed evidence, and whether each item is verified,
remaining or blocked. Future audits must retain those requirements. Missing
verification is unfinished work. `/goal status` shows the latest audit count.
The audit is a model assessment with recorded evidence, not a mathematical proof
of arbitrary software correctness.

If files change during completion assessment, LINA tests and reviews those files
again. Full-access reviewers keep their configured permissions; measured edits
are attributed and saved in turn history. Self-review does not become independent
review. When the other provider is unavailable, independent review remains a
scheduled job and the goal is reported as waiting for review.

## Surviving host restarts

On Linux, enable a supervised user daemon once:

```sh
lina daemon enable
```

Run this while no session is executing a turn; Pause reaches a turn boundary.
The command preserves saved goals, installs a systemd user service, and enables
user lingering so it starts at boot and stays alive after SSH logout. The service
restarts the foreground daemon after a crash. Durable goal recovery then runs
without attaching a terminal. `lina daemon start|stop|restart` controls the same
supervisor. `lina daemon disable` stops and disables this profile's boot service;
it keeps project files and saved goals. Separate `LINA_HOME` profiles receive
separate service names. An explicitly selected `LINA_PORT` is retained.
Install updates preserve the existing daemon instead of killing active turns.
Restart it after a turn boundary to load the new build.

## Recovery behavior

| Condition | Automatic action | Verification |
| --- | --- | --- |
| Concrete remaining work | Implement, test, review, assess again | `goal.test.ts`: one-message continuation |
| Missing completion evidence | Retain the requirement and perform its next action | `goal.test.ts`: missing evidence artifact |
| Malformed completion or blocker response | Repair its protocol, then retry durably if needed | goal/audit protocol regressions |
| Minor findings or exhausted review rounds | Resolve findings and renew the repair cycle | goal review-cycle regressions |
| Repeated cycles without file progress | Replan with the prior failure evidence and choose another approach | goal progress regressions |
| Provider capacity | Immediate takeover, then bounded short cooldown | failover capacity regressions |
| Usage quota | Takeover, then retry after reset; preserve rounded elapsed hints | reset and failover regressions |
| Connection failure, crash or timeout | Preserve partial work, clear broken conversation context, try the other provider; retry durably | goal recovery regressions |
| One provider needs login, a valid model, installation or sandbox repair | Continue using the usable provider; retain an actionable setup notice and recheck every five minutes | goal configuration regressions |
| Provider model corrected | Recheck its non-quota cooldown and deferred review promptly | goal configuration regressions |
| Unexpected runner error | Save the failed step and diagnosis; retry with bounded backoff | runner recovery scheduling |
| Project busy when a goal is submitted | Save and queue the first goal message; start automatically when free | goal startup/queue regressions |
| Restart or crash during work or a scheduled retry | Restore durable intent and schedules before a client opens the session | process acceptance and restart regressions |
| One item requires external evidence | Keep it in the deferred queue; work on another approved item first | goal backlog regressions |
| Genuine missing owner fact | Finish other useful approved work; request the specific fact | blocker/backlog regressions |
| Owner answers that question, including during its closing turn | Resume automatically with the answer; explicit Pause wins at the boundary | owner-answer and boundary regressions |
| Explicit Pause, Cancel or Undo | Stop automatic work; an ordinary message does not override it | controls/restart regressions |
| Inherited step mode | A goal runs autonomously; explicit Pause still works | goal step-mode regression |

An unavailable credential, missing physical device, or required external event
cannot be manufactured by a retry loop. LINA keeps timed waits and owner facts
separate, preserves the full scope, and never declares those dependencies done
merely because local attempts passed. An explicitly selected isolated workspace
still has its separate apply/merge boundary. Ordinary `/goal` use in a direct
workspace edits the selected project without that merge step.

## Reproduce the acceptance checks

Run from the repository with dependencies installed:

```sh
npm run typecheck
npm test -- --maxWorkers=2
npm run build
python3 scripts/verify-goal-recovery.py --output /tmp/lina-goal-recovery
python3 scripts/verify-cli-pty.py --output /tmp/lina-goal-terminal
```

The process acceptance command creates its own temporary project and LINA state.
It injects provider timeout/crash failures, kills the fixture daemon during a
scheduled recovery, then kills it again during completion assessment. Three
separate daemon processes use real HTTP, SQLite and timers. After restart, only
the database is observed: no client opens the conversation or sends Resume.
The fixture must finish with one owner message, zero control calls, preserved
partial files, a successful actual test command, and verified requirement evidence.
It closes its own processes and retains a result JSON and log in the output path.
Provider responses in this fault-injection check are mocks; it does not consume
real provider quotas or certify a particular external project's feature claims.

Scheduler availability errors retry after 30 seconds without disabling automation. Explicit session Pause still disables automatic retries until Resume; Pause and Resume requests are recorded in conversation history.

## Delegating implementation to Freebuff

Run `/delegate` before sending a task or goal. This selects a custom team: Codex plans, Claude critiques, Freebuff implements and addresses findings, and Codex plus Claude independently review the actual changes. `/goal` preserves this team. The equivalent explicit command is `/team plan=codex,critic=claude,dev=freebuff,review=codex+claude`.

Freebuff is also tried after unavailable Codex and Claude providers when its CLI is installed. Reviews that cannot run remain scheduled; fallback self-review does not count as independent approval. Explicit Pause and Cancel still stop automatic continuation.

Freebuff's interactive CLI uses its own configured model and permissions. LINA passes the full goal, plan, constraints and role instructions through its composer, reads structured persisted tool activity, and stops the process after the turn finishes. Tool activity appears under the Freebuff panel. The currently tested Freebuff CLI does not expose its own spawn_agents tool; LINA delegates to the Freebuff process itself, rather than claiming it spawned nested workers. Token usage and per-worker provider identities are not supplied by this CLI. It must already be installed and logged in (`lina doctor` checks it).
