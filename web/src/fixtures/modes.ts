// Fixture sessions for the v2 modes: compete (at the candidate choice), parallel (split → conflict resolved →
// cross-review), and a custom team with two reviewers. Plus per-worktree diffs/trees/files for ?variant=.
import type { AgentId, DiffFile, Finding, SessionSnapshot, TestRun, TreeEntry } from '@shared/types';
import { F, FILES, PROJECTS, T0, TREE, addPatch, baseSession, mkEvents, usage } from './data';

const MIN = 60_000;

export interface Workspace { diff: DiffFile[]; tree: TreeEntry[]; files: Record<string, string> }
export type Workspaces = { main: Workspace } & Partial<Record<AgentId, Workspace>>;

/** DiffFile with counts derived from the patch. */
function df(path: string, status: DiffFile['status'], patch: string): DiffFile {
  const lines = patch.split('\n');
  return {
    path, status, patch,
    additions: lines.filter((l) => l.startsWith('+')).length,
    deletions: lines.filter((l) => l.startsWith('-')).length,
  };
}
const added = (path: string, text: string) => df(path, 'added', addPatch(text));
const dirsOf = (paths: string[]) => [...new Set(paths.flatMap((p) => p.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/'))))];
function treeWith(base: TreeEntry[], diff: DiffFile[], files: Record<string, string>): TreeEntry[] {
  const changed = new Set(diff.map((f) => f.path));
  const out = base.map((e) => (e.type === 'file' && changed.has(e.path) ? { ...e, changed: true } : e));
  for (const d of dirsOf([...changed])) if (!out.some((e) => e.path === d)) out.push({ path: d, type: 'dir' });
  for (const p of changed) if (!out.some((e) => e.path === p)) out.push({ path: p, type: 'file', size: (files[p] ?? '').length || 600, changed: true });
  return out;
}
const ws = (base: TreeEntry[], baseFiles: Record<string, string>, diff: DiffFile[], files: Record<string, string>): Workspace =>
  ({ diff, tree: treeWith(base, diff, files), files: { ...baseFiles, ...files } });

// ─────────────────────────────── compete ───────────────────────────────

const CSV_CODEX = `import type { Response } from 'express';

const FORMULA = /^[=+\\-@\\t\\r]/;

/** RFC 4180 field: quote when needed, double embedded quotes, neutralise spreadsheet formulas. */
export function csvField(v: unknown): string {
  let s = v == null ? '' : String(v);
  if (FORMULA.test(s)) s = \`'\${s}\`;
  return /[",\\r\\n]/.test(s) ? \`"\${s.replace(/"/g, '""')}"\` : s;
}

/** Streams rows as CSV without buffering the whole export in memory. */
export async function streamCsv(res: Response, header: string[], rows: AsyncIterable<unknown[]>) {
  res.setHeader('Content-Type', 'text/csv');
  res.write(header.map(csvField).join(',') + '\\r\\n');
  for await (const row of rows) res.write(row.map(csvField).join(',') + '\\r\\n');
  res.end();
}
`;

const CSV_CLAUDE = `/** RFC 4180 encoding as a pure function, so it is testable without HTTP. */
export function encodeField(value: unknown): string {
  const s = value == null ? '' : value instanceof Date ? value.toISOString() : String(value);
  const guarded = /^[=+\\-@]/.test(s) ? \`'\${s}\` : s;
  return /[",\\r\\n]/.test(guarded) ? \`"\${guarded.replace(/"/g, '""')}"\` : guarded;
}

export function encodeRow(values: unknown[]): string {
  return values.map(encodeField).join(',') + '\\r\\n';
}

export function* encodeCsv(header: string[], rows: Iterable<unknown[]>): Generator<string> {
  yield encodeRow(header);
  for (const r of rows) yield encodeRow(r);
}
`;

const EXPORT_HANDLER_CLAUDE = `import type { Request, Response } from 'express';
import { encodeCsv } from '../lib/csv';
import { invoicesForUser } from '../db/invoices';

const HEADER = ['id', 'number', 'issued_at', 'amount_cents', 'currency', 'status'];

export async function exportInvoices(req: Request, res: Response) {
  const invoices = await invoicesForUser(req.user!.id);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="invoices.csv"');
  for (const chunk of encodeCsv(HEADER, invoices.map((i) => [i.id, i.number, i.issuedAt, i.amountCents, i.currency, i.status]))) res.write(chunk);
  res.end();
}
`;

const CSV_TEST_CLAUDE = `import { describe, it, expect } from 'vitest';
import { encodeField, encodeRow } from '../src/lib/csv';

describe('encodeField', () => {
  it('doubles embedded quotes', () => expect(encodeField('say "hi"')).toBe('"say ""hi"""'));
  it('quotes commas and newlines', () => expect(encodeField('a,b\\nc')).toBe('"a,b\\nc"'));
  it('neutralises formulas', () => expect(encodeField('=SUM(A1)')).toBe("'=SUM(A1)"));
  it('renders dates as ISO 8601', () => expect(encodeField(new Date(0))).toBe('1970-01-01T00:00:00.000Z'));
});

describe('encodeRow', () => {
  it('ends with CRLF', () => expect(encodeRow([1, 'x'])).toBe('1,x\\r\\n'));
});
`;

const EXPORT_TEST_CODEX = `import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { makeApp, loginAs } from './helpers';

describe('GET /invoices/export.csv', () => {
  it('streams the user\\'s invoices as CSV', async () => {
    const app = makeApp({ invoices: 3 });
    const res = await loginAs(app, 'ada').get('/invoices/export.csv').expect(200);
    expect(res.headers['content-type']).toMatch(/text\\/csv/);
    expect(res.text.split('\\r\\n')).toHaveLength(5);
  });

  it('returns only the header when there are no invoices', async () => {
    const res = await loginAs(makeApp(), 'ada').get('/invoices/export.csv').expect(200);
    expect(res.text).toBe('id,number,issued_at,amount_cents,currency,status\\r\\n');
  });

  it('escapes formula cells', async () => {
    const app = makeApp({ invoices: [{ number: '=HYPERLINK("x")' }] });
    const res = await loginAs(app, 'ada').get('/invoices/export.csv');
    expect(res.text).toContain(\`"'=HYPERLINK(""x"")"\`);
  });
});
`;

const ROUTE_CODEX = `@@ -1,9 +1,24 @@
 import { Router } from 'express';
 import { requireUser } from '../middleware/session';
 import { billingHandler } from '../handlers/billing';
+import { streamCsv } from '../lib/csv';
+import { iterateInvoices } from '../db/invoices';

 export const billing = Router();

 billing.get('/invoices', requireUser, billingHandler.list);
+
+const HEADER = ['id', 'number', 'issued_at', 'amount_cents', 'currency', 'status'];
+
+billing.get('/invoices/export.csv', requireUser, async (req, res, next) => {
+  try {
+    res.setHeader('Content-Disposition', 'attachment; filename="invoices.csv"');
+    const rows = iterateInvoices(req.user!.id, (i) => [i.id, i.number, i.issuedAt.toISOString(), i.amountCents, i.currency, i.status]);
+    await streamCsv(res, HEADER, rows);
+  } catch (e) {
+    next(e);
+  }
+});
+
 billing.post('/invoices/:id/pay', requireUser, billingHandler.pay);`;

const ROUTE_CLAUDE = `@@ -1,9 +1,11 @@
 import { Router } from 'express';
 import { requireUser } from '../middleware/session';
 import { billingHandler } from '../handlers/billing';
+import { exportInvoices } from '../handlers/invoicesExport';

 export const billing = Router();

 billing.get('/invoices', requireUser, billingHandler.list);
+billing.get('/invoices/export.csv', requireUser, exportInvoices);
 billing.post('/invoices/:id/pay', requireUser, billingHandler.pay);`;

const DB_CODEX = `@@ -12,6 +12,17 @@ export async function invoicesForUser(userId: string) {
   return db.select().from(invoices).where(eq(invoices.userId, userId)).orderBy(desc(invoices.issuedAt));
 }

+/** Pages through a user's invoices (500 at a time) so exports never load everything at once. */
+export async function* iterateInvoices<T>(userId: string, map: (i: Invoice) => T): AsyncGenerator<T> {
+  let offset = 0;
+  for (;;) {
+    const page = await db.select().from(invoices).where(eq(invoices.userId, userId)).orderBy(desc(invoices.issuedAt)).limit(500).offset(offset);
+    for (const i of page) yield map(i);
+    if (page.length < 500) return;
+    offset += page.length;
+  }
+}
+
 export async function markPaid(id: string) {`;

const COMPETE_TREE: TreeEntry[] = [...TREE.filter((e) => !e.changed).map((e) => ({ ...e })), { path: 'src/db', type: 'dir' }, { path: 'src/db/invoices.ts', type: 'file', size: 1460 }, { path: 'src/lib', type: 'dir' }];
const COMPETE_BASE_FILES: Record<string, string> = { 'README.md': FILES['README.md'], 'package.json': FILES['package.json'] };

const compCodexDiff = [added('src/lib/csv.ts', CSV_CODEX), df('src/routes/billing.ts', 'modified', ROUTE_CODEX), df('src/db/invoices.ts', 'modified', DB_CODEX), added('test/invoicesExport.test.ts', EXPORT_TEST_CODEX)];
const compClaudeDiff = [added('src/lib/csv.ts', CSV_CLAUDE), added('src/handlers/invoicesExport.ts', EXPORT_HANDLER_CLAUDE), df('src/routes/billing.ts', 'modified', ROUTE_CLAUDE), added('test/csv.test.ts', CSV_TEST_CLAUDE), added('test/invoicesExport.test.ts', EXPORT_TEST_CODEX.replace("'escapes formula cells'", "'sets a download filename'").replace(/const app = makeApp\(\{ invoices: \[[^\n]*\n[^\n]*\n[^\n]*\n/, "const res = await loginAs(makeApp(), 'ada').get('/invoices/export.csv');\n    expect(res.headers['content-disposition']).toContain('invoices.csv');\n"))];
const sum = (d: DiffFile[]) => ({ files: d.length, additions: d.reduce((n, f) => n + f.additions, 0), deletions: d.reduce((n, f) => n + f.deletions, 0) });

export function competeWorkspaces(): Workspaces {
  return {
    main: { diff: [], tree: COMPETE_TREE, files: COMPETE_BASE_FILES },
    codex: ws(COMPETE_TREE, COMPETE_BASE_FILES, compCodexDiff, { 'src/lib/csv.ts': CSV_CODEX, 'test/invoicesExport.test.ts': EXPORT_TEST_CODEX }),
    claude: ws(COMPETE_TREE, COMPETE_BASE_FILES, compClaudeDiff, { 'src/lib/csv.ts': CSV_CLAUDE, 'src/handlers/invoicesExport.ts': EXPORT_HANDLER_CLAUDE, 'test/csv.test.ts': CSV_TEST_CLAUDE }),
  };
}

const testOut = (passed: number, failed = 0, extra = '') => `${extra} ✓ test/login.test.ts (12)\n ✓ test/billing.test.ts (11)\n ${failed ? '✗' : '✓'} test/invoicesExport.test.ts (${passed - 23 + failed})${failed ? '\n   AssertionError: expected \'"say "hi""\' to be \'"say ""hi"""\'' : ''}\n\n Test Files  ${failed ? '1 failed | ' : ''}${failed ? 2 : 3} passed (3)\n      Tests  ${failed ? `${failed} failed | ` : ''}${passed} passed (${passed + failed})`;

export function competeFixture(): SessionSnapshot {
  const sid = 'ses_compete';
  const { list, ev } = mkEvents(sid);
  const at = (m: number) => 6 + m;
  ev('message', 'user', { id: 'k1', kind: 'chat', text: 'Add `GET /invoices/export.csv` that streams the signed-in user\'s invoices as CSV (RFC 4180 quoting, safe against spreadsheet formula injection). Include tests.' }, at(0));
  ev('phase', 'lina', { phase: 'implementing', round: 1, note: 'both agents build it independently' }, at(0.1));
  ev('turn', 'codex', { agent: 'codex', state: 'start', role: 'developer', phase: 'implementing', model: 'gpt-6.1-sol', variant: 'codex' }, at(0.1));
  ev('turn', 'claude', { agent: 'claude', state: 'start', role: 'developer', phase: 'implementing', model: 'claude-opus-5-5', variant: 'claude' }, at(0.1));
  ev('activity', 'codex', { agent: 'codex', id: 'k-a1', kind: 'read', title: 'src/routes/billing.ts', state: 'ok', source: 'observed' }, at(0.4));
  ev('activity', 'claude', { agent: 'claude', id: 'k-b1', kind: 'read', title: 'src/handlers/billing.ts', state: 'ok', source: 'observed' }, at(0.5));
  ev('activity', 'codex', { agent: 'codex', id: 'k-a2', kind: 'note', title: 'Streaming with a small hand-written encoder and paging through the DB — no new dependency.', state: 'ok', source: 'narrated' }, at(0.8));
  ev('activity', 'claude', { agent: 'claude', id: 'k-b2', kind: 'note', title: 'Keeping the CSV encoder a pure function so it can be tested without HTTP.', state: 'ok', source: 'narrated' }, at(0.9));
  ev('activity', 'codex', { agent: 'codex', id: 'k-a3', kind: 'write', title: 'src/lib/csv.ts', state: 'ok', files: ['src/lib/csv.ts'], source: 'observed' }, at(2));
  ev('activity', 'claude', { agent: 'claude', id: 'k-b3', kind: 'write', title: 'src/lib/csv.ts', state: 'ok', files: ['src/lib/csv.ts'], source: 'observed' }, at(2.2));
  ev('activity', 'codex', { agent: 'codex', id: 'k-a4', kind: 'edit', title: 'src/routes/billing.ts', state: 'ok', files: ['src/routes/billing.ts', 'src/db/invoices.ts'], source: 'observed' }, at(2.8));
  ev('activity', 'claude', { agent: 'claude', id: 'k-b4', kind: 'write', title: 'src/handlers/invoicesExport.ts', state: 'ok', files: ['src/handlers/invoicesExport.ts', 'test/csv.test.ts'], source: 'observed' }, at(3.1));
  ev('message', 'codex', { id: 'k2', kind: 'chat', role: 'developer', model: 'gpt-6.1-sol', variant: 'codex', text: 'Done in my worktree. `iterateInvoices` pages 500 rows at a time and `streamCsv` writes as it goes, so a 100k-invoice export stays flat in memory. Formula-looking cells get a leading `\'`.' }, at(4));
  ev('turn', 'codex', { agent: 'codex', state: 'end', role: 'developer', phase: 'implementing', model: 'gpt-6.1-sol', variant: 'codex', ok: true, durationMs: 232_000 }, at(4));
  ev('checkpoint', 'lina', { commit: 'b7d0e2c41a', message: 'Streaming CSV export', variant: 'codex', files: [{ path: 'src/lib/csv.ts', additions: 19, deletions: 0, status: 'A' }, { path: 'src/routes/billing.ts', additions: 13, deletions: 0, status: 'M' }, { path: 'src/db/invoices.ts', additions: 11, deletions: 0, status: 'M' }, { path: 'test/invoicesExport.test.ts', additions: 16, deletions: 0, status: 'A' }] }, at(4.1));
  ev('message', 'claude', { id: 'k3', kind: 'chat', role: 'developer', model: 'claude-opus-5-5', variant: 'claude', text: 'Implemented as a pure `encodeCsv` generator plus a thin handler. Dates are ISO 8601, the download gets a filename, and the encoder has its own unit tests.' }, at(4.6));
  ev('turn', 'claude', { agent: 'claude', state: 'end', role: 'developer', phase: 'implementing', model: 'claude-opus-5-5', variant: 'claude', ok: true, durationMs: 268_000 }, at(4.6));
  ev('checkpoint', 'lina', { commit: '3c19f8a2d6', message: 'CSV encoder + export handler', variant: 'claude', files: [{ path: 'src/lib/csv.ts', additions: 16, deletions: 0, status: 'A' }, { path: 'src/handlers/invoicesExport.ts', additions: 15, deletions: 0, status: 'A' }, { path: 'src/routes/billing.ts', additions: 2, deletions: 0, status: 'M' }, { path: 'test/csv.test.ts', additions: 15, deletions: 0, status: 'A' }, { path: 'test/invoicesExport.test.ts', additions: 14, deletions: 0, status: 'A' }] }, at(4.7));

  ev('phase', 'lina', { phase: 'testing', round: 1, note: 'each worktree separately' }, at(4.8));
  ev('tests', 'lina', { command: 'npm test', exitCode: 0, ok: true, durationMs: 9_120, passed: 26, failed: 0, sandboxed: true, variant: 'codex', output: testOut(26) }, at(5.0));
  ev('tests', 'lina', { command: 'npm test', exitCode: 1, ok: false, durationMs: 9_870, passed: 30, failed: 1, sandboxed: true, variant: 'claude', output: testOut(30, 1) }, at(5.2));

  ev('phase', 'lina', { phase: 'reviewing', round: 1, note: 'each reviews the other\'s version' }, at(5.3));
  ev('turn', 'codex', { agent: 'codex', state: 'start', role: 'reviewer', phase: 'reviewing', model: 'gpt-6.1-sol', variant: 'claude' }, at(5.3));
  ev('turn', 'claude', { agent: 'claude', state: 'start', role: 'reviewer', phase: 'reviewing', model: 'claude-opus-5-5', variant: 'codex' }, at(5.3));
  ev('activity', 'codex', { agent: 'codex', id: 'k-a5', kind: 'command', title: 'git diff --stat lina/c0mp3t-claude', state: 'ok', exitCode: 0, output: ' 5 files changed, 62 insertions(+)', source: 'observed' }, at(5.6));
  ev('activity', 'claude', { agent: 'claude', id: 'k-b5', kind: 'read', title: 'src/lib/csv.ts', state: 'ok', source: 'observed' }, at(5.7));
  const c1 = F({ id: 'C1', severity: 'blocker', title: 'Embedded quotes are not doubled in one path', detail: 'encodeField guards formulas first and then quotes — but the failing test shows `say "hi"` comes out with single quotes inside.', file: 'src/lib/csv.ts', line: 4, status: 'open', round: 1, raisedBy: 'codex', owner: 'claude', variant: 'claude' });
  const c2 = F({ id: 'C2', severity: 'nit', title: 'Header uses snake_case while the JSON API is camelCase', detail: 'Mixed naming across the export and the API.', file: 'src/handlers/invoicesExport.ts', line: 5, status: 'open', round: 1, raisedBy: 'codex', owner: 'claude', variant: 'claude' });
  ev('message', 'codex', { id: 'k4', kind: 'review', role: 'reviewer', model: 'gpt-6.1-sol', variant: 'claude', text: 'Clean separation and good unit tests. One real bug: the quoting path fails its own test (`say "hi"`). Header naming is a nit.\n\n```lina-review\n{"verdict":"request_changes"}\n```' }, at(7));
  ev('review', 'codex', { round: 1, reviewer: 'codex', verdict: 'request_changes', variant: 'claude', summary: 'Quote doubling bug (failing test); naming nit.', findings: [c1, c2] }, at(7));
  const c3 = F({ id: 'C3', severity: 'major', title: 'Tab-prefixed cells bypass the formula guard', detail: 'Excel treats a leading tab + = as a formula in some locales; the regex includes \\t but the test does not cover it.', file: 'src/lib/csv.ts', line: 3, status: 'open', round: 1, raisedBy: 'claude', owner: 'codex', variant: 'codex' });
  const c4 = F({ id: 'C4', severity: 'minor', title: 'No test for an empty export', detail: 'Header-only output is the common first-run case.', file: 'test/invoicesExport.test.ts', status: 'open', round: 1, raisedBy: 'claude', owner: 'codex', variant: 'codex' });
  ev('message', 'claude', { id: 'k5', kind: 'review', role: 'reviewer', model: 'claude-opus-5-5', variant: 'codex', text: 'The streaming design is the right call for large accounts. Two gaps in the tests: the formula guard and the empty export.' }, at(7.4));
  ev('review', 'claude', { round: 1, reviewer: 'claude', verdict: 'request_changes', variant: 'codex', summary: 'Solid streaming design; formula guard and empty-export tests missing.', findings: [c1, c2, c3, c4] }, at(7.4));

  ev('phase', 'lina', { phase: 'revising', round: 1 }, at(7.6));
  ev('turn', 'codex', { agent: 'codex', state: 'start', role: 'developer', phase: 'revising', model: 'gpt-6.1-sol', variant: 'codex' }, at(7.6));
  ev('turn', 'claude', { agent: 'claude', state: 'start', role: 'developer', phase: 'revising', model: 'claude-opus-5-5', variant: 'claude' }, at(7.6));
  ev('response', 'codex', { round: 1, developer: 'codex', items: [{ id: 'C3', action: 'fixed', note: 'Covered by a new test; regex now anchored on the trimmed-left value.' }, { id: 'C4', action: 'fixed', note: 'Added a header-only test.' }] }, at(9));
  ev('checkpoint', 'lina', { commit: 'd41e7a0b93', message: 'Formula guard + empty export tests', variant: 'codex', files: [{ path: 'src/lib/csv.ts', additions: 2, deletions: 1, status: 'M' }, { path: 'test/invoicesExport.test.ts', additions: 10, deletions: 0, status: 'M' }] }, at(9.1));
  ev('response', 'claude', { round: 1, developer: 'claude', items: [{ id: 'C1', action: 'fixed', note: 'Quote first, then guard — order was inverted.' }, { id: 'C2', action: 'disputed', note: 'snake_case matches the column names finance already imports from the legacy export.' }] }, at(9.4));
  ev('checkpoint', 'lina', { commit: '8a2f6c1e57', message: 'Double embedded quotes before guarding', variant: 'claude', files: [{ path: 'src/lib/csv.ts', additions: 3, deletions: 2, status: 'M' }] }, at(9.5));
  ev('phase', 'lina', { phase: 'testing', round: 2 }, at(9.6));
  const codexTests: TestRun = { command: 'npm test', exitCode: 0, ok: true, durationMs: 8_840, passed: 28, failed: 0, sandboxed: false, variant: 'codex', output: testOut(28, 0, '[LINA] The test sandbox could not start (bwrap: setting up uid map: Permission denied); ran the tests WITHOUT the sandbox.\n') };
  const claudeTests: TestRun = { command: 'npm test', exitCode: 0, ok: true, durationMs: 9_460, passed: 31, failed: 0, sandboxed: true, variant: 'claude', output: testOut(31) };
  ev('tests', 'lina', codexTests, at(9.8));
  ev('tests', 'lina', claudeTests, at(10));

  ev('phase', 'lina', { phase: 'reviewing', round: 2 }, at(10.1));
  ev('turn', 'codex', { agent: 'codex', state: 'start', role: 'reviewer', phase: 'reviewing', model: 'gpt-6.1-sol', variant: 'claude' }, at(10.1));
  ev('turn', 'claude', { agent: 'claude', state: 'start', role: 'reviewer', phase: 'reviewing', model: 'claude-opus-5-5', variant: 'codex' }, at(10.1));
  const c5 = F({ id: 'C5', severity: 'nit', title: 'Declare charset=utf-8 on the Content-Type', detail: 'Excel on Windows guesses the encoding otherwise.', file: 'src/lib/csv.ts', line: 14, status: 'open', round: 2, raisedBy: 'claude', owner: 'codex', variant: 'codex' });
  const fin: Finding[] = [{ ...c1, status: 'resolved' }, { ...c2, status: 'withdrawn' }, { ...c3, status: 'resolved' }, { ...c4, status: 'resolved' }, c5];
  ev('message', 'codex', { id: 'k6', kind: 'review', role: 'reviewer', model: 'gpt-6.1-sol', variant: 'claude', text: 'C1 is fixed and tested. Fair point on C2 — withdrawn.' }, at(11.2));
  ev('review', 'codex', { round: 2, reviewer: 'codex', verdict: 'approve', variant: 'claude', summary: 'Approve.', findings: [fin[0], fin[1], c3, c4] }, at(11.2));
  ev('turn', 'codex', { agent: 'codex', state: 'end', role: 'reviewer', phase: 'reviewing', model: 'gpt-6.1-sol', variant: 'claude', ok: true, durationMs: 64_000 }, at(11.2));
  ev('message', 'claude', { id: 'k7', kind: 'review', role: 'reviewer', model: 'claude-opus-5-5', variant: 'codex', text: 'C3 and C4 are resolved. One nit left (charset); not blocking.' }, at(11.5));
  ev('review', 'claude', { round: 2, reviewer: 'claude', verdict: 'approve', variant: 'codex', summary: 'Approve with a nit.', findings: fin }, at(11.5));
  ev('turn', 'claude', { agent: 'claude', state: 'end', role: 'reviewer', phase: 'reviewing', model: 'claude-opus-5-5', variant: 'codex', ok: true, durationMs: 81_000 }, at(11.5));

  ev('phase', 'lina', { phase: 'verifying', round: 2 }, at(11.6));
  const cs = sum(compCodexDiff), ls = sum(compClaudeDiff);
  const codexUsage = usage(301_200, 14_900, 210_000, 2.11, 3), claudeUsage = usage(276_400, 17_800, 188_000, 2.37, 3);
  const summary = `**Two candidates for \`GET /invoices/export.csv\`** — both approved by the other agent.\n\n| | Codex | Claude |\n|---|---|---|\n| Tests | ${codexTests.passed} passed · **not sandboxed** | ${claudeTests.passed} passed · sandboxed |\n| Diff | ${cs.files} files, +${cs.additions} −${cs.deletions} | ${ls.files} files, +${ls.additions} −${ls.deletions} |\n| Open findings | 1 nit | none |\n| Approach | streams rows from a paged DB cursor | builds rows in memory, pure encoder |\n\nCodex's version scales to very large accounts; Claude's has broader unit tests and a download filename.`;
  ev('message', 'lina', { id: 'k8', kind: 'summary', text: summary }, at(11.8));
  ev('phase', 'lina', { phase: 'awaiting_approval', round: 2 }, at(11.9));
  ev('approval', 'lina', {
    state: 'requested', summary, unresolved: [c5],
    candidates: [
      { agent: 'codex', headCommit: 'd41e7a0b93', ...cs, tests: codexTests, openFindings: 1, blockingFindings: 0, verdict: 'approve', usage: codexUsage },
      { agent: 'claude', headCommit: '8a2f6c1e57', ...ls, tests: claudeTests, openFindings: 0, blockingFindings: 0, verdict: 'approve', usage: claudeUsage },
    ],
  }, at(11.9));

  const session = baseSession(sid, 'prj_atlas', 'CSV export for invoices', {
    status: 'awaiting_approval', phase: 'awaiting_approval', round: 2, lastSeq: list.length, branch: 'lina/c0mp3t', baseCommit: '5be12a90c4',
    updatedAt: Date.now() - 4 * MIN, createdAt: T0 + 6 * MIN,
    config: { mode: 'compete', developer: 'codex', reviewer: 'claude', models: { codex: { model: 'gpt-6.1-sol', effort: 'high' }, claude: { model: 'opus' }, freebuff: { model: 'auto' } }, maxRounds: 3, network: false },
    usage: { codex: codexUsage, claude: claudeUsage, freebuff: usage(0, 0, 0, 0, 0) },
    variants: {
      codex: { agent: 'codex', branch: 'lina/c0mp3t-codex', workspacePath: '/home/sam/.lina/workspaces/ses_compete--codex', baseCommit: '5be12a90c4', headCommit: 'd41e7a0b93' },
      claude: { agent: 'claude', branch: 'lina/c0mp3t-claude', workspacePath: '/home/sam/.lina/workspaces/ses_compete--claude', baseCommit: '5be12a90c4', headCommit: '8a2f6c1e57' },
    },
  });
  return {
    session, project: PROJECTS[0], events: list, findings: fin,
    live: {
      agents: {
        codex: { status: 'done', role: 'reviewer', since: Date.now() - 5 * MIN, model: 'gpt-6.1-sol' },
        claude: { status: 'done', role: 'reviewer', since: Date.now() - 5 * MIN, model: 'claude-opus-5-5' },
        freebuff: { status: 'idle', since: Date.now() - 5 * MIN },
      },
      streams: {}, rateLimits: {},
    },
  };
}

// ─────────────────────────────── parallel ───────────────────────────────

const LUMEN_TREE: TreeEntry[] = [
  ...['src', 'src/api', 'src/components', 'src/db', 'src/db/migrations', 'src/lib', 'src/pages', 'src/pages/settings', 'src/types', 'test'].map((p) => ({ path: p, type: 'dir' as const })),
  { path: 'package.json', type: 'file', size: 1320 }, { path: 'README.md', type: 'file', size: 410 },
  { path: 'src/api/index.ts', type: 'file', size: 880 }, { path: 'src/api/billing.ts', type: 'file', size: 2400 },
  { path: 'src/components/Button.tsx', type: 'file', size: 1100 }, { path: 'src/components/Dialog.tsx', type: 'file', size: 2300 },
  { path: 'src/db/client.ts', type: 'file', size: 640 }, { path: 'src/db/migrations/013_invoices.sql', type: 'file', size: 720 },
  { path: 'src/lib/api.ts', type: 'file', size: 1530 }, { path: 'src/pages/settings/Billing.tsx', type: 'file', size: 3900 },
  { path: 'src/types/billing.ts', type: 'file', size: 980 }, { path: 'test/billing.test.ts', type: 'file', size: 2700 },
];

const SEATS_API = `import { Router } from 'express';
import { requireAdmin } from './auth';
import { db } from '../db/client';
import type { Seat } from '../types/billing';

export const seats = Router();

seats.get('/', requireAdmin, async (req, res) => {
  const rows: Seat[] = await db.seats.list(req.workspace.id);
  res.json(rows);
});

seats.post('/invite', requireAdmin, async (req, res) => {
  const email = String(req.body.email ?? '').trim().toLowerCase();
  if (!/^[^@\\s]+@[^@\\s]+$/.test(email)) return res.status(400).json({ error: 'invalid_email' });
  res.status(201).json(await db.seats.invite(req.workspace.id, email, req.body.role ?? 'member'));
});

seats.delete('/:userId', requireAdmin, async (req, res) => {
  const admins = await db.seats.countAdmins(req.workspace.id);
  const target = await db.seats.get(req.workspace.id, req.params.userId);
  if (target?.role === 'admin' && admins <= 1) return res.status(409).json({ error: 'last_admin' });
  await db.seats.remove(req.workspace.id, req.params.userId);
  res.status(204).end();
});
`;
const SEATS_SQL = `CREATE TABLE seats (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id      TEXT,
  email        TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  invited_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, email)
);
`;
const SEATS_PAGE = `import { useEffect, useState } from 'react';
import { listSeats, inviteSeat, removeSeat } from '../../lib/api';
import { SeatTable } from '../../components/SeatTable';
import type { SeatRow } from '../../types/billing';

export function Seats() {
  const [rows, setRows] = useState<SeatRow[] | null>(null);
  const [email, setEmail] = useState('');
  useEffect(() => { void listSeats().then(setRows); }, []);
  const invite = async () => { await inviteSeat(email); setEmail(''); setRows(await listSeats()); };
  return (
    <section className="settings-section">
      <h2>Seats</h2>
      <form onSubmit={(e) => { e.preventDefault(); void invite(); }}>
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" />
        <button type="submit">Invite</button>
      </form>
      {rows && <SeatTable rows={rows} onRemove={async (id) => { await removeSeat(id); setRows(await listSeats()); }} />}
    </section>
  );
}
`;
const SEAT_TABLE = `import { useState } from 'react';
import type { SeatRow } from '../types/billing';
import { Dialog } from './Dialog';

export function SeatTable({ rows, onRemove }: { rows: SeatRow[]; onRemove: (userId: string) => void }) {
  const [confirm, setConfirm] = useState<SeatRow | null>(null);
  if (!rows.length) return <p className="muted">No one else here yet — invite a teammate.</p>;
  return (
    <>
      <table className="seats">
        <tbody>
          {rows.map((r) => (
            <tr key={r.email}><td>{r.email}</td><td>{r.role}</td><td><button onClick={() => setConfirm(r)}>Remove</button></td></tr>
          ))}
        </tbody>
      </table>
      {confirm && <Dialog title={\`Remove \${confirm.email}?\`} onConfirm={() => { onRemove(confirm.userId!); setConfirm(null); }} onClose={() => setConfirm(null)} />}
    </>
  );
}
`;
const TYPES_CODEX = `@@ -18,3 +18,11 @@ export interface Invoice {
   status: 'open' | 'paid' | 'void';
 }
+
+export type SeatRole = 'admin' | 'member';
+export interface Seat {
+  userId: string | null;
+  email: string;
+  role: SeatRole;
+  invitedAt: string;
+}`;
const TYPES_CLAUDE = `@@ -18,3 +18,9 @@ export interface Invoice {
   status: 'open' | 'paid' | 'void';
 }
+
+/** A row in the Seats settings table. */
+export interface SeatRow {
+  userId?: string;
+  email: string;
+  role: 'admin' | 'member';
+}`;
const TYPES_MERGED = `@@ -18,3 +18,15 @@ export interface Invoice {
   status: 'open' | 'paid' | 'void';
 }
+
+export type SeatRole = 'admin' | 'member';
+export interface Seat {
+  userId: string | null;
+  email: string;
+  role: SeatRole;
+  invitedAt: string;
+}
+
+/** A row in the Seats settings table. */
+export type SeatRow = Pick<Seat, 'email' | 'role'> & { userId?: string };`;
const API_CODEX = `@@ -4,6 +4,7 @@ export const ROUTES = {
   invoices: '/api/invoices',
   billing: '/api/billing',
+  seats: '/api/seats',
 } as const;
 `;
const API_CLAUDE = `@@ -4,6 +4,7 @@ export const ROUTES = {
   invoices: '/api/invoices',
   billing: '/api/billing',
+  seats: '/api/workspace/seats',
 } as const;

@@ -22,3 +23,9 @@ export async function payInvoice(id: string) {
   return post(\`\${ROUTES.invoices}/\${id}/pay\`);
 }
+
+export const listSeats = () => get<SeatRow[]>(ROUTES.seats);
+export const inviteSeat = (email: string) => post(\`\${ROUTES.seats}/invite\`, { email });
+export const removeSeat = (userId: string) => del(\`\${ROUTES.seats}/\${userId}\`);`;
const API_MERGED = `@@ -4,6 +4,7 @@ export const ROUTES = {
   invoices: '/api/invoices',
   billing: '/api/billing',
+  seats: '/api/seats',
 } as const;

@@ -22,3 +23,9 @@ export async function payInvoice(id: string) {
   return post(\`\${ROUTES.invoices}/\${id}/pay\`);
 }
+
+export const listSeats = () => get<SeatRow[]>(ROUTES.seats);
+export const inviteSeat = (email: string) => post(\`\${ROUTES.seats}/invite\`, { email });
+export const removeSeat = (userId: string) => del(\`\${ROUTES.seats}/\${userId}\`);`;
const INDEX_CODEX = `@@ -1,8 +1,10 @@
 import { Router } from 'express';
 import { billing } from './billing';
+import { seats } from './seats';

 export const api = Router();
 api.use('/billing', billing);
+api.use('/seats', seats);`;

const parCodex = [added('src/api/seats.ts', SEATS_API), df('src/api/index.ts', 'modified', INDEX_CODEX), added('src/db/migrations/014_seats.sql', SEATS_SQL), df('src/types/billing.ts', 'modified', TYPES_CODEX), df('src/lib/api.ts', 'modified', API_CODEX)];
const parClaude = [added('src/pages/settings/Seats.tsx', SEATS_PAGE), added('src/components/SeatTable.tsx', SEAT_TABLE), df('src/types/billing.ts', 'modified', TYPES_CLAUDE), df('src/lib/api.ts', 'modified', API_CLAUDE)];
const parMain = [parCodex[0], parCodex[1], parCodex[2], parClaude[0], parClaude[1], df('src/types/billing.ts', 'modified', TYPES_MERGED), df('src/lib/api.ts', 'modified', API_MERGED)];
const LUMEN_FILES: Record<string, string> = { 'README.md': '# lumen-web\n\nDashboard and settings for Lumen workspaces.\n', 'package.json': '{\n  "name": "lumen-web",\n  "private": true,\n  "scripts": { "test": "vitest run" }\n}\n' };

export function parallelWorkspaces(): Workspaces {
  const f = { 'src/api/seats.ts': SEATS_API, 'src/db/migrations/014_seats.sql': SEATS_SQL, 'src/pages/settings/Seats.tsx': SEATS_PAGE, 'src/components/SeatTable.tsx': SEAT_TABLE };
  return {
    main: ws(LUMEN_TREE, LUMEN_FILES, parMain, f),
    codex: ws(LUMEN_TREE, LUMEN_FILES, parCodex, { 'src/api/seats.ts': SEATS_API, 'src/db/migrations/014_seats.sql': SEATS_SQL }),
    claude: ws(LUMEN_TREE, LUMEN_FILES, parClaude, { 'src/pages/settings/Seats.tsx': SEATS_PAGE, 'src/components/SeatTable.tsx': SEAT_TABLE }),
  };
}

const ckFiles = (d: DiffFile[]) => d.map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions, status: f.status === 'added' ? 'A' : 'M' }));

export function parallelFixture(): SessionSnapshot {
  const sid = 'ses_parallel';
  const { list, ev } = mkEvents(sid);
  const at = (m: number) => 14 + m;
  ev('message', 'user', { id: 'p1', kind: 'chat', text: 'Let workspace admins manage seats: an API to list, invite and remove members, and a **Seats** page under Settings. Never allow removing the last admin.' }, at(0));
  ev('phase', 'lina', { phase: 'planning', round: 0 }, at(0.1));
  ev('turn', 'codex', { agent: 'codex', state: 'start', role: 'developer', phase: 'planning', model: 'gpt-6.1-sol' }, at(0.1));
  ev('activity', 'codex', { agent: 'codex', id: 'p-a1', kind: 'read', title: 'src/api/index.ts', state: 'ok', source: 'observed' }, at(0.3));
  ev('activity', 'codex', { agent: 'codex', id: 'p-a2', kind: 'search', title: 'rg -n "ROUTES" src', state: 'ok', source: 'observed' }, at(0.4));
  const parts = [
    { agent: 'codex' as const, title: 'Seats API and storage', scope: 'REST endpoints under /api/seats (list, invite, remove) with admin checks, the seats table migration, and the shared Seat type. Owns the last-admin rule.', files: ['src/api/seats.ts', 'src/api/index.ts', 'src/db/migrations/014_seats.sql', 'src/types/billing.ts'] },
    { agent: 'claude' as const, title: 'Seats settings page', scope: 'The Settings → Seats page: invite form, member table with remove + confirmation, empty state, and client helpers in lib/api.', files: ['src/pages/settings/Seats.tsx', 'src/components/SeatTable.tsx', 'src/lib/api.ts'] },
  ];
  ev('message', 'codex', { id: 'p2', kind: 'plan', role: 'developer', model: 'gpt-6.1-sol', text: `I'll split this along the API boundary so we never edit the same files:\n\n1. **Codex** — endpoints, migration, the \`Seat\` type and the last-admin rule.\n2. **Claude** — the Settings page and its API client.\n\nShared contract: \`GET/POST/DELETE /api/seats\`, rows shaped like \`Seat\`.\n\n\`\`\`lina-split\n${JSON.stringify({ parts })}\n\`\`\`` }, at(1.4));
  ev('split', 'codex', { lead: 'codex', parts }, at(1.4));
  ev('turn', 'codex', { agent: 'codex', state: 'end', role: 'developer', phase: 'planning', model: 'gpt-6.1-sol', ok: true, durationMs: 78_000 }, at(1.4));

  ev('phase', 'lina', { phase: 'implementing', round: 1, note: 'both parts at once' }, at(1.6));
  ev('turn', 'codex', { agent: 'codex', state: 'start', role: 'developer', phase: 'implementing', model: 'gpt-6.1-sol', variant: 'codex' }, at(1.6));
  ev('turn', 'claude', { agent: 'claude', state: 'start', role: 'developer', phase: 'implementing', model: 'claude-opus-5-5', variant: 'claude' }, at(1.6));
  ev('activity', 'codex', { agent: 'codex', id: 'p-a3', kind: 'write', title: 'src/api/seats.ts', state: 'ok', files: ['src/api/seats.ts'], source: 'observed' }, at(2.6));
  ev('activity', 'claude', { agent: 'claude', id: 'p-b1', kind: 'write', title: 'src/pages/settings/Seats.tsx', state: 'ok', files: ['src/pages/settings/Seats.tsx'], source: 'observed' }, at(2.8));
  ev('activity', 'claude', { agent: 'claude', id: 'p-b2', kind: 'note', title: 'I need a SeatRow type for the table — adding it next to Invoice.', state: 'ok', source: 'narrated' }, at(3.1));
  ev('activity', 'codex', { agent: 'codex', id: 'p-a4', kind: 'write', title: 'src/db/migrations/014_seats.sql', state: 'ok', files: ['src/db/migrations/014_seats.sql'], source: 'observed' }, at(3.3));
  ev('activity', 'claude', { agent: 'claude', id: 'p-b3', kind: 'write', title: 'src/components/SeatTable.tsx', state: 'ok', files: ['src/components/SeatTable.tsx'], source: 'observed' }, at(4.0));
  ev('turn', 'codex', { agent: 'codex', state: 'end', role: 'developer', phase: 'implementing', model: 'gpt-6.1-sol', variant: 'codex', ok: true, durationMs: 290_000 }, at(6.4));
  ev('checkpoint', 'lina', { commit: '61af0c9d24', message: 'Seats API, migration and Seat type', variant: 'codex', files: ckFiles(parCodex) }, at(6.5));
  ev('turn', 'claude', { agent: 'claude', state: 'end', role: 'developer', phase: 'implementing', model: 'claude-opus-5-5', variant: 'claude', ok: true, durationMs: 336_000 }, at(7.2));
  ev('checkpoint', 'lina', { commit: 'f0b83e5a17', message: 'Seats settings page and client helpers', variant: 'claude', files: ckFiles(parClaude) }, at(7.3));

  ev('phase', 'lina', { phase: 'integrating', round: 1 }, at(7.4));
  ev('integration', 'lina', { state: 'conflict', conflicts: ['src/types/billing.ts', 'src/lib/api.ts'], note: 'Both parts added a seat type and a seats route constant.' }, at(7.5));
  ev('turn', 'codex', { agent: 'codex', state: 'start', role: 'developer', phase: 'integrating', model: 'gpt-6.1-sol' }, at(7.5));
  ev('activity', 'codex', { agent: 'codex', id: 'p-a5', kind: 'edit', title: 'src/types/billing.ts', state: 'ok', files: ['src/types/billing.ts'], source: 'observed' }, at(8.2));
  ev('activity', 'codex', { agent: 'codex', id: 'p-a6', kind: 'note', title: 'Keeping my Seat type and deriving SeatRow from it; the route is /api/seats.', state: 'ok', source: 'narrated' }, at(8.4));
  ev('activity', 'codex', { agent: 'codex', id: 'p-a7', kind: 'edit', title: 'src/lib/api.ts', state: 'ok', files: ['src/lib/api.ts'], source: 'observed' }, at(8.6));
  ev('turn', 'codex', { agent: 'codex', state: 'end', role: 'developer', phase: 'integrating', model: 'gpt-6.1-sol', ok: true, durationMs: 71_000 }, at(8.7));
  ev('integration', 'lina', { state: 'resolved', commit: 'e9c4b21f08', conflicts: ['src/types/billing.ts', 'src/lib/api.ts'] }, at(8.8));

  ev('phase', 'lina', { phase: 'testing', round: 1 }, at(8.9));
  ev('tests', 'lina', { command: 'npm test', exitCode: 0, ok: true, durationMs: 14_300, passed: 58, failed: 0, sandboxed: true, output: ' ✓ test/billing.test.ts (31)\n ✓ test/seats.api.test.ts (14)\n ✓ test/SeatTable.test.tsx (13)\n\n Test Files  3 passed (3)\n      Tests  58 passed (58)' }, at(9.2));

  ev('phase', 'lina', { phase: 'reviewing', round: 1, note: 'cross-review' }, at(9.3));
  ev('turn', 'claude', { agent: 'claude', state: 'start', role: 'reviewer', phase: 'reviewing', model: 'claude-opus-5-5' }, at(9.3));
  ev('turn', 'codex', { agent: 'codex', state: 'start', role: 'reviewer', phase: 'reviewing', model: 'gpt-6.1-sol' }, at(9.3));
  const p1 = F({ id: 'P1', severity: 'major', title: 'Demoting the last admin to member is still allowed', detail: 'DELETE checks the last-admin rule, but POST /invite with role=member for an existing admin silently demotes them.', file: 'src/api/seats.ts', line: 14, status: 'open', round: 1, raisedBy: 'claude', owner: 'codex' });
  const p2 = F({ id: 'P2', severity: 'minor', title: 'Invites are case-sensitive on email', detail: 'Ada@x.com and ada@x.com create two seats.', file: 'src/api/seats.ts', line: 13, status: 'open', round: 1, raisedBy: 'claude', owner: 'codex' });
  ev('message', 'claude', { id: 'p3', kind: 'review', role: 'reviewer', model: 'claude-opus-5-5', variant: 'codex', text: 'Reviewed the API part. The DELETE path guards the last admin, but the invite path can demote them.' }, at(11));
  ev('review', 'claude', { round: 1, reviewer: 'claude', verdict: 'request_changes', summary: 'Last-admin rule has a hole via invite; email casing.', findings: [p1, p2] }, at(11));
  const p3 = F({ id: 'P3', severity: 'blocker', title: 'Remove deletes a member with one click', detail: 'No confirmation, no undo — an admin can lock a teammate out by mis-clicking.', file: 'src/components/SeatTable.tsx', line: 11, status: 'open', round: 1, raisedBy: 'codex', owner: 'claude' });
  const p4 = F({ id: 'P4', severity: 'nit', title: 'Empty state is a bare table', detail: 'Show a hint to invite the first teammate.', file: 'src/components/SeatTable.tsx', status: 'open', round: 1, raisedBy: 'codex', owner: 'claude' });
  ev('message', 'codex', { id: 'p4', kind: 'review', role: 'reviewer', model: 'gpt-6.1-sol', variant: 'claude', text: 'Reviewed the UI part. The table works, but removing a member needs a confirmation.' }, at(11.3));
  ev('review', 'codex', { round: 1, reviewer: 'codex', verdict: 'request_changes', summary: 'Destructive action without confirmation; empty state.', findings: [p1, p2, p3, p4] }, at(11.3));

  ev('phase', 'lina', { phase: 'revising', round: 1, note: 'each fixes the findings it owns' }, at(11.5));
  ev('response', 'codex', { round: 1, developer: 'codex', items: [{ id: 'P1', action: 'fixed', note: 'Role changes go through the same last-admin check.' }, { id: 'P2', action: 'fixed', note: 'Emails are trimmed and lower-cased.' }] }, at(13));
  ev('checkpoint', 'lina', { commit: '2d7e19b0ca', message: 'Guard last admin on role change; normalise invite emails', files: [{ path: 'src/api/seats.ts', additions: 6, deletions: 2, status: 'M' }] }, at(13.1));
  ev('response', 'claude', { round: 1, developer: 'claude', items: [{ id: 'P3', action: 'fixed', note: 'Remove opens a confirmation dialog naming the member.' }, { id: 'P4', action: 'fixed', note: 'Added an empty state that points to the invite form.' }] }, at(14.6));
  ev('checkpoint', 'lina', { commit: 'a83c5f2e61', message: 'Confirm before removing a member; empty state', files: [{ path: 'src/components/SeatTable.tsx', additions: 9, deletions: 3, status: 'M' }] }, at(14.7));
  ev('phase', 'lina', { phase: 'testing', round: 2 }, at(14.8));
  ev('tests', 'lina', { command: 'npm test', exitCode: 0, ok: true, durationMs: 14_900, passed: 61, failed: 0, sandboxed: true, output: ' ✓ test/billing.test.ts (31)\n ✓ test/seats.api.test.ts (16)\n ✓ test/SeatTable.test.tsx (14)\n\n Test Files  3 passed (3)\n      Tests  61 passed (61)' }, at(15.1));
  ev('phase', 'lina', { phase: 'reviewing', round: 2, note: 'cross-review' }, at(15.2));
  ev('turn', 'claude', { agent: 'claude', state: 'start', role: 'reviewer', phase: 'reviewing', model: 'claude-opus-5-5' }, at(15.2));
  ev('turn', 'codex', { agent: 'codex', state: 'start', role: 'reviewer', phase: 'reviewing', model: 'gpt-6.1-sol' }, at(15.2));
  ev('activity', 'claude', { agent: 'claude', id: 'p-b4', kind: 'read', title: 'src/api/seats.ts', state: 'ok', source: 'observed' }, at(15.5));
  ev('activity', 'codex', { agent: 'codex', id: 'p-a8', kind: 'read', title: 'src/components/SeatTable.tsx', state: 'ok', source: 'observed' }, at(15.6));
  const findings: Finding[] = [{ ...p1, status: 'fixed' }, { ...p2, status: 'fixed' }, { ...p3, status: 'fixed' }, { ...p4, status: 'fixed' }];
  ev('findings', 'lina', { findings }, at(15.7));

  const session = baseSession(sid, 'prj_lumen', 'Team seats: API + settings page', {
    status: 'running', phase: 'reviewing', round: 2, lastSeq: list.length, branch: 'lina/p4r411', baseCommit: '0c7a9e3b55', headCommit: 'a83c5f2e61',
    updatedAt: Date.now() - 15_000, createdAt: T0 + 14 * MIN,
    config: { mode: 'parallel', developer: 'codex', reviewer: 'claude', models: { codex: { model: 'gpt-6.1-sol', effort: 'medium' }, claude: { model: 'opus' }, freebuff: { model: 'auto' } }, maxRounds: 3, network: false },
    usage: { codex: usage(388_000, 19_200, 270_000, 2.64, 5), claude: usage(244_300, 15_700, 160_100, 1.98, 3), freebuff: usage(0, 0, 0, 0, 0) },
    variants: {
      codex: { agent: 'codex', branch: 'lina/p4r411-codex', workspacePath: '/home/sam/.lina/workspaces/ses_parallel--codex', baseCommit: '0c7a9e3b55', headCommit: '61af0c9d24', part: parts[0] },
      claude: { agent: 'claude', branch: 'lina/p4r411-claude', workspacePath: '/home/sam/.lina/workspaces/ses_parallel--claude', baseCommit: '0c7a9e3b55', headCommit: 'f0b83e5a17', part: parts[1] },
    },
  });
  return {
    session, project: PROJECTS[1], events: list, findings,
    live: {
      agents: {
        codex: { status: 'reviewing', detail: 'src/components/SeatTable.tsx', role: 'reviewer', since: Date.now() - 41_000, model: 'gpt-6.1-sol' },
        claude: { status: 'reading', detail: 'src/api/seats.ts', role: 'reviewer', since: Date.now() - 23_000, model: 'claude-opus-5-5' },
        freebuff: { status: 'idle', since: Date.now() - 41_000 },
      },
      streams: {}, rateLimits: {},
    },
  };
}

// ─────────────────────────────── custom team ───────────────────────────────

const RETRY_TS = `export interface RetryOptions { retries: number; baseMs: number; maxMs: number }

/** Full-jitter exponential backoff (AWS architecture blog), capped at maxMs. */
export function backoff(attempt: number, { baseMs, maxMs }: RetryOptions, rand = Math.random): number {
  return Math.round(rand() * Math.min(maxMs, baseMs * 2 ** attempt));
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions, isRetryable: (e: unknown) => boolean): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); } catch (e) {
      if (attempt >= opts.retries || !isRetryable(e)) throw e;
      await new Promise((r) => setTimeout(r, backoff(attempt, opts)));
    }
  }
}
`;
const TIDE_TREE: TreeEntry[] = [
  ...['src', 'src/commands', 'src/lib', 'test'].map((p) => ({ path: p, type: 'dir' as const })),
  { path: 'Cargo.toml', type: 'file', size: 300 }, { path: 'package.json', type: 'file', size: 720 },
  { path: 'src/cli.ts', type: 'file', size: 1800 }, { path: 'src/commands/sync.ts', type: 'file', size: 3100 }, { path: 'src/commands/status.ts', type: 'file', size: 1500 },
  { path: 'src/lib/http.ts', type: 'file', size: 1200 },
];
const SYNC_PATCH = `@@ -1,12 +1,17 @@
 import { fetchRemote, pushLocal } from '../lib/http';
+import { withRetry } from '../lib/retry';

+const RETRYABLE = new Set([429, 502, 503, 504]);
+const isRetryable = (e: unknown) => e instanceof HttpError ? RETRYABLE.has(e.status) : (e as NodeJS.ErrnoException)?.code === 'ECONNRESET';
+
 export async function sync(opts: SyncOptions) {
-  const remote = await fetchRemote(opts.url);
+  const retry = { retries: opts.retries ?? 4, baseMs: 250, maxMs: 8_000 };
+  const remote = await withRetry(() => fetchRemote(opts.url), retry, isRetryable);
   const plan = diff(remote, await readLocal(opts.dir));
-  await pushLocal(opts.url, plan);
+  await withRetry(() => pushLocal(opts.url, plan), retry, isRetryable);
   return plan;
 }`;
const customDiff = [added('src/lib/retry.ts', RETRY_TS), df('src/commands/sync.ts', 'modified', SYNC_PATCH), added('test/retry.test.ts', `import { describe, it, expect, vi } from 'vitest';\nimport { backoff, withRetry } from '../src/lib/retry';\n\ndescribe('backoff', () => {\n  it('is capped', () => expect(backoff(20, { retries: 0, baseMs: 250, maxMs: 8000 }, () => 1)).toBe(8000));\n});\n\ndescribe('withRetry', () => {\n  it('retries retryable errors then succeeds', async () => {\n    vi.useFakeTimers();\n    const fn = vi.fn().mockRejectedValueOnce(new Error('503')).mockResolvedValue('ok');\n    const p = withRetry(fn, { retries: 2, baseMs: 1, maxMs: 1 }, () => true);\n    await vi.runAllTimersAsync();\n    expect(await p).toBe('ok');\n  });\n});\n`)];

export function customWorkspaces(): Workspaces {
  return { main: ws(TIDE_TREE, { 'package.json': '{\n  "name": "tide-cli",\n  "bin": { "tide": "dist/cli.js" }\n}\n' }, customDiff, { 'src/lib/retry.ts': RETRY_TS }) };
}

export function customFixture(): SessionSnapshot {
  const sid = 'ses_custom';
  const { list, ev } = mkEvents(sid);
  const at = (m: number) => 22 + m;
  ev('message', 'user', { id: 'q1', kind: 'chat', text: '`tide sync` fails on flaky networks. Add retries with exponential backoff for 429/5xx and connection resets — configurable with `--retries`.' }, at(0));
  ev('phase', 'lina', { phase: 'planning', round: 0 }, at(0.1));
  ev('message', 'claude', { id: 'q2', kind: 'plan', model: 'claude-opus-5-5', text: '1. A tiny `withRetry(fn, opts, isRetryable)` in `src/lib/retry.ts` with **full-jitter** backoff.\n2. Wrap both the fetch and the push in `sync`.\n3. Retry only 429/502/503/504 and `ECONNRESET` — never 4xx.\n4. `--retries <n>` (default 4).' }, at(1.2));
  ev('phase', 'lina', { phase: 'plan_review', round: 0 }, at(1.3));
  ev('message', 'codex', { id: 'q3', kind: 'review', role: 'reviewer', model: 'gpt-6.1-sol', text: 'Plan is sound. One addition: honour `Retry-After` on 429 when present — otherwise we hammer a rate-limited server.' }, at(2.0));
  ev('phase', 'lina', { phase: 'implementing', round: 1 }, at(2.2));
  ev('activity', 'codex', { agent: 'codex', id: 'q-a1', kind: 'write', title: 'src/lib/retry.ts', state: 'ok', files: ['src/lib/retry.ts'], source: 'observed' }, at(3.4));
  ev('activity', 'codex', { agent: 'codex', id: 'q-a2', kind: 'edit', title: 'src/commands/sync.ts', state: 'ok', files: ['src/commands/sync.ts'], source: 'observed' }, at(3.9));
  ev('checkpoint', 'lina', { commit: '4b0e9d7c12', message: 'withRetry + backoff around sync', files: ckFiles(customDiff) }, at(5));
  ev('phase', 'lina', { phase: 'testing', round: 1 }, at(5.1));
  ev('tests', 'lina', { command: 'npm test', exitCode: 0, ok: true, durationMs: 4_210, passed: 19, failed: 0, sandboxed: true, output: ' ✓ test/sync.test.ts (14)\n ✓ test/retry.test.ts (5)\n\n Tests  19 passed (19)' }, at(5.3));
  ev('phase', 'lina', { phase: 'reviewing', round: 1, note: 'two reviewers' }, at(5.4));
  ev('turn', 'claude', { agent: 'claude', state: 'start', role: 'reviewer', phase: 'reviewing', model: 'claude-opus-5-5' }, at(5.4));
  ev('turn', 'codex', { agent: 'codex', state: 'start', role: 'reviewer', phase: 'reviewing', model: 'gpt-6.1-sol' }, at(5.4));
  const t1 = F({ id: 'T1', severity: 'major', title: 'Retry-After is ignored on 429', detail: 'The plan critique asked for it; the implementation always uses jittered backoff.', file: 'src/lib/retry.ts', line: 9, status: 'open', round: 1, raisedBy: 'claude', owner: 'codex' });
  const t2 = F({ id: 'T2', severity: 'minor', title: 'isRetryable is defined inline in sync.ts', detail: 'Self-review: move it next to withRetry so `tide pull` can reuse it.', file: 'src/commands/sync.ts', line: 5, status: 'open', round: 1, raisedBy: 'codex', owner: 'codex' });
  ev('review', 'claude', { round: 1, reviewer: 'claude', verdict: 'request_changes', summary: 'Retry-After not honoured.', findings: [t1] }, at(6.5));
  ev('review', 'codex', { round: 1, reviewer: 'codex', verdict: 'request_changes', summary: 'Self-review: one structural nit.', findings: [t1, t2] }, at(6.7));
  ev('phase', 'lina', { phase: 'revising', round: 1 }, at(6.8));
  ev('response', 'codex', { round: 1, developer: 'codex', items: [{ id: 'T1', action: 'fixed', note: 'Uses Retry-After (seconds or HTTP date) when present, capped at maxMs.' }, { id: 'T2', action: 'fixed', note: 'Moved to src/lib/retry.ts as isTransient().' }] }, at(8));
  ev('checkpoint', 'lina', { commit: '9e21a4f0bb', message: 'Honour Retry-After; share isTransient', files: [{ path: 'src/lib/retry.ts', additions: 12, deletions: 2, status: 'M' }, { path: 'src/commands/sync.ts', additions: 1, deletions: 3, status: 'M' }] }, at(8.1));
  ev('phase', 'lina', { phase: 'testing', round: 2 }, at(8.2));
  ev('tests', 'lina', { command: 'npm test', exitCode: 0, ok: true, durationMs: 4_480, passed: 22, failed: 0, sandboxed: true, output: ' ✓ test/sync.test.ts (14)\n ✓ test/retry.test.ts (8)\n\n Tests  22 passed (22)' }, at(8.4));
  ev('phase', 'lina', { phase: 'reviewing', round: 2, note: 'two reviewers' }, at(8.5));
  const fin: Finding[] = [{ ...t1, status: 'resolved' }, { ...t2, status: 'resolved' }];
  ev('review', 'claude', { round: 2, reviewer: 'claude', verdict: 'approve', summary: 'T1 resolved.', findings: [fin[0], { ...t2, status: 'fixed' }] }, at(9.4));
  ev('review', 'codex', { round: 2, reviewer: 'codex', verdict: 'approve', summary: 'T2 resolved.', findings: fin }, at(9.6));
  ev('phase', 'lina', { phase: 'verifying', round: 2 }, at(9.7));
  const summary = '**Retries with backoff for `tide sync`** — full-jitter exponential backoff, honours `Retry-After`, `--retries <n>` (default 4).\n\n- 3 files changed across 2 checkpoints\n- Tests: **22 passed** (verified by LINA, sandboxed)\n- Two reviewers (Claude, and Codex reviewing its own code read-only): both approve, 2 findings resolved';
  ev('message', 'lina', { id: 'q4', kind: 'summary', text: summary }, at(9.9));
  ev('phase', 'lina', { phase: 'awaiting_approval', round: 2 }, at(10));
  ev('approval', 'lina', { state: 'requested', summary, unresolved: [] }, at(10));

  const team = { planner: 'claude' as const, planCritic: 'codex' as const, developer: 'codex' as const, reviewers: ['claude' as const, 'codex' as const] };
  const session = baseSession(sid, 'prj_tide', 'Retry with backoff for `tide sync`', {
    status: 'awaiting_approval', phase: 'awaiting_approval', round: 2, lastSeq: list.length, branch: 'lina/cu5t0m', headCommit: '9e21a4f0bb',
    updatedAt: Date.now() - 9 * MIN, createdAt: T0 + 22 * MIN,
    config: { mode: 'custom', developer: 'codex', reviewer: 'claude', team, models: { codex: { model: 'gpt-6.1-sol', effort: 'medium' }, claude: { model: 'opus' }, freebuff: { model: 'auto' } }, maxRounds: 3, network: false },
    usage: { codex: usage(198_000, 9_300, 140_000, 1.31, 4), claude: usage(121_500, 6_100, 88_000, 0.92, 3), freebuff: usage(0, 0, 0, 0, 0) },
  });
  return {
    session, project: PROJECTS[2], events: list, findings: fin,
    live: { agents: { codex: { status: 'idle', since: Date.now() - 9 * MIN, model: 'gpt-6.1-sol' }, claude: { status: 'idle', since: Date.now() - 9 * MIN, model: 'claude-opus-5-5' }, freebuff: { status: 'idle', since: Date.now() - 9 * MIN } }, streams: {}, rateLimits: {} },
  };
}
