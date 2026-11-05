/**
 * Issue types overview page: one card per screen scheme group with its Default, Create, Edit and View
 * slots, lock markers for shared screens, and entry points to the editor, assignment changes, split, merge
 * and bulk edits.
 *
 * @file        static/app/src/views/Overview.tsx
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import { AnimatePresence, motion } from 'framer-motion';
import { ArrowRight, GitMerge, Info, ListChecks, Lock, Split } from 'lucide-react';
import clsx from 'clsx';
import { forwardRef } from 'react';
import type { Op, ProjectModel } from '@shared/types';
import { OPS } from '@shared/types';
import { effective, groupsOf, itssExclusive, otherProjects, schemeExclusive, screenExclusive, type Group } from '@shared/domain';
import { useModel, useStore } from '../store';
import { HealthBanner } from './Health';
import { useT } from '../i18n';
import { Btn, ItIcon, Morph, easeOut, spring, useGlow } from '../ui';

export function Overview() {
  const t = useT();
  const m = useModel();
  const groups = groupsOf(m);
  const usedScreens = new Set(groups.flatMap((g) => Object.values(m.screenSchemes[g.schemeId].screens)));
  return (
    <>
      <HealthBanner />
      <div className="page-meta">
        <p className="small muted">{t('summary', { schemes: groups.length, types: m.issueTypes.length, screens: usedScreens.size })}</p>
        <Btn size="sm" variant="ghost" icon={<ListChecks size={15} />} onClick={() => useStore.getState().open({ type: 'bulk' })}>{t('bulkOpen')}</Btn>
        <div className="legend">
          <span><span className="dot dot-lg" />{t('legendEditable')}</span>
          <span><Lock size={14} />{t('legendShared')}</span>
          <span><span className="legend-dash" />{t('legendInherits')}</span>
        </div>
      </div>
      <AnimatePresence mode="popLayout" initial={false}>
        {groups.map((g, i) => <GroupCard key={g.schemeId} g={g} i={i} m={m} canMerge={groups.filter((x) => schemeExclusive(m, x.schemeId)).length > 1} />)}
      </AnimatePresence>
      <motion.div layout className="hint">
        <Info size={18} />
        <span>{t('overviewHint', { key: m.project.key })}</span>
      </motion.div>
    </>
  );
}

const GroupCard = forwardRef<HTMLElement, { g: Group; i: number; m: ProjectModel; canMerge: boolean }>(function GroupCard({ g, i, m, canMerge }, ref) {
  const t = useT();
  const open = useStore((s) => s.open);
  const pulse = useStore((s) => s.pulse);
  const sc = m.screenSchemes[g.schemeId];
  const exclusive = schemeExclusive(m, sc.id);
  const structural = exclusive && itssExclusive(m);
  const others = otherProjects(sc, m.project.key);
  return (
    <motion.section
      ref={ref}
      layout
      layoutId={`group-${g.schemeId}`}
      className={clsx('card', pulse.includes(sc.id) && 'pulse')}
      aria-label={g.title}
      initial={{ opacity: 0, y: 24, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96, filter: 'blur(4px)', transition: { duration: 0.3 } }}
      transition={{ ...spring, opacity: { duration: 0.4, delay: Math.min(i * 0.06, 0.3) }, y: { ...spring, delay: Math.min(i * 0.06, 0.3) } }}
    >
      <div className="card-head">
        <div className="col" style={{ gap: 8, minWidth: 0 }}>
          <div className="row wrap" style={{ gap: 8 }}>
            {g.issueTypes.map((it) => (
              <motion.span key={it.id} layoutId={`it-${it.id}`} className="issue-chip" transition={spring}>
                <ItIcon name={it.name} url={it.iconUrl} />{it.name}
              </motion.span>
            ))}
            <motion.span layout="position">
              {exclusive
                ? <span className="pill pill-accent"><span className="dot" />{t('onlyProject', { key: m.project.key })}</span>
                : <span className="pill"><Lock size={12} />{t('sharedProjects', { n: others + 1 })}</span>}
            </motion.span>
          </div>
          <div className="small muted"><Morph text={t('schemeLabel', { name: sc.name })} /></div>
        </div>
        <div className="row wrap">
          {structural && g.issueTypes.length > 1 && (
            <Btn size="sm" icon={<Split size={16} />} onClick={() => open({ type: 'split', schemeId: sc.id })}>{t('splitOff')}</Btn>
          )}
          {structural && canMerge && (
            <Btn size="sm" icon={<GitMerge size={16} />} onClick={() => open({ type: 'merge', schemeId: sc.id })}>{t('merge')}</Btn>
          )}
          {exclusive
            ? <Btn variant="dark" size="sm" onClick={() => open({ type: 'assign', schemeId: sc.id })}>{t('changeAssignment')}</Btn>
            : <Btn size="sm" icon={<Lock size={15} />} onClick={() => open({ type: 'locked', screenId: sc.screens.default })}>{t('whyLocked')}</Btn>}
        </div>
      </div>
      <div className="slots">
        {OPS.map((op) => <Slot key={op} m={m} schemeId={sc.id} op={op} />)}
      </div>
    </motion.section>
  );
});

function Slot({ m, schemeId, op }: { m: ProjectModel; schemeId: string; op: Op }) {
  const t = useT();
  const glow = useGlow();
  const open = useStore((s) => s.open);
  const setHover = useStore((s) => s.setHover);
  const sc = m.screenSchemes[schemeId];
  const { screenId, inherited } = effective(sc, op);
  const pulsing = useStore((s) => s.pulse.includes(screenId));
  const linked = useStore((s) => s.hoverScreen === screenId);
  const dimmed = useStore((s) => s.hoverScreen !== null && s.hoverScreen !== screenId && Object.values(sc.screens).includes(s.hoverScreen));
  const s = m.screens[screenId];
  const editable = screenExclusive(m, screenId);
  const schemeEditable = schemeExclusive(m, schemeId);
  const sameAs = !inherited ? OPS.find((o) => o !== op && OPS.indexOf(o) < OPS.indexOf(op) && sc.screens[o] === screenId && o !== 'default') : undefined;
  if (!s) return null;
  return (
    <motion.div
      className={clsx('slot', op === 'default' && 'slot-default', inherited && 'inherit', !editable && !inherited && 'locked', linked && 'linked', dimmed && 'dimmed', pulsing && 'pulse')}
      onPointerEnter={() => setHover(screenId)}
      onPointerLeave={() => setHover(null)}
      {...glow}
    >
      <span className="slot-glow" aria-hidden="true" />
      <div className={op === 'default' ? 'slot-main' : 'col'} style={op === 'default' ? undefined : { gap: 6 }}>
        <div className="slot-label">
          {t(`op_${op}`)}
          {!editable && !inherited && <Lock size={12} />}
        </div>
        {inherited ? (
          <>
            <div className="slot-name">{t('inheritsDefault')}</div>
            <div className="slot-meta"><Morph text={s.name} /></div>
          </>
        ) : (
          <>
            <div className="slot-name"><Morph text={s.name} /></div>
            <div className="slot-meta">{sameAs ? t('sameAsCreate', { op: t(`op_${sameAs}`) }) : t('fieldsTabs', { f: s.fieldCount, t: s.tabCount })}</div>
          </>
        )}
        <div className="slot-actions">
          {inherited ? (
            schemeEditable && <button type="button" className="linkish" onClick={() => open({ type: 'assign', schemeId, prefill: { op, screenId: '' } })}>{t('assignOwn')} <ArrowRight size={14} className="arrow" /></button>
          ) : editable ? (
            <button type="button" className="linkish" onClick={(e) => open({ type: 'editor', screenId, origin: rectOf(e) })}>{t('edit')} <ArrowRight size={14} className="arrow" /></button>
          ) : (
            <>
              <button type="button" className="linkish" onClick={() => open({ type: 'locked', screenId })}><Lock size={13} /> {t('readOnly')}</button>
              <button type="button" className="linkish" style={{ color: 'var(--ink-2)', fontWeight: 400 }} onClick={(e) => open({ type: 'editor', screenId, origin: rectOf(e) })}>{t('view')}</button>
            </>
          )}
        </div>
      </div>
      {op === 'default' && <ScreenShape tabs={s.tabCount} fields={s.fieldCount} />}
    </motion.div>
  );
}

/** The slot card the user clicked — the editor grows out of it. */
function rectOf(e: React.MouseEvent) {
  const r = (e.currentTarget as HTMLElement).closest('.slot')!.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/** Tiny abstract drawing of a screen: one bar per tab, height ~ fields. */
function ScreenShape({ tabs, fields }: { tabs: number; fields: number }) {
  const n = Math.max(1, Math.min(tabs, 6));
  const per = fields / n;
  return (
    <svg className="slot-shape" viewBox="0 0 72 54" aria-hidden="true">
      <rect x="0.5" y="0.5" width="71" height="53" rx="7" fill="var(--surface-sunk)" stroke="var(--line)" />
      {Array.from({ length: n }).map((_, i) => {
        const w = (60 - (n - 1) * 3) / n;
        const h = Math.max(6, Math.min(36, per * 4 + ((i * 7) % 5)));
        return (
          <motion.rect key={i} x={6 + i * (w + 3)} width={w} rx="2" fill={i === 0 ? 'var(--accent-bright)' : 'var(--line-strong)'}
            initial={{ y: 48, height: 0 }} animate={{ y: 48 - h, height: h }} transition={{ duration: 0.7, ease: easeOut, delay: 0.2 + i * 0.06 }} />
        );
      })}
    </svg>
  );
}
