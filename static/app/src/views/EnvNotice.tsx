/**
 * Full-page notice shown instead of the app when the project cannot be managed: team-managed projects,
 * legacy field configurations, or a caller without the needed permission.
 *
 * @file        static/app/src/views/EnvNotice.tsx
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import { motion } from 'framer-motion';
import { Lock, Settings2, Users } from 'lucide-react';
import type { EnvironmentIssue } from '@shared/types';
import { useStore } from '../store';
import { useT } from '../i18n';
import { Logo, easeOut } from '../ui';

/** Clear notice instead of a half-working app (team-managed, legacy field configs, no permission). */
export function EnvNotice({ issue }: { issue: EnvironmentIssue }) {
  const t = useT();
  const key = useStore((s) => s.model?.project.key ?? '');
  const map = {
    'team-managed': { icon: <Users size={22} />, title: t('envTeam'), body: t('envTeamBody') },
    'legacy-field-config': { icon: <Settings2 size={22} />, title: t('envLegacy'), body: t('envLegacyBody') },
    'no-permission': { icon: <Lock size={22} />, title: t('envPerm'), body: t('envPermBody', { key }) },
  }[issue];
  return (
    <div className="empty" style={{ minHeight: '86vh', justifyContent: 'center' }}>
      <motion.div className="brand-mark" style={{ width: 56, height: 56, borderRadius: 14 }} initial={{ scale: 0.7, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}><Logo size={56} /></motion.div>
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: easeOut, delay: 0.1 }} className="col" style={{ gap: 10, alignItems: 'center', maxWidth: 520 }}>
        <span className="pill pill-accent" style={{ padding: 8 }}>{map.icon}</span>
        <h1 className="h1">{map.title}</h1>
        <p className="muted">{map.body}</p>
      </motion.div>
    </div>
  );
}
