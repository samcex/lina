import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { ArrowUp, AtSign, Paperclip, Slash, Zap, Pause, Play, Square, Eye, RotateCcw, Stamp, Upload } from 'lucide-react';
import type { AgentId, Attachment } from '@shared/types';
import { AGENT_IDS } from '@shared/types';
import type { SessionView } from '@shared/reducer';
import { useLina } from '../lib/lina';
import { useUI } from '../lib/store';
import { AGENT_NAME, cx } from '../lib/format';
import { Glyph } from './ui/Glyphs';
import { Spinner } from './ui/Overlay';
import { AttachmentChips } from './timeline/Message';
import { isBusy } from './ui/Status';
import { useMedia } from '../lib/hooks';

interface Cmd { name: string; hint: string; icon: typeof Pause; when?: (v: SessionView) => boolean }
const COMMANDS: Cmd[] = [
  { name: 'undo', hint: 'Undo the latest writing turn (or /undo <turn>)', icon: RotateCcw, when: (v) => v.session.config.workspaceMode === 'direct' && v.session.status !== 'running' },
  { name: 'changes', hint: 'Inspect per-turn changes', icon: Eye },
  { name: 'previews', hint: 'Open persistent preview controls', icon: Eye },
  { name: 'review', hint: 'Run an extra review round on the current state', icon: Eye },
  { name: 'pause', hint: 'Stop at the next turn boundary', icon: Pause, when: (v) => v.session.status === 'running' },
  { name: 'resume', hint: 'Continue from the last step', icon: Play, when: (v) => ['paused', 'interrupted', 'failed', 'cancelled'].includes(v.session.status) },
  { name: 'cancel', hint: 'Kill the running turn now and stop', icon: Square, when: (v) => ['running', 'paused'].includes(v.session.status) },
  { name: 'retry', hint: 'Re-run the last failed step', icon: RotateCcw, when: (v) => v.session.status === 'failed' },
  { name: 'approve', hint: 'Approve & squash (or: /approve merge, /approve branch)', icon: Stamp, when: (v) => v.session.status === 'awaiting_approval' },
];

interface Upload { key: string; name: string; state: 'uploading' | 'done'; att?: Attachment }

