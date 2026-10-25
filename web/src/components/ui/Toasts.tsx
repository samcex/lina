import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react';
import { useApp } from '../../lib/store';
import { useLina } from '../../lib/lina';

const ICON = { info: Info, ok: CircleCheck, warn: TriangleAlert, error: CircleAlert };

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const lina = useLina();
  return (
    <div className="toasts" role="region" aria-live="polite" aria-label="Notifications">
      {toasts.map((t) => {
        const Icon = ICON[t.tone];
        return (
          <div key={t.id} className="toast" data-tone={t.tone} role={t.tone === 'error' ? 'alert' : 'status'}>
            <Icon size={16} className="toast-icon" />
            <div className="toast-body">
              <div className="toast-title">{t.title}</div>
              {t.detail && <div className="toast-detail">{t.detail}</div>}
            </div>
            {t.action && <button className="btn btn-sm btn-ghost" onClick={() => { t.action!.run(); lina.dismissToast(t.id); }}>{t.action.label}</button>}
            <button className="icon-btn icon-btn-sm" onClick={() => lina.dismissToast(t.id)} aria-label="Dismiss"><X size={14} /></button>
          </div>
        );
      })}
    </div>
  );
}
