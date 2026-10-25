import { useRef, useState, type ReactNode } from 'react';
import { useClickOutside } from '../../lib/hooks';
import { cx } from '../../lib/format';

/** Anchored popover. `trigger` receives the open state and a toggle function. */
export function Popover({
  trigger, children, align = 'start', side = 'bottom', className, panelClassName, width,
}: {
  trigger: (p: { open: boolean; toggle: () => void }) => ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: 'start' | 'end' | 'center';
  side?: 'bottom' | 'top';
  className?: string;
  panelClassName?: string;
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);
  useClickOutside(ref, close, open);
  return (
    <div ref={ref} className={cx('pop', className)}>
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && (
        <div className={cx('pop-panel', `pop-${align}`, `pop-${side}`, panelClassName)} style={width ? { width } : undefined} role="dialog">
          {typeof children === 'function' ? children(close) : children}
        </div>
      )}
    </div>
  );
}
