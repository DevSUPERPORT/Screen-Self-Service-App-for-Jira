/**
 * Bulk field drawer: adds or removes fields on many screens at once, with screen presets and a target tab,
 * a per-screen preview, and a results view after applying.
 *
 * @file        static/app/src/views/Bulk.tsx
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import { AnimatePresence, motion } from 'framer-motion';
import { useMemo, useState } from 'react';
import { Check, CircleSlash, Lock, Minus, Plus, Search, X } from 'lucide-react';
import type { Op } from '@shared/types';
import { OPS } from '@shared/types';
import { bulkPlan, bulkPresets, type BulkItem, type BulkSpec } from '@shared/bulk';
import { effective, groupsOf, screenExclusive } from '@shared/domain';
import { useDrawerModel as useModel, useStore } from '../store';
import type { LayoutResult } from '../api/gateway';
import { useT, type Key } from '../i18n';
import { Btn, DrawerHead, Segmented, easeOut, spring, stagger } from '../ui';

type Preset = 'all' | 'create' | 'edit' | 'view' | 'createEdit';
const PRESETS: { id: Preset; label: Key }[] = [
  { id: 'all', label: 'bulkAll' }, { id: 'create', label: 'bulkCreate' }, { id: 'edit', label: 'bulkEdit' }, { id: 'view', label: 'bulkView' }, { id: 'createEdit', label: 'bulkCreateEdit' },
];

/**
 * Add or remove fields on many screens at once. The preview is computed by the same pure function the backend
 * uses; on apply the backend re-reads Jira and checks each screen's digest, so nothing stale is ever written.
 */
