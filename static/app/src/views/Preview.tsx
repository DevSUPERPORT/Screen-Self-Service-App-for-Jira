/**
 * Animated "what happens" list rendered straight from a plan's preview items (new, renamed, changed,
 * unchanged, freed, deleted), so users see exactly what the backend will execute.
 *
 * @file        static/app/src/views/Preview.tsx
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import { AnimatePresence, motion } from 'framer-motion';
import { ArrowRight } from 'lucide-react';
import type { Plan, PreviewItem, ProjectModel } from '@shared/types';
import { useT, type Key } from '../i18n';
import { easeOut, spring } from '../ui';

const PILL: Record<PreviewItem['kind'], string> = {
  new: 'pill pill-solid', renamed: 'pill pill-ink', changed: 'pill pill-ink', unchanged: 'pill pill-line', freed: 'pill pill-line', deleted: 'pill pill-danger',
};

/** Animated "what happens" list, rendered straight from the plan the backend will execute. */
export function PreviewList({ plan, m }: { plan: Plan; m: ProjectModel }) {
  const t = useT();
  const refName = (id: string) => {
    const st = plan.steps.find((s) => s.kind === 'createScreen' && s.ref === id) as { name: string } | undefined;
    const renamed = plan.steps.find((s) => s.kind === 'renameScreen' && s.screenId === id) as { to: string } | undefined;
    return renamed?.to ?? st?.name ?? m.screens[id]?.name ?? id;
  };
  const text = (p: PreviewItem): { main: React.ReactNode; sub?: string } => {
    if (p.title.startsWith('op:')) {
      const op = t(`op_${p.title.slice(3)}` as Key);
      if (p.detail === 'inherits') return { main: p.kind === 'unchanged' ? t('opInheritsStill', { op }) : t('opInherits', { op }) };
      return { main: t('opUses', { op, name: refName(p.detail!.slice(7)) }) };
    }
    if (p.title === 'mapping') return { main: t('pvMapping', { it: p.detail ?? '' }) };
    if (p.title === 'remaining') return { main: t('pvRemaining', { its: p.detail ?? '' }) };
    if (p.kind === 'renamed') return { main: <><span className="from">{p.from}</span><ArrowRight size={14} className="muted" /><span className="to">{p.title}</span></> };
    const sub = p.detail?.startsWith('copy:') ? t('copyOf', { name: p.detail.slice(5) }) : p.detail === 'empty' ? t('emptyScreen') : p.detail === 'seeded' ? t('seededScreen') : undefined;
    return { main: <span className="to">{p.title}</span>, sub };
  };
  const items = plan.preview;
  return (
    <div className="pv-list">
      <AnimatePresence mode="popLayout" initial={false}>
        {items.length === 0 ? (
          <motion.div key="empty" className="pv-empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>{t('nothingChanges')}</motion.div>
        ) : items.map((p, i) => {
          const x = text(p);
          return (
            <motion.div
              layout
              key={`${p.kind}-${p.title}-${p.from ?? ''}-${p.detail ?? ''}`}
              className="pv"
              initial={{ opacity: 0, y: 10, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, x: 20, transition: { duration: 0.18 } }}
              transition={{ ...spring, opacity: { duration: 0.35, ease: easeOut, delay: i * 0.035 } }}
            >
              <span className={PILL[p.kind]}>{t(`pv_${p.kind}` as Key)}</span>
              {x.main}
              {x.sub && <span className="muted">{x.sub}</span>}
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
