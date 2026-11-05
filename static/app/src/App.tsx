/**
 * Root component of the Custom UI. Boots the store, applies the light or dark theme, renders the header,
 * the project or admin navigation and the active page, and wires the Cmd/Ctrl+K palette and Cmd/Ctrl+Z undo
 * shortcuts; it also shows the launch sequence, environment notices, maintenance states and the global
 * overlays.
 *
 * @file        static/app/src/App.tsx
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import { AnimatePresence, LayoutGroup, MotionConfig, motion } from 'framer-motion';
import { useShallow } from 'zustand/react/shallow';
import { useEffect, useMemo } from 'react';
import { Command, Copy, Plus, Sparkles, Undo2 } from 'lucide-react';
import { healthChecks } from '@shared/bulk';
import { askRovo, inForge } from './api/gateway';
import { useStore, type Page } from './store';
import { useT, type Key } from './i18n';
import { Btn, Logo, MOD, spring, easeOut } from './ui';
import { Launch } from './views/Launch';
import { Overview } from './views/Overview';
import { Transitions } from './views/Transitions';
import { Unused } from './views/Unused';
import { Audit } from './views/Audit';
import { Config } from './views/Config';
import { Overlays } from './views/Overlays';
import { Palette } from './views/Palette';
import { Toasts } from './views/Toasts';
import { EnvNotice } from './views/EnvNotice';
import { Health } from './views/Health';
import { Maintenance, ReadonlyBanner, Unlicensed } from './views/Maintenance';

const PAGES: { id: Page; label: Key }[] = [
  { id: 'types', label: 'navTypes' },
  { id: 'health', label: 'navHealth' },
  { id: 'transitions', label: 'navTransitions' },
  { id: 'unused', label: 'navUnused' },
  { id: 'audit', label: 'navAudit' },
];

export function App() {
  const t = useT();
  const { status, model, page, go, mode, dark, setPalette, open, error, introDone } = useStore(useShallow((s) => ({ status: s.status, model: s.model, page: s.page, go: s.go, mode: s.mode, dark: s.dark, setPalette: s.setPalette, open: s.open, error: s.error, introDone: s.introDone })));

  useEffect(() => { void useStore.getState().boot(); }, []);
  useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; }, [dark]);
  // Each page starts at the top (pages differ a lot in height)
  useEffect(() => {
    window.scrollTo({ top: 0 });
    // Inside Jira the iframe grows with its content and the host page scrolls — bring the header back into view
    const h = document.querySelector('.shell-header');
    h?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [page]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(!useStore.getState().palette); }
      // ⌘Z undoes the last change — but never steals undo from a text field
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && !typing && !useStore.getState().overlay) { e.preventDefault(); void useStore.getState().undo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setPalette]);

  const admin = mode === 'admin';
  const pages = admin ? [{ id: 'config' as Page, label: 'navConfig' as Key }, { id: 'audit' as Page, label: 'navAudit' as Key }] : PAGES;
  const ready = introDone && status === 'ready' && (admin || model);
  const blocked = model?.environmentIssue;
  // problems worth a look (errors and warnings; info-level items show on the page itself)
  const problems = useMemo(() => (model && !admin ? healthChecks(model).filter((c) => c.severity !== 'info').reduce((n, c) => n + c.items.length, 0) : 0), [model, admin]);
  const undoing = useStore((s) => s.undoing);
  const maintenance = useStore((s) => s.maintenance);

  return (
    <MotionConfig reducedMotion="user" transition={spring}>
      <AnimatePresence>{!introDone && <Launch key="launch" />}</AnimatePresence>
      {status === 'error' && (
        <div className="empty" style={{ minHeight: '80vh', justifyContent: 'center' }}>
          <h1 className="h1">{t('errorTitle')}</h1>
          <p className="muted" style={{ maxWidth: 520 }}>{error}</p>
          <Btn variant="primary" onClick={() => location.reload()}>{t('retry')}</Btn>
        </div>
      )}
      {introDone && status === 'unavailable' && <Maintenance />}
      {introDone && status === 'unlicensed' && <Unlicensed />}
      {ready && blocked && <EnvNotice issue={blocked} />}
      {ready && !blocked && (
        <LayoutGroup>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5 }}>
            <header className="shell-header">
              <div className="container">
                <div className="header-top">
                  <motion.div className="brand" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: easeOut }}>
                    <div className="brand-mark"><Logo /></div>
                    <div className="col" style={{ gap: 2, minWidth: 0 }}>
                      <div className="eyebrow" style={{ fontWeight: 400 }}>{admin ? t('adminEyebrow') : t('appName')}</div>
                      <h1 className="h1 ellipsis">{admin ? t('adminTitle') : t('screensIn', { key: model!.project.key })}</h1>
                    </div>
                  </motion.div>
                  <motion.div className="header-actions" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: easeOut, delay: 0.08 }}>
                    <Btn variant="ghost" size="sm" onClick={() => setPalette(true)} aria-label={t('search')} icon={<Command size={16} />}>
                      <span className="lbl muted">{t('search')}</span><span className="kbd lbl">{MOD}K</span>
                    </Btn>
                    {!admin && (
                      <>
                        <AnimatePresence>
                          {model?.lastChange && (
                            <motion.span key="undo" initial={{ opacity: 0, scale: 0.8, width: 0 }} animate={{ opacity: 1, scale: 1, width: 'auto' }} exit={{ opacity: 0, scale: 0.8, width: 0 }} transition={spring} style={{ display: 'inline-flex', overflow: 'hidden' }}>
                              <Btn variant="ghost" size="sm" icon={<Undo2 size={16} />} disabled={undoing} title={t('undoLast', { label: model.lastChange.label })} aria-label={t('undoLast', { label: model.lastChange.label })} onClick={() => void useStore.getState().undo()}><span className="lbl">{undoing ? t('undoing') : t('undo')}</span></Btn>
                            </motion.span>
                          )}
                        </AnimatePresence>
                        {inForge && <Btn variant="ghost" size="sm" icon={<Sparkles size={16} />} onClick={async () => { if (!(await askRovo())) useStore.getState().toast('info', t('rovoUnavailable')); }}><span className="lbl">{t('rovoHint')}</span></Btn>}
                        <Btn variant="dark" icon={<Copy size={18} />} onClick={() => open({ type: 'copy' })}><span className="lbl">{t('copyScreen')}</span></Btn>
                        <Btn variant="primary" icon={<Plus size={18} />} onClick={() => open({ type: 'new' })}><span className="lbl">{t('newScreen')}</span></Btn>
                      </>
                    )}
                  </motion.div>
                </div>
                <nav className="nav" aria-label={t('sections')}>
                  {pages.map((p) => (
                    <button key={p.id} type="button" className="nav-link" aria-current={page === p.id ? 'page' : undefined} onClick={() => go(p.id)}>
                      {t(p.label)}
                      {p.id === 'health' && problems > 0 && (
                        <motion.span key={problems} className="count count-warn" initial={{ scale: 1.5 }} animate={{ scale: 1 }} transition={spring}>{problems}</motion.span>
                      )}
                      {p.id === 'unused' && model && model.unused.length > 0 && (
                        <motion.span key={model.unused.length} className="count" initial={{ scale: 1.5 }} animate={{ scale: 1 }} transition={spring}>{model.unused.length}</motion.span>
                      )}
                      {page === p.id && <motion.span layoutId="nav-underline" className="nav-underline" transition={spring} />}
                    </button>
                  ))}
                </nav>
              </div>
            </header>

            <div className="container">
              <AnimatePresence mode="wait" initial={false}>
                <motion.main
                  key={page}
                  className="main"
                  initial={{ opacity: 0, y: 14 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.32, ease: easeOut }}
                >
                  {maintenance === 'readonly' && <ReadonlyBanner />}
                  {page === 'types' && <Overview />}
                  {page === 'health' && <Health />}
                  {page === 'transitions' && <Transitions />}
                  {page === 'unused' && <Unused />}
                  {page === 'audit' && <Audit />}
                  {page === 'config' && <Config />}
                </motion.main>
              </AnimatePresence>
            </div>
            <footer className="container footer">
              <span className="dot" />
              <span>{t('madeBy')}</span>
            </footer>
          </motion.div>
          {!admin && <Overlays />}
        </LayoutGroup>
      )}
      <Palette />
      <Toasts />
    </MotionConfig>
  );
}
