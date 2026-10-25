import {
  BookOpen, CircleAlert, CircleCheck, Eye, FlaskConical, Hourglass, PenLine, TerminalSquare, Circle,
  FileSearch, FilePen, FilePlus, Globe, Wrench, GitCommitHorizontal, StickyNote, SquareTerminal,
} from 'lucide-react';
import type { ActivityKind, AgentStatus, SessionStatus } from '@shared/types';
import { STATUS_LABEL } from '@shared/reducer';
import { SESSION_STATUS_LABEL, cx } from '../../lib/format';

export function AgentStatusIcon({ status, size = 15 }: { status: AgentStatus; size?: number }) {
  const cls = cx('st-icon', `st-${status}`);
  switch (status) {
    case 'thinking':
      return <span className={cls} aria-label={STATUS_LABEL.thinking}><span className="think-dots"><i /><i /><i /></span></span>;
    case 'reading': return <span className={cls}><BookOpen size={size} /></span>;
    case 'writing': return <span className={cls}><PenLine size={size} /></span>;
    case 'running': return <span className={cls}><TerminalSquare size={size} /></span>;
    case 'testing': return <span className={cls}><FlaskConical size={size} /></span>;
    case 'reviewing': return <span className={cls}><Eye size={size} /></span>;
    case 'waiting': return <span className={cls}><Hourglass size={size} /></span>;
    case 'done': return <span className={cls}><CircleCheck size={size} /></span>;
    case 'error': return <span className={cls}><CircleAlert size={size} /></span>;
    default: return <span className={cls}><Circle size={size - 3} /></span>;
  }
}

export const isBusy = (s: AgentStatus) => !['idle', 'done', 'error', 'waiting'].includes(s);

export function SessionDot({ status, size = 8 }: { status: SessionStatus; size?: number }) {
  return (
    <span
      className="sdot" data-status={status} style={{ width: size, height: size }}
      role="img" aria-label={SESSION_STATUS_LABEL[status]} title={SESSION_STATUS_LABEL[status]}
    />
  );
}

export function ActivityIcon({ kind, size = 14 }: { kind: ActivityKind; size?: number }) {
  switch (kind) {
    case 'command': return <SquareTerminal size={size} />;
    case 'read': return <BookOpen size={size} />;
    case 'search': return <FileSearch size={size} />;
    case 'edit': return <FilePen size={size} />;
    case 'write': return <FilePlus size={size} />;
    case 'web': return <Globe size={size} />;
    case 'test': return <FlaskConical size={size} />;
    case 'git': return <GitCommitHorizontal size={size} />;
    case 'note': return <StickyNote size={size} />;
    default: return <Wrench size={size} />;
  }
}
