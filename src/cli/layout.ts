// Pure layout and formatting helpers for the TUI (unit-tested).
import type { AgentModelChoice } from '../shared/types.js';

export const WIDE_MIN_COLS = 110;

export interface LayoutInput {
  columns: number;
  rows: number;
  /** Visible composer text lines (≥1). */
  composerLines: number;
  /** Lines used by the suggestion popup above the composer. */
  suggestionLines: number;
  /** Lines used by banners (approval / confirm / queued hint). */
  bannerLines: number;
}

export interface Layout {
  wide: boolean;
  columns: number;
  rows: number;
  headerHeight: number;
  sideWidth: number;
  /** Width available to transcript text (inside its padding). */
  transcriptWidth: number;
  /** Lines available to the transcript. */
  transcriptHeight: number;
  /** Height of each stacked agent panel (wide) or of the compact row (narrow). */
  panelHeight: number;
  compactRowHeight: number;
  composerHeight: number;
  footerHeight: number;
}

export const HEADER_HEIGHT = 3; // two info lines + rule
export const FOOTER_HEIGHT = 1;
export const COMPACT_ROW_HEIGHT = 5; // original compact cards, expanded when room permits

export function computeLayout(i: LayoutInput): Layout {
  const columns = Math.max(20, i.columns);
  const rows = Math.max(8, i.rows);
  const wide = columns >= WIDE_MIN_COLS;
  const composerHeight = Math.min(8, Math.max(1, i.composerLines), Math.max(1, rows - 9)) + (rows < 10 ? 1 : 2);
  const bottom = composerHeight + FOOTER_HEIGHT + i.suggestionLines + i.bannerLines;
  const mainHeight = Math.max(1, rows - HEADER_HEIGHT - bottom);
  if (wide) {
    const sideWidth = Math.min(64, Math.max(40, Math.round(columns * 0.34)));
    return {
      wide, columns, rows, headerHeight: HEADER_HEIGHT, sideWidth,
      transcriptWidth: columns - sideWidth - 3, transcriptHeight: mainHeight,
      panelHeight: Math.floor(mainHeight / 2), compactRowHeight: 0, composerHeight, footerHeight: FOOTER_HEIGHT,
    };
  }
  const compact = mainHeight >= 10 ? Math.min(8, Math.max(COMPACT_ROW_HEIGHT, Math.floor(mainHeight * 0.4))) : 0;
  return {
    wide, columns, rows, headerHeight: HEADER_HEIGHT, sideWidth: 0,
    transcriptWidth: columns - 2, transcriptHeight: Math.max(1, mainHeight - compact),
    panelHeight: 0, compactRowHeight: compact, composerHeight, footerHeight: FOOTER_HEIGHT,
  };
}

/** Index window into `total` lines given an offset from the bottom (0 = follow). */
export function visibleWindow(total: number, height: number, offsetFromBottom: number): { start: number; end: number; offset: number } {
  const maxOffset = Math.max(0, total - height);
  const offset = Math.min(Math.max(0, offsetFromBottom), maxOffset);
  const end = total - offset;
  const start = Math.max(0, end - height);
  return { start, end, offset };
}

export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

export function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function formatAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

export function modelLabel(c?: AgentModelChoice | { model?: string; effort?: string }): string {
  if (!c?.model) return '—';
  return c.effort ? `${c.model}·${c.effort}` : c.model;
}

export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return formatElapsed(ms);
}

/** Window of `room` rows over a list of `total` items that keeps `sel` roughly centered. */
export function listWindow(total: number, room: number, sel: number): { start: number; end: number } {
  const r = Math.max(1, room);
  const start = Math.max(0, Math.min(sel - Math.floor(r / 2), total - r));
  return { start, end: Math.min(total, start + r) };
}