export function Composer({ view }: { view: SessionView }) {
  const lina = useLina();
  const prefill = useUI((u) => u.composerPrefill);
  const focusTick = useUI((u) => u.composerFocus);
  const [text, setText] = useState('');
  const [interrupt, setInterrupt] = useState(false);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [drag, setDrag] = useState(false);
  const [menuIdx, setMenuIdx] = useState(0);
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const sid = view.session.id;
  const narrow = useMedia('(max-width: 560px)');

  const running = view.session.status === 'running' || AGENT_IDS.some((a) => isBusy(view.agents[a].status));
  const awaiting = view.session.status === 'awaiting_approval';

  // Reset per session.
  useEffect(() => { setText(''); setUploads([]); setInterrupt(false); }, [sid]);
  useEffect(() => { if (!running) setInterrupt(false); }, [running]);
  useEffect(() => {
    if (!prefill) return;
    if (prefill.text) setText(prefill.text);
    requestAnimationFrame(() => { const el = ta.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } });
  }, [prefill]);
  useEffect(() => { if (focusTick) ta.current?.focus(); }, [focusTick]);

  // Auto-grow.
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  }, [text]);

  // Autocomplete: @mention at caret, or /command at start.
  const before = text.slice(0, caret);
  const mention = before.match(/(^|\s)@(\w*)$/);
  const slash = /^\/(\w*)$/.test(text.trim()) && !text.includes('\n') ? text.trim().slice(1) : null;
  const menu = useMemo(() => {
    if (mention) {
      const q = mention[2].toLowerCase();
      return { type: 'mention' as const, items: AGENT_IDS.filter((a) => a.startsWith(q)) };
    }
    if (slash !== null) {
      return { type: 'slash' as const, items: COMMANDS.filter((c) => c.name.startsWith(slash.toLowerCase()) && (!c.when || c.when(view))) };
    }
    return null;
  }, [mention, slash, view]);
  const menuOpen = !!menu && menu.items.length > 0 && dismissed !== text;
  const activeIdx = Math.min(menuIdx, (menu?.items.length ?? 1) - 1);
  useEffect(() => setMenuIdx(0), [menu?.type, menu?.items.length]);
  useEffect(() => {
    if (menuOpen) menuRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [menuOpen, activeIdx]);

  const focusAt = (pos: number) => requestAnimationFrame(() => {
    ta.current?.focus();
    ta.current?.setSelectionRange(pos, pos);
    setCaret(pos);
  });

  const openMentions = () => {
    const start = ta.current?.selectionStart ?? text.length;
    const end = ta.current?.selectionEnd ?? start;
    const prefix = start > 0 && !/\s/.test(text[start - 1]) ? ' @' : '@';
    setText(text.slice(0, start) + prefix + text.slice(end));
    setDismissed(null);
    focusAt(start + prefix.length);
  };

  const openCommands = () => {
    if (slash === null) { setText('/'); setDismissed(null); focusAt(1); }
    else { setDismissed(menuOpen ? text : null); focusAt(text.length); }
  };

  const pickMention = (a: AgentId) => {
    const start = caret - (mention?.[2].length ?? 0) - 1;
    const next = `${text.slice(0, start)}@${a} ${text.slice(caret)}`;
    setText(next);
    const pos = start + a.length + 2;
    focusAt(pos);
  };

  const runCommand = (raw: string): boolean => {
    const m = raw.trim().match(/^\/(\w+)(?:\s+(\w+))?$/);
    if (!m) return false;
    const [, name, arg] = m;
    switch (name) {
      case 'undo':
        if (arg && (!/^\d+$/.test(arg) || Number(arg) < 1)) { lina.toast({ tone: 'error', title: 'Use /undo or /undo <turn number>' }); break; }
        void lina.undo(arg ? Number(arg) : undefined); break;
      case 'changes': lina.openInspector('changes'); break;
      case 'previews': lina.openInspector('previews'); break;
      case 'pause': case 'resume': case 'cancel': case 'review': case 'retry':
        void lina.control(name); break;
      case 'approve': {
        const strategy = arg === 'merge' || arg === 'branch' ? arg : 'squash';
        // choose_variant (compete, nothing chosen yet) is explained by lina.approve itself.
        void lina.approve(strategy).then((e) => e ? (e.code !== 'choose_variant' && lina.toast({ tone: 'error', title: e.message, detail: e.hint })) : lina.toast({ tone: 'ok', title: `Approved · ${strategy}` }));
        break;
      }
      default: return false;
    }
    setText('');
    return true;
  };

  const uploading = uploads.some((u) => u.state === 'uploading');
  const canSend = text.trim().length > 0 && !uploading;

  const send = () => {
    if (!canSend) return;
    if (text.trim().startsWith('/') && runCommand(text)) return;
    const atts = uploads.filter((u) => u.att).map((u) => u.att!);
    void lina.send(text.trim(), atts, interrupt && running);
    setText(''); setUploads([]); setInterrupt(false);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (menuOpen && menu) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMenuIdx((i) => (i + 1) % menu.items.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMenuIdx((i) => (i - 1 + menu.items.length) % menu.items.length); return; }
      if ((e.key === 'Tab' || e.key === 'Enter') && !e.shiftKey) {
        e.preventDefault();
        if (menu.type === 'mention') pickMention(menu.items[activeIdx] as AgentId);
        else {
          const c = menu.items[activeIdx] as Cmd;
          if (e.key === 'Tab') { const next = `/${c.name} `; setText(next); setDismissed(next); focusAt(next.length); }
          else runCommand(`/${c.name}`);
        }
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); setDismissed(text); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur();
  };

  const addFiles = async (files: File[]) => {
    for (const f of files) {
      const key = `${f.name}-${f.size}-${Math.random().toString(36).slice(2, 7)}`;
      setUploads((u) => [...u, { key, name: f.name || 'pasted image', state: 'uploading' }]);
      const att = await lina.upload(f, sid);
      setUploads((u) => (att ? u.map((x) => (x.key === key ? { ...x, state: 'done', att } : x)) : u.filter((x) => x.key !== key)));
    }
  };
  const onPaste = (e: ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length) { e.preventDefault(); void addFiles(files); }
  };
  const onDrop = (e: DragEvent) => { e.preventDefault(); setDrag(false); const files = Array.from(e.dataTransfer.files); if (files.length) void addFiles(files); };

  const directed = text.match(/^@(codex|claude)\b/)?.[1] as AgentId | undefined;
  // Short forms on phones: a one-row textarea must never wrap (and clip) its placeholder.
  const placeholder = awaiting ? (narrow ? 'Request changes…' : 'Request changes — your message starts a revision cycle…')
    : running ? (narrow ? 'Guide the agents…' : 'Add guidance for the agents…')
    : view.timeline.length ? (narrow ? 'Reply or give a task…' : 'Reply, or give the next task…')
    : narrow ? 'Describe the task…' : 'Describe the task for Codex and Claude…';

  return (
    <div className={cx('composer-wrap')}>
      <div
        className={cx('composer', drag && 'is-drag', interrupt && running && 'is-interrupt', directed && 'is-directed')} data-agent={directed}
        onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true); } }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrag(false); }}
        onDrop={onDrop}
      >
        {drag && <div className="drop-hint"><Upload size={18} /> Drop files to attach</div>}
        {menuOpen && menu && (
          <div className="ac-menu">
            <div className="ac-label"><span>{menu.type === 'mention' ? 'Address one agent' : 'Session commands'}</span><span>{menu.items.length} available</span></div>
            <div className="ac-options" ref={menuRef} id={menuId} role="listbox" aria-label={menu.type === 'mention' ? 'Mention an agent' : 'Commands'}>
            {menu.type === 'mention'
              ? (menu.items as AgentId[]).map((a, i) => (
                <button key={a} id={`${menuId}-${i}`} type="button" role="option" tabIndex={-1} aria-selected={i === activeIdx} className={cx('ac-item', i === activeIdx && 'is-on')} data-agent={a}
                  onMouseEnter={() => setMenuIdx(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pickMention(a)}>
                  <Glyph actor={a} size={14} /> <b>@{a}</b>
                  <span>{AGENT_NAME[a]} · {a === view.session.config.developer ? 'developer' : 'reviewer'} permissions</span>
                </button>
              ))
              : (menu.items as Cmd[]).map((c, i) => (
                <button key={c.name} id={`${menuId}-${i}`} type="button" role="option" tabIndex={-1} aria-selected={i === activeIdx} className={cx('ac-item', i === activeIdx && 'is-on')}
                  onMouseEnter={() => setMenuIdx(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => { runCommand(`/${c.name}`); ta.current?.focus(); }}>
                  <c.icon size={14} /> <b>/{c.name}</b><span>{c.hint}</span>
                </button>
              ))}
            </div>
            <div className="ac-footer"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>Tab</kbd> complete</span><span><kbd>Enter</kbd> {menu.type === 'mention' ? 'insert' : 'run'}</span><span><kbd>Esc</kbd> close</span></div>
          </div>
        )}
        {uploads.length > 0 && (
          <div className="composer-atts">
            {uploads.map((u) => u.state === 'uploading'
              ? <span key={u.key} className="att-chip is-uploading"><Spinner size={11} /> {u.name}</span>
              : <AttachmentChips key={u.key} list={[u.att!]} onRemove={() => setUploads((x) => x.filter((y) => y.key !== u.key))} />)}
          </div>
        )}
        <textarea
          ref={ta} value={text} rows={1} placeholder={placeholder} aria-label="Message LINA"
          role="combobox" aria-autocomplete="list" aria-expanded={menuOpen} aria-haspopup="listbox"
          aria-controls={menuOpen ? menuId : undefined} aria-activedescendant={menuOpen ? `${menuId}-${activeIdx}` : undefined}
          onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart); }}
          onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
          onKeyDown={onKey} onPaste={onPaste} spellCheck
        />
        <div className="composer-bar">
          <button className="icon-btn" onClick={() => fileInput.current?.click()} aria-label="Attach files" data-tip="Attach files (or paste / drop)">
            <Paperclip size={16} />
          </button>
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => { void addFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
          {(!text.trim() || slash !== null) && <button type="button" className={cx('composer-tool', menuOpen && menu?.type === 'slash' && 'is-on')} onClick={openCommands} aria-label="Browse commands" aria-expanded={menuOpen && menu?.type === 'slash'} aria-controls={menuOpen && menu?.type === 'slash' ? menuId : undefined}>
            <Slash size={14} /><span>Commands</span>
          </button>}
          <button type="button" className="composer-tool" onClick={openMentions} aria-label="Mention an agent"><AtSign size={14} /><span>Mention</span></button>
          {running && (
            <label className={cx('switch', interrupt && 'is-on')} data-tip="Cancel the current turn and re-run it with your message">
              <input type="checkbox" checked={interrupt} onChange={(e) => setInterrupt(e.target.checked)} />
              <span className="switch-track"><i /></span>
              <Zap size={12} /> Interrupt current turn
            </label>
          )}
          {directed && <span className="directed-tag" data-agent={directed}><Glyph actor={directed} size={12} /> to {AGENT_NAME[directed]} only</span>}
          <span className="composer-spacer" />
          <button className={cx('send-btn', canSend && 'is-ready')} onClick={send} disabled={!canSend} aria-label={running && !interrupt ? 'Queue message' : 'Send message'}>
            {uploading ? <Spinner size={14} /> : <ArrowUp size={17} strokeWidth={2.4} />}
          </button>
        </div>
      </div>
      <div className="composer-hint" aria-live="polite">
        {running
          ? interrupt ? <><Zap size={11} /> Sends now: the current turn is cancelled and re-run with your message.</>
            : <>Agents are working — your message is queued and delivered at the next turn.</>
          : <><kbd>Enter</kbd> send · <kbd>Shift</kbd>+<kbd>Enter</kbd> newline · <kbd>@</kbd> address one agent · <kbd>/</kbd> commands</>}
      </div>
    </div>
  );
}
