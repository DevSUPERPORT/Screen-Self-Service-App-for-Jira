/**
 * Drawers that restructure screen schemes: split an issue type off into its own scheme (UC-11), merge an
 * issue type into another scheme (UC-12), and explain why a shared screen is locked (UC-07).
 *
 * @file        static/app/src/views/Structure.tsx
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import { AnimatePresence, motion } from 'framer-motion';
import { useMemo, useState } from 'react';
import { ArrowRight, Check, Copy, FileStack, Folder, Layers, Lock, Mail } from 'lucide-react';
import type { IssueType, Op } from '@shared/types';
import { OPS } from '@shared/types';
import { effective, groupsOf, otherProjects, planFor, schemeExclusive } from '@shared/domain';
import { useDrawerModel as useModel, useStore } from '../store';
import { useT } from '../i18n';
import { Btn, Choice, DrawerHead, ItIcon, easeOut, spring } from '../ui';
import { PreviewList } from './Preview';
import { useScreen } from './Copy';

function Step({ n, title, children }: { n: number; title: React.ReactNode; children: React.ReactNode }) {
  return (
    <motion.section className="panel step" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, ease: easeOut, delay: n * 0.06 }}>
      <div className="step-head"><span className="step-num">{n}</span><h3 className="step-title">{title}</h3></div>
      {children}
    </motion.section>
  );
}

function TypePills({ types, value, onChange, label }: { types: IssueType[]; value: string; onChange: (id: string) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="row wrap">
      {types.map((it) => (
        <button key={it.id} type="button" role="radio" aria-checked={value === it.id} onClick={() => onChange(it.id)}
          className="btn btn-sm" style={{ borderRadius: 999, position: 'relative', border: '1px solid var(--line-strong)', color: value === it.id ? 'var(--surface)' : 'var(--ink)', fontWeight: 400, isolation: 'isolate' }}>
          {value === it.id && <motion.span layoutId="type-pill" style={{ position: 'absolute', inset: -1, borderRadius: 999, background: 'var(--ink)', zIndex: -1 }} transition={spring} />}
          <ItIcon name={it.name} url={it.iconUrl} />{it.name}
        </button>
      ))}
    </div>
  );
}

// ---------------- UC-11 Split ----------------
export function SplitDrawer({ schemeId, onClose }: { schemeId: string; onClose: () => void }) {
  const t = useT();
  const m = useModel();
  const run = useStore((s) => s.run);
  const group = groupsOf(m).find((g) => g.schemeId === schemeId)!;
  const sc = m.screenSchemes[schemeId];
  const [typeId, setTypeId] = useState(group.issueTypes[group.issueTypes.length - 1].id);
  const [mode, setMode] = useState<'copy' | 'share'>('copy');
  const [busy, setBusy] = useState(false);
  const it = group.issueTypes.find((i) => i.id === typeId)!;
  const rest = group.issueTypes.filter((i) => i.id !== typeId);
  const plan = useMemo(() => planFor(m, { type: 'split', schemeId, issueTypeId: typeId, mode }), [m, schemeId, typeId, mode]);
  const newSchemeName = (plan.steps.find((s) => s.kind === 'createScreenScheme') as { name: string }).name;
  const remainingName = (plan.steps.find((s) => s.kind === 'renameScreenScheme' && s.schemeId === schemeId) as { to: string } | undefined)?.to ?? sc.name;
  const screenCount = new Set(Object.values(sc.screens)).size;

  const go = async () => {
    setBusy(true);
    const res = await run({ type: 'split', schemeId, issueTypeId: typeId, mode }, t('splitDone', { it: it.name }), { close: true, label: t('lbSplit', { it: it.name }) });
    if (!res) setBusy(false);
  };

  return (
    <>
      <DrawerHead eyebrow={t('splitEyebrow', { scheme: sc.name })} title={t('splitTitle', { it: it.name })} onClose={onClose} />
      <div className="drawer-body">
        <Step n={1} title={t('splitWhich')}>
          <TypePills types={group.issueTypes} value={typeId} onChange={setTypeId} label={t('splitWhich')} />
          <p className="small muted">{t('splitStays', { it: rest.map((r) => r.name).join(', ') })}</p>
        </Step>
        <Step n={2} title={t('splitStart', { it: it.name })}>
          <div role="radiogroup" className="col" style={{ gap: 10 }}>
            <Choice checked={mode === 'copy'} onSelect={() => setMode('copy')} title={t('splitCopy')} badge={<span className="pill pill-accent" style={{ fontSize: 11, padding: '2px 8px' }}>{t('recommended')}</span>} body={t('splitCopyBody', { it: it.name })} />
            <Choice checked={mode === 'share'} onSelect={() => setMode('share')} title={t('splitShare')} body={t('splitShareBody', { it: it.name })} />
          </div>
        </Step>
        <Step n={3} title={t('splitWhat')}>
          <PreviewList plan={plan} m={m} />
        </Step>
        <section className="col" style={{ gap: 10 }}>
          <h3 className="eyebrow">{t('splitAfter')}</h3>
          <div className="row wrap" style={{ gap: 12, alignItems: 'stretch' }}>
            <motion.div layout className="card" style={{ flex: '1 1 240px', padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div className="row wrap">{rest.map((r) => <span key={r.id} className="issue-chip"><ItIcon name={r.name} />{r.name}</span>)}</div>
              <span className="xs muted">{remainingName} · {screenCount} screens</span>
            </motion.div>
            <motion.div layout className="card" style={{ flex: '1 1 240px', padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 6, borderColor: 'var(--accent-bright)', borderWidth: 1.5 }}
              initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} key={typeId}>
              <div className="row wrap"><span className="issue-chip"><ItIcon name={it.name} />{it.name}</span><span className="pill pill-solid">{t('pv_new')}</span></div>
              <span className="xs muted">{newSchemeName} · {screenCount} screens</span>
            </motion.div>
          </div>
        </section>
      </div>
      <div className="drawer-foot">
        <Btn variant="quiet" onClick={onClose}>{t('cancel')}</Btn>
        <Btn variant="primary" loading={busy} onClick={go}>{t('splitGo', { it: it.name })}</Btn>
      </div>
    </>
  );
}

// ---------------- UC-12 Merge ----------------
export function MergeDrawer({ schemeId, onClose }: { schemeId: string; onClose: () => void }) {
  const t = useT();
  const m = useModel();
  const run = useStore((s) => s.run);
  const groups = groupsOf(m);
  const group = groups.find((g) => g.schemeId === schemeId)!;
  const targets = groups.filter((g) => g.schemeId !== schemeId && schemeExclusive(m, g.schemeId));
  const [typeId, setTypeId] = useState(group.issueTypes[0].id);
  const [target, setTarget] = useState(targets[0]?.schemeId ?? '');
  const [busy, setBusy] = useState(false);
  const it = group.issueTypes.find((i) => i.id === typeId)!;
  const plan = useMemo(() => (target ? planFor(m, { type: 'merge', issueTypeId: typeId, targetSchemeId: target }) : null), [m, typeId, target]);
  const tgt = targets.find((g) => g.schemeId === target);
  const freed = plan?.preview.filter((p) => p.kind === 'freed') ?? [];
  const renames = plan?.preview.filter((p) => p.kind === 'renamed') ?? [];

  const go = async () => {
    setBusy(true);
    const res = await run({ type: 'merge', issueTypeId: typeId, targetSchemeId: target }, t('mergeDone', { it: it.name, target: tgt?.title ?? '' }), { close: true, label: t('lbMerge', { it: it.name }) });
    if (!res) setBusy(false);
  };
  const cell = (sid: string, op: Op) => {
    const e = effective(m.screenSchemes[sid], op);
    return e.inherited ? <span className="muted">{t('inheritsDefault')}</span> : m.screens[e.screenId]?.name;
  };

  return (
    <>
      <DrawerHead eyebrow={t('mergeEyebrow', { scheme: m.screenSchemes[schemeId].name })} title={t('mergeTitle', { it: it.name })} onClose={onClose} />
      <div className="drawer-body">
        {group.issueTypes.length > 1 && (
          <Step n={0} title={t('mergeWhichType')}>
            <TypePills types={group.issueTypes} value={typeId} onChange={setTypeId} label={t('mergeWhichType')} />
          </Step>
        )}
        <Step n={1} title={t('mergeWhich', { it: it.name })}>
          <div role="radiogroup" className="col" style={{ gap: 10 }}>
            {targets.map((g) => (
              <Choice key={g.schemeId} checked={target === g.schemeId} onSelect={() => setTarget(g.schemeId)}
                title={g.title} body={m.screenSchemes[g.schemeId].name} />
            ))}
          </div>
          <p className="xs muted">{t('mergeOnlyExclusive', { key: m.project.key })}</p>
        </Step>
        {plan && (
          <>
            <Step n={2} title={t('mergeBeforeAfter')}>
              <div className="table-wrap">
                <table className="tbl" style={{ minWidth: 520 }}>
                  <thead><tr><th>{t('operation')}</th><th>{t('mergeBefore', { it: it.name })}</th><th>{t('mergeAfter', { it: it.name })}</th></tr></thead>
                  <tbody>
                    {OPS.map((op) => (
                      <tr key={op}>
                        <td style={{ fontWeight: 600 }}>{t(`op_${op}`)}</td>
                        <td className="muted">{cell(schemeId, op)}</td>
                        <td><AnimatePresence mode="wait"><motion.span key={target} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }} style={{ display: 'inline-block' }}>{cell(target, op)}</motion.span></AnimatePresence></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Step>
            <Step n={3} title={t('mergeFreed')}>
              <PreviewList plan={{ ...plan, preview: [...freed, ...renames] }} m={m} />
              {freed.length > 0 && <p className="small muted">{t('mergeFreedNote', { d: m.config.days })}</p>}
              {renames.length === 0 && <p className="small muted row"><Check size={14} />{t('mergeNoRename')}</p>}
            </Step>
          </>
        )}
      </div>
      <div className="drawer-foot">
        <Btn variant="quiet" onClick={onClose}>{t('cancel')}</Btn>
        <Btn variant="primary" loading={busy} disabled={!plan} onClick={go}>{t('mergeGo')}</Btn>
      </div>
    </>
  );
}

// ---------------- UC-07 Locked ----------------
export function LockedDrawer({ screenId, onClose }: { screenId: string; onClose: () => void }) {
  const t = useT();
  const m = useModel();
  const open = useStore((s) => s.open);
  const s = m.screens[screenId];
  const [showAll, setShowAll] = useState(false);
  const [copied, setCopied] = useState(false);
  const others = otherProjects(s, m.project.key);
  const scheme = s.screenSchemeIds.map((id) => m.screenSchemes[id]).find(Boolean);
  const projects = [m.project.key, ...s.projects.filter((p) => p !== m.project.key)];
  const visible = showAll ? projects : projects.slice(0, 8);
  const full = useScreen(screenId);
  const fields = (full?.tabs ?? s.tabs ?? []).flatMap((x) => x.fieldIds);
  const nodes = [
    { icon: <FileStack size={16} />, label: t('kindScreen'), name: s.name },
    ...(scheme ? [{ icon: <Layers size={16} />, label: t('kindScheme'), name: scheme.name }] : []),
    ...(s.screenSchemeIds.length ? [{ icon: <Layers size={16} />, label: t('itssLabel'), name: m.itss.name }] : []),
    { icon: <Folder size={16} />, label: t('nProjects', { n: others + 1 }), name: '' },
  ];
  const copyName = async () => {
    try { await navigator.clipboard.writeText(s.name); } catch { /* clipboard may be blocked in iframes */ }
    setCopied(true); setTimeout(() => setCopied(false), 1600);
  };
  return (
    <>
      <DrawerHead eyebrow={<span className="row"><Lock size={12} />{t('readOnly')}</span>} title={s.name} onClose={onClose} />
      <div className="drawer-body">
        <motion.div className="hint accent" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <Lock size={18} />
          <div className="col" style={{ gap: 4 }}>
            <strong style={{ fontWeight: 600, fontSize: 15 }}>{t(others === 1 ? 'lockedTitle1' : 'lockedTitle', { n: others })}</strong>
            <span>{t('lockedBody')}</span>
          </div>
        </motion.div>
        <section className="panel">
          <h3 className="eyebrow">{t('lockedPath', { key: m.project.key })}</h3>
          <div className="path">
            {nodes.map((n, i) => (
              <div key={i}>
                {i > 0 && (
                  <svg className="path-link" viewBox="0 0 2 26" aria-hidden="true">
                    <motion.line x1="1" y1="0" x2="1" y2="26" stroke="var(--accent-bright)" strokeWidth="2" strokeDasharray="3 3"
                      initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.35, delay: 0.15 + i * 0.18 }} />
                  </svg>
                )}
                <motion.div className="path-node" initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} transition={{ ...spring, delay: 0.1 + i * 0.18 }}>
                  <span className="ic">{n.icon}</span>
                  <span className="col grow" style={{ minWidth: 0 }}>
                    <span className="xs muted">{n.label}</span>
                    {n.name && <span style={{ fontWeight: 600 }} className="ellipsis">{n.name}</span>}
                    {i === nodes.length - 1 && (
                      <div className="chips" style={{ marginTop: 8 }}>
                        <AnimatePresence initial={false}>
                          {visible.map((p, k) => (
                            <motion.span key={p} className={`chip${p === m.project.key ? ' me' : ''}`} initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.6 }} transition={{ ...spring, delay: 0.6 + k * 0.03 }}>{p}</motion.span>
                          ))}
                        </AnimatePresence>
                        {projects.length > 8 && (
                          <button type="button" className="linkish" style={{ fontSize: 13 }} onClick={() => setShowAll((v) => !v)}>
                            {showAll ? t('hideProjects') : `${t('andMore', { n: projects.length - 8 })} · ${t('showProjects')}`}
                          </button>
                        )}
                        {s.projectCount > projects.length && <span className="chip">+{s.projectCount - projects.length}</span>}
                      </div>
                    )}
                  </span>
                </motion.div>
              </div>
            ))}
          </div>
        </section>
        {fields.length > 0 && (
          <section className="panel">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h3 className="eyebrow">{t('content')}</h3>
              <span className="xs muted">{t('fieldsTabs', { f: s.fieldCount, t: s.tabCount })}</span>
            </div>
            <div className="preview-fields">
              {fields.slice(0, 8).map((f, i) => (
                <motion.div key={f} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 + i * 0.03 }}>{m.fields[f]?.name ?? f}</motion.div>
              ))}
              {fields.length > 8 && <div className="muted">{t('andMore', { n: fields.length - 8 })}</div>}
            </div>
          </section>
        )}
        <section className="panel">
          <h3 className="step-title">{t('needChange')}</h3>
          <p className="small muted">{t('needChangeBody', { key: m.project.key })}</p>
          <div className="row wrap">
            <Btn size="sm" icon={copied ? <Check size={16} /> : <Mail size={16} />} onClick={copyName}>{copied ? t('copied') : t('copyName')}</Btn>
            <Btn variant="dark" size="sm" icon={<Copy size={16} />} onClick={() => { onClose(); open({ type: 'copy', templateId: s.id }); }}>
              {t('makeOwnCopy', { key: m.project.key })} <ArrowRight size={14} />
            </Btn>
          </div>
        </section>
      </div>
    </>
  );
}
