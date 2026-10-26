import { memo, useDeferredValue } from 'react';
import { CircleHelp, Clock3, Eye, ListChecks, MessagesSquare, Paperclip, RotateCcw, ScrollText, X, Zap, AtSign } from 'lucide-react';
import type { Actor, AgentId, Attachment, Role } from '@shared/types';
import { STATUS_LABEL } from '@shared/reducer';
import type { MsgEvent } from '../../lib/timeline';
import { useApp, type PendingMsg } from '../../lib/store';
import { useLina } from '../../lib/lina';
import { AGENT_NAME, bytes, clockTime, cx, fullTime } from '../../lib/format';
import { Avatar } from '../ui/Glyphs';
import { Markdown } from '../Markdown';
import { Spinner } from '../ui/Overlay';
import type { AgentView } from '@shared/reducer';
import { agentDisplayText } from '@shared/agent-display';
import { VariantChip } from '../Variants';
import { variantPhrase, worktreePhrase } from '../../lib/modes';

const KIND_META: Record<string, { label: string; icon: typeof Eye } | undefined> = {
  plan: { label: 'Plan', icon: ListChecks },
  review: { label: 'Review', icon: Eye },
  response: { label: 'Response', icon: MessagesSquare },
  summary: { label: 'Summary', icon: ScrollText },
  question: { label: 'Needs your answer', icon: CircleHelp },
};

/** Structured lina-review / lina-response / lina-split JSON blocks render as cards; hide them from prose. */
export function stripStructured(text: string, streaming = false): string {
  return agentDisplayText(text, streaming);
}

function RoleTag({ role }: { role?: Role }) {
  if (!role) return null;
  return <span className="role-tag">{role === 'developer' ? 'Developer' : 'Reviewer'}</span>;
}

