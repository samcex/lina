// Turns the persisted event timeline into render items for the conversation.
import type { Actor, AnyLinaEvent, LinaEvent } from '@shared/types';

export type MsgEvent = LinaEvent<'message'>;
export type ActEvent = LinaEvent<'activity'>;

export type Item =
  | { t: 'group'; key: string; actor: Actor; msgs: MsgEvent[] }
  | { t: 'notice'; key: string; e: MsgEvent }
  | { t: 'phase'; key: string; e: LinaEvent<'phase'> }
  | { t: 'activity'; key: string; agent: ActEvent['data']['agent']; acts: ActEvent[]; start: number; end: number }
  | { t: 'review'; key: string; e: LinaEvent<'review'> }
  | { t: 'response'; key: string; e: LinaEvent<'response'> }
  | { t: 'tests'; key: string; e: LinaEvent<'tests'> }
  | { t: 'checkpoint'; key: string; e: LinaEvent<'checkpoint'>; prev?: string }
  | { t: 'error'; key: string; e: LinaEvent<'error'> }
  | { t: 'split'; key: string; e: LinaEvent<'split'> }
  | { t: 'integration'; key: string; e: LinaEvent<'integration'> }
  | { t: 'approval'; key: string; e: LinaEvent<'approval'> };

const GROUP_GAP = 8 * 60_000;

export function buildItems(timeline: AnyLinaEvent[]): Item[] {
  const out: Item[] = [];
  let lastPhase = '';
  // Previous checkpoint per line of work ('' = session workspace, else the variant's worktree).
  const lastCheckpoint = new Map<string, string>();
  for (const e of timeline) {
    const last = out[out.length - 1];
    switch (e.type) {
      case 'message': {
        if (e.data.kind === 'notice') { out.push({ t: 'notice', key: `n${e.seq}`, e }); break; }
        const prevMsg = last?.t === 'group' ? last.msgs[last.msgs.length - 1] : undefined;
        if (last?.t === 'group' && last.actor === e.actor && prevMsg && e.ts - prevMsg.ts < GROUP_GAP && e.data.kind !== 'summary' && prevMsg.data.kind !== 'summary'
          && prevMsg.data.variant === e.data.variant) {
          last.msgs.push(e);
        } else {
          out.push({ t: 'group', key: `g${e.seq}`, actor: e.actor, msgs: [e] });
        }
        break;
      }
      case 'phase': {
        const sig = `${e.data.phase}:${e.data.round}`;
        if (sig === lastPhase) break;
        lastPhase = sig;
        out.push({ t: 'phase', key: `p${e.seq}`, e });
        break;
      }
      case 'activity': {
        if (last?.t === 'activity' && last.agent === e.data.agent) {
          const i = last.acts.findIndex((a) => a.data.id === e.data.id);
          if (i >= 0) last.acts[i] = e; else last.acts.push(e);
          last.end = e.ts;
        } else {
          out.push({ t: 'activity', key: `a${e.seq}`, agent: e.data.agent, acts: [e], start: e.ts, end: e.ts });
        }
        break;
      }
      case 'review': out.push({ t: 'review', key: `r${e.seq}`, e }); break;
      case 'response': out.push({ t: 'response', key: `s${e.seq}`, e }); break;
      case 'tests': out.push({ t: 'tests', key: `t${e.seq}`, e }); break;
      case 'checkpoint': {
        const line = e.data.variant ?? '';
        out.push({ t: 'checkpoint', key: `c${e.seq}`, e, prev: lastCheckpoint.get(line) });
        lastCheckpoint.set(line, e.data.commit);
        break;
      }
      case 'split': out.push({ t: 'split', key: `sp${e.seq}`, e }); break;
      case 'integration': out.push({ t: 'integration', key: `in${e.seq}`, e }); break;
      case 'error': out.push({ t: 'error', key: `e${e.seq}`, e }); break;
      case 'approval': out.push({ t: 'approval', key: `ap${e.seq}`, e }); break;
      default: break;
    }
  }
  return out;
}

export function lastOf<T extends AnyLinaEvent['type']>(timeline: AnyLinaEvent[], type: T): LinaEvent<T> | undefined {
  for (let i = timeline.length - 1; i >= 0; i--) if (timeline[i].type === type) return timeline[i] as LinaEvent<T>;
  return undefined;
}
