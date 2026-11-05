/**
 * Copy-screen drawer (UC-04) and new-empty-screen drawer (UC-05): pick a template screen (from this project
 * or, when allowed, other projects), the target issue type and operation, and preview the plan before the
 * screen is created. Also exports useScreen, which loads a screen's tabs lazily.
 *
 * @file        static/app/src/views/Copy.tsx
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import { AnimatePresence, motion } from 'framer-motion';
import { useShallow } from 'zustand/react/shallow';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Search } from 'lucide-react';
import type { Op, Screen } from '@shared/types';
import { OPS } from '@shared/types';
import { groupsOf, newRef, onlyProject, planFor, schemeExclusive, schemeIdFor } from '@shared/domain';
import { gateway, type SearchResult } from '../api/gateway';
import { useModel, useStore } from '../store';
import { useT } from '../i18n';
import { Btn, DrawerHead, Highlight, Segmented, easeOut, spring } from '../ui';
import { PreviewList } from './Preview';

/** Loads a screen with its tabs (lazy in Jira). */
export function useScreen(id: string | undefined) {
  const m = useModel();
  const cached = id ? m.screens[id] : undefined;
  const [s, setS] = useState<Screen | undefined>(cached?.tabs ? cached : undefined);
  useEffect(() => {
    if (!id) { setS(undefined); return; }
    if (cached?.tabs) { setS(cached); return; }
    let live = true;
    setS(undefined);
    gateway.loadScreen(id).then((x) => { if (live) setS(x); }).catch(() => {});
    return () => { live = false; };
  }, [id, cached]);
  return s;
}

function useTargets(issueTypeId?: string) {
  const m = useModel();
  // Issue types whose screen scheme the project admin may change
  const types = m.issueTypes.filter((it) => schemeExclusive(m, schemeIdFor(m, it.id)));
  const [typeId, setTypeId] = useState(issueTypeId && types.some((x) => x.id === issueTypeId) ? issueTypeId : types[0]?.id);
  // The segmented control shows one option per group — its first selectable issue type stands for the group
  const groupValue = (id?: string) => groupsOf(m).find((g) => g.issueTypes.some((i) => i.id === id))?.issueTypes.find((x) => types.includes(x))?.id ?? '';
  return { types, typeId, setTypeId, groupValue };
}

