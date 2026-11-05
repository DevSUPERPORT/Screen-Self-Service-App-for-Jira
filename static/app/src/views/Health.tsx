/**
 * Configuration health page: runs the shared health checks (missing summary, empty transition screens, hidden
 * fields, names, empty tabs, unused objects), shows a score ring and one-click fixes, and exports the overview banner and
 * fixCheck used elsewhere in the UI.
 *
 * @file        static/app/src/views/Health.tsx
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import { AnimatePresence, motion } from 'framer-motion';
import { useMemo, useState } from 'react';
import { AlertOctagon, AlertTriangle, ArrowRight, Check, EyeOff, GitBranch, Info, Lock, PanelTop, Sparkles, Tag, Trash2, Wand2 } from 'lucide-react';
import { healthChecks, type Check as HealthCheck, type CheckId } from '@shared/bulk';
import { planFor } from '@shared/domain';
import { useModel, useStore } from '../store';
import { useT, type Key } from '../i18n';
import { Btn, easeOut, spring, stagger } from '../ui';

const ICON: Record<CheckId, typeof Info> = { 'missing-summary': AlertOctagon, 'empty-transition': GitBranch, 'hidden-fields': EyeOff, names: Tag, 'empty-tabs': PanelTop, unused: Trash2 };
const SHOWN = 6;

/** Runs one check's fix; resolves true when it went through. Shared by the Health page and the overview banner. */
export async function fixCheck(c: HealthCheck, t: ReturnType<typeof useT>) {
  const st = useStore.getState();
  const title = t(`hl_${c.id}` as Key);
  if (!c.fix) return false;
  switch (c.fix.kind) {
    case 'layouts': return !!(await st.saveLayouts(c.fix.saves, `${t('lbHealth')}: ${title}`, `${t('hlFixed')}: ${title}`))?.some((r) => r.ok);
    case 'fieldScheme': return st.addToFieldScheme(c.fix.fieldIds, `${t('lbHealth')}: ${title}`, `${t('hlFixed')}: ${title}`);
    case 'intent': return !!(await st.run(c.fix.intent, `${t('hlFixed')}: ${title}`, { label: t('lbNames') }));
    case 'navigate': st.go(c.fix.page); return true;
  }
}

export function useHealth() {
  const m = useModel();
  return useMemo(() => healthChecks(m), [m]);
}

export function Health() {
  const t = useT();
  const m = useModel();
  const checks = useHealth();
  const [busy, setBusy] = useState<CheckId | 'all' | null>(null);
  const fixable = checks.filter((c) => c.fix && c.fix.kind !== 'navigate');
  const total = checks.reduce((n, c) => n + c.items.length, 0);

  const fix = async (c: HealthCheck) => { setBusy(c.id); await fixCheck(c, t); setBusy(null); };
  const fixAll = async () => {
    setBusy('all');
    // one at a time, re-reading the checks between fixes: each fix changes what the next one sees
    for (const id of fixable.map((c) => c.id)) {
      const cur = healthChecks(useStore.getState().model!).find((c) => c.id === id);
      if (cur?.fix && cur.fix.kind !== 'navigate') { const ok = await fixCheck(cur, t); if (!ok) break; }
    }
    setBusy(null);
  };

  return (
    <div className="col" style={{ gap: 18 }}>
      <motion.section className="health-hero card" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, ease: easeOut }}>
        <HealthRing checks={checks} />
        <div className="col grow" style={{ gap: 6, minWidth: 0 }}>
          <div className="eyebrow">{t('navHealth')} · {m.project.key}</div>
          <AnimatePresence mode="wait" initial={false}>
            <motion.h2 key={total ? 'n' : 'ok'} className="h2" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.25 }}>
              {total ? t(total === 1 ? 'hlIssues1' : 'hlIssues', { n: total }) : t('hlAllGood')}
            </motion.h2>
          </AnimatePresence>
          <p className="small muted" style={{ maxWidth: 560 }}>{total ? t('hlIntro') : t('hlAllGoodBody')}</p>
        </div>
        {fixable.length > 0 && (
          <Btn variant="primary" icon={<Wand2 size={17} />} loading={busy === 'all'} disabled={!!busy} onClick={fixAll}>{t('hlFixAll')}</Btn>
        )}
      </motion.section>

      <AnimatePresence initial={false} mode="popLayout">
        {checks.length === 0 && (
          <motion.div key="clean" className="empty card" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={spring}>
            <motion.span className="pill pill-ok" style={{ padding: 12 }} initial={{ rotate: -30, scale: 0 }} animate={{ rotate: 0, scale: 1 }} transition={{ ...spring, delay: 0.1 }}><Sparkles size={22} /></motion.span>
            <p className="small muted">{t('hlAllGoodBody')}</p>
          </motion.div>
        )}
        {checks.map((c, i) => <CheckCard key={c.id} c={c} i={i} busy={busy === c.id || busy === 'all'} disabled={!!busy} onFix={() => fix(c)} />)}
      </AnimatePresence>
    </div>
  );
}

