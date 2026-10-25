// Role and step prompts. Kept compact: with resumed provider sessions the agent already has
// the request/plan, so those are only sent on an agent's first turn ("primed" = false).
// Every step prompt starts with a machine marker `<!-- lina:step=<step> round=<n> -->`
// (used by the mock adapter and handy when reading transcripts).
import type { Finding, TestRun, WorkPart } from '../shared/types.js';

export type PromptStep =
  | 'feedback' | 'chat' | 'plan' | 'plan_review' | 'implement' | 'review' | 'revise' | 'consult' | 'repair' | 'deliver'
  // parallel / compete
  | 'split' | 'split_repair' | 'part' | 'integrate' | 'compete' | 'cross_review';

export function marker(step: PromptStep, round: number): string {
  return `<!-- lina:step=${step} round=${round} -->`;
}

export const REVIEW_BLOCK_EXAMPLE = [
  '```lina-review',
  '{"verdict":"request_changes","summary":"One-line overall assessment",',
  ' "findings":[{"id":"F1","severity":"major","title":"Short title","detail":"What is wrong and why it matters","file":"src/x.ts","line":42,"suggestion":"How to fix"}],',
  ' "resolved":["F2"],',
  ' "withdrawn":[{"id":"F3","reason":"Developer\'s explanation is correct"}]}',
  '```',
].join('\n');

export const SPLIT_BLOCK_EXAMPLE = [
  '```lina-split',
  '{"parts":[{"agent":"codex","title":"Short title","scope":"What this agent builds","files":["src/a.ts","test/a.test.ts"]},',
  ' {"agent":"claude","title":"Short title","scope":"What this agent builds","files":["src/b.ts"]}]}',
  '```',
].join('\n');

export const RESPONSE_BLOCK_EXAMPLE = [
  '```lina-response',
  '{"items":[{"id":"F1","action":"fixed","note":"Added bounds check + test"},{"id":"F2","action":"disputed","note":"Evidence: …"}]}',
  '```',
].join('\n');

export function developerSystemPrompt(direct = false): string {
  return [
    'You are the developer on a small engineering team coordinated by LINA. Carry the project owner\'s request through implementation and verification; a reviewer may check your work.',
    direct
      ? '- You work directly in the owner\'s project. Edits take effect immediately. Preserve existing uncommitted changes and do not revert work you did not make. Git inspection commands (status, diff, log, show) are available. Leave changes uncommitted by default. When the owner explicitly requests a commit, inspect the diff and index, stage only the requested changes and commit them; preserve unrelated staged and unstaged work. Do not push, stash, reset, change git config, remotes or branches unless explicitly requested. No final merge or approval step is needed.'
      : '- You work in an isolated git clone of the project. Do NOT commit, push, change remotes or branches: LINA checkpoints your changes automatically.',
    '- In conversational chat, when another agent must answer or approve a proposal before you continue, request an actual handoff instead of saying you will wait. End your reply with a lina-chat fenced JSON block: {"handoff":{"agent":"codex","message":"Please review my proposal above before implementation."}} (choose the other configured reviewer, never yourself). This works even without file edits. LINA routes the request, returns the answer, and limits repeated exchanges.',
    '- In conversational chat, LINA automatically starts a developer response when the reviewer replies, including approval notes. Measured edits are reviewed again within the round limit. You do not need a background watcher or a memory note to wait for feedback; LINA schedules the next turn.',
    '- Keep changes focused on the request; follow the codebase\'s existing conventions; no drive-by refactors.',
    '- Read Agents.md when present for project instructions and the handoff log. Keep that log current when the owner asks you to record work.',
    '- Run the relevant tests/linters yourself when practical and fix what you break.',
    '- In a sandbox, Node\'s test runner cannot report from its per-file subprocesses: run `node --test --experimental-test-isolation=none` instead of plain `node --test`, or test files may show as passing or failing without having run. LINA also runs the project\'s tests itself.',
    '- Be candid. When the reviewer raises a finding you believe is wrong, push back with concrete evidence (code, tests, docs) instead of complying blindly. When it is right, fix it properly.',
    '- End each turn with a short summary: what changed (files) and how you verified it.',
  ].join('\n');
}

