import { describe, expect, it } from 'vitest';
import { lenientJson, normalizeId, normalizeSeverity, parseResponse, parseReview, parseSplit } from '../../src/server/review-parse.js';

const block = (tag: string, body: string) => '```' + tag + '\n' + body + '\n```';

describe('parseReview', () => {
  it('parses a well-formed block and strips it from the prose', () => {
    const text = `Looks mostly good.\n\n${block('lina-review', JSON.stringify({
      verdict: 'request_changes', summary: 'needs work',
      findings: [{ id: 'F1', severity: 'major', title: 'Bug', detail: 'off by one', file: 'a.ts', line: 3, suggestion: 'fix' }],
      resolved: ['F2'], withdrawn: [{ id: 'F3', reason: 'fair' }],
    }))}`;
    const r = parseReview(text);
    expect(r.prose).toBe('Looks mostly good.');
    expect(r.value).toEqual({
      verdict: 'request_changes', summary: 'needs work',
      findings: [{ id: 'F1', severity: 'major', title: 'Bug', detail: 'off by one', file: 'a.ts', line: 3, suggestion: 'fix' }],
      resolved: ['F2'], withdrawn: [{ id: 'F3', reason: 'fair' }],
    });
  });

  it('uses the last lina-review block and strips all of them', () => {
    const text = `a\n${block('lina-review', '{"verdict":"approve"}')}\nb\n${block('lina-review', '{"verdict":"request_changes","findings":[{"severity":"blocker","title":"X","detail":"d"}]}')}`;
    const r = parseReview(text);
    expect(r.value?.verdict).toBe('request_changes');
    expect(r.value?.findings[0].severity).toBe('blocker');
    expect(r.prose).toBe('a\n\nb');
  });

  it('tolerates trailing commas, comments, smart quotes and missing fields', () => {
    const r = parseReview(block('lina-review', '{\n // note\n "verdict": "approve",\n "findings": [ {"title": “T”, "severity":"nit",}, ],\n}'));
    expect(r.value?.verdict).toBe('approve');
    expect(r.value?.findings).toHaveLength(1);
    expect(r.value?.resolved).toEqual([]);
    expect(r.value?.withdrawn).toEqual([]);
    expect(r.value?.summary).toBe('');
  });

  it('falls back to a ```json block that looks like a review', () => {
    const r = parseReview(`prose\n${block('json', '{"other":1}')}\n${block('json', '{"verdict":"lgtm","findings":[]}')}`);
    expect(r.value?.verdict).toBe('approve');
    expect(r.prose).toContain('prose');
  });

  it('accepts an unterminated final fence', () => {
    const r = parseReview('text\n```lina-review\n{"verdict":"approve","findings":[]}\n');
    expect(r.value?.verdict).toBe('approve');
    expect(r.prose).toBe('text');
  });

  it('accepts an unfenced verdict object as last resort', () => {
    const r = parseReview('Here: {"verdict":"request_changes","findings":[{"title":"a","severity":"high"}]} done');
    expect(r.value?.findings[0].severity).toBe('major');
  });

  it('normalizes severities, ids and verdicts; derives a missing verdict', () => {
    const r = parseReview(block('lina-review', '{"findings":[{"id":"f-2","severity":"CRITICAL","title":"a"},{"severity":"weird","detail":"only detail text"}],"resolved":["#1",{"id":"f3"}],"withdrawn":["F4"]}'));
    expect(r.value?.verdict).toBe('request_changes');
    expect(r.value?.findings.map((f) => [f.id, f.severity])).toEqual([['F2', 'blocker'], [undefined, 'minor']]);
    expect(r.value?.findings[1].title).toBe('only detail text');
    expect(r.value?.resolved).toEqual(['F1', 'F3']);
    expect(r.value?.withdrawn).toEqual([{ id: 'F4', reason: '' }]);
    const ok = parseReview(block('lina-review', '{"findings":[{"title":"n","severity":"nit"}]}'));
    expect(ok.value?.verdict).toBe('approve');
  });

  it('drops invalid findings and bad line numbers', () => {
    const r = parseReview(block('lina-review', '{"verdict":"approve","findings":[null, 3, {}, {"title":"t","line":-4,"file":""}]}'));
    expect(r.value?.findings).toEqual([{ severity: 'minor', title: 't', detail: '' }]);
  });

  it('reports an error when there is no block', () => {
    const r = parseReview('just words');
    expect(r.value).toBeUndefined();
    expect(r.error).toMatch(/no lina-review/);
    expect(r.prose).toBe('just words');
  });

  it('reports invalid JSON in a tagged block', () => {
    const r = parseReview(block('lina-review', '{"verdict": approve'));
    expect(r.value).toBeUndefined();
    expect(r.error).toMatch(/not valid JSON/);
  });

  it('ignores fences that are not at line start and keeps code blocks in prose', () => {
    const text = 'Use ```inline``` here.\n```ts\nconst x = 1;\n```\n' + block('lina-review', '{"verdict":"approve"}');
    const r = parseReview(text);
    expect(r.value?.verdict).toBe('approve');
    expect(r.prose).toContain('const x = 1;');
  });
});

