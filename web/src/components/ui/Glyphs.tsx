// Original identity marks. Geometric, not company logos:
//  Codex    → "facet": a crystalline hexagon with a cut (glacier)
//  Claude   → "ember": a disc rising over a horizon line (warm)
//  Freebuff → "spark": a four-point glint on a base line (lime)
//  LINA     → "orbit": a violet core with the agents in orbit
//  You      → "pearl": a soft ring
import type { Actor } from '@shared/types';
import { cx } from '../../lib/format';

export function BrandMark({ size = 28, live = false, className }: { size?: number; live?: boolean; className?: string }) {
  return (
    <svg className={cx('brand-mark', live && 'is-live', className)} width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <radialGradient id="bm-core" cx="50%" cy="40%" r="60%">
          <stop offset="0%" stopColor="var(--iris-hi)" />
          <stop offset="100%" stopColor="var(--iris)" />
        </radialGradient>
      </defs>
      <g className="bm-orbit">
        <ellipse cx="16" cy="16" rx="12" ry="5.2" fill="none" stroke="var(--iris)" strokeOpacity=".5" strokeWidth="1.4" transform="rotate(-30 16 16)" />
        <circle className="bm-codex" cx="5.6" cy="22" r="2.8" fill="var(--glacier)" />
        <circle className="bm-claude" cx="26.4" cy="10" r="2.8" fill="var(--ember)" />
        <circle className="bm-freebuff" cx="16" cy="4.2" r="2.2" fill="var(--freebuff)" />
      </g>
      <path d="M16 11.2 20.8 16 16 20.8 11.2 16Z" fill="url(#bm-core)" />
    </svg>
  );
}

export function Glyph({ actor, size = 16 }: { actor: Actor; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true as const };
  switch (actor) {
    case 'codex':
      return (
        <svg {...common}>
          <path d="M12 2.6 20.2 7.3v9.4L12 21.4 3.8 16.7V7.3Z" fill="currentColor" fillOpacity=".16" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
          <path d="M12 2.8v9.2l8 4.6M12 12l-8 4.6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeOpacity=".75" />
        </svg>
      );
    case 'claude':
      return (
        <svg {...common}>
          <path d="M4.5 15.2a7.5 7.5 0 0 1 15 0Z" fill="currentColor" />
          <path d="M2.8 18.6h18.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M7.5 21.4h9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeOpacity=".55" />
          <circle cx="12" cy="4.4" r="1.3" fill="currentColor" fillOpacity=".7" />
        </svg>
      );
    case 'freebuff':
      return (
        <svg {...common}>
          <path d="M12 2.4c.9 4.4 2.6 6.1 7 7-4.4.9-6.1 2.6-7 7-.9-4.4-2.6-6.1-7-7 4.4-.9 6.1-2.6 7-7Z" fill="currentColor" fillOpacity=".22" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
          <path d="M4.2 19.6h15.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeOpacity=".6" />
          <circle cx="19.4" cy="19.6" r="1.3" fill="currentColor" />
        </svg>
      );
    case 'lina':
      return (
        <svg {...common}>
          <ellipse cx="12" cy="12" rx="9.6" ry="4.1" fill="none" stroke="currentColor" strokeOpacity=".55" strokeWidth="1.5" transform="rotate(-30 12 12)" />
          <path d="M12 8.3 15.7 12 12 15.7 8.3 12Z" fill="currentColor" />
          <circle cx="3.7" cy="16.8" r="1.9" fill="var(--glacier)" />
          <circle cx="20.3" cy="7.2" r="1.9" fill="var(--ember)" />
          <circle cx="16" cy="3.4" r="1.6" fill="var(--freebuff)" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="7.6" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <circle cx="12" cy="12" r="3" fill="currentColor" fillOpacity=".8" />
        </svg>
      );
  }
}

export function Avatar({ actor, size = 30, live = false }: { actor: Actor; size?: number; live?: boolean }) {
  return (
    <span className={cx('avatar', live && 'is-live')} data-actor={actor} style={{ width: size, height: size }}>
      <Glyph actor={actor} size={Math.round(size * 0.58)} />
    </span>
  );
}
