// Turns raw tool calls (shell commands, Claude tool_use blocks) into
// human-friendly activity kinds and titles.
import { isAbsolute, relative, resolve } from 'node:path';
import type { ActivityKind } from '../../shared/types.js';

export type CommandKind = 'read' | 'search' | 'test' | 'command' | 'git' | 'edit';

const TITLE_MAX = 160;

export function oneLine(s: string, max = TITLE_MAX): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

/**
 * Removes `bash -lc "…"` / `/bin/bash -lc '…'` / `sh -c …` wrappers, as emitted
 * by Codex (`/bin/bash -lc "sed -n '1,8p' README.md"`, `/bin/bash -lc 'cat x'`,
 * `/bin/bash -lc pwd`).
 */
export function unwrapShell(cmd: string): string {
  let s = cmd.trim();
  for (let i = 0; i < 3; i++) {
    const m = /^(?:\/usr)?(?:\/bin\/|\/usr\/bin\/env\s+)?(?:bash|sh|zsh|dash)\s+(-[a-zA-Z]*c[a-zA-Z]*)\s+([\s\S]+)$/.exec(s);
    if (!m) break;
    let body = m[2].trim();
    if (body.length >= 2 && body.startsWith('"') && body.endsWith('"')) {
      body = body.slice(1, -1).replace(/\\(["\\$`\n])/g, '$1');
    } else if (body.length >= 2 && body.startsWith("'") && body.endsWith("'")) {
      body = body.slice(1, -1).replace(/'\\''/g, "'");
    }
    s = body.trim();
  }
  return s;
}

interface Segment { tokens: string[]; redirectsToFile: boolean }

/** Very small shell lexer: splits on && || ; | and newlines outside quotes, tokenizes words, detects `>`/`>>` file redirections. */
function lex(cmd: string): Segment[] {
  const segs: Segment[] = [];
  let tokens: string[] = [];
  let cur = '';
  let hasCur = false;
  let redirectsToFile = false;
  let pendingRedirect = false;
  let i = 0;
  const pushWord = () => {
    if (!hasCur) return;
    if (pendingRedirect) {
      if (cur !== '/dev/null' && !cur.startsWith('&') && !/^\/dev\/std(out|err)$/.test(cur)) redirectsToFile = true;
      pendingRedirect = false;
    } else {
      tokens.push(cur);
    }
    cur = '';
    hasCur = false;
  };
  const endSeg = () => {
    pushWord();
    if (tokens.length || redirectsToFile) segs.push({ tokens, redirectsToFile });
    tokens = [];
    redirectsToFile = false;
    pendingRedirect = false;
  };
  while (i < cmd.length) {
    const c = cmd[i];
    if (c === "'") {
      const j = cmd.indexOf("'", i + 1);
      const end = j < 0 ? cmd.length : j;
      cur += cmd.slice(i + 1, end);
      hasCur = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < cmd.length && cmd[j] !== '"') { if (cmd[j] === '\\') j++; cur += cmd[j] ?? ''; j++; }
      hasCur = true;
      i = j + 1;
      continue;
    }
    if (c === '\\' && i + 1 < cmd.length) { cur += cmd[i + 1]; hasCur = true; i += 2; continue; }
    if (c === ' ' || c === '\t') { pushWord(); i++; continue; }
    if (c === '\n' || c === ';') { endSeg(); i++; continue; }
    if (c === '&' && cmd[i + 1] === '&') { endSeg(); i += 2; continue; }
    if (c === '|') { endSeg(); i += cmd[i + 1] === '|' ? 2 : 1; continue; }
    if (c === '&' && cmd[i + 1] === '>') { pushWord(); pendingRedirect = true; i += cmd[i + 2] === '>' ? 3 : 2; continue; }
    if (c === '>') {
      // fd prefix: "2>" → stderr; "1>"/">" → stdout.
      let fd = '';
      if (hasCur && /^\d+$/.test(cur)) { fd = cur; cur = ''; hasCur = false; } else pushWord();
      i += cmd[i + 1] === '>' ? 2 : 1;
      if (cmd[i] === '&') { // >&2, 2>&1
        i++;
        while (i < cmd.length && /[0-9-]/.test(cmd[i])) i++;
        continue;
      }
      if (fd === '' || fd === '1') pendingRedirect = true;
      else { // stderr redirection target: consume it without counting as a write
        while (cmd[i] === ' ') i++;
        while (i < cmd.length && !/[\s;&|]/.test(cmd[i])) i++;
      }
      continue;
    }
    if (c === '<') { pushWord(); i += cmd[i + 1] === '<' ? (cmd[i + 2] === '<' ? 3 : 2) : 1; continue; }
    if (c === '&') { endSeg(); i++; continue; }
    cur += c;
    hasCur = true;
    i++;
  }
  endSeg();
  return segs;
}

const READ_CMDS = new Set(['cat', 'head', 'tail', 'nl', 'less', 'more', 'wc', 'ls', 'tree', 'stat', 'file', 'bat', 'du', 'pwd', 'realpath', 'readlink', 'od', 'xxd', 'hexdump', 'jq']);
const SEARCH_CMDS = new Set(['rg', 'grep', 'egrep', 'fgrep', 'find', 'fd', 'fdfind', 'ag', 'ack', 'locate', 'git-grep']);
const RUNNER_PREFIXES = new Set(['npx', 'bunx', 'pnpx', 'time', 'nice', 'env', 'command', 'exec', 'timeout', 'stdbuf']);

/** Drops env assignments and wrapper programs like `npx`, `uv run`, `poetry run`, `timeout 60`. */
function core(tokens: string[]): string[] {
  let t = tokens.slice();
  for (let guard = 0; guard < 6 && t.length; guard++) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0])) { t = t.slice(1); continue; }
    if (t[0] === 'sudo') { t = t.slice(1); continue; }
    if (RUNNER_PREFIXES.has(t[0])) {
      const prefix = t[0];
      t = t.slice(1);
      while (t.length && t[0].startsWith('-') && t[0] !== '--') t = t.slice(1);
      if (prefix === 'timeout' && t.length && /^\d/.test(t[0])) t = t.slice(1);
      if (prefix === 'env') while (t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0])) t = t.slice(1);
      continue;
    }
    if ((t[0] === 'uv' || t[0] === 'poetry' || t[0] === 'pipenv' || t[0] === 'hatch' || t[0] === 'pdm') && t[1] === 'run') { t = t.slice(2); continue; }
    if ((t[0] === 'pnpm' || t[0] === 'yarn' || t[0] === 'bun') && t[1] === 'exec') { t = t.slice(2); continue; }
    break;
  }
  if (t.length) t[0] = t[0].replace(/^.*\//, ''); // /usr/bin/git → git
  return t;
}

