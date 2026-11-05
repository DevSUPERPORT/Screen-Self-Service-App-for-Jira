/**
 * Toast stack for success, error and info messages, with optional actions such as Undo. Toasts can be
 * swiped or clicked away, and auto-dismiss pauses while the pointer or focus is on them.
 *
 * @file        static/app/src/views/Toasts.tsx
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import { AnimatePresence, motion } from 'framer-motion';
import { useShallow } from 'zustand/react/shallow';
import { AlertTriangle, Check, Info, X } from 'lucide-react';
import { useStore } from '../store';
import { spring } from '../ui';
import { useT } from '../i18n';

export function Toasts() {
  const { toasts, dismiss } = useStore(useShallow((s) => ({ toasts: s.toasts, dismiss: s.dismiss })));
  const tr = useT();
  return (
    <div className="toasts" role="status" aria-live="polite"
      onPointerEnter={() => useStore.getState().holdToasts(true)} onPointerLeave={() => useStore.getState().holdToasts(false)}
      onFocus={() => useStore.getState().holdToasts(true)} onBlur={() => useStore.getState().holdToasts(false)}>
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            className={`toast ${t.tone}`}
            initial={{ opacity: 0, y: 24, scale: 0.92 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, x: -40, scale: 0.95, transition: { duration: 0.2 } }}
            transition={spring}
            drag="x"
            dragConstraints={{ left: 0, right: 0 }}
            dragElastic={0.6}
            onDragEnd={(_, i) => { if (Math.abs(i.offset.x) > 80) dismiss(t.id); }}
          >
            <span className="ic">
              <motion.span initial={{ scale: 0, rotate: -90 }} animate={{ scale: 1, rotate: 0 }} transition={{ ...spring, delay: 0.08 }} style={{ display: 'inline-flex' }}>
                {t.tone === 'ok' ? <Check size={15} strokeWidth={3} /> : t.tone === 'error' ? <AlertTriangle size={14} /> : <Info size={14} />}
              </motion.span>
            </span>
            <span className="grow">{t.text}</span>
            {t.action && <button type="button" className="toast-action" onClick={() => { t.action!.run(); dismiss(t.id); }}>{t.action.label}</button>}
            <button type="button" className="btn btn-ghost btn-xs btn-icon" style={{ color: 'inherit' }} onClick={() => dismiss(t.id)} aria-label={tr('dismiss')}><X size={14} /></button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
