/**
 * UI side of the SUPERPORT kill switch: a full-page "temporarily unavailable" notice when APP_MAINTENANCE
 * is on, and a slim banner while it is readonly, both linking to the public status page. Also the
 * "license not active" page for sites without an active Marketplace license.
 *
 * @file        static/app/src/views/Maintenance.tsx
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import { motion } from 'framer-motion';
import { ExternalLink, KeyRound, PauseCircle, ShieldCheck, Wrench } from 'lucide-react';
import { useStore } from '../store';
import { useT } from '../i18n';
import { Logo, easeOut } from '../ui';

/** Opens the public status page (Jira's router when inside Jira, a new tab otherwise). */
async function openStatus(url: string) {
  try {
    const { router } = await import('@forge/bridge');
    await router.open(url);
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

/** Full-page notice while SUPERPORT has taken the app down (APP_MAINTENANCE=on). Purely informational. */
export function Maintenance() {
  const t = useT();
  const statusUrl = useStore((s) => s.statusUrl);
  return (
    <div className="empty" style={{ minHeight: '86vh', justifyContent: 'center' }}>
      <motion.div className="brand-mark" style={{ width: 56, height: 56, borderRadius: 14 }} initial={{ scale: 0.7, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}><Logo size={56} /></motion.div>
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: easeOut, delay: 0.1 }} className="col" style={{ gap: 10, alignItems: 'center', maxWidth: 520 }}>
        <span className="pill pill-accent" style={{ padding: '6px 12px', gap: 6, fontWeight: 600 }}><ShieldCheck size={16} /><Wrench size={16} />{t('maintBadge')}</span>
        <h1 className="h1">{t('maintTitle')}</h1>
        <p className="muted">{t('maintBody')}</p>
        <button type="button" className="btn btn-dark" onClick={() => void openStatus(statusUrl)}>
          {t('maintStatus')}<ExternalLink size={16} />
        </button>
      </motion.div>
    </div>
  );
}

/** Full-page notice when the site has no active Marketplace license (trial ended, subscription cancelled). */
export function Unlicensed() {
  const t = useT();
  return (
    <div className="empty" style={{ minHeight: '86vh', justifyContent: 'center' }}>
      <motion.div className="brand-mark" style={{ width: 56, height: 56, borderRadius: 14 }} initial={{ scale: 0.7, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}><Logo size={56} /></motion.div>
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: easeOut, delay: 0.1 }} className="col" style={{ gap: 10, alignItems: 'center', maxWidth: 540 }}>
        <span className="pill pill-accent" style={{ padding: '6px 12px', gap: 6, fontWeight: 600 }}><KeyRound size={16} />{t('licBadge')}</span>
        <h1 className="h1">{t('licTitle')}</h1>
        <p className="muted">{t('licBody')}</p>
      </motion.div>
    </div>
  );
}

/** Slim banner on every page while changes are paused (APP_MAINTENANCE=readonly). */
export function ReadonlyBanner() {
  const t = useT();
  const statusUrl = useStore((s) => s.statusUrl);
  return (
    <motion.div className="hint accent" role="status" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} style={{ marginBottom: 16 }}>
      <PauseCircle size={18} />
      <span className="grow">{t('maintReadonly')}</span>
      <button type="button" className="btn btn-ghost btn-xs" onClick={() => void openStatus(statusUrl)}>{t('maintStatus')}<ExternalLink size={14} /></button>
    </motion.div>
  );
}