export function reviewerSystemPrompt(): string {
  return [
    'You are the code reviewer on a small engineering team coordinated by LINA: demanding but fair, like a senior engineer who wants this to ship correctly.',
    '- You are read-only: never modify files. Inspect the actual changes (`git diff <base>`, `git log`, read the files) — do not trust summaries.',
    '- Prioritize correctness, security, edge cases, error handling, tests and maintainability over style. Do not nitpick; give genuine opinions; acknowledge good work.',
    '- Severity: blocker (must not ship), major (should fix before merge), minor (worth fixing), nit (optional).',
    '- When the developer disputes a finding with sound reasoning, accept it (withdraw it). Maintain it only with a concrete counter-argument.',
    '- Approve when no blocker/major issues remain. Every review ends with exactly one block:',
    REVIEW_BLOCK_EXAMPLE,
    'Reuse the ids of earlier findings you still maintain; omit "id" for new findings. "resolved": earlier findings now fixed. "withdrawn": earlier findings you drop.',
  ].join('\n');
}

export interface OwnerMessage { text: string; attachments?: { name: string; path: string }[] }

export function previewInstructions(sessionId: string): string {
  return `For a web app that needs a live preview, use LINA's managed preview command instead of starting a background server in your shell. Start it with: lina preview start 'npm run dev -- --host 127.0.0.1 --port {port}' --session ${sessionId} (adapt the command to the project). The {port} placeholder is replaced with a free local port, also supplied as PORT. Keep the server in the foreground in that command. List with: lina preview list --session ${sessionId}; inspect logs with: lina preview logs <id> --session ${sessionId}; stop with: lina preview stop <id> --session ${sessionId}. Managed previews survive agent turns and daemon restarts. Reuse an existing healthy preview; do not start duplicates on every turn. Report the actual URL returned by LINA. Other background children are still cleaned up at turn end. These commands run without approval prompts in Full access mode.`;
}

export function chatPrompt(ctx: { text: string; attachments?: { name: string; path: string }[]; owner: OwnerMessage[] }): string {
  return join([
    marker('chat', 0),
    taskBlock({ task: ctx.text, taskAttachments: ctx.attachments } as TaskContext),
    ownerBlock(ctx.owner),
    'Respond naturally to this message. For a question, read what you need and answer directly; do not start a coding workflow or edit files just to answer. For a coding request, make the requested changes, run relevant checks, and explain the result. Ask a concise clarification when required. Choose planning, testing and independent review according to the actual work; no separate plan turn is required. Do not rerun the previous request unless the owner asks. If you change files, you may end with the exact fenced control block below to request LINA verification/review; set either false when unnecessary (for example a documentation-only edit). Omit this block for ordinary answers. LINA measures actual file changes rather than treating your prose as evidence of edits.\n\n```lina-chat\n{"test":true,"review":true}\n```',
  ]);
}

export interface PeerHandoff { agent: 'codex' | 'claude'; message: string }

export function parseChatReply(text: string, writing = false): { text: string; test?: boolean; review?: boolean; handoff?: PeerHandoff } {
  const fenced = /\n?```lina-chat\s*\n([\s\S]*?)\n```\s*$/.exec(text);
  // Some providers emitted the two control fields without the requested fence.
  // Accept that narrow form only after a real writing turn and a prose answer;
  // ordinary JSON answers must remain visible and must not control verification.
  const match = fenced ?? (writing ? /\n[ \t]*\n(\{[^{}]*\})\s*$/.exec(text) : null);
  if (!match) return { text: text.trim() };
  try {
    const value = JSON.parse(match[1]);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { text: text.trim() };
    if (!fenced && (!text.slice(0, match.index).trim() || Object.keys(value).length !== 2 || typeof value.test !== 'boolean' || typeof value.review !== 'boolean')) return { text: text.trim() };
    const handoff = value.handoff && ['codex', 'claude'].includes(value.handoff.agent) && typeof value.handoff.message === 'string' && value.handoff.message.trim()
      ? { agent: value.handoff.agent as 'codex' | 'claude', message: value.handoff.message.trim().slice(0, 10000) } : undefined;
    return { text: text.slice(0, match.index).trim(), ...(typeof value.test === 'boolean' ? { test: value.test } : {}), ...(typeof value.review === 'boolean' ? { review: value.review } : {}), ...(handoff ? { handoff } : {}) };
  } catch { return { text: text.trim() }; }
}

