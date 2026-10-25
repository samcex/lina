import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, Bug, FlaskConical, Sparkles, Wand2 } from 'lucide-react';
import type { SessionConfig } from '@shared/types';
import { AGENT_IDS } from '@shared/types';
import type { SessionView } from '@shared/reducer';
import { buildItems, type Item } from '../lib/timeline';
import { useApp, useUI } from '../lib/store';
import { useLina } from '../lib/lina';
import { AGENT_NAME } from '../lib/format';
import { MessageGroup, Notice, PendingBubble, StreamingMessage, WorkingLine } from './timeline/Message';
import { ActivityGroup, CheckpointCard, ErrorCard, IntegrationCard, PhaseDivider, ResponseCard, ReviewCard, SplitCard, TestsCard } from './timeline/Cards';
import { lastTurns, teamSentence } from '../lib/modes';
import { ApprovalCard } from './timeline/Approval';
import { BrandMark } from './ui/Glyphs';
import { isBusy } from './ui/Status';

const STARTERS = [
  { icon: Bug, title: 'Fix a bug', text: 'Find and fix the bug where ' },
  { icon: FlaskConical, title: 'Add tests', text: 'Add focused unit tests for the most critical module and make sure they pass.' },
  { icon: Wand2, title: 'Refactor', text: 'Refactor ' },
  { icon: Sparkles, title: 'Build a feature', text: 'Implement ' },
];

export function Conversation({ view }: { view: SessionView }) {
  const lina = useLina();
  const pendingAll = useApp((s) => s.pending);
  const focusSeq = useUI((u) => u.focusSeq);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [unseen, setUnseen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const historyAnchor = useRef<{ height: number; top: number } | null>(null);

  const items = useMemo(() => buildItems(view.timeline), [view.timeline]);
  const pending = useMemo(() => pendingAll.filter((p) => p.sessionId === view.session.id), [pendingAll, view.session.id]);
  const streams = Object.entries(view.streams);
  const streamingAgents = new Set(streams.map(([, s]) => s.agent));
  const working = AGENT_IDS.filter((a) => isBusy(view.agents[a].status) && !streamingAgents.has(a));
  const cfg = view.session.config;
  const turns = useMemo(() => lastTurns(view.timeline), [view.timeline]);
  const firstSeq = view.timeline.find((e) => e.seq > 0)?.seq ?? 0;

  const loadEarlier = async () => {
    const el = scroller.current;
    if (historyLoading || !el) return;
    pinned.current = false;
    historyAnchor.current = { height: el.scrollHeight, top: el.scrollTop };
    setHistoryLoading(true); setHistoryError('');
    try { await lina.loadEarlier(); }
    catch (e) { setHistoryError(e instanceof Error ? e.message : String(e)); }
    finally { setHistoryLoading(false); }
  };
  useLayoutEffect(() => {
    const anchor = historyAnchor.current, el = scroller.current;
    if (anchor && el && !historyLoading) {
      el.scrollTop = anchor.top + el.scrollHeight - anchor.height;
      lastTop.current = el.scrollTop;
      historyAnchor.current = null;
    }
  }, [firstSeq, historyLoading]);

  const lastApprovalSeq = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) { const it = items[i]; if (it.t === 'approval') return it.e.seq; }
    return -1;
  }, [items]);
  const lastErrorKey = useMemo(() => { for (let i = items.length - 1; i >= 0; i--) if (items[i].t === 'error') return items[i].key; return ''; }, [items]);

  const scrollToEnd = useCallback((smooth: boolean) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'auto' });
  }, []);

  // Track whether the user is reading history.
  // Only a real upward scroll unpins (content growth never decreases scrollTop),
  // so programmatic follow-scrolls can't race with fast event bursts.
  const lastTop = useRef(0);
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (el.scrollTop < lastTop.current - 4 && dist > 96) pinned.current = false;
    else if (dist < 96) pinned.current = true;
    lastTop.current = el.scrollTop;
    setShowJump(dist > 240);
    if (pinned.current) setUnseen(false);
  };

  // Follow growth (streaming, new items) only while pinned to the bottom.
  useEffect(() => {
    const c = content.current;
    if (!c) return;
    const ro = new ResizeObserver(() => {
      if (pinned.current) scrollToEnd(false);
      else setUnseen(true);
    });
    ro.observe(c);
    return () => ro.disconnect();
  }, [scrollToEnd]);

  // New session → jump to bottom.
  useLayoutEffect(() => { pinned.current = true; setUnseen(false); scrollToEnd(false); }, [view.session.id, scrollToEnd]);

  // Search hit → scroll to the message and flash it.
  useEffect(() => {
    if (focusSeq == null) return;
    const el = document.getElementById(`ev-${focusSeq}`);
    if (!el) {
      if (firstSeq > focusSeq) {
        let alive = true;
        setHistoryLoading(true); setHistoryError('');
        void lina.loadEarlier(focusSeq).catch((e: unknown) => {
          if (alive) setHistoryError(e instanceof Error ? e.message : String(e));
        }).finally(() => { if (alive) setHistoryLoading(false); });
        return () => { alive = false; };
      }
      return;
    }
    setHistoryLoading(false);
    pinned.current = false;
    el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    const t = setTimeout(() => lina.setUI({ focusSeq: null }), 2400);
    return () => clearTimeout(t);
  }, [focusSeq, firstSeq, items.length, lina]);

  // Sending a message always re-pins.
  useEffect(() => { if (pending.length) { pinned.current = true; scrollToEnd(true); } }, [pending.length, scrollToEnd]);

  const empty = items.length === 0 && streams.length === 0 && pending.length === 0;

  return (
    <div className="convo">
      <div className="convo-scroll" ref={scroller} onScroll={onScroll} role="log" aria-label="Conversation" aria-live="polite" aria-relevant="additions">
        <div className="convo-content" ref={content}>
          {firstSeq > 1 && <div className="history-load">
            <button className="btn btn-sm" disabled={historyLoading} onClick={() => void loadEarlier()}>{historyLoading ? 'Loading earlier messages…' : 'Load earlier messages'}</button>
            {historyError && <p role="alert" className="text-bad">{historyError}</p>}
          </div>}
          {empty ? (
            <EmptySession cfg={cfg} />
          ) : (
            <>
              {items.map((it) => <TimelineItem key={it.key} it={it} focusSeq={focusSeq} cfg={cfg}
                activeApproval={view.session.status === 'awaiting_approval' && it.t === 'approval' && it.e.seq === lastApprovalSeq}
                lastError={it.key === lastErrorKey} />)}
              {pending.map((p) => <PendingBubble key={p.cid} p={p} />)}
              {streams.map(([id, s]) => (
                <StreamingMessage key={id} agent={s.agent} text={s.text} role={view.agents[s.agent].role ?? (s.agent === cfg.developer ? 'developer' : 'reviewer')}
                  model={view.agents[s.agent].model} status={view.agents[s.agent].status} />
              ))}
              {working.map((a) => {
                const t = turns[a];
                return <WorkingLine key={a} agent={a} view={view.agents[a]} variant={t?.data.state === 'start' ? t.data.variant : undefined} />;
              })}
            </>
          )}
          <div className="convo-end" />
        </div>
      </div>
      {showJump && (
        <button className={`jump-pill ${unseen ? 'has-new' : ''}`} onClick={() => { pinned.current = true; setUnseen(false); scrollToEnd(true); }}>
          <ArrowDown size={14} /> {unseen ? 'New activity' : 'Jump to latest'}
        </button>
      )}
    </div>
  );
}

