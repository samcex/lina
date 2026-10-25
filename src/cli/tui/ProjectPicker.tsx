// Project picker with "add path…" and "create new project…". Creating a
// directory or running `git init` always requires an explicit y/n confirmation.
import React, { useState } from 'react';
import { Box, Text, useInput, usePaste } from 'ink';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Project } from '../../shared/types.js';
import { LinaApiError } from '../../shared/client.js';
import { bg, bold, dim, fg, padAnsi, truncateAnsi } from '../ansi.js';
import { C } from '../theme.js';
import { listWindow } from '../layout.js';
import { expandHome, isDirectory } from '../util.js';
import * as E from './editor.js';
import { composerRows, spread } from './chrome.js';
import { useAsync } from './hooks.js';
import { describeError, type ClientLike } from './store.js';
import { Frame } from './overlays.js';
import { Lines } from './Lines.js';
import { useWheelSelection } from './mouse.js';

type Step =
  | { kind: 'list' }
  | { kind: 'input'; purpose: 'add' | 'create' }
  | { kind: 'confirm'; message: string; body: { path: string; create?: boolean; initGit?: boolean } }
  | { kind: 'working'; message: string };

export interface PickerProps {
  client: ClientLike;
  cwd: string;
  width: number;
  height: number;
  title?: string;
  /** Message shown above the list (e.g. why the picker opened). */
  intro?: string;
  onSelect: (p: Project) => void;
  onCancel?: () => void;
}

/** Decides what registering `path` needs (pure, exported for tests). */
export function planRegistration(input: string, cwd: string, purpose: 'add' | 'create'):
  | { action: 'error'; message: string }
  | { action: 'confirm'; message: string; body: { path: string; create?: boolean; initGit?: boolean } }
  | { action: 'register'; body: { path: string } } {
  const raw = input.trim();
  if (!raw) return { action: 'error', message: 'Enter a path.' };
  const path = resolve(cwd, expandHome(raw));
  if (!existsSync(path)) {
    return { action: 'confirm', message: `${path} does not exist. Create it and initialize a git repository there?`, body: { path, create: true, initGit: true } };
  }
  if (!isDirectory(path)) return { action: 'error', message: `${path} is not a directory.` };
  if (!existsSync(join(path, '.git'))) {
    return { action: 'confirm', message: `${path} is not a git repository. Run \`git init\` there so LINA can track changes?`, body: { path, initGit: true } };
  }
  void purpose;
  return { action: 'register', body: { path } };
}

