// Real DOM/hook checks plus asynchronous controller races. No browser required.
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Store, initialState, setStore } from '../web/src/lib/store.ts';
import { Lina, LinaContext } from '../web/src/lib/lina.ts';
import { Modal } from '../web/src/components/ui/Overlay.tsx';
import { NewSessionDialog } from '../web/src/components/dialogs/NewSession.tsx';
import { snapshot } from '../test/cli/fixture.ts';
import { viewFromSnapshot } from '../src/shared/reducer.ts';

const win = new Window({ url: 'http://127.0.0.1:7077/' });
for (const key of ['window', 'document', 'history', 'localStorage', 'sessionStorage', 'HTMLElement', 'Node']) globalThis[key] = key === 'window' ? win : win[key];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = win.ResizeObserver;
globalThis.matchMedia = win.matchMedia.bind(win);
const { Conversation } = await import('../web/src/components/Conversation.tsx');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const fresh = (client) => {
  const state = initialState(false);
  const snap = snapshot();
  state.currentId = snap.session.id;
  state.view = viewFromSnapshot(snap);
  const store = new Store(state); setStore(store);
  return { store, lina: new Lina({ fixture: false, client }), snap };
};
const second = (snap) => ({ ...snap, session: { ...snap.session, id: 'second-session' }, events: [] });

// A failed message must stay attached to its original session when retried after navigation.
{
  const calls = [];
  const { lina, store, snap } = fresh({ send: async (...args) => { calls.push(args); if (calls.length === 1) throw new Error('offline'); return { queued: false }; } });
  await lina.send('original request', [], false);
  const cid = store.get().pending[0].cid;
  store.set({ currentId: 'second-session', view: viewFromSnapshot(second(snap)) });
  lina.retryPending(cid);
  await delay(0);
  assert.deepEqual(calls.map((c) => c[0]), [snap.session.id, snap.session.id]);
  assert.equal(store.get().pending[0].sessionId, snap.session.id);
}

// A failed history fetch must never insert session A's events into the newly opened B.
{
  const request = deferred();
  const { lina, store, snap } = fresh({ events: () => request.promise });
  const trigger = { sessionId: snap.session.id, seq: 11, ts: Date.now(), actor: 'codex', type: 'message', data: { id: 'late', text: 'Only session A', kind: 'chat' } };
  const resync = lina.resync(trigger);
  const other = viewFromSnapshot(second(snap));
  store.set({ currentId: other.session.id, view: other });
  request.reject(new Error('connection lost'));
  await resync;
  assert.equal(store.get().view, other);
  assert.equal(store.get().view.timeline.length, 0);
}

// Repeating recent text cannot let its old echo hide a new failed message.
{
  const request = deferred();
  const { lina, store, snap } = fresh({ send: () => request.promise });
  const old = { sessionId: snap.session.id, seq: 10, ts: Date.now(), actor: 'user', type: 'message', data: { id: 'old', text: 'Try again', kind: 'chat' } };
  lina.onEvent(old);
  const sending = lina.send('Try again', [], false);
  lina.onSnapshot(snap.session.id, { ...snap, session: { ...snap.session, lastSeq: 10 }, events: [...snap.events, old] });
  assert.equal(store.get().pending.length, 1, 'a prior identical message is not an acknowledgement');
  request.reject(new Error('offline'));
  await sending;
  assert.equal(store.get().pending[0].state, 'failed');
}

// Two concurrent history repairs retain independent queues across session navigation.
{
  const a = deferred(), b = deferred();
  const { lina, store, snap } = fresh({ events: (id) => id === snap.session.id ? a.promise : b.promise });
  const event = (id, seq, text) => ({ sessionId: id, seq, ts: Date.now(), actor: 'codex', type: 'message', data: { id: text, text, kind: 'chat' } });
  const first = lina.resync(event(snap.session.id, 11, 'A'));
  const other = viewFromSnapshot(second(snap));
  store.set({ currentId: other.session.id, view: other });
  const next = lina.resync(event(other.session.id, 2, 'B'));
  a.resolve([]); await first;
  lina.onEvent(event(other.session.id, 3, 'B queued'));
  b.resolve([event(other.session.id, 1, 'B first')]); await next;
  assert.deepEqual(store.get().view.timeline.map((e) => e.data.text), ['B first', 'B', 'B queued']);
}

// A failed repair leaves its cursor behind the gap so the next event can recover it.
{
  let attempts = 0;
  const { lina, store, snap } = fresh({ events: async () => { attempts++; if (attempts === 1) throw new Error('offline'); return [event(10), event(11)]; } });
  const event = (seq) => ({ sessionId: snap.session.id, seq, ts: Date.now(), actor: 'codex', type: 'message', data: { id: `m${seq}`, text: `message ${seq}`, kind: 'chat' } });
  await lina.resync(event(11));
  assert.equal(store.get().view.lastSeq, 9);
  lina.onEvent(event(12));
  await delay(0);
  assert.equal(store.get().view.lastSeq, 12);
  assert.deepEqual(store.get().view.timeline.slice(-3).map((e) => e.seq), [10, 11, 12]);
}

// Missing final events recover without needing another message to arrive.
{
  let attempts = 0;
  const { lina, store, snap } = fresh({ events: async () => { if (++attempts === 1) throw new Error('brief outage'); return [event(10), event(11)]; } });
  const event = (seq) => ({ sessionId: snap.session.id, seq, ts: Date.now(), actor: 'codex', type: 'message', data: { id: `m${seq}`, text: `message ${seq}`, kind: 'chat' } });
  await lina.resync(event(11));
  await delay(1100);
  assert.equal(store.get().view.lastSeq, 11);
  assert.equal(attempts, 2);
}