function ownerBlock(msgs: OwnerMessage[]): string {
  if (!msgs.length) return '';
  return msgs.map((m) => {
    const att = m.attachments?.length ? `\n(Attached: ${m.attachments.map((a) => `${a.name} → ${a.path}`).join(', ')})` : '';
    return `Message from the project owner:\n${m.text}${att}`;
  }).join('\n\n');
}

function join(parts: (string | undefined | false)[]): string {
  return parts.filter((p): p is string => !!p && !!p.trim()).join('\n\n');
}

export interface TaskContext {
  task: string;
  taskAttachments?: { name: string; path: string }[];
  plan?: string;
  /** Agent that drafted the plan (when it is not the one being prompted, the plan is always included). */
  planBy?: string;
  /** Agent being prompted. */
  self?: string;
  critique?: string;
  /** Agent already received the request (and plan) in its resumed provider session. */
  primed: boolean;
  owner: OwnerMessage[];
}

/** The plan, unless the agent wrote it itself and already has it in its resumed session. */
function planBlock(ctx: TaskContext): string | undefined {
  if (!ctx.plan) return undefined;
  const foreign = !!ctx.planBy && ctx.planBy !== ctx.self;
  if (ctx.primed && !foreign) return undefined;
  return foreign ? `Plan (drafted by ${ctx.planBy}):\n${ctx.plan}` : `Your plan:\n${ctx.plan}`;
}

function taskBlock(ctx: TaskContext): string {
  const att = ctx.taskAttachments?.length ? `\n(Attached: ${ctx.taskAttachments.map((a) => `${a.name} → ${a.path}`).join(', ')})` : '';
  return `Request from the project owner:\n${ctx.task}${att}`;
}

export function planPrompt(ctx: TaskContext): string {
  return join([
    marker('plan', 0),
    taskBlock(ctx),
    ownerBlock(ctx.owner),
    'Step: PLAN (read-only). Inspect the relevant code, then reply with a concise implementation plan: at most ~12 bullets covering files to touch, approach, risks/edge cases and how you will test it. Do not edit files yet.',
  ]);
}

export function planCritiquePrompt(ctx: TaskContext): string {
  return join([
    marker('plan_review', 0),
    taskBlock(ctx),
    `${!ctx.planBy ? 'The developer\'s' : ctx.planBy === ctx.self ? 'Your own' : `${ctx.planBy}'s`} plan:\n${ctx.plan ?? '(none)'}`,
    ownerBlock(ctx.owner),
    'Step: PLAN CRITIQUE (read-only), acting as architect. Check the plan against the code: missing cases, wrong assumptions, simpler alternatives, test strategy. Reply with a short critique (bullets). No lina-review block needed.',
  ]);
}

export function implementPrompt(ctx: TaskContext & { revisionRequest?: string; round: number }): string {
  const parts: (string | undefined)[] = [marker('implement', ctx.round)];
  if (ctx.revisionRequest) {
    if (!ctx.primed) parts.push(taskBlock(ctx));
    parts.push(`The project owner reviewed the result and requests changes:\n${ctx.revisionRequest}`);
  } else {
    if (!ctx.primed) parts.push(taskBlock(ctx));
    parts.push(planBlock(ctx));
    if (ctx.critique) parts.push(`Architect's critique of the plan:\n${ctx.critique}`);
  }
  parts.push(ownerBlock(ctx.owner));
  parts.push('Step: IMPLEMENT. Make the changes now and run the relevant tests. Follow the system Git policy. Finish with a short summary of what changed and how you verified it.');
  return join(parts);
}