export const MessageGroup = memo(function MessageGroup({ actor, msgs, focusSeq }: { actor: Actor; msgs: MsgEvent[]; focusSeq?: number | null }) {
  const mode = useApp((s) => s.view?.session.config.mode);
  if (actor === 'user') {
    return (
      <div className="mgroup is-user" data-actor="user">
        {msgs.map((m) => (
          <div key={m.seq} id={`ev-${m.seq}`} className={cx('ububble-wrap', focusSeq === m.seq && 'is-focus')}>
            <div className="ububble">
              {m.data.mention && <span className="mention-tag" data-agent={m.data.mention}><AtSign size={11} />{AGENT_NAME[m.data.mention]}</span>}
              <Markdown text={m.data.text} />
              {m.data.attachments?.length ? <AttachmentChips list={m.data.attachments} /> : null}
            </div>
            <div className="ububble-meta">
              {m.data.queued && <span className="tag tag-iris" title="Agents were busy — this was delivered at the next turn boundary"><Clock3 size={11} /> queued — delivered at next turn</span>}
              <time title={fullTime(m.ts)}>{clockTime(m.ts)}</time>
            </div>
          </div>
        ))}
      </div>
    );
  }
  const first = msgs[0];
  return (
    <div className="mgroup" data-actor={actor}>
      <div className="mgroup-gutter"><Avatar actor={actor} size={30} /></div>
      <div className="mgroup-main">
        <div className="mgroup-head">
          <span className="mgroup-name">{AGENT_NAME[actor]}</span>
          <RoleTag role={first.data.role} />
          {first.data.model && <span className="model-tag mono">{first.data.model}</span>}
          <time title={fullTime(first.ts)}>{clockTime(first.ts)}</time>
        </div>
        {msgs.map((m) => {
          const meta = KIND_META[m.data.kind];
          const text = stripStructured(m.data.text);
          return (
            <div key={m.seq} id={`ev-${m.seq}`} className={cx('msg', `kind-${m.data.kind}`, focusSeq === m.seq && 'is-focus')}>
              {(meta || m.data.variant) && (
                <div className="msg-kind">
                  {meta && <><meta.icon size={12} /> {meta.label}</>}
                  {m.data.variant && <VariantChip agent={m.data.variant} text={variantPhrase(actor, m.data.variant, m.data.kind, mode)} />}
                </div>
              )}
              {text ? <Markdown text={text} /> : <p className="text-dim msg-empty">Structured {m.data.kind} below.</p>}
              {m.data.attachments?.length ? <AttachmentChips list={m.data.attachments} /> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}, (a, b) => a.actor === b.actor && a.msgs.length === b.msgs.length && a.msgs[a.msgs.length - 1] === b.msgs[b.msgs.length - 1] && a.focusSeq === b.focusSeq);

export function AttachmentChips({ list, onRemove }: { list: Attachment[]; onRemove?: (id: string) => void }) {
  return (
    <div className="att-chips">
      {list.map((a) => (
        <span key={a.id} className="att-chip" title={`${a.name} · ${bytes(a.size)}`}>
          <Paperclip size={12} /> <span className="att-name">{a.name}</span> <span className="att-size">{bytes(a.size)}</span>
          {onRemove && <button className="icon-btn icon-btn-xs" onClick={() => onRemove(a.id)} aria-label={`Remove ${a.name}`}><X size={11} /></button>}
        </span>
      ))}
    </div>
  );
}

export function StreamingMessage({ agent, text, role, model, status }: { agent: AgentId; text: string; role?: Role; model?: string; status?: AgentView['status'] }) {
  const deferred = useDeferredValue(text);
  return (
    <div className="mgroup is-streaming" data-actor={agent} aria-live="off">
      <div className="mgroup-gutter"><Avatar actor={agent} size={30} live /></div>
      <div className="mgroup-main">
        <div className="mgroup-head">
          <span className="mgroup-name">{AGENT_NAME[agent]}</span>
          <RoleTag role={role} />
          {model && <span className="model-tag mono">{model}</span>}
          <span className="streaming-tag"><i />{status && status !== 'idle' ? STATUS_LABEL[status] : 'Writing'}</span>
        </div>
        <div className="msg">
          {deferred ? <Markdown text={stripStructured(deferred, true) || '…'} streaming /> : <div className="shimmer-lines"><i /><i /><i /></div>}
        </div>
      </div>
    </div>
  );
}

/** "Codex is reading files…" — shown when an agent is busy but not streaming text. */
export function WorkingLine({ agent, view, variant }: { agent: AgentId; view: AgentView; variant?: AgentId }) {
  const lastObserved = [...view.activity].reverse().find((a) => a.source === 'observed' && a.state === 'running');
  return (
    <div className="working" data-actor={agent}>
      <Avatar actor={agent} size={22} live />
      <span className="working-text">
        <b>{AGENT_NAME[agent]}</b> {STATUS_LABEL[view.status].toLowerCase()}
        {lastObserved ? <> · <code>{lastObserved.title}</code></> : view.detail ? <> · {view.detail}</> : null}
      </span>
      {variant && <VariantChip agent={variant} text={worktreePhrase(variant)} />}
      <span className="think-dots"><i /><i /><i /></span>
    </div>
  );
}

export function PendingBubble({ p }: { p: PendingMsg }) {
  const lina = useLina();
  return (
    <div className="mgroup is-user is-pending" data-actor="user">
      <div className="ububble-wrap">
        <div className={cx('ububble', p.state === 'failed' && 'is-failed')}>
          <Markdown text={p.text} />
          {p.attachments.length ? <AttachmentChips list={p.attachments} /> : null}
        </div>
        <div className="ububble-meta">
          {p.interrupt && <span className="tag tag-warn"><Zap size={11} /> interrupting</span>}
          {p.state === 'sending' && <span className="text-dim"><Spinner size={10} /> sending…</span>}
          {p.state === 'sent' && p.queued && <span className="tag tag-iris"><Clock3 size={11} /> queued — delivered at next turn</span>}
          {p.state === 'sent' && !p.queued && <span className="text-dim">delivered</span>}
          {p.state === 'failed' && (
            <span className="text-bad">
              Not sent{p.error ? `: ${p.error}` : ''}{' '}
              <button className="link-btn" onClick={() => lina.retryPending(p.cid)}><RotateCcw size={11} /> Retry</button>{' '}
              <button className="link-btn" onClick={() => lina.dropPending(p.cid)}>Discard</button>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export function Notice({ e }: { e: MsgEvent }) {
  return (
    <div className="notice" id={`ev-${e.seq}`}>
      <Avatar actor="lina" size={18} />
      <div className="notice-text"><Markdown text={e.data.text} /></div>
      <time title={fullTime(e.ts)}>{clockTime(e.ts)}</time>
    </div>
  );
}
