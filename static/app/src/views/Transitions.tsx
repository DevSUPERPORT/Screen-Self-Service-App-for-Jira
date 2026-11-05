/**
 * Transition screens page and drawer: lists the screens used on the project's workflow transitions, creates
 * new transition screens, and switches a screen on or off for individual transitions.
 *
 * @file        static/app/src/views/Transitions.tsx
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import { AnimatePresence, motion } from 'framer-motion';
import { useShallow } from 'zustand/react/shallow';
import { useMemo, useState } from 'react';
import { Info, Lock } from 'lucide-react';
import clsx from 'clsx';
import { onlyProject, otherProjects, planFor } from '@shared/domain';
import { useModel, useStore } from '../store';
import { useT } from '../i18n';
import { Btn, DrawerHead, Morph, Switch, easeOut, spring } from '../ui';

export function Transitions() {
  const t = useT();
  const m = useModel();
  const { run, open, pulse } = useStore(useShallow((s) => ({ run: s.run, open: s.open, pulse: s.pulse })));
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const key = m.project.key;

  // Every screen that is used on a transition of one of the project's workflows, plus own unused transition screens
  const rows = useMemo(() => {
    const ids = new Set<string>();
    for (const w of m.workflows) for (const tr of w.transitions) if (tr.screenId) ids.add(tr.screenId);
    for (const s of Object.values(m.screens)) if (!s.foreign && s.name.startsWith(`${key} Transition - `) && s.screenSchemeIds.length === 0) ids.add(s.id);
    return [...ids].map((id) => m.screens[id]).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  }, [m, key]);

  const create = async () => {
    setBusy(true);
    const res = await run({ type: 'newTransitionScreen', text }, undefined, { label: t('lbNewTransition') });
    setBusy(false);
    if (res) {
      const id = Object.values(res.idMap)[0];
      useStore.getState().toast('ok', t('trCreated', { name: res.model.screens[id]?.name ?? '' }));
      setText('');
      open({ type: 'transitionAssign', screenId: id });
    }
  };

  return (
    <>
      <motion.section className="card card-pad col" style={{ gap: 16 }} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
        <div className="col" style={{ gap: 4 }}>
          <h2 className="card-title">{t('trNewTitle')}</h2>
          <p className="small muted">{t('trNewBody', { key })}</p>
        </div>
        <form className="row wrap" style={{ alignItems: 'flex-end', gap: 12 }} onSubmit={(e) => { e.preventDefault(); if (text.trim()) void create(); }}>
          <div style={{ flex: '1 1 420px', minWidth: 0 }}>
            <label className="label" htmlFor="tr-name">{t('trName')}</label>
            <div className="affix">
              <span>{key} Transition -</span>
              <input id="tr-name" value={text} maxLength={120} onChange={(e) => setText(e.target.value)} placeholder={t('trNamePlaceholder')} autoComplete="off" />
              <span>- Screen</span>
            </div>
          </div>
          <Btn type="submit" variant="primary" loading={busy} disabled={!text.trim()} style={{ height: 48 }}>{t('trCreate')}</Btn>
        </form>
      </motion.section>

      <motion.div className="card" style={{ overflow: 'hidden' }} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.06 }}>
        {rows.length === 0 ? <div className="empty muted">{t('trEmpty')}</div> : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th scope="col">{t('trScreen')}</th>
                  <th scope="col">{t('trUsedIn')}</th>
                  <th scope="col" className="num-cell">{t('trFields')}</th>
                  <th scope="col">{t('trStatus')}</th>
                  <th scope="col"><span className="sr-only">{t('unActions')}</span></th>
                </tr>
              </thead>
              <tbody>
                <AnimatePresence initial={false}>
                  {rows.map((s, i) => {
                    const uses = m.workflows.flatMap((w) => w.transitions.filter((x) => x.screenId === s.id).map((x) => ({ w, x })));
                    const byWf = [...new Set(uses.map((u) => u.w))];
                    const editable = !s.foreign && onlyProject(s, key) && byWf.every((w) => onlyProject(w, key));
                    return (
                      <motion.tr key={s.id} className={clsx(pulse.includes(s.id) && 'pulse')} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.35, ease: easeOut, delay: i * 0.04 }}>
                        <td style={{ fontWeight: 600 }}><Morph text={s.name} /></td>
                        <td>
                          {byWf.length === 0 ? <span className="muted">{t('trNotUsed')}</span> : byWf.map((w) => (
                            <div key={w.id}>
                              <div>{w.name}{!w.active && <span className="muted"> · {t('trInactive')}</span>}</div>
                              <div className="small muted">{uses.filter((u) => u.w === w).map((u) => `${u.x.from.join(', ') || t('trAnyStatus')} → ${u.x.to}`).join(', ')}{!onlyProject(w, key) && ` · +${otherProjects(w, key)}`}</div>
                            </div>
                          ))}
                        </td>
                        <td className="num-cell">{s.fieldCount}</td>
                        <td>
                          {editable
                            ? <span className="pill pill-accent"><span className="dot" />{t('onlyProject', { key })}</span>
                            : <span className="pill"><Lock size={12} />{t('sharedProjects', { n: otherProjects(s, key) + 1 })}</span>}
                        </td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          {editable ? (
                            <span className="row" style={{ justifyContent: 'flex-end' }}>
                              <Btn size="sm" onClick={() => open({ type: 'transitionAssign', screenId: s.id })}>{t('trAssign')}</Btn>
                              <Btn variant="dark" size="sm" onClick={() => open({ type: 'editor', screenId: s.id })}>{t('edit')}</Btn>
                            </span>
                          ) : (
                            <button type="button" className="linkish" style={{ color: 'var(--ink-2)', fontWeight: 400 }} onClick={() => open({ type: 'locked', screenId: s.id })}><Lock size={13} /> {t('readOnly')}</button>
                          )}
                        </td>
                      </motion.tr>
                    );
                  })}
                </AnimatePresence>
              </tbody>
            </table>
          </div>
        )}
      </motion.div>
      <div className="hint"><Info size={18} /><span>{t('trHint', { key })}</span></div>
    </>
  );
}

export function TransitionAssignDrawer({ screenId, onClose }: { screenId: string; onClose: () => void }) {
  const t = useT();
  const m = useModel();
  const run = useStore((s) => s.run);
  const [pending, setPending] = useState<string | null>(null);
  const s = m.screens[screenId];
  const key = m.project.key;
  const toggle = async (workflowId: string, transitionId: string, on: boolean) => {
    setPending(`${workflowId}/${transitionId}`);
    try { planFor(m, { type: 'transition', screenId, workflowId, transitionId, on }); } catch (e) { useStore.getState().toast('error', (e as Error).message); setPending(null); return; }
    await run({ type: 'transition', screenId, workflowId, transitionId, on }, undefined, { label: t('lbTransition') });
    setPending(null);
  };
  return (
    <>
      <DrawerHead eyebrow={t('navTransitions')} title={t('trAssignTitle', { name: s?.name ?? '' })} onClose={onClose} />
      <div className="drawer-body">
        <p className="small muted">{t('trAssignBody')}</p>
        {m.workflows.map((w, wi) => {
          const editable = onlyProject(w, key);
          return (
            <motion.section key={w.id} className="panel" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay: wi * 0.06 }}>
              <div className="row wrap" style={{ justifyContent: 'space-between' }}>
                <h3 className="step-title" style={{ fontSize: 16 }}>{w.name}{!w.active && <span className="muted" style={{ fontWeight: 400 }}> · {t('trInactive')}</span>}</h3>
                {editable ? <span className="pill pill-accent"><span className="dot" />{t('onlyProject', { key })}</span> : <span className="pill"><Lock size={12} />{t('trWorkflowShared')}</span>}
              </div>
              <div className="col" style={{ gap: 8 }}>
                {w.transitions.map((x) => {
                  const on = x.screenId === screenId;
                  const other = x.screenId && !on ? m.screens[x.screenId]?.name : null;
                  const busy = pending === `${w.id}/${x.id}`;
                  return (
                    <motion.div key={x.id} layout className={clsx('trans', on && 'on')} transition={spring}>
                      <div className="col" style={{ gap: 6, minWidth: 0 }}>
                        <span style={{ fontWeight: 600 }}>{x.name}</span>
                        <div className="flow">
                          {(x.from.length ? x.from : [t('trAnyStatus')]).map((f) => <span key={f} className="status">{f}</span>)}
                          <svg className="flow-line" viewBox="0 0 36 10" aria-hidden="true">
                            <motion.path d="M0 5 H30 M26 1 L31 5 L26 9" fill="none" stroke={on ? 'var(--accent-bright)' : 'var(--line-strong)'} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
                              initial={false} animate={{ pathLength: on ? [0, 1] : 1 }} transition={{ duration: 0.5, ease: easeOut }} />
                          </svg>
                          <span className="status">{x.to}</span>
                          {other && <span className="xs muted">· {t('trOtherScreen', { name: other })}</span>}
                        </div>
                      </div>
                      <span className="row">
                        {busy && <span className="xs muted">{t('saving')}</span>}
                        <Switch on={on} label={`${x.name}: ${s?.name}`} onChange={(v) => editable && !busy && toggle(w.id, x.id, v)} />
                      </span>
                    </motion.div>
                  );
                })}
              </div>
            </motion.section>
          );
        })}
      </div>
    </>
  );
}
