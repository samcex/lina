import { describe, expect, it } from 'vitest';
import { classifyError, unwrapJsonError } from '../../src/server/agents/errors.js';

describe('classifyError', () => {
  it('retries temporary model capacity failures without treating disk capacity as a provider limit',()=>{
    const e=classifyError('codex','Selected model is at capacity. Please try a different model.');
    expect(e.code).toBe('capacity');expect(e.message).toContain('temporarily at capacity');
    expect(classifyError('codex','Disk is at capacity').code).toBe('crashed');
    expect(classifyError('codex','Selected model is at capacity',{apiStatus:401}).code).toBe('auth');
  });
  it('auth', () => {
    expect(classifyError('codex', 'Not logged in. Run codex login').code).toBe('auth');
    const e = classifyError('claude', 'Invalid API key · Please run /login');
    expect(e.code).toBe('auth');
    expect(e.hint).toContain('claude auth login');
    expect(classifyError('codex', 'unexpected status 401 Unauthorized').hint).toContain('codex login');
    expect(classifyError('codex', 'request failed', { apiStatus: 401 }).code).toBe('auth');
  });
  it('model_unavailable', () => {
    expect(classifyError('codex', "The 'no-such-model-x' model is not supported when using Codex with a ChatGPT account.").code).toBe('model_unavailable');
    expect(classifyError('claude', "There's an issue with the selected model (no-such-model-x). It may not exist or you may not have access to it.", { apiStatus: 404 }).code).toBe('model_unavailable');
    expect(classifyError('claude', '[claude-code:unrecognized_model] foo').code).toBe('model_unavailable');
    expect(classifyError('claude', 'model claude-x not found').code).toBe('model_unavailable');
    expect(classifyError('claude', 'whatever', { apiStatus: 404 }).code).toBe('model_unavailable');
  });
  it('rate_limited', () => {
    expect(classifyError('codex', "You've hit your usage limit. Try again in 3 hours.").code).toBe('rate_limited');
    expect(classifyError('claude', 'API Error: 529 Overloaded').code).toBe('capacity');
    expect(classifyError('claude', 'x', { apiStatus: 429 }).code).toBe('rate_limited');
    expect(classifyError('claude', 'Claude AI usage limit reached|1792815600').code).toBe('rate_limited');
  });
  it('sandbox (real bwrap output) with doctor hint', () => {
    const e = classifyError('codex', 'bwrap: Can\'t bind mount /oldroot/ on /newroot/: Unable to apply mount flags: remount "/newroot/mnt/network-share": No such device');
    expect(e.code).toBe('sandbox');
    expect(e.hint).toContain('lina doctor --live');
    expect(e.hint).toContain('/mnt');
    expect(classifyError('claude', 'apply-seccomp: failed: nested userns is capability-restricted').code).toBe('sandbox');
  });
  it('timeout / cancel / missing / crashed', () => {
    expect(classifyError('codex', '', { timedOut: 'idle' }).code).toBe('timeout');
    expect(classifyError('codex', '', { timedOut: 'turn' }).code).toBe('timeout');
    expect(classifyError('codex', '', { aborted: true }).code).toBe('cancelled');
    expect(classifyError('claude', '', { spawnError: 'ENOENT' }).code).toBe('cli_missing');
    const c = classifyError('claude', 'segfault', { exitCode: 139 });
    expect(c.code).toBe('crashed');
    expect(c.message).toContain('139');
  });
  it('redacts secrets in messages', () => {
    expect(classifyError('codex', 'boom sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAA').message).not.toContain('AAAAAAAAAAAAAAAAAAAA');
  });
});

describe('unwrapJsonError', () => {
  it('extracts nested message and status', () => {
    const raw = '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'no-such-model-x\' model is not supported when using Codex with a ChatGPT account."}}';
    expect(unwrapJsonError(raw)).toEqual({ status: 400, message: "The 'no-such-model-x' model is not supported when using Codex with a ChatGPT account." });
    expect(unwrapJsonError('plain')).toEqual({ message: 'plain' });
    expect(unwrapJsonError('{broken')).toEqual({ message: '{broken' });
  });
});
