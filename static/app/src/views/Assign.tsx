/**
 * Change-assignment drawer: lets a project admin choose which screen a screen scheme uses for Default,
 * Create, Edit and View, including copies of existing screens or new ones, and previews the resulting plan
 * before running it. Operations the user did not touch follow Jira when it changes underneath, so a retry
 * never reverts someone else's change.
 *
 * @file        static/app/src/views/Assign.tsx
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import { AnimatePresence, motion } from 'framer-motion';
import { useShallow } from 'zustand/react/shallow';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Copy, CornerDownRight, FilePlus2, RotateCcw } from 'lucide-react';
import type { Op } from '@shared/types';
import { OPS } from '@shared/types';
import { byName, groupsOf, newRef, onlyProject, planFor, RuleError } from '@shared/domain';
import { useDrawerModel as useModel, useStore } from '../store';
import { useT } from '../i18n';
import { Btn, DrawerHead, spring } from '../ui';
import { PreviewList } from './Preview';

type NewSpec = { ref: string; copyFrom?: string; op: Op; issueType: string };

export function AssignDrawer({ schemeId, prefillOp, onClose }: { schemeId: string; prefillOp?: Op; onClose: () => void }) {
  const t = useT();
  const m = useModel();
  const { run, open } = useStore(useShallow((s) => ({ run: s.run, open: s.open })));
  const sc = m.screenSchemes[schemeId];
  const group = groupsOf(m).find((g) => g.schemeId === schemeId);
  const firstType = group?.issueTypes[0]?.name ?? '';
  const [next, setNext] = useState<Record<Op, string | undefined>>({ default: sc.screens.default, create: sc.screens.create, edit: sc.screens.edit, view: sc.screens.view });
  // Operations the user changed. When Jira changes underneath (conflict → reload), untouched operations follow
  // the new state, so re-confirming never silently reverts someone else's change.
  const [touched, setTouched] = useState<Set<Op>>(new Set());
  useEffect(() => {
    setNext((n) => {
      const x = { ...n };
      for (const o of OPS) if (!touched.has(o)) x[o] = sc.screens[o];
      return x;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sc.screens]);
  const [news, setNews] = useState<NewSpec[]>([]);
  const [openOp, setOpenOp] = useState<Op | null>(prefillOp ?? null);
  const [busy, setBusy] = useState(false);

  const plan = useMemo(() => {
    try { return planFor(m, { type: 'assign', schemeId, next, newScreens: news }); } catch (e) { return e instanceof RuleError ? null : null; }
  }, [m, schemeId, next, news]);

  const own = useMemo(() => Object.values(m.screens)
    .filter((s) => !s.foreign && s.projects.length > 0 && onlyProject(s, m.project.key) && s.workflowIds.length === 0)
    .sort(byName), [m]);

  const nameOf = (id?: string) => {
    if (!id) return '';
    const n = news.find((x) => x.ref === id);
    if (n) return n.copyFrom ? t('newCopyOf', { name: m.screens[n.copyFrom]?.name ?? '' }) : t('newEmptyLabel');
    return m.screens[id]?.name ?? id;
  };

  const pick = (op: Op, id: string | undefined) => {
    setTouched((t) => new Set(t).add(op));
    setNext((s) => ({ ...s, [op]: id }));
    setOpenOp(null);
  };
  const addNew = (op: Op, copyFrom?: string) => {
    const ref = newRef();
    setNews((n) => [...n.filter((x) => x.op !== op), { ref, copyFrom, op, issueType: firstType }]);
    pick(op, ref);
  };

  const save = async () => {
    setBusy(true);
    const res = await run({ type: 'assign', schemeId, next, newScreens: news }, plan?.preview.some((p) => p.kind === 'renamed') ? t('savedOk') : t('saved'), { close: true, label: t('lbAssign', { types: group?.issueTypes.map((i) => i.name).join(', ') || sc.name }) });
    if (!res) setBusy(false);
  };

  return (
    <>
      <DrawerHead eyebrow={t('assignEyebrow', { scheme: sc.name })} title={t('assignTitle', { types: group?.title ?? '' })} onClose={onClose} />
      <div className="drawer-body">
        <div className="panel" style={{ paddingTop: 8, paddingBottom: 8, gap: 0 }}>
          {OPS.map((op) => {
            const val = next[op];
            const inherits = op !== 'default' && (!val || val === next.default);
            const changed = (val ?? '') !== (sc.screens[op] ?? '');
            return (
              <div key={op} className="op-row">
                <div className="op-name">
                  <span style={{ fontWeight: 600 }}>{t(`op_${op}`)}</span>
                  <AnimatePresence mode="popLayout">
                    {op === 'default' && <span className="pill pill-accent" style={{ alignSelf: 'flex-start', fontSize: 11, padding: '2px 8px' }}>{t('required')}</span>}
                    {changed && op !== 'default' && <motion.span key="c" initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.6 }} className="pill pill-ink" style={{ alignSelf: 'flex-start' }}>{t('changed')}</motion.span>}
                  </AnimatePresence>
                </div>
                <div className="col" style={{ gap: 8 }}>
                  <ScreenPicker
                    open={openOp === op}
                    setOpen={(v) => setOpenOp(v ? op : null)}
                    label={inherits ? t('inheritsDefault') : nameOf(val)}
                    sub={inherits ? nameOf(next.default) : undefined}
                    dashed={inherits}
                    current={inherits ? undefined : val}
                    options={own.map((s) => ({ id: s.id, name: s.name }))}
                    canInherit={op !== 'default'}
                    onPick={(id) => pick(op, id)}
                    onNewEmpty={() => addNew(op)}
                    onCopy={() => { onClose(); open({ type: 'copy', issueTypeId: group?.issueTypes[0]?.id, op }); }}
                    ownLabel={t('ownScreens', { key: m.project.key })}
                  />
                  <AnimatePresence>
                    {op !== 'default' && val && val === next.default && (
                      <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="xs muted row" style={{ alignItems: 'flex-start' }}>
                        <CornerDownRight size={14} style={{ flexShrink: 0 }} />{t('identicalToDefault')}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            );
          })}
        </div>
        <div className="col" style={{ gap: 10 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h3 className="eyebrow">{t('whatHappens')}</h3>
            <span className="xs muted">{t('namesFollow')}</span>
          </div>
          {plan && <PreviewList plan={plan} m={m} />}
        </div>
      </div>
      <div className="drawer-foot">
        <Btn variant="quiet" onClick={onClose}>{t('cancel')}</Btn>
        <Btn variant="primary" loading={busy} disabled={!plan || plan.steps.length === 0} onClick={save}>{busy ? t('saving') : t('save')}</Btn>
      </div>
    </>
  );
}

function ScreenPicker(props: {
  open: boolean; setOpen: (v: boolean) => void; label: string; sub?: string; dashed?: boolean; current?: string;
  options: { id: string; name: string }[]; canInherit: boolean; onPick: (id: string | undefined) => void;
  onNewEmpty: () => void; onCopy: () => void; ownLabel: string;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const items: { key: string; run: () => void; node: React.ReactNode; selected?: boolean }[] = [
    ...props.options.map((o) => ({ key: o.id, run: () => props.onPick(o.id), selected: o.id === props.current, node: <><span className="grow">{o.name}</span>{o.id === props.current && <Check size={16} />}</> })),
    ...(props.canInherit ? [{ key: 'inherit', run: () => props.onPick(undefined), node: <><RotateCcw size={16} className="muted" /><span>{t('resetInherit')}</span></> }] : []),
    { key: 'copy', run: props.onCopy, node: <><Copy size={16} className="muted" /><span>{t('newFromCopy')}</span></> },
    { key: 'new', run: props.onNewEmpty, node: <><FilePlus2 size={16} className="muted" /><span>{t('newEmpty')}</span></> },
  ];
  useEffect(() => {
    if (!props.open) return;
    const close = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) props.setOpen(false); };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [props.open, props]);
  const onKey = (e: React.KeyboardEvent) => {
    if (!props.open) { if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); props.setOpen(true); } return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % items.length); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + items.length) % items.length); }
    if (e.key === 'Enter') { e.preventDefault(); items[active]?.run(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); props.setOpen(false); }
  };
  return (
    <div className="picker" ref={ref}>
      <button type="button" className="picker-btn" aria-haspopup="listbox" aria-expanded={props.open} onClick={() => props.setOpen(!props.open)} onKeyDown={onKey}
        style={props.dashed ? { borderStyle: 'dashed', background: 'var(--surface-sunk)' } : undefined}>
        <span className="col grow" style={{ minWidth: 0 }}>
          <span className={props.dashed ? 'muted' : ''} style={{ fontWeight: props.dashed ? 400 : 500 }}>{props.label}</span>
          {props.sub && <span className="xs muted ellipsis">{props.sub}</span>}
        </span>
        <motion.span animate={{ rotate: props.open ? 180 : 0 }} transition={spring} style={{ display: 'inline-flex' }}><ChevronDown size={18} /></motion.span>
      </button>
      <AnimatePresence>
        {props.open && (
          <motion.div className="menu" role="listbox" initial={{ opacity: 0, y: -6, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -6, scale: 0.97, transition: { duration: 0.14 } }} transition={spring}>
            <div className="menu-group">{props.ownLabel}</div>
            {items.map((it, i) => (
              <div key={it.key}>
                {it.key === 'inherit' || (it.key === 'copy' && !props.canInherit) ? <div className="menu-sep" /> : null}
                <button type="button" role="option" aria-selected={!!it.selected} data-active={active === i} className="menu-item" onPointerEnter={() => setActive(i)} onClick={it.run}>{it.node}</button>
              </div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
