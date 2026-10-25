// Secret masking for anything LINA persists or displays (agent tool output,
// stderr tails, daemon log). Conservative: prefers masking a few false
// positives over leaking a credential.

const MASK = '[REDACTED]';

interface Rule { re: RegExp; replace: string | ((m: string, ...groups: string[]) => string) }

const RULES: Rule[] = [
  // PEM private key blocks (RSA/EC/OPENSSH/PKCS8/encrypted…).
  {
    re: /-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY-----[\s\S]*?(?:-----END \1PRIVATE KEY-----|$)/g,
    replace: '[REDACTED PRIVATE KEY]',
  },
  // Authorization headers (Bearer / Basic / token schemes).
  {
    re: /\b(authorization\s*[:=]\s*["']?\s*(?:bearer|basic|token)\s+)[^\s"',;]+/gi,
    replace: (_m, p: string) => p + MASK,
  },
  // Bare "Bearer <long token>" (e.g. curl -H "Bearer …" without the header name).
  { re: /\b(bearer\s+)[A-Za-z0-9\-._~+/]{20,}=*/gi, replace: (_m, p: string) => p + MASK },
  // Anthropic (must precede the generic sk- rule).
  { re: /\bsk-ant-[A-Za-z0-9_-]{8,}/g, replace: 'sk-ant-' + MASK },
  // OpenAI sk-, sk-proj-, sk-svcacct-, sk-admin-…
  { re: /\bsk-(?:proj-|svcacct-|admin-|None-)?[A-Za-z0-9_-]{20,}/g, replace: 'sk-' + MASK },
  // GitHub tokens.
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replace: (m) => m.slice(0, 4) + MASK },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replace: 'github_pat_' + MASK },
  // Slack.
  { re: /\bxox[abposre]-[A-Za-z0-9-]{10,}/g, replace: (m) => m.slice(0, 5) + MASK },
  // AWS access key ids.
  { re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{16}\b/g, replace: 'AKIA' + MASK },
  // Google API keys.
  { re: /\bAIza[0-9A-Za-z_-]{30,}/g, replace: 'AIza' + MASK },
  // JWT-like tokens (header.payload[.signature]) and other long eyJ… base64url blobs.
  { re: /\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{4,}){1,2}/g, replace: 'eyJ' + MASK },
  { re: /\beyJ[A-Za-z0-9_-]{40,}/g, replace: 'eyJ' + MASK },
  // key = value / "key": "value" for secret-ish names.
  {
    re: /\b([A-Za-z0-9_.-]*?(?:api[_-]?key|secret|password|passwd|pwd|token|access[_-]?key|private[_-]?key|client[_-]?secret))(["']?\s*[:=]\s*)(["']?)([^\s"',;}{)]+)/gi,
    replace: (m, key: string, sep: string, q: string, value: string) => {
      if (/^(?:true|false|null|none|undefined|\d+|\[REDACTED[^\]]*\]|.*REDACTED\]?)$/i.test(value)) return m;
      if (value.length < 4) return m;
      // Process substitutions / variable references are not secrets.
      if (/^\$[{(A-Za-z_]/.test(value)) return m;
      return `${key}${sep}${q}${MASK}`;
    },
  },
];

/** Masks credentials in free-form text. Safe to call on any string. */
export function redact(text: string): string {
  if (!text) return text;
  let out = text;
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    out = out.replace(rule.re, rule.replace as (substring: string, ...args: any[]) => string);
  }
  return out;
}

/** Keeps the last `maxChars` characters, prefixed with a truncation marker. */
export function tail(text: string, maxChars: number): string {
  if (!text) return '';
  if (text.length <= maxChars) return text;
  const dropped = text.length - maxChars;
  return `…[truncated ${dropped} chars]\n` + text.slice(text.length - maxChars);
}

/** redact() then tail(): the form used for persisted tool output. */
export function redactTail(text: string, maxChars = 8000): string {
  // Redact before cutting so a secret split by the cut can't survive half-masked.
  return tail(redact(text), maxChars);
}
