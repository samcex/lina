// Parses the structured blocks agents append to their final message:
//   ```lina-review { verdict, summary, findings[], resolved[], withdrawn[] } ```
//   ```lina-response { items: [{ id, action, note }] } ```
//   ```lina-split { parts: [{ agent, title, scope, files[] }] } ```   (parallel planning)
// The last matching block wins. Tolerates ```json fences, trailing commas, smart quotes, missing fields.
import type { AgentId, Severity, WorkPart } from '../shared/types.js';

export interface ParsedFinding {
  id?: string;
  severity: Severity;
  title: string;
  detail: string;
  file?: string;
  line?: number;
  suggestion?: string;
  /** parallel: the agent expected to fix it, when the reviewer says so. */
  owner?: AgentId;
}

export interface ParsedReview {
  verdict: 'approve' | 'request_changes';
  summary: string;
  findings: ParsedFinding[];
  resolved: string[];
  withdrawn: { id: string; reason: string }[];
}

export interface ParsedResponseItem { id: string; action: 'fixed' | 'disputed' | 'deferred'; note?: string }
export interface ParsedResponse { items: ParsedResponseItem[] }

export interface ParseOutcome<T> {
  /** Text with the structured block(s) removed — shown as the chat message. */
  prose: string;
  value?: T;
  error?: string;
}

interface Block { tag: string; body: string; start: number; end: number }

const FENCE_RE = /(^|\n)[ \t]*(`{3,}|~{3,})[ \t]*([\w-]*)[^\n]*\n([\s\S]*?)(?:\n[ \t]*\2[ \t]*(?=\n|$)|$)/g;

function findBlocks(text: string): Block[] {
  const out: Block[] = [];
  FENCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCE_RE.exec(text))) {
    const start = m.index + m[1].length;
    out.push({ tag: m[3].toLowerCase(), body: m[4], start, end: m.index + m[0].length });
    if (m[0].length === 0) FENCE_RE.lastIndex++;
  }
  return out;
}

/** Lenient JSON: strips BOM, comments, trailing commas, smart quotes; extracts the outermost object. */
export function lenientJson(src: string): unknown {
  let s = src.replace(/^﻿/, '').trim();
  const first = s.indexOf('{');
  if (first < 0) throw new Error('no JSON object');
  s = extractObject(s, first);
  try { return JSON.parse(s); } catch { /* try repairs */ }
  let r = s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  r = stripComments(r);
  r = r.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(r);
}

/** Returns the balanced {...} starting at `from` (string-aware); falls back to the rest. */
function extractObject(s: string, from: number): string {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return s.slice(from, i + 1); }
  }
  return s.slice(from);
}

function stripComments(s: string): string {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && s[i + 1] === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i++; continue; }
    out += c;
  }
  return out;
}

const SEVERITY_ALIASES: Record<string, Severity> = {
  blocker: 'blocker', critical: 'blocker', blocking: 'blocker', p0: 'blocker', severe: 'blocker',
  major: 'major', high: 'major', important: 'major', p1: 'major', error: 'major',
  minor: 'minor', medium: 'minor', moderate: 'minor', p2: 'minor', warning: 'minor', suggestion: 'minor',
  nit: 'nit', nitpick: 'nit', low: 'nit', trivial: 'nit', style: 'nit', p3: 'nit', info: 'nit', optional: 'nit',
};

export function normalizeSeverity(v: unknown): Severity {
  const k = String(v ?? '').toLowerCase().trim();
  return SEVERITY_ALIASES[k] ?? 'minor';
}

/** "f1", "F-1", "#F1", 1 → "F1"; anything else is kept as-is (trimmed). */
export function normalizeId(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v).trim();
  const m = /^#?\s*f?\s*-?\s*(\d+)$/i.exec(s);
  return m ? `F${Number(m[1])}` : s || undefined;
}

function str(v: unknown): string { return typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v); }

function stripBlocks(text: string, blocks: Block[]): string {
  let out = text;
  for (const b of [...blocks].sort((a, b2) => b2.start - a.start)) out = out.slice(0, b.start) + out.slice(b.end);
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

function pickBlock(text: string, tag: string, looksRight: (v: Record<string, unknown>) => boolean): { block?: Block; value?: Record<string, unknown>; error?: string; all: Block[] } {
  const blocks = findBlocks(text);
  const tagged = blocks.filter((b) => b.tag === tag);
  let error: string | undefined;
  for (const b of [...tagged].reverse()) {
    try {
      const v = lenientJson(b.body);
      if (v && typeof v === 'object' && !Array.isArray(v)) return { block: b, value: v as Record<string, unknown>, all: tagged };
      error = `${tag} block is not a JSON object`;
    } catch (e) { error = `${tag} block is not valid JSON: ${(e as Error).message}`; }
  }
  // Fallback: ```json (or untagged) fences that look like the expected object.
  for (const b of [...blocks].reverse()) {
    if (b.tag !== 'json' && b.tag !== '' && b.tag !== 'jsonc') continue;
    try {
      const v = lenientJson(b.body);
      if (v && typeof v === 'object' && !Array.isArray(v) && looksRight(v as Record<string, unknown>)) return { block: b, value: v as Record<string, unknown>, all: [...tagged, b] };
    } catch { /* not it */ }
  }
  return { error: error ?? `no ${tag} block found`, all: tagged };
}

