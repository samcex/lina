import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const home = mkdtempSync(join(tmpdir(), 'lina-models-test-'));
let prevHome: string | undefined;
beforeAll(() => { prevHome = process.env.LINA_HOME; process.env.LINA_HOME = home; });
afterAll(() => {
  if (prevHome === undefined) delete process.env.LINA_HOME; else process.env.LINA_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

const models = await import('../../src/server/agents/models.js');

describe('parseCodexCatalog', () => {
  const json = readFileSync(new URL('../fixtures/codex-models.json', import.meta.url), 'utf8');
  it('lists visibility=list models sorted by priority with efforts', () => {
    const list = models.parseCodexCatalog(json);
    expect(list.map((m) => m.id)).toEqual(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-daybreak-blue-latest']);
    expect(list[0]).toMatchObject({ label: 'GPT-6.1-Sol', source: 'catalog', defaultEffort: 'low', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] });
    expect(list.find((m) => m.id === 'gpt-6-luna')?.efforts).not.toContain('ultra');
    expect(list.some((m) => m.id === 'codex-auto-review')).toBe(false);
  });
});

describe('parseClaudeHelpAliases', () => {
  it('reads aliases from the --model paragraph only', () => {
    const help = `Options:
  --mcp-config <configs...>             Load MCP servers ('x')
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name.
  -n, --name <name>                     Set a display name 'nope'`;
    expect(models.parseClaudeHelpAliases(help)).toEqual(['fable', 'opus', 'sonnet']);
    expect(models.parseClaudeHelpAliases('nothing')).toEqual([]);
  });
});

describe('readCodexConfigModel', () => {
  it('reads only the top-level model key', () => {
    const f = join(home, 'config.toml');
    writeFileSync(f, 'model_reasoning_effort = "low"\nmodel = "gpt-6-sol"  # comment\n[profiles.x]\nmodel = "other"\n');
    expect(models.readCodexConfigModel(f)).toBe('gpt-6-sol');
    writeFileSync(f, '[profiles.x]\nmodel = "other"\n');
    expect(models.readCodexConfigModel(f)).toBeUndefined();
    expect(models.readCodexConfigModel(join(home, 'missing.toml'))).toBeUndefined();
  });
});

describe('recordObservedModel', () => {
  it('persists observations under paths.cache', () => {
    models.recordObservedModel('claude', 'haiku', 'claude-haiku-5-5');
    const stored = JSON.parse(readFileSync(join(home, 'cache', 'observed-models.json'), 'utf8'));
    expect(stored.claude.haiku.resolved).toBe('claude-haiku-5-5');
    expect(models.getObservedModels('claude').haiku.resolved).toBe('claude-haiku-5-5');
  });
});