export function BulkDrawer({ init, onClose }: { init?: { screenIds?: string[]; fieldIds?: string[]; action?: 'add' | 'remove' }; onClose: () => void }) {
  const t = useT();
  const m = useModel();
  const saveLayouts = useStore((s) => s.saveLayouts);
  const presets = useMemo(() => bulkPresets(m), [m]);
  const [action, setAction] = useState<'add' | 'remove'>(init?.action ?? 'add');
  const [fieldIds, setFieldIds] = useState<string[]>(init?.fieldIds ?? []);
  const [screenIds, setScreenIds] = useState<string[]>(init?.screenIds ?? presets.createEdit);
  const [tabMode, setTabMode] = useState<'first' | 'named'>('first');
  const [tabName, setTabName] = useState('');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  // results keep the names of the screens as they were applied (the model changes underneath afterwards)
  const [results, setResults] = useState<{ list: LayoutResult[]; names: Record<string, string> } | null>(null);

  // screens of this project, with the operations each one serves
  const screens = useMemo(() => {
    const uses = new Map<string, Set<Op>>();
    for (const g of groupsOf(m)) for (const o of OPS) {
      const id = effective(m.screenSchemes[g.schemeId], o).screenId;
      uses.set(id, (uses.get(id) ?? new Set()).add(o));
    }
    return [...uses].map(([id, ops]) => ({ id, name: m.screens[id]?.name ?? id, ops: [...ops], own: screenExclusive(m, id) }))
      .sort((a, b) => Number(b.own) - Number(a.own) || a.name.localeCompare(b.name));
  }, [m]);

  const spec: BulkSpec = { action, fieldIds, screenIds, tab: tabMode === 'named' && tabName.trim() ? { mode: 'named', name: tabName.trim().slice(0, 60) } : { mode: 'first' } };
  const items = useMemo(() => (fieldIds.length && screenIds.length ? bulkPlan(m, spec) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [m, action, fieldIds, screenIds, tabMode, tabName]);
  const changing = items.filter((i) => i.status === 'change');
  // what changes first, then what is skipped
  const ordered = [...changing, ...items.filter((i) => i.status !== 'change')];
  const presetOn = (p: Preset) => presets[p].length > 0 && presets[p].length === screenIds.length && presets[p].every((id) => screenIds.includes(id));

  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    return Object.values(m.fields)
      .filter((f) => !fieldIds.includes(f.id) && !(action === 'remove' && f.locked))
      .filter((f) => !s || f.name.toLowerCase().includes(s) || f.id.toLowerCase().includes(s))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 8);
  }, [m, q, fieldIds, action]);

  const fieldNames = (ids: string[]) => ids.map((f) => m.fields[f]?.name ?? f).join(', ');
  const toggleScreen = (id: string) => setScreenIds((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const apply = async () => {
    if (!changing.length) return;
    setBusy(true);
    const label = t(changing.length === 1 ? 'lbBulk1' : 'lbBulk', { action: t(action === 'add' ? 'lbAdd' : 'lbRemove'), fields: fieldNames(changing.flatMap((i) => i.fields).filter((f, k, a) => a.indexOf(f) === k)), n: changing.length, name: changing[0].name });
    const names = Object.fromEntries(changing.map((i) => [i.screenId, i.name]));
    const r = await saveLayouts(changing.map((i) => i.save!), label, changing.length === 1 ? t('bulkDone1', { name: changing[0].name }) : undefined);
    setBusy(false);
    if (r) setResults({ list: r, names });
  };

  if (results) return <BulkResults results={results.list} names={results.names} onClose={onClose} />;

  return (
    <>
      <DrawerHead eyebrow={t('bulkOpen')} title={t('bulkTitle')} onClose={onClose} />
      <div className="drawer-body">
        <section className="panel">
          <h3 className="step-title">{t('bulkWhat')}</h3>
          <Segmented label={t('bulkWhat')} value={action} onChange={setAction} options={[{ value: 'add', label: <span className="row" style={{ gap: 6 }}><Plus size={15} />{t('bulkAdd')}</span> }, { value: 'remove', label: <span className="row" style={{ gap: 6 }}><Minus size={15} />{t('bulkRemove')}</span> }]} />
        </section>

        <section className="panel">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h3 className="step-title">{t('bulkFields')}</h3>
            {fieldIds.length > 0 && <span className="xs muted">{t('bulkSelected', { n: fieldIds.length })}</span>}
          </div>
          <div className="row wrap" style={{ gap: 6, minHeight: fieldIds.length ? undefined : 0 }}>
            <AnimatePresence initial={false}>
              {fieldIds.map((f) => (
                <motion.button key={f} type="button" layout className="bulk-chip" initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.6 }} transition={spring}
                  onClick={() => setFieldIds((x) => x.filter((y) => y !== f))} aria-label={`${m.fields[f]?.name ?? f} ×`}>
                  {m.fields[f]?.name ?? f}<X size={13} />
                </motion.button>
              ))}
            </AnimatePresence>
          </div>
          <div className="input-wrap">
            <Search size={16} />
            <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('bulkFieldsHint')} aria-label={t('bulkFields')}
              onKeyDown={(e) => { if (e.key === 'Enter' && matches[0]) { e.preventDefault(); setFieldIds((x) => [...x, matches[0].id]); setQ(''); } }} />
          </div>
          <ul className="bulk-matches" role="listbox" aria-label={t('bulkFields')}>
            {matches.map((f, i) => (
              <motion.li key={f.id} layout initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, ease: easeOut, ...stagger(i, 0.02) }}>
                <button type="button" role="option" aria-selected={false} onClick={() => { setFieldIds((x) => [...x, f.id]); setQ(''); }}>
                  <Plus size={14} className="muted" /><span className="grow ellipsis">{f.name}</span><span className="xs muted mono">{f.system ? f.id : f.type}</span>
                </button>
              </motion.li>
            ))}
          </ul>
        </section>

        <section className="panel">
          <h3 className="step-title">{t('bulkWhere')}</h3>
          <div className="row wrap" style={{ gap: 6 }}>
            {PRESETS.map((p) => (
              <button key={p.id} type="button" className={`bulk-preset ${presetOn(p.id) ? 'on' : ''}`} aria-pressed={presetOn(p.id)} disabled={!presets[p.id].length} onClick={() => setScreenIds(presets[p.id])}>
                {t(p.label)} <span className="xs">{presets[p.id].length}</span>
              </button>
            ))}
            <button type="button" className="bulk-preset" onClick={() => setScreenIds([])}>{t('bulkNone')}</button>
          </div>
          <ul className="bulk-screens">
            {screens.map((s) => {
              const on = screenIds.includes(s.id);
              return (
                <li key={s.id}>
                  <button type="button" role="checkbox" aria-checked={on} disabled={!s.own} onClick={() => toggleScreen(s.id)} className={on ? 'on' : ''}>
                    <span className="bulk-box">{on && <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} transition={spring} style={{ display: 'inline-flex' }}><Check size={13} strokeWidth={3} /></motion.span>}{!s.own && <Lock size={11} />}</span>
                    <span className="col grow" style={{ gap: 1, minWidth: 0, textAlign: 'left' }}>
                      <span className="ellipsis">{s.name}</span>
                      <span className="xs muted">{s.own ? t('bulkUsedFor', { ops: s.ops.map((o) => t(`op_${o}` as Key)).join(' · ') }) : t('bulkLocked')}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <AnimatePresence initial={false}>
          {action === 'add' && (
            <motion.section key="tab" className="panel" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.3, ease: easeOut }} style={{ overflow: 'hidden' }}>
              <h3 className="step-title">{t('bulkTab')}</h3>
              <Segmented label={t('bulkTab')} value={tabMode} onChange={setTabMode} options={[{ value: 'first', label: t('bulkFirstTab') }, { value: 'named', label: t('bulkNamedTab') }]} />
              {tabMode === 'named' && (
                <>
                  <input className="input" value={tabName} maxLength={60} onChange={(e) => setTabName(e.target.value)} placeholder={t('tabNamePlaceholder')} aria-label={t('bulkNamedTab')} />
                  <p className="xs muted">{t('bulkTabHint')}</p>
                </>
              )}
            </motion.section>
          )}
        </AnimatePresence>

        <section className="col" style={{ gap: 10 }}>
          <h3 className="eyebrow">{t('bulkPreview')}</h3>
          {items.length === 0 ? <p className="small muted">{t('bulkNothing')}</p> : (
            <ul className="bulk-preview">
              <AnimatePresence initial={false}>
                {ordered.map((it) => <PreviewRow key={it.screenId} it={it} action={action} names={fieldNames} />)}
              </AnimatePresence>
            </ul>
          )}
        </section>
      </div>
      <div className="drawer-foot">
        <Btn variant="quiet" onClick={onClose}>{t('cancel')}</Btn>
        <Btn variant="primary" loading={busy} disabled={!changing.length} onClick={apply}>
          {changing.length === 0 ? t('bulkApply0') : changing.length === 1 ? t('bulkApply1') : t('bulkApply', { n: changing.length })}
        </Btn>
      </div>
    </>
  );
}