export function CopyDrawer({ issueTypeId, op: initialOp, templateId, onClose }: { issueTypeId?: string; op?: Op; templateId?: string; onClose: () => void }) {
  const t = useT();
  const m = useModel();
  const { run, open } = useStore(useShallow((s) => ({ run: s.run, open: s.open })));
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(4);
  const [raw, setRaw] = useState<SearchResult | null>(null);
  const [sel, setSel] = useState<string | undefined>(templateId);
  const [op, setOp] = useState<Op>(initialOp ?? 'create');
  const { types, typeId, setTypeId, groupValue } = useTargets(issueTypeId);
  const [busy, setBusy] = useState(false);
  const preview = useScreen(sel);
  const seq = useRef(0);

  useEffect(() => {
    const my = ++seq.current;
    const id = setTimeout(() => {
      gateway.searchScreens(q, limit).then((r) => { if (my === seq.current) setRaw(r); }).catch(() => setRaw({ items: [], total: 0 }));
    }, q ? 160 : 0);
    return () => clearTimeout(id);
  }, [q, limit]);

  // Own screens come from the project model (listed first); the instance search provides the rest
  const res = useMemo(() => {
    if (!raw) return null;
    const ql = q.trim().toLowerCase();
    const isOwn = (s: Screen) => !s.foreign && s.projects.length > 0 && onlyProject(s, m.project.key);
    const own = Object.values(m.screens).filter((s) => isOwn(s) && (s.screenSchemeIds.length || s.workflowIds.length) && s.name.toLowerCase().includes(ql)).sort((a, b) => a.name.localeCompare(b.name));
    const ownIds = new Set(Object.values(m.screens).filter(isOwn).map((s) => s.id));
    const rest = raw.items.filter((s) => !ownIds.has(s.id)).map((s) => (m.screens[s.id] ? { ...s, ...m.screens[s.id], tabs: undefined } : s));
    return { own, all: rest.slice(0, limit), total: Math.max(rest.length, raw.total - own.length) };
  }, [raw, q, m, limit]);
  const it = types.find((x) => x.id === typeId);
  const schemeId = typeId ? schemeIdFor(m, typeId) : undefined;
  const ref = useMemo(() => newRef(), []);
  const intent = useMemo(() => {
    if (!schemeId || !sel || !it) return null;
    const sc = m.screenSchemes[schemeId];
    const next = { ...sc.screens, [op]: ref } as Record<Op, string | undefined>;
    return { type: 'assign' as const, schemeId, next, newScreens: [{ ref, copyFrom: sel, op, issueType: groupsOf(m).find((g) => g.schemeId === schemeId)!.issueTypes[0].name }] };
  }, [m, schemeId, sel, op, ref, it]);
  // Templates from other projects aren't part of the project model — add the previewed one for planning
  const mm = useMemo(() => (preview && !m.screens[preview.id] ? { ...m, screens: { ...m.screens, [preview.id]: { ...preview, foreign: true } } } : m), [m, preview]);
  const plan = useMemo(() => { try { return intent ? planFor(mm, intent) : null; } catch { return null; } }, [mm, intent]);
  const finalName = plan?.preview.find((p) => p.kind === 'new')?.title;

  const go = async () => {
    if (!intent) return;
    setBusy(true);
    const r = await run(intent, plan?.preview.some((p) => p.kind === 'renamed') ? t('savedOk') : t('saved'), { model: mm, label: t('lbCopy', { name: finalName ?? '' }) });
    setBusy(false);
    if (r) open({ type: 'editor', screenId: r.idMap[ref] ?? ref });
  };

  // Project of a foreign screen: known usage, else the key prefix in its name ("BIL: Scrum Bug Screen")
  const originOf = (s: Screen) => {
    if (s.projects.length === 1) return t('projectN', { key: s.projects[0] });
    if (s.projectCount > 1) return t('nProjects', { n: s.projectCount });
    const k = /^([A-Z][A-Z0-9_]{1,9})[: ]/.exec(s.name)?.[1];
    return k ? t('projectN', { key: k }) : t('otherProject');
  };
  const list = (items: Screen[], offset: number) => items.map((s, i) => (
    <motion.button key={s.id} layout="position" type="button" role="option" aria-selected={sel === s.id} className="result" onClick={() => setSel(s.id)}
      initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: easeOut, delay: (offset + i) * 0.02 }}>
      <span style={{ fontWeight: 600 }}><Highlight text={s.name} q={q} /></span>
      <span className="xs muted">
        {[s.foreign ? originOf(s) : null, s.tabCount ? t('fieldsTabs', { f: s.fieldCount, t: s.tabCount }) : null].filter(Boolean).join(' · ')}
      </span>
    </motion.button>
  ));

  return (
    <>
      <DrawerHead title={t('copyTitle')} onClose={onClose} />
      <div className="drawer-body">
        <div className="copy-grid">
          <section className="col" style={{ gap: 12 }}>
            <h3 className="step-title">{t('copyPick')}</h3>
            <div>
              <label className="sr-only" htmlFor="copy-q">{t('copySearch')}</label>
              <div className="input-wrap">
                <Search size={18} />
                <input id="copy-q" data-autofocus className="input" placeholder={t('copySearch')} value={q} onChange={(e) => { setQ(e.target.value); setLimit(4); }} autoComplete="off" />
              </div>
              <p className="xs muted" style={{ marginTop: 6 }}>{t('copySearchHint')}</p>
            </div>
            <div role="listbox" aria-label={t('copyPick')} className="col" style={{ gap: 6 }}>
              {!res && [0, 1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 58 }} />)}
              {res && (
                <>
                  {res.own.length > 0 && <div className="eyebrow" style={{ marginTop: 4 }}>{t('copyOwn', { key: m.project.key })} · {res.own.length}</div>}
                  {list(res.own, 0)}
                  {res.total > 0 && <div className="eyebrow" style={{ marginTop: 10 }}>{t('copyAll')} · {res.total}</div>}
                  {list(res.all, res.own.length)}
                  {res.total > res.all.length && (
                    <Btn size="sm" variant="ghost" onClick={() => setLimit((l) => l + 10)}>{t('copyLoadMore', { n: Math.min(10, res.total - res.all.length) })}</Btn>
                  )}
                  {raw?.disabled && (
                    <div className="pv-empty col" style={{ gap: 4, alignItems: 'flex-start' }}>
                      <strong>{t('copyOffTitle')}</strong>
                      <span>{t('copyOffBody')}</span>
                    </div>
                  )}
                  {!raw?.disabled && res.own.length + res.all.length === 0 && <div className="pv-empty">{t('copyNone', { q })}</div>}
                </>
              )}
            </div>
          </section>
          <section className="panel">
            <AnimatePresence mode="wait">
              {!sel ? (
                <motion.div key="none" className="empty" style={{ padding: '40px 12px' }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                  <p className="muted small">{t('copyPickHint')}</p>
                </motion.div>
              ) : (
                <motion.div key={sel} className="col" style={{ gap: 14 }} initial={{ opacity: 0, y: 10, filter: 'blur(4px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.3, ease: easeOut }}>
                  <div className="col" style={{ gap: 2 }}>
                    <span className="eyebrow">{t('copyPreview')}</span>
                    <span style={{ fontWeight: 600 }}>{preview?.name ?? m.screens[sel]?.name ?? res?.all.find((x) => x.id === sel)?.name}</span>
                    <span className="xs muted">{t('copyPreviewNote')}</span>
                  </div>
                  {!preview ? <div className="skeleton" style={{ height: 120 }} /> : (
                    <div className="col" style={{ gap: 12 }}>
                      {preview.tabs!.map((tab, ti) => (
                        <div key={tab.id} className="col" style={{ gap: 6 }}>
                          <span className="pill" style={{ alignSelf: 'flex-start' }}>{tab.name} · {tab.fieldIds.length}</span>
                          <div className="preview-fields">
                            {tab.fieldIds.map((f, i) => (
                              <motion.div key={f} initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: ti * 0.05 + i * 0.015 }}>{m.fields[f]?.name ?? f}</motion.div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="col" style={{ gap: 8 }}>
                    <span className="label" style={{ margin: 0 }}>{t('copyIssueType')}</span>
                    <Segmented value={groupValue(typeId)} onChange={setTypeId} label={t('copyIssueType')}
                      options={groupsOf(m).filter((g) => schemeExclusive(m, g.schemeId)).map((g) => ({ value: g.issueTypes.find((x) => types.includes(x))!.id, label: g.title }))} />
                  </div>
                  <div className="col" style={{ gap: 8 }}>
                    <span className="label" style={{ margin: 0 }}>{t('copyAssignAs')}</span>
                    <Segmented value={op} onChange={setOp} label={t('copyAssignAs')} options={OPS.map((o) => ({ value: o, label: t(`op_${o}`) }))} />
                  </div>
                  <div className="col" style={{ gap: 6 }}>
                    <span className="label" style={{ margin: 0 }}>{t('copyNameLabel')}</span>
                    <div className="pv" style={{ background: 'var(--surface-2)' }}><motion.span key={finalName} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} style={{ fontWeight: 600 }}>{finalName ?? '—'}</motion.span></div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </section>
        </div>
      </div>
      <div className="drawer-foot">
        <Btn variant="quiet" onClick={onClose}>{t('cancel')}</Btn>
        <Btn variant="primary" loading={busy} disabled={!plan} onClick={go}>{t('copyGo')} <ArrowRight size={16} /></Btn>
      </div>
    </>
  );
}

// ---------------- UC-05 new empty screen ----------------
export function NewDrawer({ issueTypeId, op: initialOp, onClose }: { issueTypeId?: string; op?: Op; onClose: () => void }) {
  const t = useT();
  const m = useModel();
  const { run, open } = useStore(useShallow((s) => ({ run: s.run, open: s.open })));
  const [op, setOp] = useState<Op>(initialOp ?? 'create');
  const { types, typeId, setTypeId, groupValue } = useTargets(issueTypeId);
  const [busy, setBusy] = useState(false);
  const ref = useMemo(() => newRef(), []);
  const schemeId = typeId ? schemeIdFor(m, typeId) : undefined;
  const intent = useMemo(() => {
    if (!schemeId) return null;
    const sc = m.screenSchemes[schemeId];
    return { type: 'assign' as const, schemeId, next: { ...sc.screens, [op]: ref } as Record<Op, string | undefined>, newScreens: [{ ref, op, issueType: groupsOf(m).find((g) => g.schemeId === schemeId)!.issueTypes[0].name }] };
  }, [m, schemeId, op, ref]);
  const plan = useMemo(() => { try { return intent ? planFor(m, intent) : null; } catch { return null; } }, [m, intent]);
  const go = async () => {
    if (!intent) return;
    setBusy(true);
    const r = await run(intent, plan?.preview.some((p) => p.kind === 'renamed') ? t('savedOk') : t('saved'), { label: t('lbCopy', { name: plan?.preview.find((p) => p.kind === 'new')?.title ?? '' }) });
    setBusy(false);
    if (r) open({ type: 'editor', screenId: r.idMap[ref] ?? ref });
  };
  const groups = groupsOf(m).filter((g) => schemeExclusive(m, g.schemeId));
  return (
    <>
      <DrawerHead title={t('newTitle')} onClose={onClose} />
      <div className="drawer-body">
        <section className="panel">
          <h3 className="step-title">{t('newFor')}</h3>
          <div className="col" style={{ gap: 8 }}>
            <span className="label" style={{ margin: 0 }}>{t('copyIssueType')}</span>
            <Segmented value={groupValue(typeId)} onChange={setTypeId} label={t('copyIssueType')}
              options={groups.map((g) => ({ value: g.issueTypes.find((x) => types.includes(x))!.id, label: g.title }))} />
          </div>
          <div className="col" style={{ gap: 8 }}>
            <span className="label" style={{ margin: 0 }}>{t('copyAssignAs')}</span>
            <Segmented value={op} onChange={setOp} label={t('copyAssignAs')} options={OPS.map((o) => ({ value: o, label: t(`op_${o}`) }))} />
          </div>
        </section>
        <section className="col" style={{ gap: 10 }}>
          <h3 className="eyebrow">{t('whatHappens')}</h3>
          {plan && (
            <motion.div layout transition={spring}>
              {/* reuse the same preview list as every other flow */}
              <PreviewLazy plan={plan} />
            </motion.div>
          )}
        </section>
      </div>
      <div className="drawer-foot">
        <Btn variant="quiet" onClick={onClose}>{t('cancel')}</Btn>
        <Btn variant="primary" loading={busy} disabled={!plan} onClick={go}>{t('createGo')} <ArrowRight size={16} /></Btn>
      </div>
    </>
  );
}

function PreviewLazy({ plan }: { plan: NonNullable<ReturnType<typeof planFor>> }) {
  const m = useModel();
  return <PreviewList plan={plan} m={m} />;
}