function isTest(t: string[]): boolean {
  if (!t.length) return false;
  const [a, b, c] = t;
  if ((a === 'npm' || a === 'pnpm' || a === 'yarn' || a === 'bun') && (b === 'test' || b === 't')) return true;
  if ((a === 'npm' || a === 'pnpm' || a === 'yarn' || a === 'bun') && b === 'run' && /^test/.test(c ?? '')) return true;
  if ((a === 'yarn' || a === 'pnpm') && /^test[:-]/.test(b ?? '')) return true;
  if (['vitest', 'jest', 'pytest', 'py.test', 'mocha', 'ava', 'tap', 'nox', 'tox', 'phpunit', 'rspec'].includes(a)) return true;
  if (/^python[0-9.]*$/.test(a) && b === '-m' && ['pytest', 'unittest', 'nose2', 'tox'].includes(c ?? '')) return true;
  if (a === 'go' && b === 'test') return true;
  if (a === 'cargo' && (b === 'test' || b === 'nextest')) return true;
  if (a === 'make' && t.slice(1).some((x) => x === 'test' || x === 'check' || x === 'tests')) return true;
  if (a === 'node' && t.includes('--test')) return true;
  if (a === 'deno' && b === 'test') return true;
  if ((a === 'mvn' || a === 'gradle' || a === './gradlew' || a === 'gradlew') && t.includes('test')) return true;
  if (a === 'dotnet' && b === 'test') return true;
  if (a === 'ctest') return true;
  return false;
}

function isEdit(seg: Segment, t: string[]): boolean {
  if (seg.redirectsToFile) return true;
  if (!t.length) return false;
  const a = t[0];
  if (a === 'apply_patch' || a === 'applypatch' || a === 'tee') return true;
  if (a === 'sed' && t.some((x) => /^-[a-zA-Z]*i/.test(x) || x === '--in-place' || x.startsWith('--in-place='))) return true;
  if (a === 'perl' && t.some((x) => /^-[a-zA-Z]*i/.test(x))) return true;
  if (a === 'git' && t[1] === 'apply') return true;
  if (a === 'patch') return true;
  return false;
}

function kindOf(t: string[]): CommandKind | null {
  if (!t.length) return null;
  const a = t[0];
  if (a === 'git') return t[1] === 'grep' ? 'search' : 'git';
  if (SEARCH_CMDS.has(a)) return 'search';
  if (a === 'sed') return t.includes('-n') || t.some((x) => /^-[a-zA-Z]*n/.test(x)) ? 'read' : 'command';
  if (READ_CMDS.has(a)) return 'read';
  return null;
}

