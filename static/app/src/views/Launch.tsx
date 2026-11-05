/**
 * First-run launch sequence shown while the project loads. Its four checklist ticks (company-managed
 * project, field schemes, admin permission, scan) reflect the real backend load rather than a timer.
 *
 * @file        static/app/src/views/Launch.tsx
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { useStore } from '../store';
import { useT, type Key } from '../i18n';
import { Logo, easeOut, spring } from '../ui';

const CHECKS: Key[] = ['launchCompany', 'launchFieldSchemes', 'launchPermission', 'launchScan'];

/** First-run sequence. Ticks reflect the real load: the backend verifies all four before answering. */
export function Launch() {
  const t = useT();
  const status = useStore((s) => s.status);
  const model = useStore((s) => s.model);
  const mode = useStore((s) => s.mode);
  const [ticked, setTicked] = useState(0);

  useEffect(() => {
    if (status === 'error' || status === 'unavailable' || status === 'unlicensed' || (status === 'ready' && model?.environmentIssue)) { useStore.setState({ introDone: true }); return; }
    if (status !== 'ready') return;
    if (mode === 'admin') { useStore.setState({ introDone: true }); return; }
    let i = 0;
    const id = setInterval(() => {
      i++; setTicked(i);
      if (i >= CHECKS.length) { clearInterval(id); setTimeout(() => useStore.setState({ introDone: true }), 420); }
    }, 130);
    return () => clearInterval(id);
  }, [status, model, mode]);

  return (
    <motion.main className="launch" aria-busy="true" exit={{ opacity: 0, scale: 1.02, filter: 'blur(6px)' }} transition={{ duration: 0.45, ease: easeOut }}>
      <div className="launch-card">
        <motion.div className="brand-mark" style={{ width: 56, height: 56, borderRadius: 14 }} initial={{ scale: 0.6, opacity: 0, rotate: -12 }} animate={{ scale: 1, opacity: 1, rotate: 0 }} transition={{ ...spring, delay: 0.05 }}>
          <Logo size={56} />
        </motion.div>
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: easeOut, delay: 0.15 }} className="col" style={{ gap: 4 }}>
          <div className="eyebrow">{t('appName')}</div>
          <h1 className="h1">{t('launchChecking', { key: model?.project.key ?? '…' })}</h1>
        </motion.div>
        <div className="col" style={{ gap: 12, width: '100%' }}>
          {CHECKS.map((k, i) => (
            <motion.div key={k} className={`check${ticked > i ? ' done' : ''}`} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.5, ease: easeOut, delay: 0.25 + i * 0.08 }}>
              <span className="box">
                {ticked > i
                  ? <motion.span initial={{ scale: 0, rotate: -45 }} animate={{ scale: 1, rotate: 0 }} transition={spring}><Check size={14} strokeWidth={3} /></motion.span>
                  : <motion.span style={{ width: 6, height: 6, borderRadius: 3, background: 'var(--line-strong)' }} animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.15 }} />}
              </span>
              <span className={ticked > i ? '' : 'muted'}>{t(k)}</span>
            </motion.div>
          ))}
        </div>
        <div className="progress">
          <motion.i initial={{ width: '6%' }} animate={{ width: status === 'ready' ? '100%' : '72%' }} transition={{ duration: status === 'ready' ? 0.5 : 4, ease: easeOut }} />
        </div>
      </div>
    </motion.main>
  );
}
