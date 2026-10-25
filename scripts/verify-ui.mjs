// Render checks and controller checks for environments without a browser surface.
// This does not claim to replace interactive browser/layout verification.
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Store, initialState, setStore } from '../web/src/lib/store.ts';
import { Lina, LinaContext } from '../web/src/lib/lina.ts';
import { PreviewsPanel } from '../web/src/components/inspector/PreviewsPanel.tsx';
import { SessionHeader } from '../web/src/components/SessionHeader.tsx';
import { AgentModelPill } from '../web/src/components/ModelPicker.tsx';
import { LivePanel } from '../web/src/components/inspector/LivePanel.tsx';
import { viewFromSnapshot } from '../src/shared/reducer.ts';
import { DEFAULT_SETTINGS } from '../src/shared/types.ts';
import { project, session } from '../test/cli/fixture.ts';

globalThis.window = { innerWidth: 1440 };
const current = { ...session, status: 'completed', phase: 'completed', config: { ...session.config, workspaceMode: 'direct', interactionMode: 'chat' } };
const view = viewFromSnapshot({ session: current, project, events: [], findings: [], live: { agents: {}, streams: {}, rateLimits: {} } });
const state = initialState(false);
Object.assign(state, { currentId: current.id, view, settings: DEFAULT_SETTINGS });
const store = new Store(state); setStore(store);
let undoCall;
const lina = new Lina({ fixture: false, client: { undo: async (sid, turn) => { undoCall = [sid, turn]; return { turn }; } } });
const render = (Component) => renderToStaticMarkup(React.createElement(LinaContext.Provider, { value: lina }, React.createElement(Component, { view })));
const previews = render(PreviewsPanel);
assert.match(previews, /aria-label="Preview command"/);
assert.match(previews, /Start preview/);
assert.match(previews, /daemon restarts/);
assert.doesNotMatch(previews, /disabled=""/); // full-access preview startup needs no approval
const header = render(SessionHeader);
assert.match(header, /Full access/);
assert.match(header, />Chat</);
assert.match(header, /Direct/);
await lina.undo(7);
assert.deepEqual(undoCall, [current.id, 7]);
assert.equal(store.get().ui.inspectorTab, 'changes');
assert.ok(store.get().toasts.some((t) => t.title === 'Undid turn 7'));
assert.match(header, /aria-label="View Codex activity"/);
assert.match(header, /aria-label="Codex model settings"/);
assert.match(header, /aria-label="View Claude activity"/);

// Activate the actual activity button's handler; model configuration must stay untouched.
let modelChanged = false;
const pill = AgentModelPill({ agent: 'codex', role: 'Developer', value: current.config.models.codex,
  onInspect: () => lina.inspectAgent('codex'), onChange: () => { modelChanged = true; } });
const activityButton = React.Children.toArray(pill.props.children).find((child) => child.type === 'button');
lina.setUI({ inspectorOpen: false, inspectorTab: 'files' });
activityButton.props.onClick();
assert.equal(store.get().ui.inspectorOpen, true);
assert.equal(store.get().ui.inspectorTab, 'live');
assert.equal(store.get().ui.liveAgent, 'codex');
assert.equal(modelChanged, false);

view.streams = {
  c1: { agent: 'codex', text: 'Inspecting the requested files' },
  c2: { agent: 'claude', text: 'Reviewing the implementation' },
};
view.agents.codex.activity = [{ key: 'codex:a1', agent: 'codex', id: 'a1', kind: 'command',
  title: 'npm run typecheck', detail: 'Checking types', state: 'running', source: 'observed', ts: Date.now() }];
let live = render(LivePanel);
assert.match(live, /Codex live status/);
assert.doesNotMatch(live, /Claude live status/);
assert.match(live, /Inspecting the requested files/);
assert.match(live, /npm run typecheck/);
assert.doesNotMatch(live, /Reviewing the implementation/);
view.streams.c1.text += ' and running checks';
assert.match(render(LivePanel), /and running checks/);
view.streams = {};
view.timeline = [{ sessionId: current.id, seq: 1, ts: Date.now(), type: 'message', actor: 'codex',
  data: { id: 'c1', text: 'Checks passed', kind: 'chat' } }];
assert.match(render(LivePanel), /Latest update/);
assert.match(render(LivePanel), /Checks passed/);
lina.inspectAgent('claude');
live = render(LivePanel);
assert.match(live, /Claude live status/);
assert.doesNotMatch(live, /Codex live status/);
lina.setUI({ liveAgent: null });
assert.match(render(LivePanel), /Codex live status/);
assert.match(render(LivePanel), /Claude live status/);
// The shortcut also opens the mobile inspector, and focus is session-local.
window.innerWidth = 500;
lina.setUI({ inspectorOpen: false });
lina.inspectAgent('codex');
assert.equal(store.get().ui.inspectorOpen, true);
assert.equal(store.get().ui.liveAgent, 'codex');
lina.select(null, { replace: true });
assert.equal(store.get().ui.liveAgent, null);
console.log('Preview/header controls, agent activity navigation/live updates, and undo controller passed.');