function CheckCard({ c, i, busy, disabled, onFix }: { c: HealthCheck; i: number; busy: boolean; disabled: boolean; onFix: () => void }) {
  const t = useT();
  const m = useModel();
  const [all, setAll] = useState(false);
  const Ic = ICON[c.id];
  const items = all ? c.items : c.items.slice(0, SHOWN);
  // the rename fix is a regular plan — preview it so nobody renames blind
  const renamePreview = useMemo(() => (c.fix?.kind === 'intent' ? (() => { try { return planFor(m, c.fix.intent).preview.length; } catch { return 0; } })() : 0), [m, c.fix]);
  return (
    <motion.article layout className={`card health-card sev-${c.severity}`} initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97, filter: 'blur(4px)', transition: { duration: 0.3 } }} transition={{ duration: 0.45, ease: easeOut, ...stagger(i, 0.06) }}>
      <div className="health-head">
        <span className={`health-ic sev-${c.severity}`}><Ic size={18} /></span>
        <div className="col grow" style={{ gap: 4, minWidth: 0 }}>
          <div className="row wrap" style={{ gap: 8 }}>
            <h3 className="card-title">{t(`hl_${c.id}` as Key)}</h3>
            <span className={`pill ${c.severity === 'error' ? 'pill-danger' : c.severity === 'warning' ? 'pill-solid' : 'pill-line'}`}>{c.items.length}</span>
          </div>
          <p className="small muted">{t(`hl_${c.id}_body` as Key)}</p>
        </div>
        <div className="health-act">
          {c.fix ? (
            c.fix.kind === 'navigate'
              ? <Btn size="sm" variant="ghost" icon={<ArrowRight size={15} />} onClick={onFix}>{t('hlReview')}</Btn>
              : <Btn size="sm" variant={c.severity === 'error' ? 'primary' : 'dark'} loading={busy} disabled={disabled} icon={<Wand2 size={15} />} onClick={onFix}>{t('hlFix')}{renamePreview ? ` · ${renamePreview}` : ''}</Btn>
          ) : (
            <span className="pill pill-line" title={c.blocked === 'field-scheme-shared' ? t('hlBlockedShared') : t('hlBlockedScreen')}><Lock size={12} /> {t('hlCantFix')}</span>
          )}
        </div>
      </div>
      {!c.fix && c.blocked && <div className="hint" style={{ margin: '0 18px 4px' }}><Lock size={16} /><span>{c.blocked === 'field-scheme-shared' ? t('hlBlockedShared') : t('hlBlockedScreen')}</span></div>}
      <ul className="health-items">
        <AnimatePresence initial={false}>
          {items.map((it, k) => (
            <motion.li key={it.id} layout initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 24 }} transition={{ duration: 0.3, ease: easeOut, ...stagger(k, 0.03) }}>
              <span className="health-dot" />
              <span className="ellipsis" style={{ fontWeight: 600 }}>{it.name}</span>
              {it.detail && (c.id === 'names'
                ? <span className="row ellipsis xs" style={{ gap: 6 }}><ArrowRight size={12} className="muted" /><span className="mono">{it.detail}</span></span>
                : <span className="xs muted ellipsis">{c.id === 'unused' ? (it.detail === 'screen' ? t('kindScreen') : t('kindScheme')) : it.detail}</span>)}
              {c.id === 'missing-summary' && m.screens[it.id] && (
                <button type="button" className="linkish xs" onClick={() => useStore.getState().open({ type: 'editor', screenId: it.id })}>{t('hlOpen')}</button>
              )}
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
      {c.items.length > SHOWN && (
        <button type="button" className="linkish xs" style={{ margin: '0 18px 16px' }} onClick={() => setAll(!all)}>{all ? t('showLess') : t('hlMore', { n: c.items.length - SHOWN })}</button>
      )}
    </motion.article>
  );
}