export function findingLine(f: Finding, withNotes = false): string {
  const loc = f.file ? ` (${f.file}${f.line ? ':' + f.line : ''})` : '';
  let s = `- ${f.id} [${f.severity}/${f.status}] ${f.title}${loc}`;
  if (withNotes) {
    const devNote = [...f.history].reverse().find((h) => h.actor !== 'user' && h.actor !== 'lina' && (h.action === 'disputed' || h.action === 'fixed' || h.action === 'deferred'));
    if (devNote?.note && (f.status === 'disputed' || f.status === 'fixed' || devNote.action === 'deferred')) s += `\n  developer (${devNote.action}): ${oneLine(devNote.note, 400)}`;
  }
  return s;
}

export function testLine(t?: TestRun): string {
  if (!t) return 'Tests: not run.';
  if (t.skippedReason) return `Tests: skipped (${t.skippedReason}).`;
  const counts = t.passed !== undefined || t.failed !== undefined ? ` — ${t.passed ?? 0} passed, ${t.failed ?? 0} failed` : '';
  const head = `Tests (\`${t.command}\`): ${t.ok ? 'PASS' : 'FAIL'} (exit ${t.exitCode ?? 'n/a'})${counts}.`;
  if (t.ok) return head;
  return `${head}\nOutput tail:\n\`\`\`\n${t.output.slice(-1500)}\n\`\`\``;
}

/** Earlier findings: the reviewer's own (which it judges) and, for context, those raised by others. */
function findingsBlock(own: Finding[], others: Finding[]): string | undefined {
  const mine = own.filter((f) => f.status !== 'waived');
  const theirs = others.filter((f) => f.status !== 'waived');
  const parts: string[] = [];
  if (mine.length) parts.push(`Findings so far (id [severity/status]):\n${mine.map((f) => findingLine(f, true)).join('\n')}\nFor each fixed/disputed finding: verify the fix and list it in "resolved", accept a sound dispute in "withdrawn", or keep it in "findings" (same id) with your counter-argument.`);
  if (theirs.length) parts.push(`Findings raised by the other reviewer (context only — do not resolve, withdraw or repeat them):\n${theirs.map((f) => `- ${f.id} (raised by ${f.raisedBy}) [${f.severity}/${f.status}] ${f.title}`).join('\n')}`);
  return parts.join('\n\n') || undefined;
}

export function reviewPrompt(ctx: TaskContext & {
  round: number; base: string; diffStat: string; test?: TestRun; findings: Finding[];
  /** Findings by other reviewers this round (multi-reviewer teams). */
  others?: Finding[];
  /** The developer, when it is not the one reviewing (a self-review is said so). */
  developer?: string;
  /** Direct sessions include a measured diff against the initial working files, including untracked files. */
  liveDiff?: string;
}): string {
  const parts: (string | undefined)[] = [marker('review', ctx.round)];
  if (!ctx.primed) parts.push(taskBlock(ctx), ctx.plan ? `${ctx.planBy && ctx.planBy !== ctx.self ? 'The' : 'Your'} plan:\n${ctx.plan}` : undefined);
  parts.push(ownerBlock(ctx.owner));
  if (ctx.developer && ctx.developer === ctx.self) parts.push('You wrote this code in a separate session; review it now as an independent reviewer, as critically as you would review someone else\'s work.');
  parts.push(ctx.liveDiff !== undefined
    ? `Review round ${ctx.round}. Working directly in the project. The following measured diff compares current files (including untracked files) against the session's initial files; existing owner changes are excluded. Inspect these changes and read the actual files. Do not use HEAD alone as the task diff: changes may be uncommitted or explicitly committed by the owner request. Use the measured baseline diff in either case.\nChanged files:\n${ctx.diffStat || '(no changes)'}\n\nLive diff:\n${ctx.liveDiff || '(no changes)'}`
    : `Review round ${ctx.round}. Base commit: ${ctx.base} — inspect with \`git diff ${ctx.base.slice(0, 12)}\`.\nChanged files:\n${ctx.diffStat || '(no changes)'}`);
  parts.push(testLine(ctx.test));
  parts.push(findingsBlock(ctx.findings, ctx.others ?? []));
  parts.push('Step: REVIEW (read-only). Give your honest assessment in prose, then end with the lina-review block.');
  return join(parts);
}

