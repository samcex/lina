// Tiny external store + selector hook (useSyncExternalStore). No dependencies.
import { useSyncExternalStore } from 'react';
import type {
  AgentId, AgentModels, Attachment, ModelValidation, Project, Session, Settings,
} from '@shared/types';
import type { SessionView } from '@shared/reducer';

export type InspectorTab = 'live' | 'changes' | 'files' | 'review' | 'tests' | 'previews' | 'summary';
export const INSPECTOR_TABS: InspectorTab[] = ['live', 'changes', 'files', 'review', 'tests', 'previews', 'summary'];

export interface Toast {
  id: number;
  tone: 'info' | 'ok' | 'warn' | 'error';
  title: string;
  detail?: string;
  action?: { label: string; run: () => void };
}

export interface PendingMsg {
  cid: string;
  sessionId: string;
  text: string;
  ts: number;
  /** Last event already visible when sending; older identical messages are not acknowledgements. */
  afterSeq?: number;
  state: 'sending' | 'sent' | 'failed';
  attachments: Attachment[];
  interrupt: boolean;
  queued?: boolean;
  error?: string;
}

export interface DiffRange { from?: string; to?: string; label?: string; focusPath?: string }

/** Which line of work the workspace views show: null = the session workspace, else that agent's worktree. */
export type Worktree = AgentId | null;

export type ValidationState = { state: 'checking' } | { state: 'done'; result: ModelValidation };

export interface UIState {
  sidebarOpen: boolean;
  inspectorOpen: boolean;
  inspectorTab: InspectorTab;
  liveAgent: AgentId | null;
  inspectorWidth: number;
  palette: boolean;
  settings: false | 'general' | 'models' | 'doctor';
  addProject: boolean;
  newSession: false | { projectId?: string };
  diffRange: DiffRange | null;
  filePath: string | null;
  worktree: Worktree;
  composerPrefill: { text: string; nonce: number } | null;
  composerFocus: number;
  focusSeq: number | null;
  theme: 'dark' | 'light';
}

export interface AppState {
  conn: 'connecting' | 'open' | 'closed';
  everOpen: boolean;
  projects: Project[];
  projectsLoaded: boolean;
  sessions: Record<string, Session>;
  sessionsLoaded: boolean;
  currentId: string | null;
  view: SessionView | null;
  viewError: string | null;
  models: Record<AgentId, AgentModels> | null;
  modelsLoading: boolean;
  modelsError: string | null;
  validations: Record<string, ValidationState>;
  settings: Settings | null;
  pending: PendingMsg[];
  ui: UIState;
  toasts: Toast[];
  fixture: boolean;
  /** Stored token was rejected (daemon restarted with a new token). */
  unauthorized: boolean;
  /** The open session was deleted (here or from another client). */
  deleted: { id: string; title: string } | null;
}

type Listener = () => void;

export class Store<S> {
  private listeners = new Set<Listener>();
  constructor(private state: S) {}
  get = (): S => this.state;
  set = (patch: Partial<S> | ((s: S) => Partial<S>)) => {
    const p = typeof patch === 'function' ? patch(this.state) : patch;
    let changed = false;
    for (const k in p) if ((p as S)[k] !== this.state[k]) { changed = true; break; }
    if (!changed) return;
    this.state = { ...this.state, ...p };
    for (const l of this.listeners) l();
  };
  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  };
}

function readLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch { return fallback; }
}
export function writeLocal(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

export function initialState(fixture: boolean): AppState {
  const wide = typeof window !== 'undefined' ? window.innerWidth : 1440;
  return {
    conn: 'connecting',
    everOpen: false,
    projects: [],
    projectsLoaded: false,
    sessions: {},
    sessionsLoaded: false,
    currentId: null,
    view: null,
    viewError: null,
    models: null,
    modelsLoading: false,
    modelsError: null,
    validations: {},
    settings: null,
    pending: [],
    toasts: [],
    fixture,
    unauthorized: false,
    deleted: null,
    ui: {
      sidebarOpen: wide >= 900,
      inspectorOpen: wide >= 1280 && readLocal('lina.inspectorOpen', true),
      inspectorTab: readLocal<InspectorTab>('lina.inspectorTab', 'live'),
      liveAgent: null,
      inspectorWidth: readLocal('lina.inspectorWidth', 420),
      palette: false,
      settings: false,
      addProject: false,
      newSession: false,
      diffRange: null,
      filePath: null,
      worktree: null,
      composerPrefill: null,
      composerFocus: 0,
      focusSeq: null,
      theme: readLocal<'dark' | 'light'>('lina.theme', 'dark'),
    },
  };
}

let storeRef: Store<AppState> | null = null;
export function setStore(s: Store<AppState>) { storeRef = s; }
export function getStore(): Store<AppState> {
  if (!storeRef) throw new Error('store not initialised');
  return storeRef;
}

/** Subscribe to a slice of app state. Selectors must return stable references or primitives. */
export function useApp<T>(sel: (s: AppState) => T): T {
  const st = getStore();
  return useSyncExternalStore(st.subscribe, () => sel(st.get()), () => sel(st.get()));
}
export const useUI = <T,>(sel: (u: UIState) => T): T => useApp((s) => sel(s.ui));