function TimelineItem({ it, focusSeq, cfg, activeApproval, lastError }: {
  it: Item; focusSeq: number | null; cfg: SessionConfig; activeApproval: boolean; lastError: boolean;
}) {
  switch (it.t) {
    case 'group': return <MessageGroup actor={it.actor} msgs={it.msgs} focusSeq={focusSeq} />;
    case 'notice': return <Notice e={it.e} />;
    case 'phase': return <PhaseDivider e={it.e} cfg={cfg} />;
    case 'activity': return <ActivityGroup agent={it.agent} acts={it.acts} start={it.start} end={it.end} />;
    case 'review': return <ReviewCard e={it.e} />;
    case 'response': return <ResponseCard e={it.e} reviewer={it.e.data.developer === 'codex' ? 'claude' : 'codex'} />;
    case 'tests': return <TestsCard e={it.e} />;
    case 'checkpoint': return <CheckpointCard e={it.e} prev={it.prev} />;
    case 'error': return <ErrorCard e={it.e} isLast={lastError} />;
    case 'approval': return <ApprovalCard e={it.e} active={activeApproval} />;
    case 'split': return <SplitCard e={it.e} />;
    case 'integration': return <IntegrationCard e={it.e} />;
  }
}

function EmptySession({ cfg }: { cfg: SessionConfig }) {
  const lina = useLina();
  return (
    <div className="hero">
      <div className="hero-mark"><BrandMark size={64} live /></div>
      <h2 className="hero-title">What should we build?</h2>
      <p className="hero-sub">
        {cfg.mode === 'pair' || cfg.mode === 'architect' || cfg.mode === 'solo' ? (
          <>
            <span data-actor={cfg.developer} className="hero-agent">{AGENT_NAME[cfg.developer]}</span> develops
            {cfg.mode !== 'solo' && <>, <span data-actor={cfg.reviewer} className="hero-agent">{AGENT_NAME[cfg.reviewer]}</span> reviews</>}.
          </>
        ) : teamSentence(cfg)}{' '}
        {cfg.workspaceMode === 'direct' ? 'Edits appear directly in your project. Keep chatting to steer the work.' : 'You approve before anything touches your repo.'}
      </p>
      <div className="starters">
        {STARTERS.map((s) => (
          <button key={s.title} className="starter" onClick={() => { lina.prefillComposer(s.text); }}>
            <s.icon size={16} />
            <span className="starter-title">{s.title}</span>
            <span className="starter-text">{s.text.endsWith(' ') ? `${s.text.trim()}…` : s.text}</span>
          </button>
        ))}
      </div>
      <p className="hero-hint">Tip: mention <code>@codex</code> or <code>@claude</code> to ask one agent directly.</p>
    </div>
  );
}