export function partLine(p: WorkPart): string {
  return `**${p.title}** — ${p.scope}${p.files?.length ? ` (files: ${p.files.join(', ')})` : ''}`;
}

/** parallel: the lead plans and splits the task into one part per agent. */
export function splitPlanPrompt(ctx: TaskContext & { lead: string; other: string }): string {
  return join([
    marker('split', 0),
    taskBlock(ctx),
    ownerBlock(ctx.owner),
    `Step: PLAN AND SPLIT (read-only). You lead this task. You and ${ctx.other} will implement it at the same time, each in a separate git worktree; LINA then merges both branches and you review each other's part. Inspect the relevant code, then reply with a concise implementation plan (at most ~12 bullets: approach, interfaces between the parts, risks, how to test) and split the work into exactly two parts — one for you (${ctx.lead}) and one for ${ctx.other}. Give each part clear ownership of files so you never edit the same file; a shared file (index, config, registry…) belongs to exactly one part. Do not edit files yet. End with exactly one block:\n${SPLIT_BLOCK_EXAMPLE}`,
  ]);
}

export function splitRepairPrompt(lead: string, other: string): string {
  return join([
    marker('split_repair', 0),
    `Your plan did not end with a valid lina-split block. Output ONLY that block (valid JSON, no prose): exactly one part for ${lead} and one for ${other}, with non-overlapping files:\n${SPLIT_BLOCK_EXAMPLE}`,
  ]);
}

/** parallel: implement one part in the agent's own worktree. */
export function partPrompt(ctx: TaskContext & { part: WorkPart; other: WorkPart; lead: string }): string {
  return join([
    marker('part', 0),
    !ctx.primed && taskBlock(ctx),
    ctx.plan && `The plan (${ctx.lead === ctx.self ? 'yours' : `by ${ctx.lead}, who leads this task`}):\n${ctx.plan}`,
    `Your part: ${partLine(ctx.part)}`,
    `The other part, built by ${ctx.other.agent} at the same time in its own worktree: ${partLine(ctx.other)}\nDo NOT edit files the other part owns. Where you depend on it, code against the interface in the plan and mention it in your summary.`,
    ownerBlock(ctx.owner),
    'Step: IMPLEMENT YOUR PART. You work in your own git worktree; LINA merges both parts afterwards. Make the changes now and run the relevant tests. Do not commit. Finish with a short summary of what changed and how you verified it.',
  ]);
}

