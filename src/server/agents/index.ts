// Adapter registry. Real adapters are imported lazily so mock-only runs (tests, LINA_MOCK=1 demos)
// never load the provider integrations.
import type { AgentId } from '../../shared/types.js';
import { MockAdapter } from './mock.js';
import type { AgentAdapter } from './types.js';

export type AdapterFactory = (agent: AgentId, ctx: { mock: boolean; sessionId?: string }) => AgentAdapter | undefined;

let override: AdapterFactory | null = null;

/** Test hook: return an adapter (or undefined to fall through to the default). */
export function setAdapterOverride(f: AdapterFactory | null): void { override = f; }

export function mockEnabled(): boolean { return process.env.LINA_MOCK === '1'; }

export async function getAdapter(agent: AgentId, opts: { mock?: boolean; sessionId?: string } = {}): Promise<AgentAdapter> {
  const mock = !!opts.mock || mockEnabled();
  const o = override?.(agent, { mock, sessionId: opts.sessionId });
  if (o) return o;
  if (mock) return new MockAdapter(agent);
  if (agent === 'claude') {
    const { ClaudeAdapter } = await import('./claude.js');
    return new ClaudeAdapter();
  }
  if (agent === 'codex') {
    const { CodexAdapter } = await import('./codex.js');
    return new CodexAdapter();
  }
  if (agent === 'freebuff') {
    const { FreebuffAdapter } = await import('./freebuff.js');
    return new FreebuffAdapter();
  }
  throw new Error(`Unknown agent: ${String(agent)}`);
}
