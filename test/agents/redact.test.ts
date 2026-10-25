import { describe, expect, it } from 'vitest';
import { redact, redactTail, tail } from '../../src/server/agents/redact.js';

describe('redact', () => {
  const cases: [string, string, string][] = [
    ['openai', 'key sk-abcdefghijklmnopqrstuvwxyz0123456789', 'sk-abcdefghijklmnopqrstuvwxyz0123456789'],
    ['openai proj', 'OPENAI=sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789', 'AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789'],
    ['anthropic', 'use sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA-bbbb now', 'api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['github ghp', 'token ghp_1234567890abcdefghijABCDEFGHIJ123456', 'ghp_1234567890abcdefghij'],
    ['github gho', 'gho_1234567890abcdefghijABCDEFGHIJ123456', '1234567890abcdefghij'],
    ['github pat', 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz', '11ABCDEFG0123456789'],
    ['slack', 'xoxb-1234567890-abcdefghijkl', '1234567890-abcdefghijkl'],
    ['aws', 'aws AKIAIOSFODNN7EXAMPLE key', 'IOSFODNN7EXAMPLE'],
    ['google', 'AIzaSyA1234567890abcdefghijklmnopqrstuv', 'SyA1234567890abcdefghijklmnopqrstuv'],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'dozjgNryP4J3jVmNHl0w5N'],
    ['bearer header', 'Authorization: Bearer abc.def-ghi_jkl', 'abc.def-ghi_jkl'],
    ['bearer bare', 'curl -H "Bearer abcdefghijklmnopqrstuvwxyz012345"', 'abcdefghijklmnopqrstuvwxyz012345'],
    ['password kv', 'password=hunter2hunter2', 'hunter2hunter2'],
    ['api_key json', '{"api_key": "zzz-secret-value-1"}', 'zzz-secret-value-1'],
    ['env token', 'GITHUB_TOKEN=abcd1234efgh', 'abcd1234efgh'],
    ['secret colon', 'client_secret: s3cr3tvalue', 's3cr3tvalue'],
  ];
  for (const [name, input, secret] of cases) {
    it(`masks ${name}`, () => {
      const out = redact(input);
      expect(out).not.toContain(secret);
      expect(out).toContain('REDACTED');
    });
  }

  it('masks PEM private key blocks', () => {
    const pem = 'before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAx\nabc\n-----END RSA PRIVATE KEY-----\nafter';
    const out = redact(pem);
    expect(out).not.toContain('MIIEowIBAAKCAQEAx');
    expect(out).toContain('before');
    expect(out).toContain('after');
    expect(out).toContain('[REDACTED PRIVATE KEY]');
  });

  it('leaves ordinary text and token counts alone', () => {
    const s = 'input_tokens: 132039, output_tokens=230; password: null; ran `npm test` in /work/probe';
    expect(redact(s)).toBe(s);
    expect(redact('')).toBe('');
    expect(redact('token = $GITHUB_TOKEN')).toBe('token = $GITHUB_TOKEN');
  });
});

describe('tail', () => {
  it('returns short text unchanged', () => {
    expect(tail('hello', 10)).toBe('hello');
  });
  it('keeps the end with a truncation marker', () => {
    const out = tail('0123456789abcdef', 6);
    expect(out.endsWith('abcdef')).toBe(true);
    expect(out).toContain('[truncated 10 chars]');
  });
  it('redactTail redacts before cutting', () => {
    const out = redactTail('x'.repeat(100) + ' sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA', 40);
    expect(out).not.toContain('AAAAAAAAAAAAAAAAAAAA');
  });
});