/** parallel: the lead resolves merge conflicts left in the session workspace. */
export function integratePrompt(ctx: { agent: string; branch: string; conflicts: string[]; parts?: WorkPart[]; owner?: OwnerMessage[] }): string {
  return join([
    marker('integrate', 0),
    `LINA is merging ${ctx.agent}'s branch (${ctx.branch}) into the session branch. Git reported conflicts in:\n${ctx.conflicts.map((f) => `- \`${f}\``).join('\n')}`,
    ctx.parts?.length ? `The parts:\n${ctx.parts.map((p) => `- ${p.agent}: ${partLine(p)}`).join('\n')}` : undefined,
    ownerBlock(ctx.owner ?? []),
    'Step: RESOLVE CONFLICTS. Edit each file listed above so that it correctly combines both sides and contains no conflict markers (<<<<<<<, =======, >>>>>>>). Do NOT run git (no add, commit, merge, checkout, reset or stash): LINA checks the files, then stages and commits the merge itself. Finish with a short summary of how you resolved each file.',
  ]);
}

/** compete: build the whole task independently in the agent's own worktree (or revise it on request). */
export function competePrompt(ctx: TaskContext & { revisionRequest?: string; round: number; rival: string }): string {
  const parts: (string | undefined | false)[] = [marker('compete', ctx.round), !ctx.primed && taskBlock(ctx)];
  if (ctx.revisionRequest) parts.push(`The project owner compared both versions and requests changes:\n${ctx.revisionRequest}\n(Apply them to your own version, in this worktree.)`);
  parts.push(ownerBlock(ctx.owner));
  parts.push(`Step: IMPLEMENT (competition). ${ctx.rival} implements the same request independently in its own worktree. You do not see each other's work until the cross-review, and the project owner then picks one version. Build the complete solution yourself, in this worktree — do not split the work or wait for anyone. Make the changes now and run the relevant tests. Do not commit. Finish with a short summary of what changed and how you verified it.`);
  return join(parts);
}

/** parallel / compete: review the other agent's part (integrated tree) or candidate (its worktree). */
export function crossReviewPrompt(ctx: TaskContext & {
  round: number; base: string; diffStat: string; test?: TestRun; findings: Finding[]; others: Finding[];
  /** parallel: the part to focus on. */
  focus?: WorkPart;
  /** compete: whose version this is. */
  author?: string;
}): string {
  const parts: (string | undefined | false)[] = [marker('cross_review', ctx.round)];
  if (!ctx.primed) parts.push(taskBlock(ctx), ctx.plan && `The plan:\n${ctx.plan}`);
  parts.push(ownerBlock(ctx.owner));
  if (ctx.author) parts.push(`You are reviewing ${ctx.author}'s version: ${ctx.author} implemented the whole request independently, in the worktree that is your working directory now. Judge this version on its own merits (your own version is elsewhere and is reviewed by ${ctx.author}). Every finding you raise is for ${ctx.author} to fix.`);
  if (ctx.focus) parts.push(`Both parts are merged in this workspace. Focus on the part ${ctx.focus.agent} built: ${partLine(ctx.focus)}\nFindings go to ${ctx.focus.agent} by default. Add "owner":"codex"|"claude" to a finding that the other part's author must fix instead.`);
  parts.push(`Review round ${ctx.round}. Base commit: ${ctx.base} — inspect with \`git diff ${ctx.base.slice(0, 12)}\`.\nChanged files:\n${ctx.diffStat || '(no changes)'}`);
  parts.push(testLine(ctx.test));
  parts.push(findingsBlock(ctx.findings, ctx.others));
  parts.push('Step: CROSS-REVIEW (read-only). Give your honest assessment in prose, then end with the lina-review block.');
  return join(parts);
}

export function revisePrompt(ctx: TaskContext & { round: number; open: Finding[]; heading?: string }): string {
  const parts: (string | undefined)[] = [marker('revise', ctx.round)];
  if (!ctx.primed) parts.push(taskBlock(ctx));
  parts.push(ownerBlock(ctx.owner));
  parts.push(`${ctx.heading ?? 'The reviewer\'s open findings'} (round ${ctx.round}):\n${ctx.open.map((f) => {
    const loc = f.file ? ` (${f.file}${f.line ? ':' + f.line : ''})` : '';
    return `- ${f.id} [${f.severity}] ${f.title}${loc}\n  ${oneLine(f.detail, 600)}${f.suggestion ? `\n  suggestion: ${oneLine(f.suggestion, 300)}` : ''}`;
  }).join('\n')}`);
  parts.push(`Step: REVISE. Fix what is right; dispute (with evidence) what is wrong; defer only with a reason. Follow the system Git policy. Answer every finding id in a final block:\n${RESPONSE_BLOCK_EXAMPLE}`);
  return join(parts);
}