export function parseReview(text: string): ParseOutcome<ParsedReview> {
  const { block, value, error, all } = pickBlock(text, 'lina-review', (v) => 'verdict' in v || 'findings' in v);
  let obj = value;
  let prose = stripBlocks(text, all);
  if (!obj) {
    // Last resort: an unfenced object containing "verdict".
    const idx = text.lastIndexOf('{"verdict"') >= 0 ? text.lastIndexOf('{"verdict"') : text.search(/\{\s*"verdict"\s*:/);
    if (idx >= 0) {
      try {
        const raw = extractObject(text, idx);
        obj = lenientJson(raw) as Record<string, unknown>;
        prose = (text.slice(0, idx) + text.slice(idx + raw.length)).trim();
      } catch { /* give up */ }
    }
  }
  if (!obj) return { prose: prose || text.trim(), error };
  void block;

  const rawFindings = Array.isArray(obj.findings) ? obj.findings : [];
  const findings: ParsedFinding[] = [];
  for (const rf of rawFindings) {
    if (!rf || typeof rf !== 'object') continue;
    const f = rf as Record<string, unknown>;
    const title = str(f.title) || str(f.summary) || str(f.issue) || firstWords(str(f.detail ?? f.description));
    const detail = str(f.detail ?? f.description ?? f.body ?? f.explanation);
    if (!title && !detail) continue;
    const out: ParsedFinding = { severity: normalizeSeverity(f.severity ?? f.level ?? f.priority), title: title || firstWords(detail), detail };
    const id = normalizeId(f.id);
    if (id) out.id = id;
    const file = str(f.file ?? f.path);
    if (file) out.file = file;
    const line = Number(f.line);
    if (Number.isInteger(line) && line > 0) out.line = line;
    const sug = str(f.suggestion ?? f.fix);
    if (sug) out.suggestion = sug;
    const owner = agentOf(f.owner);
    if (owner) out.owner = owner;
    findings.push(out);
  }
  const resolved = (Array.isArray(obj.resolved) ? obj.resolved : [])
    .map((x) => normalizeId(typeof x === 'object' && x ? (x as Record<string, unknown>).id : x)).filter((x): x is string => !!x);
  const withdrawn = (Array.isArray(obj.withdrawn) ? obj.withdrawn : [])
    .map((x) => {
      if (x && typeof x === 'object') {
        const o = x as Record<string, unknown>;
        const id = normalizeId(o.id);
        return id ? { id, reason: str(o.reason ?? o.note) } : undefined;
      }
      const id = normalizeId(x);
      return id ? { id, reason: '' } : undefined;
    }).filter((x): x is { id: string; reason: string } => !!x);

  const v = str(obj.verdict).toLowerCase().replace(/[\s-]+/g, '_');
  let verdict: ParsedReview['verdict'];
  if (['approve', 'approved', 'lgtm', 'accept', 'accepted', 'pass', 'ok'].includes(v)) verdict = 'approve';
  else if (['request_changes', 'changes_requested', 'reject', 'rejected', 'needs_changes', 'changes', 'revise', 'fail'].includes(v)) verdict = 'request_changes';
  else verdict = findings.some((f) => f.severity === 'blocker' || f.severity === 'major') ? 'request_changes' : 'approve';

  return { prose, value: { verdict, summary: str(obj.summary), findings, resolved, withdrawn } };
}

export function parseResponse(text: string): ParseOutcome<ParsedResponse> {
  const { value, error, all } = pickBlock(text, 'lina-response', (v) => 'items' in v);
  const prose = stripBlocks(text, all);
  if (!value) return { prose: prose || text.trim(), error };
  const raw = Array.isArray(value.items) ? value.items : Array.isArray(value.responses) ? value.responses : [];
  const items: ParsedResponseItem[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const id = normalizeId(o.id ?? o.finding);
    if (!id) continue;
    const a = str(o.action ?? o.status).toLowerCase();
    let action: ParsedResponseItem['action'];
    if (/^(fix|fixed|done|addressed|resolved|implemented)$/.test(a)) action = 'fixed';
    else if (/^(dispute|disputed|disagree|reject|rejected|wontfix|won't fix|wont_fix|declined)$/.test(a)) action = 'disputed';
    else if (/^(defer|deferred|later|postponed|skip|skipped)$/.test(a)) action = 'deferred';
    else action = 'fixed';
    const note = str(o.note ?? o.reason ?? o.comment);
    items.push(note ? { id, action, note } : { id, action });
  }
  return { prose, value: { items } };
}

export interface ParsedSplit { parts: WorkPart[] }

function agentOf(v: unknown): AgentId | undefined {
  const a = str(v).toLowerCase();
  return a === 'codex' || a === 'claude' ? a : undefined;
}

/** parallel: the lead's split — exactly one part per agent, each with a title or scope. */
export function parseSplit(text: string): ParseOutcome<ParsedSplit> {
  const { value, error, all } = pickBlock(text, 'lina-split', (v) => 'parts' in v);
  const prose = stripBlocks(text, all);
  if (!value) return { prose: prose || text.trim(), error };
  let raw = value.parts;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) raw = Object.entries(raw).map(([agent, p]) => ({ agent, ...(p && typeof p === 'object' ? p : { scope: p }) }));
  if (!Array.isArray(raw)) return { prose, error: 'lina-split block has no "parts" array' };
  const parts: WorkPart[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const agent = agentOf(o.agent ?? o.owner);
    if (!agent) return { prose, error: `lina-split part has an unknown agent: ${str(o.agent ?? o.owner) || '(none)'}` };
    if (parts.some((p) => p.agent === agent)) return { prose, error: `lina-split has two parts for ${agent}` };
    const title = str(o.title ?? o.name);
    const scope = str(o.scope ?? o.description ?? o.detail);
    if (!title && !scope) return { prose, error: `lina-split part for ${agent} has no title or scope` };
    const p: WorkPart = { agent, title: title || firstWords(scope, 60), scope: scope || title };
    const files = Array.isArray(o.files) ? o.files.map(str).filter(Boolean) : [];
    if (files.length) p.files = files;
    parts.push(p);
  }
  if (parts.length !== 2) return { prose, error: `lina-split needs exactly one part per agent (got ${parts.length})` };
  return { prose, value: { parts } };
}

function firstWords(s: string, n = 80): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}