export function ProjectPicker({ client, cwd, width, height, title = '◆ Choose a project', intro, onSelect, onCancel }: PickerProps) {
  const res = useAsync(() => client.projects(), []);
  const projects = (res.data ?? []).slice().sort((a, b) => b.updatedAt - a.updatedAt);
  const items = [...projects.map((p) => ({ kind: 'project' as const, p })), { kind: 'add' as const }, { kind: 'create' as const }];
  const [sel, setSel] = useState(0);
  const [step, setStep] = useState<Step>({ kind: 'list' });
  const [ed, setEd] = useState<E.Ed>(E.empty);
  const [error, setError] = useState<{ text: string; hint?: string } | undefined>();
  const h = Math.max(1, height - 4);
  const w = Math.max(10, width - 4);

  const register = async (body: { path: string; create?: boolean; initGit?: boolean }) => {
    setStep({ kind: 'working', message: body.create ? 'Creating project…' : body.initGit ? 'Initializing git and registering…' : 'Registering project…' });
    try {
      const p = await client.addProject(body);
      onSelect(p);
    } catch (e) {
      if (e instanceof LinaApiError && e.code === 'not_git' && !body.initGit) {
        setStep({ kind: 'confirm', message: `${body.path} is not a git repository. Run \`git init\` there?`, body: { ...body, initGit: true } });
        return;
      }
      setError(describeError(e));
      setStep({ kind: 'list' });
    }
  };

  const submitPath = (purpose: 'add' | 'create') => {
    const plan = planRegistration(ed.value, cwd, purpose);
    setError(undefined);
    if (plan.action === 'error') { setError({ text: plan.message }); return; }
    if (plan.action === 'confirm') { setStep({ kind: 'confirm', message: plan.message, body: plan.body }); return; }
    void register(plan.body);
  };

  useWheelSelection(setSel, items.length, step.kind === 'list');

  usePaste((text) => { if (step.kind === 'input') setEd((e) => E.insert(e, text.replace(/\n/g, ''))); }, { isActive: step.kind === 'input' });

  useInput((input, key) => {
    if (step.kind === 'working') return;
    if (step.kind === 'confirm') {
      if (input === 'y' || input === 'Y') void register(step.body);
      else if (input === 'n' || input === 'N' || key.escape) setStep({ kind: 'list' });
      return;
    }
    if (step.kind === 'input') {
      if (key.escape) { setStep({ kind: 'list' }); return; }
      if (key.return) { submitPath(step.purpose); return; }
      if (key.backspace) setEd(E.backspace);
      else if (key.delete) setEd(E.del);
      else if (key.leftArrow) setEd(E.left);
      else if (key.rightArrow) setEd(E.right);
      else if (key.ctrl && input === 'a') setEd(E.lineStart);
      else if (key.ctrl && input === 'e') setEd(E.lineEnd);
      else if (key.ctrl && input === 'u') setEd(E.killToLineStart);
      else if (key.ctrl && input === 'c') { setStep({ kind: 'list' }); }
      else if (input && !key.ctrl && !key.meta && !key.tab && !key.upArrow && !key.downArrow) setEd((e) => E.insert(e, input.replace(/[\r\n]/g, '')));
      return;
    }
    if (key.escape || (key.ctrl && input === 'c')) { onCancel?.(); return; }
    if (key.upArrow) setSel((s) => Math.max(0, s - 1));
    if (key.downArrow) setSel((s) => Math.min(items.length - 1, s + 1));
    if (input === 'r') res.reload();
    if (key.return) {
      const it = items[sel];
      if (!it) return;
      setError(undefined);
      if (it.kind === 'project') onSelect(it.p);
      else { setEd(it.kind === 'add' ? E.insert(E.empty, cwd) : E.insert(E.empty, cwd.replace(/\/?$/, '/'))); setStep({ kind: 'input', purpose: it.kind }); }
    }
  });

  const lines: string[] = [];
  if (intro) lines.push(...intro.split('\n').map((l) => truncateAnsi(l, w)), '');
  if (step.kind === 'list') {
    if (res.loading && !res.data) lines.push(dim('Loading projects…'));
    if (res.error) lines.push(fg(C.err)('✖ ' + describeError(res.error).text));
    const room = h - lines.length - (error ? 3 : 0);
    const win = listWindow(items.length, room, sel);
    items.slice(win.start, win.end).forEach((it, i) => {
      const idx = win.start + i;
      let line: string;
      if (it.kind === 'project') line = spread(`${bold(fg(C.text)(it.p.name))}`, dim(it.p.path), w - 2);
      else if (it.kind === 'add') line = fg(C.lina)('＋ Add an existing directory…');
      else line = fg(C.lina)('✚ Create a new project…');
      lines.push(idx === sel ? bg('#2E2645')(padAnsi(fg(C.lina)('▸') + line, w)) : ' ' + line);
    });
  } else if (step.kind === 'input') {
    lines.push(bold(step.purpose === 'add' ? 'Path of an existing directory to register:' : 'Path for the new project directory:'));
    const { rows } = composerRows(ed, w - 2, true);
    lines.push(...rows.map((r) => fg(C.lina)('❯ ') + r));
    lines.push('', dim(step.purpose === 'add' ? 'New sessions work directly in this directory; changes stay uncommitted.' : 'You will be asked to confirm before anything is created.'));
  } else if (step.kind === 'confirm') {
    lines.push(bold(fg(C.warn)(step.message)));
    lines.push('', `${bold(fg(C.ok)('y'))} yes   ${bold(fg(C.err)('n'))} no`);
  } else {
    lines.push(fg(C.lina)('◌ ') + step.message);
  }
  if (error) lines.push('', fg(C.err)('✖ ' + error.text), ...(error.hint ? [dim('↳ ' + error.hint)] : []));

  const hint = step.kind === 'list' ? `↑/↓ select · Enter choose${onCancel ? ' · Esc cancel' : ' · Esc quit'}` : step.kind === 'input' ? 'Enter continue · Esc back' : step.kind === 'confirm' ? 'y confirm · n cancel' : '';
  return (
    <Frame title={title} hint={hint} width={width} height={height}>
      <Lines lines={lines} height={h} />
    </Frame>
  );
}

/** Asks whether to register a git repo found at cwd. */
export function RegisterPrompt({ client, root, width, height, onDone, onDecline }: { client: ClientLike; root: string; width: number; height: number; onDone: (p: Project) => void; onDecline: () => void }) {
  const [state, setState] = useState<'ask' | 'working' | { error: string; hint?: string }>('ask');
  useInput((input, key) => {
    if (state === 'working') return;
    if (input === 'y' || input === 'Y' || (key.return && state === 'ask')) {
      setState('working');
      client.addProject({ path: root }).then(onDone, (e) => setState({ error: describeError(e).text, hint: describeError(e).hint }));
    } else if (input === 'n' || input === 'N' || key.escape || (key.ctrl && input === 'c')) onDecline();
  });
  const lines = [
    `${bold(fg(C.text)(root))} ${dim('is a git repository but not a LINA project yet.')}`,
    '',
    `Register it? ${dim('LINA edits your project directly by default; changes stay uncommitted.')}`,
    '',
    ...(state === 'working' ? [fg(C.lina)('◌ Registering…')] : []),
  ];
  if (typeof state === 'object') lines.push('', fg(C.err)('✖ ' + state.error), ...(state.hint ? [dim('↳ ' + state.hint)] : []), dim('y to retry · n to pick another project'));
  return (
    <Box width={width} height={height} flexDirection="column">
      <Frame title="◆ LINA — new project" hint="y register · n choose another project · Esc quit" width={width} height={Math.min(height, lines.length + 4)}>
        <Lines lines={lines} />
      </Frame>
      <Text> </Text>
    </Box>
  );
}
