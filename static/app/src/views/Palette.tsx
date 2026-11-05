/**
 * Cmd/Ctrl+K command palette: searches screens, pages and actions (copy, new, bulk, undo, assignment
 * changes, Rovo prompts) and runs the chosen one without leaving the keyboard.
 *
 * @file        static/app/src/views/Palette.tsx
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import { AnimatePresence, motion } from 'framer-motion';
import { useShallow } from 'zustand/react/shallow';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Activity, ArrowRight, Copy, FileStack, GitBranch, Languages, ListChecks, Lock, Moon, Plus, ScrollText, Search, Settings, Sparkles, Trash2, Undo2 } from 'lucide-react';
import { groupsOf, schemeExclusive, screenExclusive } from '@shared/domain';
import { askRovo } from '../api/gateway';
import { useStore } from '../store';
import { useLang, useT } from '../i18n';
import { Highlight, MOD, spring } from '../ui';

interface Item { id: string; group: string; label: string; hint?: string; icon: ReactNode; run: () => void }

/** ⌘K — jump to any screen or action without leaving the keyboard. */
export function Palette() {
  const t = useT();
  const { palette, setPalette, model: m, mode, go, open, toggleDark, toast } = useStore(useShallow((s) => ({ palette: s.palette, setPalette: s.setPalette, model: s.model, mode: s.mode, go: s.go, open: s.open, toggleDark: s.toggleDark, toast: s.toast })));
  const lang = useLang();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (palette) { setQ(''); setActive(0); } }, [palette]);

  const rovo = async (prompt: string) => { if (!(await askRovo(prompt))) toast('info', t('rovoUnavailable')); };

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    const A = t('palActions'), G = t('palGo'), S = t('palScreens'), R = 'Rovo';
    if (m && mode === 'project') {
      out.push(
        { id: 'copy', group: A, label: t('copyScreen'), icon: <Copy size={16} />, run: () => open({ type: 'copy' }) },
        { id: 'new', group: A, label: t('newScreen'), icon: <Plus size={16} />, run: () => open({ type: 'new' }) },
        { id: 'bulk', group: A, label: t('bulkOpen'), icon: <ListChecks size={16} />, run: () => open({ type: 'bulk' }) },
      );
      if (m.lastChange) out.unshift({ id: 'undo', group: A, label: t('undoLast', { label: m.lastChange.label }), hint: `${MOD}Z`, icon: <Undo2 size={16} />, run: () => void useStore.getState().undo() });
      for (const g of groupsOf(m)) {
        if (schemeExclusive(m, g.schemeId)) out.push({ id: `as-${g.schemeId}`, group: A, label: `${t('changeAssignment')} · ${g.title}`, icon: <GitBranch size={16} />, run: () => { go('types'); open({ type: 'assign', schemeId: g.schemeId }); } });
      }
      out.push(
        { id: 'g-types', group: G, label: t('navTypes'), icon: <ArrowRight size={16} />, run: () => go('types') },
        { id: 'g-health', group: G, label: t('navHealth'), icon: <Activity size={16} />, run: () => go('health') },
        { id: 'g-tr', group: G, label: t('navTransitions'), icon: <ArrowRight size={16} />, run: () => go('transitions') },
        { id: 'g-un', group: G, label: t('navUnused'), hint: String(m.unused.length), icon: <Trash2 size={16} />, run: () => go('unused') },
        { id: 'g-au', group: G, label: t('navAudit'), icon: <ScrollText size={16} />, run: () => go('audit') },
      );
      const firstType = groupsOf(m)[0]?.issueTypes[0]?.name ?? '';
      out.push(
        { id: 'r1', group: R, label: t('rovoQ1', { key: m.project.key }), icon: <Sparkles size={16} />, run: () => rovo(t('rovoQ1', { key: m.project.key })) },
        { id: 'r2', group: R, label: t('rovoQ2', { it: firstType }), icon: <Sparkles size={16} />, run: () => rovo(t('rovoQ2', { it: firstType })) },
        { id: 'r3', group: R, label: t('rovoQ3', { key: m.project.key }), icon: <Sparkles size={16} />, run: () => rovo(t('rovoQ3', { key: m.project.key })) },
      );
      const own = Object.values(m.screens).filter((s) => !s.foreign && (s.screenSchemeIds.length || s.workflowIds.length));
      for (const s of own) {
        const ed = screenExclusive(m, s.id);
        out.push({ id: `s-${s.id}`, group: S, label: s.name, hint: t('fieldsTabs', { f: s.fieldCount, t: s.tabCount }), icon: ed ? <FileStack size={16} /> : <Lock size={16} />, run: () => open(ed ? { type: 'editor', screenId: s.id } : { type: 'locked', screenId: s.id }) });
      }
    } else {
      out.push(
        { id: 'g-cfg', group: G, label: t('navConfig'), icon: <Settings size={16} />, run: () => go('config') },
        { id: 'g-au', group: G, label: t('navAudit'), icon: <ScrollText size={16} />, run: () => go('audit') },
      );
    }
    out.push(
      { id: 'theme', group: A, label: t('palTheme'), icon: <Moon size={16} />, run: toggleDark },
      { id: 'lang', group: A, label: t('palLang'), icon: <Languages size={16} />, run: () => lang.set(lang.lang === 'de' ? 'en' : 'de') },
    );
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m, mode, lang.lang]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return items.filter((i) => i.group !== t('palScreens')).concat(items.filter((i) => i.group === t('palScreens')).slice(0, 6));
    return items.filter((i) => i.label.toLowerCase().includes(s));
  }, [q, items, t]);

  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => { listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' }); }, [active]);

  const exec = (i: Item | undefined) => { if (!i) return; setPalette(false); setTimeout(i.run, 60); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, filtered.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    if (e.key === 'Enter') { e.preventDefault(); exec(filtered[active]); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setPalette(false); }
  };

  let lastGroup = '';
  return (
    <AnimatePresence>
      {palette && (
        <>
          <motion.div className="scrim" style={{ zIndex: 89 }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setPalette(false)} />
          <motion.div className="pal" role="dialog" aria-modal="true" aria-label={t('search')}
            initial={{ opacity: 0, y: -16, scale: 0.97, x: '-50%' }} animate={{ opacity: 1, y: 0, scale: 1, x: '-50%' }} exit={{ opacity: 0, y: -10, scale: 0.98, x: '-50%' }} transition={spring}>
            <div className="pal-input">
              <Search size={20} className="muted" />
              <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder={t('palPlaceholder')} aria-label={t('palPlaceholder')}
                role="combobox" aria-expanded="true" aria-controls="pal-list" aria-activedescendant={`pal-${active}`} />
              <span className="kbd">esc</span>
            </div>
            <div className="pal-list" id="pal-list" role="listbox" ref={listRef}>
              {filtered.length === 0 && <div className="empty muted small" style={{ padding: 32 }}>{t('palNoResults', { q })}</div>}
              {filtered.map((it, i) => {
                const head = it.group !== lastGroup ? it.group : null;
                lastGroup = it.group;
                return (
                  <div key={it.id}>
                    {head && <div className="menu-group" style={{ paddingTop: i ? 12 : 6 }}>{head}</div>}
                    <button type="button" id={`pal-${i}`} role="option" aria-selected={active === i} data-idx={i} data-active={active === i} className="pal-item"
                      onPointerMove={() => active !== i && setActive(i)} onClick={() => exec(it)}>
                      {active === i && <motion.span layoutId="pal-hl" className="pal-hl" transition={{ type: 'spring', stiffness: 600, damping: 45 }} />}
                      <span className="pal-ic">{it.icon}</span>
                      <span className="grow ellipsis"><Highlight text={it.label} q={q.trim()} /></span>
                      {it.hint && <span className="xs muted">{it.hint}</span>}
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="pal-foot"><span><span className="kbd">↑</span> <span className="kbd">↓</span> {t('palNavigate')}</span><span><span className="kbd">↵</span> {t('palOpen')}</span><span><span className="kbd">{MOD}K</span> {t('palToggle')}</span></div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