// A late snapshot from another session cannot cancel the selected session's REST fallback.
{
  const { lina, snap } = fresh({});
  let fired = false;
  lina.snapshotTimer = setTimeout(() => { fired = true; }, 10);
  lina.onSnapshot('second-session', second(snap));
  await delay(30);
  assert.equal(fired, true);
  lina.select(null, { replace: true });
  assert.equal(lina.store.get().ui.composerPrefill, null);
}

// Uploads already selected for a session retain that destination after navigation.
{
  const calls = [];
  const { lina, store, snap } = fresh({ upload: async (...args) => { calls.push(args); return { id: 'attachment' }; } });
  store.set({ currentId: 'second-session' });
  await lina.upload(new win.File(['hello'], 'notes.txt', { type: 'text/plain' }), snap.session.id);
  assert.equal(calls[0][0], snap.session.id);
}

// Inline onClose handlers change identity each render. Typing must not reset modal focus.
{
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  let latestClosed = false;
  const render = (value, onClose) => React.createElement(Modal, { open: true, title: 'New session', onClose },
    React.createElement('input', { 'data-autofocus': true, 'aria-label': 'Task', defaultValue: '' }),
    React.createElement('input', { 'aria-label': 'Title', value, onChange() {} }));
  await act(async () => { root.render(render('', () => {})); });
  await act(async () => { await delay(30); });
  const title = document.querySelector('[aria-label="Title"]');
  title.focus();
  await act(async () => { root.render(render('typed title', () => { latestClosed = true; })); });
  await act(async () => { await delay(30); });
  assert.equal(document.activeElement, title, 'modal must retain the field being edited');
  await act(async () => { document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  assert.equal(latestClosed, true, 'Escape must use the latest close handler');
  await act(async () => { root.unmount(); });
}

// Repeated Enter/touch submissions create one session while the request is pending.
{
  const request = deferred();
  let creates = 0;
  const { lina, store, snap } = fresh({ createSession: () => { creates++; return request.promise; } });
  store.set((s) => ({ projects: [snap.project], ui: { ...s.ui, newSession: { projectId: snap.project.id } } }));
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(LinaContext.Provider, { value: lina }, React.createElement(NewSessionDialog))); });
  const form = document.querySelector('form.form');
  await act(async () => {
    form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  });
  assert.equal(creates, 1);
  await act(async () => { request.reject(new Error('temporary failure')); await delay(0); });
  assert.match(document.body.textContent, /temporary failure/);
  await act(async () => { root.unmount(); });
}

// A search result older than the 2,000-event snapshot loads the missing pages
// and focuses its actual message without replacing current live state.
{
  const calls = [];
  const { lina, store, snap } = fresh({ history: async (_id, before, limit = 500) => {
    calls.push(before);
    return events.filter((e) => e.seq < before).slice(-limit);
  } });
  const events = Array.from({ length: 2105 }, (_, i) => ({ sessionId: snap.session.id, seq: i + 1, ts: Date.now() + i,
    type: 'message', actor: 'user', data: { id: `history-${i + 1}`, kind: 'chat', text: `Historical message ${i + 1}` } }));
  const view = viewFromSnapshot({ ...snap, session: { ...snap.session, lastSeq: 2105 }, events: events.slice(-2000) });
  store.set({ view, ui: { ...store.get().ui, focusSeq: 2 } });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  let focused = false;
  const scroll = win.HTMLElement.prototype.scrollIntoView;
  win.HTMLElement.prototype.scrollIntoView = function () { if (this.id === 'ev-2') focused = true; };
  await act(async () => {
    root.render(React.createElement(LinaContext.Provider, { value: lina }, React.createElement(Conversation, { view: store.get().view })));
    await delay(0);
  });
  // The app normally passes each updated store view through App's subscription.
  await act(async () => { root.render(React.createElement(LinaContext.Provider, { value: lina }, React.createElement(Conversation, { view: store.get().view }))); });
  assert.equal(store.get().view.timeline[0].seq, 1);
  assert.equal(store.get().view.lastSeq, 2105);
  assert.equal(store.get().view.session, view.session);
  assert.deepEqual(calls, [106]);
  assert.equal(focused, true, 'the old search result must become a rendered, focused message');
  assert.match(document.body.textContent, /Historical message 2/);
  win.HTMLElement.prototype.scrollIntoView = scroll;
  await act(async () => { root.unmount(); });
}

// An old page completing after leaving and reopening a session cannot create a history gap.
{
  const request = deferred();
  const { lina, store, snap } = fresh({ history: () => request.promise });
  const old = { ...snap.events[0], seq: 100 };
  store.set({ view: viewFromSnapshot({ ...snap, events: [old] }) });
  const loading = lina.loadEarlier();
  lina.select(null, { replace: true });
  store.set({ currentId: snap.session.id, view: viewFromSnapshot({ ...snap, events: [{ ...old, seq: 500 }] }) });
  request.resolve([{ ...old, seq: 99 }]);
  await loading;
  assert.deepEqual(store.get().view.timeline.map((e) => e.seq), [500]);
}
await win.happyDOM.close();
console.log('Web DOM focus, cross-session retry/upload, snapshot fallback, paged search history and race checks passed.');