function PreviewRow({ it, action, names }: { it: BulkItem; action: 'add' | 'remove'; names: (ids: string[]) => string }) {
  const t = useT();
  const skipped = (r: 'present' | 'required' | 'absent') => it.skipped.filter((s) => s.reason === r).map((s) => s.fieldId);
  const notes = [
    it.fields.length ? { tone: 'go', text: t(action === 'add' ? 'bulkWillAdd' : 'bulkWillRemove', { fields: names(it.fields) }) } : null,
    skipped('present').length ? { tone: 'skip', text: t('bulkAlready', { fields: names(skipped('present')) }) } : null,
    skipped('required').length ? { tone: 'skip', text: t('bulkRequired', { fields: names(skipped('required')) }) } : null,
    skipped('absent').length ? { tone: 'skip', text: t('bulkAbsent', { fields: names(skipped('absent')) }) } : null,
    it.status === 'locked' ? { tone: 'block', text: t('bulkLocked') } : null,
    it.status === 'blocked' && it.reason === 'field-scheme-shared' ? { tone: 'block', text: t('bulkBlocked') } : null,
  ].filter(Boolean) as { tone: string; text: string }[];
  return (
    <motion.li layout className={`bulk-row st-${it.status}`} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 10 }} transition={{ duration: 0.3, ease: easeOut }}>
      <span className="bulk-st">{it.status === 'change' ? (action === 'add' ? <Plus size={13} /> : <Minus size={13} />) : it.status === 'noop' ? <CircleSlash size={13} /> : <Lock size={12} />}</span>
      <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
        <span className="ellipsis" style={{ fontWeight: 600 }}>{it.name}</span>
        {notes.map((n, i) => <span key={i} className={`xs ${n.tone === 'go' ? '' : 'muted'}`}>{n.text}</span>)}
      </span>
    </motion.li>
  );
}

function BulkResults({ results, names, onClose }: { results: LayoutResult[]; names: Record<string, string>; onClose: () => void }) {
  const t = useT();
  const ok = results.filter((r) => r.ok).length;
  const name = (id: string) => names[id] ?? id;
  return (
    <>
      <DrawerHead eyebrow={t('bulkOpen')} title={ok === results.length ? (ok === 1 ? t('bulkDone1', { name: name(results[0].screenId) }) : t('bulkDoneAll', { n: ok })) : t('bulkDone', { ok, n: results.length })} onClose={onClose} />
      <div className="drawer-body">
        <ul className="bulk-preview">
          {results.map((r, i) => (
            <motion.li key={r.screenId} className={`bulk-row ${r.ok ? 'st-done' : 'st-failed'}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, ease: easeOut, ...stagger(i, 0.05) }}>
              <motion.span className="bulk-st" initial={{ scale: 0, rotate: -90 }} animate={{ scale: 1, rotate: 0 }} transition={{ ...spring, delay: 0.1 + i * 0.05 }}>{r.ok ? <Check size={13} strokeWidth={3} /> : <X size={13} strokeWidth={3} />}</motion.span>
              <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
                <span className="ellipsis" style={{ fontWeight: 600 }}>{name(r.screenId)}</span>
                {!r.ok && <span className="xs" style={{ color: 'var(--danger)' }}>{t('bulkFailed', { msg: r.message ?? r.code ?? '' })}</span>}
              </span>
            </motion.li>
          ))}
        </ul>
      </div>
      <div className="drawer-foot">
        <Btn variant="primary" onClick={onClose}>{t('bulkClose')}</Btn>
      </div>
    </>
  );
}