describe('parseResponse', () => {
  it('parses items and maps action synonyms', () => {
    const r = parseResponse(`Done.\n${block('lina-response', '{"items":[{"id":"F1","action":"fixed","note":"n"},{"id":"f2","action":"disagree","reason":"because"},{"id":"F3","action":"later"},{"id":"F4","action":"???"},{"action":"fixed"}]}')}`);
    expect(r.prose).toBe('Done.');
    expect(r.value?.items).toEqual([
      { id: 'F1', action: 'fixed', note: 'n' },
      { id: 'F2', action: 'disputed', note: 'because' },
      { id: 'F3', action: 'deferred' },
      { id: 'F4', action: 'fixed' },
    ]);
  });
  it('falls back to json fence with items', () => {
    expect(parseResponse(block('json', '{"items":[{"id":1,"action":"wontfix"}],}')).value?.items).toEqual([{ id: 'F1', action: 'disputed' }]);
  });
  it('returns error without a block', () => {
    expect(parseResponse('nothing').value).toBeUndefined();
  });
});

describe('helpers', () => {
  it('lenientJson extracts the outer object', () => {
    expect(lenientJson('noise {"a": {"b": "}"}, } trailing')).toEqual({ a: { b: '}' } });
  });
  it('normalizeSeverity / normalizeId', () => {
    expect(normalizeSeverity('P1')).toBe('major');
    expect(normalizeSeverity(undefined)).toBe('minor');
    expect(normalizeId(' F12 ')).toBe('F12');
    expect(normalizeId('custom')).toBe('custom');
    expect(normalizeId('')).toBeUndefined();
  });
});

describe('parseSplit', () => {
  const parts = [
    { agent: 'codex', title: 'API', scope: 'server routes', files: ['src/api.ts'] },
    { agent: 'claude', title: 'UI', scope: 'the page', files: ['web/page.tsx'] },
  ];
  it('parses one part per agent and strips the block from the plan', () => {
    const r = parseSplit(`Plan:\n- do it\n\n${block('lina-split', JSON.stringify({ parts }))}`);
    expect(r.prose).toBe('Plan:\n- do it');
    expect(r.value?.parts).toEqual(parts);
  });
  it('tolerates an object keyed by agent, case, missing files and a json fence', () => {
    const r = parseSplit(block('json', '{"parts":{"Codex":{"title":"A","scope":"a"},"claude":{"scope":"b only"},},}'));
    expect(r.value?.parts).toEqual([{ agent: 'codex', title: 'A', scope: 'a' }, { agent: 'claude', title: 'b only', scope: 'b only' }]);
  });
  it('rejects unknown agents, duplicates, a single part, empty parts and a missing block', () => {
    const bad = (p: unknown[]) => parseSplit(block('lina-split', JSON.stringify({ parts: p })));
    expect(bad([{ ...parts[0], agent: 'gpt' }, parts[1]]).error).toMatch(/unknown agent/);
    expect(bad([parts[0], parts[0]]).error).toMatch(/two parts for codex/);
    expect(bad([parts[0]]).error).toMatch(/exactly one part per agent/);
    expect(bad([parts[0], { agent: 'claude' }]).error).toMatch(/no title or scope/);
    const none = parseSplit('Just a plan.');
    expect(none.value).toBeUndefined();
    expect(none.prose).toBe('Just a plan.');
    expect(none.error).toMatch(/no lina-split block/);
  });
});

describe('parseReview owner', () => {
  it('keeps a valid owner and ignores others', () => {
    const r = parseReview(block('lina-review', JSON.stringify({ verdict: 'request_changes', findings: [
      { severity: 'major', title: 'a', detail: 'x', owner: 'Claude' }, { severity: 'minor', title: 'b', detail: 'y', owner: 'bob' },
    ] })));
    expect(r.value?.findings.map((f) => f.owner)).toEqual(['claude', undefined]);
  });
});