/** Classifies a shell command (Codex command_execution or Claude Bash) for display. */
export function classifyCommand(cmd: string): { kind: CommandKind; title: string } {
  const unwrapped = unwrapShell(cmd ?? '');
  const title = oneLine(unwrapped);
  if (/^\s*(?:apply_patch|applypatch)\b/.test(unwrapped) || /\*\*\* Begin Patch/.test(unwrapped)) return { kind: 'edit', title };
  let segs: Segment[];
  try { segs = lex(unwrapped); } catch { return { kind: 'command', title }; }
  // `cd dir && …` only changes directory; it is not the interesting part.
  const meaningful = segs.filter((s) => !(s.tokens[0] === 'cd' || s.tokens[0] === 'pushd' || s.tokens[0] === 'popd' || s.tokens[0] === 'set' || s.tokens[0] === 'export'));
  const list = meaningful.length ? meaningful : segs;
  const cores = list.map((s) => core(s.tokens));
  if (cores.some(isTest)) return { kind: 'test', title };
  if (list.some((s, i) => isEdit(s, cores[i]))) return { kind: 'edit', title };
  const k = kindOf(cores[0] ?? []);
  if (k) return { kind: k, title };
  return { kind: 'command', title };
}

/** Path relative to cwd when inside it, else absolute. */
export function displayPath(p: string, cwd: string): string {
  if (!p) return p;
  const abs = isAbsolute(p) ? p : resolve(cwd, p);
  const rel = relative(cwd, abs);
  if (!rel) return '.';
  if (rel.startsWith('..') || isAbsolute(rel)) return abs;
  return rel;
}

export interface ToolClassification { kind: ActivityKind; title: string; detail?: string; files?: string[] }

/** Classifies a Claude Code tool_use block. */
export function classifyClaudeTool(name: string, input: any, cwd: string): ToolClassification {
  const inp = input && typeof input === 'object' ? input : {};
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  switch (name) {
    case 'Read': {
      const p = displayPath(str(inp.file_path) || str(inp.path), cwd);
      const range = inp.offset || inp.limit ? ` (lines ${inp.offset ?? 1}${inp.limit ? `–${(inp.offset ?? 1) + inp.limit - 1}` : '+'})` : '';
      return { kind: 'read', title: oneLine(p + range), files: p ? [p] : undefined };
    }
    case 'Grep': {
      const where = str(inp.path) ? ` in ${displayPath(str(inp.path), cwd)}` : str(inp.glob) ? ` in ${str(inp.glob)}` : '';
      return { kind: 'search', title: oneLine(`grep ${str(inp.pattern)}${where}`) };
    }
    case 'Glob': {
      const where = str(inp.path) ? ` in ${displayPath(str(inp.path), cwd)}` : '';
      return { kind: 'search', title: oneLine(`${str(inp.pattern)}${where}`) };
    }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const p = displayPath(str(inp.file_path) || str(inp.notebook_path), cwd);
      return { kind: 'edit', title: oneLine(`Edit ${p}`), files: p ? [p] : undefined };
    }
    case 'Write': {
      const p = displayPath(str(inp.file_path), cwd);
      return { kind: 'write', title: oneLine(`Write ${p}`), files: p ? [p] : undefined };
    }
    case 'Bash': {
      const c = classifyCommand(str(inp.command));
      const kind: ActivityKind = c.kind;
      return { kind, title: c.title, detail: str(inp.description) || undefined };
    }
    case 'WebFetch':
      return { kind: 'web', title: oneLine(`Fetch ${str(inp.url)}`), detail: str(inp.prompt) ? oneLine(str(inp.prompt), 300) : undefined };
    case 'WebSearch':
      return { kind: 'web', title: oneLine(`Search: ${str(inp.query)}`) };
    case 'Task':
    case 'Agent':
      return { kind: 'tool', title: oneLine(`Subagent: ${str(inp.description) || str(inp.subagent_type) || 'task'}`), detail: str(inp.subagent_type) || undefined };
    case 'TodoWrite': {
      const todos = Array.isArray(inp.todos) ? inp.todos : [];
      const done = todos.filter((t: any) => t?.status === 'completed').length;
      return { kind: 'note', title: `Updated plan (${done}/${todos.length} done)` };
    }
    default: {
      const m = /^mcp__(.+?)__(.+)$/.exec(name);
      return { kind: 'tool', title: oneLine(m ? `${m[1]}: ${m[2]}` : name) };
    }
  }
}