export function feedbackPrompt(ctx: TaskContext & { round: number; open: Finding[]; canEdit: boolean; feedback?: string; readOnlyReason?: string }): string {
  return join([
    marker('feedback', ctx.round),
    !ctx.primed ? taskBlock(ctx) : undefined,
    ownerBlock(ctx.owner),
    ctx.feedback,
    `LINA has automatically started this turn because a reviewer responded. Read the latest reviewer messages in the conversation context, including approval notes, minor findings and limitations. Reply to the reviewer now; no owner nudge or memory note is needed. Existing owner restrictions remain in force: review feedback does not expand the task's authorization.`,
    ctx.open.length ? `Findings to address:\n${ctx.open.map((f) => `- ${f.id} [${f.severity}] ${f.title}: ${f.detail}`).join('\n')}` : undefined,
    ctx.canEdit
      ? 'Fix valid in-scope issues, explain disagreements and acknowledge remaining limitations. Make changes only when the feedback actually calls for them; do not manufacture work after approval. LINA will test/review measured changes again within the round limit. Follow the system Git policy.'
      : ctx.readOnlyReason ?? 'The review round limit has been reached. This reply is read-only: acknowledge approval/limitations and describe any remaining issues for the owner; do not edit files or promise additional automatic revision rounds.',
    `Finish with a concise response. If answering finding IDs, end with the lina-response block:\n${RESPONSE_BLOCK_EXAMPLE}`,
    'LINA schedules turns when feedback arrives and stops when the exchange is finished. You do not need to poll, stay running, or save a memory note to wait for another agent.',
  ]);
}

/** Conversation context is supplied to every turn, including resumed provider sessions. */
export function conversationContext(workspace: string, messages: { agent: string; text: string; variant?: string }[]): string {
  return join([
    `Your current workspace: ${workspace}`,
    messages.length ? `Recent conversation and team handoffs (historical context; agent claims are not verified evidence):\n${messages.map((m) => `[${m.agent}${m.variant ? ` · candidate ${m.variant}` : ''}]\n${m.text}`).join('\n\n')}\n\nFollow the current request above; do not repeat historical requests. For an assessment of another agent's work, inspect the actual files, diff and tests. If its handoff names a different directory, check that path read-only before concluding the implementation is missing. Report any workspace mismatch explicitly; do not treat a teammate's claimed test results as independently verified.` : undefined,
  ]);
}

export function consultPrompt(ctx: { text: string; attachments?: { name: string; path: string }[]; task?: string; primed: boolean; role: 'developer' | 'reviewer' }): string {
  const att = ctx.attachments?.length ? `\n(Attached: ${ctx.attachments.map((a) => `${a.name} → ${a.path}`).join(', ')})` : '';
  return join([
    marker('consult', 0),
    !ctx.primed && ctx.task ? `Context — the team's current request:\n${ctx.task}` : undefined,
    `The project owner addresses you directly:\n${ctx.text}${att}`,
    ctx.role === 'reviewer'
      ? 'Answer directly and concisely. You are read-only. No lina-review block is needed unless asked.'
      : 'Answer directly and concisely. Only change files if the owner asks for it; follow the system Git policy, including explicitly requested commits in direct projects.',
  ]);
}

/** Owner messages that arrived late (after the agent's last turn in the loop). */
export function deliverPrompt(ctx: { owner: OwnerMessage[]; role: 'developer' | 'reviewer' }): string {
  return join([
    marker('deliver', 0),
    ownerBlock(ctx.owner),
    ctx.role === 'developer'
      ? 'These arrived while the team was working. Act on them if they require changes, following the system Git policy, then summarize briefly.'
      : 'These arrived while the team was working. Respond briefly (read-only).',
  ]);
}

export function repairPrompt(round: number): string {
  return join([
    marker('repair', round),
    `Your previous review could not be parsed. Output ONLY the lina-review block for that review (valid JSON, no prose):\n${REVIEW_BLOCK_EXAMPLE}`,
  ]);
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}
