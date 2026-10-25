import { describe, expect, it } from 'vitest';
import { classifyClaudeTool, classifyCommand, unwrapShell } from '../../src/server/agents/classify.js';

describe('unwrapShell', () => {
  it('handles the quoting Codex emits', () => {
    expect(unwrapShell(`/bin/bash -lc "sed -n '1,8p' README.md"`)).toBe(`sed -n '1,8p' README.md`);
    expect(unwrapShell(`/bin/bash -lc 'cat README.md'`)).toBe('cat README.md');
    expect(unwrapShell('/bin/bash -lc pwd')).toBe('pwd');
    expect(unwrapShell(`/bin/bash -lc "printf 'hi' > hello.txt && cat hello.txt"`)).toBe(`printf 'hi' > hello.txt && cat hello.txt`);
    expect(unwrapShell(`bash -lc 'echo '\\''x'\\'''`)).toBe(`echo 'x'`);
    expect(unwrapShell(`sh -c "echo \\"hi\\""`)).toBe('echo "hi"');
    expect(unwrapShell('ls -la')).toBe('ls -la');
  });
});

describe('classifyCommand', () => {
  const k = (c: string) => classifyCommand(c).kind;
  it('detects tests', () => {
    for (const c of ['npm test', 'pnpm test', 'yarn test', 'bun test', 'npm run test:unit', 'npx vitest run', 'vitest', 'jest --ci',
      'pytest -q', 'python -m pytest tests', 'python3 -m unittest discover', 'go test ./...', 'cargo test', 'make test',
      'node --test', 'mocha', 'cd app && npm test', 'uv run pytest', '/bin/bash -lc "npm test 2>&1 | tail -20"', 'CI=1 npm test']) {
      expect(k(c), c).toBe('test');
    }
  });
  it('detects reads', () => {
    for (const c of [`/bin/bash -lc "sed -n '1,8p' README.md"`, "/bin/bash -lc 'cat README.md'", 'head -n 5 a.txt', 'tail -f log', 'nl -ba x.ts',
      'wc -l *.ts', 'ls -la', 'tree src', 'stat a', 'file a.bin', '/bin/bash -lc pwd']) {
      expect(k(c), c).toBe('read');
    }
  });
  it('detects searches', () => {
    for (const c of ['rg -n foo src', 'grep -R bar .', 'find . -name "*.ts"', 'fd test', 'ag needle', "cat a | grep x".replace('cat a | ', '')]) {
      expect(k(c), c).toBe('search');
    }
  });
  it('detects git', () => {
    expect(k('git status')).toBe('git');
    expect(k('/bin/bash -lc "git diff HEAD~1"')).toBe('git');
    expect(k('git grep foo')).toBe('search');
  });
  it('detects edits', () => {
    for (const c of [`/bin/bash -lc "printf 'hi' > hello.txt && cat hello.txt"`, 'apply_patch <<EOF\n*** Begin Patch\nEOF', 'echo x | tee out.txt',
      "cat > a.txt <<'EOF'\nhi\nEOF", 'echo hi >> log.txt', "sed -i 's/a/b/' f.txt"]) {
      expect(k(c), c).toBe('edit');
    }
  });
  it('does not treat stderr/null redirections as edits', () => {
    expect(k('ls missing 2>/dev/null')).toBe('read');
    expect(k('cat x 2>&1')).toBe('read');
    expect(k('make build > /dev/null')).toBe('command');
    expect(k('node build.js 2> err.log')).toBe('command');
  });
  it('falls back to command and builds a one-line title', () => {
    const r = classifyCommand('/bin/bash -lc "npm install\nnpm run build"');
    expect(r.kind).toBe('command');
    expect(r.title).toBe('npm install npm run build');
    expect(classifyCommand('echo ' + 'x'.repeat(400)).title.length).toBeLessThanOrEqual(160);
  });
});

describe('classifyClaudeTool', () => {
  const cwd = '/work/probe';
  it('Read → read with relative path', () => {
    expect(classifyClaudeTool('Read', { file_path: '/work/probe/README.md' }, cwd)).toMatchObject({ kind: 'read', title: 'README.md', files: ['README.md'] });
  });
  it('keeps paths outside cwd absolute', () => {
    expect(classifyClaudeTool('Read', { file_path: '/etc/hosts' }, cwd).title).toBe('/etc/hosts');
  });
  it('Write / Edit → files relative', () => {
    expect(classifyClaudeTool('Write', { file_path: '/work/probe/bye.txt', content: 'bye' }, cwd)).toMatchObject({ kind: 'write', files: ['bye.txt'] });
    expect(classifyClaudeTool('Edit', { file_path: '/work/probe/src/a.ts' }, cwd)).toMatchObject({ kind: 'edit', files: ['src/a.ts'] });
    expect(classifyClaudeTool('MultiEdit', { file_path: 'src/b.ts' }, cwd)).toMatchObject({ kind: 'edit', files: ['src/b.ts'] });
    expect(classifyClaudeTool('NotebookEdit', { notebook_path: '/work/probe/n.ipynb' }, cwd)).toMatchObject({ kind: 'edit', files: ['n.ipynb'] });
  });
  it('Grep / Glob → search', () => {
    expect(classifyClaudeTool('Grep', { pattern: 'TODO' }, cwd)).toMatchObject({ kind: 'search' });
    expect(classifyClaudeTool('Glob', { pattern: '**/*.ts' }, cwd)).toMatchObject({ kind: 'search', title: '**/*.ts' });
  });
  it('Bash → classifyCommand with description as detail', () => {
    expect(classifyClaudeTool('Bash', { command: 'cat bye.txt', description: 'Print contents of bye.txt' }, cwd))
      .toEqual({ kind: 'read', title: 'cat bye.txt', detail: 'Print contents of bye.txt' });
    expect(classifyClaudeTool('Bash', { command: 'npm test' }, cwd).kind).toBe('test');
  });
  it('web, subagents, todo and others', () => {
    expect(classifyClaudeTool('WebFetch', { url: 'https://x.dev' }, cwd).kind).toBe('web');
    expect(classifyClaudeTool('WebSearch', { query: 'vitest' }, cwd).kind).toBe('web');
    expect(classifyClaudeTool('Task', { description: 'Explore repo' }, cwd)).toMatchObject({ kind: 'tool', title: 'Subagent: Explore repo' });
    expect(classifyClaudeTool('Agent', { subagent_type: 'Plan' }, cwd).title).toBe('Subagent: Plan');
    expect(classifyClaudeTool('TodoWrite', { todos: [{ status: 'completed' }, { status: 'pending' }] }, cwd)).toMatchObject({ kind: 'note', title: 'Updated plan (1/2 done)' });
    expect(classifyClaudeTool('mcp__srv__do_thing', {}, cwd)).toMatchObject({ kind: 'tool', title: 'srv: do_thing' });
  });
});