/** A score ring: full and green when clean, eaten into by errors (heavy) and warnings. */
function HealthRing({ checks }: { checks: HealthCheck[] }) {
  const weight = checks.reduce((n, c) => n + (c.severity === 'error' ? 25 : c.severity === 'warning' ? 12 : 4) * Math.min(c.items.length, 3), 0);
  const score = Math.max(0, 100 - weight);
  const r = 30;
  const C = 2 * Math.PI * r;
  const tone = score >= 90 ? 'var(--ok)' : score >= 60 ? 'var(--accent-bright)' : 'var(--danger)';
  return (
    <div className="health-ring" role="img" aria-label={`${score} / 100`}>
      <svg width="76" height="76" viewBox="0 0 76 76">
        <circle cx="38" cy="38" r={r} fill="none" stroke="var(--surface-2)" strokeWidth="7" />
        <motion.circle cx="38" cy="38" r={r} fill="none" stroke={tone} strokeWidth="7" strokeLinecap="round" transform="rotate(-90 38 38)"
          strokeDasharray={C} initial={{ strokeDashoffset: C }} animate={{ strokeDashoffset: C * (1 - score / 100) }} transition={{ duration: 1.1, ease: easeOut }} />
      </svg>
      <span className="health-score">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span key={score} initial={{ y: 10, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -10, opacity: 0 }} transition={spring}>
            {score === 100 ? <Check size={22} strokeWidth={3} color="var(--ok)" /> : score}
          </motion.span>
        </AnimatePresence>
      </span>
    </div>
  );
}

/** Slim banner on the overview when something needs attention (errors/warnings only). */
export function HealthBanner() {
  const t = useT();
  const checks = useHealth().filter((c) => c.severity !== 'info');
  const n = checks.reduce((k, c) => k + c.items.length, 0);
  const error = checks.some((c) => c.severity === 'error');
  return (
    <AnimatePresence initial={false}>
      {n > 0 && (
        <motion.button type="button" key="hb" className={`health-banner ${error ? 'sev-error' : 'sev-warning'}`} onClick={() => useStore.getState().go('health')}
          initial={{ opacity: 0, height: 0, marginBottom: 0 }} animate={{ opacity: 1, height: 'auto', marginBottom: 16 }} exit={{ opacity: 0, height: 0, marginBottom: 0 }} transition={{ duration: 0.4, ease: easeOut }}>
          {error ? <AlertOctagon size={17} /> : <AlertTriangle size={17} />}
          <span className="grow">{t(n === 1 ? 'hlBanner1' : 'hlBanner', { n })}</span>
          <span className="row" style={{ gap: 6, fontWeight: 600 }}>{t('hlReview')} <ArrowRight size={15} /></span>
        </motion.button>
      )}
    </AnimatePresence>
  );
}
