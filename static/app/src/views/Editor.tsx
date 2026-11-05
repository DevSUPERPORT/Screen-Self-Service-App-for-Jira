/**
 * Layout editor for one screen, opened from its slot card: drag and drop fields within and between tabs,
 * add, rename and remove tabs, add fields from the field palette, and save the layout. Shared screens open
 * read-only, and fields missing from the project's field scheme are flagged.
 *
 * @file        static/app/src/views/Editor.tsx
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor, closestCenter, pointerWithin, useDraggable, useDroppable, useSensor, useSensors,
  type CollisionDetection, type DragEndEvent, type DragOverEvent, type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, horizontalListSortingStrategy, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowLeft, Check, GripVertical, Info, Lock, Pencil, Plus, Search, Sparkles, Trash2, X } from 'lucide-react';
import { askRovo } from '../api/gateway';
import clsx from 'clsx';
import type { Field, LayoutSave } from '@shared/types';
import { OPS } from '@shared/types';
import { groupsOf, layoutChanges, missingFromFieldScheme, onlyProject, otherProjects, screenExclusive } from '@shared/domain';
import { useModel, useStore } from '../store';
import { useT } from '../i18n';
import { Btn, MOD, Morph, Num, easeOut, spring } from '../ui';
import { useScreen } from './Copy';
import { tabsDigest } from '@shared/digest';

interface LTab { key: string; id: string | null; name: string; fieldIds: string[] }
let keySeq = 0;
const k = () => `k${++keySeq}`;

export function Editor({ screenId, origin, onClose }: { screenId: string; origin?: { x: number; y: number; w: number; h: number }; onClose: () => void }) {
  const t = useT();
  const m = useModel();
  const saveLayout = useStore((s) => s.saveLayout);
  const screen = useScreen(screenId);
  const meta = m.screens[screenId];
  const editable = screenExclusive(m, screenId);
  const [tabs, setTabs] = useState<LTab[] | null>(null);
  const [active, setActive] = useState(0);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTab, setDropTab] = useState<string | null>(null);
  const [editingTab, setEditingTab] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [busy, setBusy] = useState(false);
  // The field palette (hundreds of fields on real sites) mounts after the open animation, not inside its first frame
  const [paletteReady, setPaletteReady] = useState(false);
  useEffect(() => { const id = setTimeout(() => setPaletteReady(true), 420); return () => clearTimeout(id); }, []);
  const hoverTimer = useRef<number>();
  // Grow out of the card that was clicked (clip-path keeps the content crisp — no scaling)
  const from = origin ? `inset(${origin.y}px ${Math.max(0, innerWidth - origin.x - origin.w)}px ${Math.max(0, innerHeight - origin.y - origin.h)}px ${origin.x}px round 10px)` : undefined;

  const reset = useCallback(() => {
    if (!screen?.tabs) return;
    setTabs(screen.tabs.map((x) => ({ key: k(), id: x.id, name: x.name, fieldIds: [...x.fieldIds] })));
    setActive((a) => Math.min(a, Math.max(0, screen.tabs!.length - 1)));
  }, [screen]);
  useEffect(() => { reset(); }, [reset]);

  const original = screen?.tabs ?? [];
  const desired: LayoutSave['tabs'] = (tabs ?? []).map((x) => ({ id: x.id, name: x.name, fieldIds: x.fieldIds }));
  const changes = tabs ? layoutChanges(original, desired) : 0;
  const onScreen = useMemo(() => new Map((tabs ?? []).flatMap((tb) => tb.fieldIds.map((f) => [f, tb.name] as const))), [tabs]);
  const originalIds = useMemo(() => new Set(original.flatMap((x) => x.fieldIds)), [original]);
  const missing = useMemo(() => new Set(missingFromFieldScheme(m, [...onScreen.keys()])), [m, onScreen]);
  const fsExclusive = !!m.fieldScheme && onlyProject(m.fieldScheme, m.project.key);
  const blockedByScheme = !fsExclusive && missing.size > 0;

  const tryClose = () => (changes > 0 ? setConfirmClose(true) : onClose());
  const save = async () => {
    if (!tabs || !changes || busy || blockedByScheme) return;
    setBusy(true);
    const ok = await saveLayout({ screenId, tabs: desired, baseDigest: tabsDigest(original) }, t('lbEdit', { name: meta?.name ?? '' }));
    setBusy(false);
    if (ok) setTabs(null);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); }
      if (e.key === 'Escape' && !dragId && !editingTab && !useStore.getState().palette) { e.preventDefault(); confirmClose ? setConfirmClose(false) : tryClose(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ---------- usage ----------
  const groups = groupsOf(m);
  const usage = groups.flatMap((g) => {
    const sc = m.screenSchemes[g.schemeId];
    const ops = OPS.filter((o) => (sc.screens[o] ?? (o !== 'default' ? sc.screens.default : undefined)) === screenId)
      .map((o) => (o !== 'default' && !sc.screens[o] ? `${t(`op_${o}`)} (${t('inheritsDefault')})` : t(`op_${o}`)));
    return ops.length ? [{ types: g.title, ops }] : [];
  });

  // ---------- dnd ----------
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const collision: CollisionDetection = (args) => {
    const within = pointerWithin(args);
    const tabHit = within.find((c) => String(c.id).startsWith('t:'));
    if (String(args.active.id).startsWith('t:')) return closestCenter({ ...args, droppableContainers: args.droppableContainers.filter((c) => String(c.id).startsWith('t:')) });
    if (tabHit) return [tabHit];
    return closestCenter({ ...args, droppableContainers: args.droppableContainers.filter((c) => !String(c.id).startsWith('t:')) });
  };
  const cur = tabs?.[active];

  const onStart = (e: DragStartEvent) => setDragId(String(e.active.id));
  const onOver = (e: DragOverEvent) => {
    const over = e.over ? String(e.over.id) : null;
    const a = String(e.active.id);
    if (a.startsWith('t:')) return;
    if (over?.startsWith('t:')) {
      if (dropTab !== over) {
        setDropTab(over);
        window.clearTimeout(hoverTimer.current);
        hoverTimer.current = window.setTimeout(() => {
          const idx = tabs!.findIndex((x) => `t:${x.key}` === over);
          if (idx >= 0) { setActive(idx); setDropTab(null); }
        }, 650);
      }
    } else if (dropTab) { setDropTab(null); window.clearTimeout(hoverTimer.current); }
  };
  const onEnd = (e: DragEndEvent) => {
    window.clearTimeout(hoverTimer.current);
    setDragId(null); setDropTab(null);
    if (!tabs || !e.over) return;
    const a = String(e.active.id); const o = String(e.over.id);
    const next = tabs.map((x) => ({ ...x, fieldIds: [...x.fieldIds] }));
    if (a.startsWith('t:') && o.startsWith('t:')) {
      const from = next.findIndex((x) => `t:${x.key}` === a); const to = next.findIndex((x) => `t:${x.key}` === o);
      if (from !== to) { const activeKey = next[active].key; const moved = arrayMove(next, from, to); setTabs(moved); setActive(moved.findIndex((x) => x.key === activeKey)); }
      return;
    }
    const fid = a.slice(2);
    const isPalette = a.startsWith('p:');
    const srcTab = next.findIndex((x) => x.fieldIds.includes(fid));
    if (isPalette && srcTab >= 0) return;
    if (o.startsWith('t:')) {
      const dst = next.findIndex((x) => `t:${x.key}` === o);
      if (dst < 0 || dst === srcTab) return;
      if (srcTab >= 0) next[srcTab].fieldIds = next[srcTab].fieldIds.filter((x) => x !== fid);
      next[dst].fieldIds.push(fid);
      setTabs(next);
      return;
    }
    const tab = next[active];
    if (o.startsWith('f:')) {
      const target = o.slice(2);
      if (srcTab === active) {
        const from = tab.fieldIds.indexOf(fid); const to = tab.fieldIds.indexOf(target);
        tab.fieldIds = arrayMove(tab.fieldIds, from, to);
      } else {
        if (srcTab >= 0) next[srcTab].fieldIds = next[srcTab].fieldIds.filter((x) => x !== fid);
        const at = tab.fieldIds.indexOf(target);
        tab.fieldIds.splice(at < 0 ? tab.fieldIds.length : at, 0, fid);
      }
      setTabs(next);
    } else if (o === 'list') {
      if (srcTab >= 0) next[srcTab].fieldIds = next[srcTab].fieldIds.filter((x) => x !== fid);
      tab.fieldIds.push(fid);
      setTabs(next);
    }
  };

  const addField = (fid: string) => {
    if (!tabs || onScreen.has(fid)) return;
    setTabs(tabs.map((x, i) => (i === active ? { ...x, fieldIds: [...x.fieldIds, fid] } : x)));
  };
  const removeField = (fid: string) => setTabs(tabs!.map((x) => ({ ...x, fieldIds: x.fieldIds.filter((f) => f !== fid) })));
  const addTab = () => {
    const key = k();
    const names = new Set(tabs!.map((x) => x.name));
    let name = t('newTab'); let i = 2;
    while (names.has(name)) name = `${t('newTab')} ${i++}`;
    setTabs([...tabs!, { key, id: null, name, fieldIds: [] }]);
    setActive(tabs!.length);
    setEditingTab(key);
  };
  const removeTab = (key: string) => {
    const idx = tabs!.findIndex((x) => x.key === key);
    const locked = tabs![idx].fieldIds.filter((f) => m.fields[f]?.locked);
    const next = tabs!.filter((x) => x.key !== key);
    if (locked.length) next[Math.max(0, idx - 1)].fieldIds.push(...locked);
    setTabs(next);
    setActive(Math.max(0, Math.min(active, next.length - 1)));
  };
  const renameTab = (key: string, name: string) => setTabs(tabs!.map((x) => (x.key === key ? { ...x, name: name.slice(0, 255) } : x)));

  const dragField = dragId && !dragId.startsWith('t:') ? m.fields[dragId.slice(2)] : null;

  return (
    <>
      <motion.div
        className="editor"
        role="dialog"
        aria-modal="true"
        aria-label={meta?.name}
        initial={from ? { clipPath: from, opacity: 1 } : { opacity: 0, y: 40 }}
        animate={{ clipPath: 'inset(0px 0px 0px 0px round 0px)', opacity: 1, y: 0 }}
        exit={from ? { clipPath: from, opacity: 0, transition: { duration: 0.42, ease: [0.4, 0, 0.2, 1], opacity: { delay: 0.25, duration: 0.17 } } } : { opacity: 0, y: 40 }}
        transition={{ duration: 0.55, ease: easeOut }}
      >
        <motion.div className="editor-head" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.15, duration: 0.3 }}>
          <div className="container">
            <Btn variant="ghost" size="sm" icon={<ArrowLeft size={16} />} onClick={tryClose}>{t('back')}</Btn>
            <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
              <span className="eyebrow ellipsis">{t('editorEyebrow', { types: usage.map((u) => u.types).join(' · ') || '—' })}</span>
              <div className="row wrap" style={{ gap: 10 }}>
                <h1 className="h1" style={{ fontSize: 22 }}><Morph text={meta?.name ?? ''} /></h1>
                {editable
                  ? <span className="pill pill-accent"><span className="dot" />{t('onlyProject', { key: m.project.key })}</span>
                  : <span className="pill"><Lock size={12} />{t('readOnly')}</span>}
              </div>
            </div>
            {editable && (
              <div className="row">
                <Btn variant="quiet" size="sm" disabled={!changes} onClick={reset}>{t('discard')}</Btn>
                <Btn variant="primary" size="sm" disabled={!changes || blockedByScheme} loading={busy} onClick={save}>{t('save')}</Btn>
              </div>
            )}
          </div>
        </motion.div>

        <motion.div className="editor-body" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.18, duration: 0.45, ease: easeOut }}>
          <div className="container editor-grid">
            <DndContext sensors={sensors} collisionDetection={collision} onDragStart={onStart} onDragOver={onOver} onDragEnd={onEnd} onDragCancel={() => { setDragId(null); setDropTab(null); }}>
              <section className="card" aria-label={t('tabs')}>
                {!tabs ? (
                  <div className="col" style={{ gap: 8, padding: 16 }}>
                    <div className="skeleton" style={{ height: 38, width: '60%' }} />
                    {[0, 1, 2, 3, 4].map((i) => <div key={i} className="skeleton" style={{ height: 56 }} />)}
                  </div>
                ) : (
                  <>
                    {!editable && <div className="hint" style={{ margin: 14 }}><Lock size={16} />{t('lockedEditor')}</div>}
                    <SortableContext items={tabs.map((x) => `t:${x.key}`)} strategy={horizontalListSortingStrategy}>
                      <div className="tabbar">
                        <div role="tablist" aria-label={t('tabs')} className="row wrap" style={{ gap: 6 }}>
                        {tabs.map((tb, i) => (
                          <TabChip key={tb.key} tab={tb} selected={i === active} onSelect={() => setActive(i)} drop={dropTab === `t:${tb.key}`} disabled={!editable}
                            editing={editingTab === tb.key} onRename={(n) => renameTab(tb.key, n)} onDoneEditing={() => setEditingTab(null)} onStartEditing={() => editable && setEditingTab(tb.key)} />
                        ))}
                        </div>
                        {editable && <Btn variant="ghost" size="xs" icon={<Plus size={15} />} onClick={addTab}>{t('addTab')}</Btn>}
                      </div>
                    </SortableContext>
                    {editable && cur && (
                      <div className="tab-tools">
                        <span className="small muted grow">{t('dragHint')}</span>
                        <Btn variant="ghost" size="xs" icon={<Pencil size={14} />} onClick={() => setEditingTab(cur.key)}>{t('tabName')}</Btn>
                        {tabs.length > 1 && <RemoveTab n={cur.fieldIds.length} onConfirm={() => removeTab(cur.key)} />}
                      </div>
                    )}
                    <AnimatePresence mode="wait" initial={false}>
                      <motion.div key={cur?.key} initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.22, ease: easeOut }}>
                        <FieldList ids={cur?.fieldIds ?? []} fields={m.fields} editable={editable} originalIds={originalIds} missing={missing} fsExclusive={fsExclusive} onRemove={removeField} />
                      </motion.div>
                    </AnimatePresence>
                  </>
                )}
              </section>

              <aside className="side">
                {editable && tabs && !paletteReady && <div className="skeleton" style={{ height: 420, borderRadius: 10 }} />}
                {editable && tabs && paletteReady && (
                  <FieldPalette fields={m.fields} onScreen={onScreen} inScheme={new Set(m.fieldScheme?.fieldIds ?? [])} onAdd={addField} />
                )}
                {editable && m.fieldScheme && (
                  <div className={clsx('hint', blockedByScheme ? 'accent' : '')}>
                    <Info size={16} />
                    <span>{fsExclusive ? t('fieldSchemeNote', { name: m.fieldScheme.name, key: m.project.key }) : t('fieldSchemeShared', { name: m.fieldScheme.name })}</span>
                  </div>
                )}
                <section className="panel">
                  <h2 className="eyebrow">{t('usage')}</h2>
                  <dl className="kv">
                    <dt>{t('usageTypes')}</dt><dd>{usage.map((u) => u.types).join(' · ') || t('none')}</dd>
                    <dt>{t('usageOps')}</dt><dd>{usage.flatMap((u) => u.ops).join(', ') || t('none')}</dd>
                    <dt>{t('usageOther')}</dt><dd>{meta && otherProjects(meta, m.project.key) > 0 ? otherProjects(meta, m.project.key) : t('none')}</dd>
                  </dl>
                  <button type="button" className="linkish" onClick={async () => { if (!(await askRovo(t('rovoQ4', { name: meta?.name ?? '' })))) useStore.getState().toast('info', t('rovoUnavailable')); }}><Sparkles size={14} /> {t('rovoHint')}</button>
                </section>
              </aside>

              <DragOverlay dropAnimation={{ duration: 220, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }}>
                {dragField ? <FieldCard f={dragField} overlay /> : dragId?.startsWith('t:') ? <div className="tab" style={{ background: 'var(--surface)', boxShadow: 'var(--shadow-2)' }}>{tabs?.find((x) => `t:${x.key}` === dragId)?.name}</div> : null}
              </DragOverlay>
            </DndContext>
          </div>
        </motion.div>
      </motion.div>

      <AnimatePresence>
        {editable && changes > 0 && !confirmClose && (
          <motion.div className="savebar" role="status" initial={{ y: 100, x: '-50%', opacity: 0, scale: 0.9 }} animate={{ y: 0, x: '-50%', opacity: 1, scale: 1 }} exit={{ y: 100, x: '-50%', opacity: 0, scale: 0.9 }} transition={spring}>
            <span className="row" style={{ gap: 6 }}><strong style={{ fontWeight: 600 }}><Num value={changes} /></strong>{changes === 1 ? t('unsavedOne') : t('unsavedMany')}</span>
            <Btn variant="ghost" size="sm" onClick={reset}>{t('discard')}</Btn>
            <Btn variant="primary" size="sm" loading={busy} disabled={blockedByScheme} onClick={save} icon={<Check size={16} />}>{t('save')} <span className="kbd" style={{ background: 'transparent', color: 'inherit', borderColor: 'currentColor', opacity: 0.6 }}>{MOD}S</span></Btn>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {confirmClose && (
          <>
            <motion.div className="scrim" style={{ zIndex: 80 }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setConfirmClose(false)} />
            <motion.div role="alertdialog" aria-modal="true" aria-label={t('leaveUnsaved')} className="pal" style={{ zIndex: 81, top: '30vh', padding: 24, display: 'flex', flexDirection: 'column', gap: 18, width: 'min(420px, calc(100vw - 32px))' }}
              initial={{ opacity: 0, scale: 0.92, x: '-50%' }} animate={{ opacity: 1, scale: 1, x: '-50%' }} exit={{ opacity: 0, scale: 0.92, x: '-50%' }} transition={spring}>
              <h2 className="drawer-title">{t('leaveUnsaved')}</h2>
              <p className="muted small">{changes === 1 ? t('unsaved1') : t('unsavedN', { n: changes })}</p>
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <Btn variant="quiet" data-autofocus onClick={() => setConfirmClose(false)} autoFocus>{t('keepEditing')}</Btn>
                <Btn variant="danger" onClick={onClose}>{t('discard')}</Btn>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}

function TabChip({ tab, selected, onSelect, drop, disabled, editing, onRename, onDoneEditing, onStartEditing }: {
  tab: LTab; selected: boolean; onSelect: () => void; drop: boolean; disabled: boolean; editing: boolean;
  onRename: (n: string) => void; onDoneEditing: () => void; onStartEditing: () => void;
}) {
  const t = useT();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: `t:${tab.key}`, disabled: disabled || editing });
  const [draft, setDraft] = useState(tab.name);
  useEffect(() => setDraft(tab.name), [tab.name, editing]);
  const style = { transform: CSS.Translate.toString(transform), transition, opacity: isDragging ? 0.4 : 1 };
  if (editing) {
    return (
      <input
        ref={(el) => el?.focus()}
        aria-label={t('tabName')}
        className="input"
        style={{ height: 38, width: Math.max(120, draft.length * 9 + 40) }}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { onRename(draft.trim() || tab.name); onDoneEditing(); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { onRename(draft.trim() || tab.name); onDoneEditing(); }
          if (e.key === 'Escape') { e.stopPropagation(); onDoneEditing(); }
        }}
      />
    );
  }
  return (
    <button
      ref={setNodeRef}
      type="button"
      {...attributes}
      role="tab"
      aria-selected={selected}
      className={clsx('tab', drop && 'drop-target')}
      style={style}
      onClick={onSelect}
      onDoubleClick={onStartEditing}
      {...listeners}
    >
      {selected && <motion.span layoutId="tab-bg" className="tab-bg" transition={spring} />}
      <Morph text={tab.name} />
      <span className="n"><Num value={tab.fieldIds.length} /></span>
    </button>
  );
}

function RemoveTab({ n, onConfirm }: { n: number; onConfirm: () => void }) {
  const t = useT();
  const [ask, setAsk] = useState(false);
  if (!ask) return <Btn variant="ghost" size="xs" icon={<Trash2 size={14} />} onClick={() => (n ? setAsk(true) : onConfirm())}>{t('removeTab')}</Btn>;
  return (
    <motion.span className="row" initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }}>
      <span className="small">{t(n === 1 ? 'removeTabFields1' : 'removeTabFields', { n })}</span>
      <Btn variant="danger" size="xs" onClick={() => { setAsk(false); onConfirm(); }}>{t('removeTab')}</Btn>
      <Btn variant="ghost" size="xs" onClick={() => setAsk(false)}>{t('cancel')}</Btn>
    </motion.span>
  );
}

function FieldList({ ids, fields, editable, originalIds, missing, fsExclusive, onRemove }: {
  ids: string[]; fields: Record<string, Field>; editable: boolean; originalIds: Set<string>; missing: Set<string>; fsExclusive: boolean; onRemove: (id: string) => void;
}) {
  const t = useT();
  const { setNodeRef, isOver } = useDroppable({ id: 'list', disabled: !editable });
  return (
    <SortableContext items={ids.map((f) => `f:${f}`)} strategy={verticalListSortingStrategy}>
      <div ref={setNodeRef} className="field-list" style={isOver ? { background: 'var(--tint)' } : undefined}>
        <AnimatePresence initial={false}>
          {ids.map((f) => (
            <SortableField key={f} f={fields[f] ?? { id: f, name: f, type: '', system: false }} editable={editable}
              isNew={!originalIds.has(f)} missing={missing.has(f)} fsExclusive={fsExclusive} onRemove={() => onRemove(f)} />
          ))}
        </AnimatePresence>
        {ids.length === 0 && <motion.div className="field-empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>{t('emptyTab')}</motion.div>}
      </div>
    </SortableContext>
  );
}

function SortableField({ f, editable, isNew, missing, fsExclusive, onRemove }: { f: Field; editable: boolean; isNew: boolean; missing: boolean; fsExclusive: boolean; onRemove: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: `f:${f.id}`, disabled: !editable });
  return (
    <motion.div
      ref={setNodeRef}
      layout={!transform}
      initial={{ opacity: 0, height: 0, scale: 0.96 }}
      animate={{ opacity: 1, height: 'auto', scale: 1 }}
      exit={{ opacity: 0, height: 0, scale: 0.96, transition: { duration: 0.2 } }}
      transition={{ ...spring, opacity: { duration: 0.2 } }}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      <FieldCard f={f} dragging={isDragging} isNew={isNew} missing={missing} fsExclusive={fsExclusive} handle={editable ? { ...attributes, ...listeners } : undefined} onRemove={editable ? onRemove : undefined} />
    </motion.div>
  );
}

function FieldCard({ f, overlay, dragging, isNew, missing, fsExclusive, handle, onRemove }: {
  f: Field; overlay?: boolean; dragging?: boolean; isNew?: boolean; missing?: boolean; fsExclusive?: boolean; handle?: object; onRemove?: () => void;
}) {
  const t = useT();
  return (
    <div className={clsx('field', overlay && 'overlay', dragging && 'dragging', isNew && 'is-new')}>
      <button type="button" className="grip" aria-label={`Move ${f.name}`} {...(handle ?? {})} disabled={!handle && !overlay}><GripVertical size={16} /></button>
      <div className="col grow" style={{ minWidth: 0 }}>
        <div className="row wrap" style={{ gap: 8 }}>
          <span className="field-name">{f.name}</span>
          {isNew && <span className="pill pill-solid">{t('newBadge')}</span>}
        </div>
        <span className="field-meta ellipsis">
          {f.id} · {f.type}{f.locked ? ` · ${t('required')}` : ''}
          {isNew && missing && <> · <span style={{ color: fsExclusive ? 'var(--accent)' : 'var(--danger)' }}>{fsExclusive ? t('willAddToScheme') : t('notInFieldScheme')}</span></>}
        </span>
      </div>
      {f.locked ? (
        <span className="xs muted row" style={{ gap: 4 }}><Lock size={12} />{t('cannotRemove')}</span>
      ) : onRemove ? (
        <button type="button" className="btn btn-ghost btn-xs btn-icon" aria-label={`${t('removeField')}: ${f.name}`} onClick={onRemove}><X size={16} /></button>
      ) : null}
    </div>
  );
}

function FieldPalette({ fields, onScreen, inScheme, onAdd }: { fields: Record<string, Field>; onScreen: Map<string, string>; inScheme: Set<string>; onAdd: (id: string) => void }) {
  const t = useT();
  const [q, setQ] = useState('');
  // Sites have hundreds of fields: filter on a deferred value and render a bounded window
  const dq = useDeferredValue(q.trim().toLowerCase());
  const all = useMemo(() => Object.values(fields)
    .filter((f) => !dq || f.name.toLowerCase().includes(dq) || f.id.toLowerCase().includes(dq))
    .sort((a, b) => Number(onScreen.has(a.id)) - Number(onScreen.has(b.id)) || a.name.localeCompare(b.name)), [fields, dq, onScreen]);
  const list = all.slice(0, 40);
  return (
    <section className="panel" aria-label={t('addField')}>
      <h2 className="eyebrow">{t('addField')}</h2>
      <div className="input-wrap">
        <Search size={16} />
        <input className="input" placeholder={t('findField')} aria-label={t('findField')} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="palette-list">
        <AnimatePresence initial={false}>
          {list.map((f) => <PaletteField key={f.id} f={f} on={onScreen.get(f.id)} inScheme={f.system || inScheme.has(f.id)} onAdd={() => onAdd(f.id)} />)}
        </AnimatePresence>
        {all.length > list.length && <p className="xs muted" style={{ padding: '6px 4px' }}>{t('moreFields', { n: all.length - list.length })}</p>}
      </div>
    </section>
  );
}

function PaletteField({ f, on, inScheme, onAdd }: { f: Field; on?: string; inScheme: boolean; onAdd: () => void }) {
  const t = useT();
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `p:${f.id}`, disabled: !!on });
  return (
    <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: isDragging ? 0.4 : 1, y: 0 }} exit={{ opacity: 0, transition: { duration: 0.1 } }} transition={{ duration: 0.18 }}>
      {/* The row is a pointer target only; the accessible drag handle and the + button are separate controls (no nested interactives) */}
      <div ref={setNodeRef} className={clsx('pfield', on && 'disabled')} {...(on ? {} : listeners)} onClick={on ? undefined : onAdd} style={{ cursor: on ? 'default' : 'pointer' }}>
        <button type="button" className="grip" style={{ width: 22, height: 28 }} aria-label={`Drag ${f.name}`} disabled={!!on} {...(on ? {} : { ...attributes, ...listeners })} onClick={(e) => e.stopPropagation()}><GripVertical size={14} /></button>
        <div className="col" style={{ minWidth: 0 }}>
          <span className="field-name ellipsis" style={{ fontSize: 13.5 }}>{f.name}</span>
          <span className="field-meta ellipsis">{f.type} · {on ? t('alreadyOn', { tab: on }) : inScheme ? t('inFieldScheme') : t('notInFieldScheme')}</span>
        </div>
        {on ? <Check size={16} className="plus muted" /> : (
          <button type="button" className="btn btn-quiet btn-xs btn-icon plus" aria-label={`${t('addField')}: ${f.name}`} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onAdd(); }}><Plus size={15} /></button>
        )}
      </div>
    </motion.div>
  );
}

