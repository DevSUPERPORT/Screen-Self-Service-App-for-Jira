/**
 * Unused screens and screen schemes page: shows how long each item has been unused and whether
 * auto-deletion is on, and lets the admin delete items (schemes first) or jump back to reassign them.
 *
 * @file        static/app/src/views/Unused.tsx
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import { AnimatePresence, motion } from 'framer-motion';
import { useShallow } from 'zustand/react/shallow';
import { useState } from 'react';
import { CalendarClock, FileStack, Info, Layers, Sparkles } from 'lucide-react';
import { useModel, useStore } from '../store';
import { formatDate, useLang, useT } from '../i18n';
import { Btn, HoldButton, Ring, easeOut, spring } from '../ui';

const DAY = 86400000;

export function Unused() {
  const t = useT();
  const lang = useLang((s) => s.lang);
  const m = useModel();
  const { run, open } = useStore(useShallow((s) => ({ run: s.run, open: s.open })));
  const [busy, setBusy] = useState<string | null>(null);
  const { autoDelete, days } = m.config;
  // Schemes first: Jira only deletes a screen once no scheme contains it
  const items = [...m.unused].sort((a, b) => (a.kind === b.kind ? a.since.localeCompare(b.since) : a.kind === 'screenScheme' ? -1 : 1));
  const holderOf = (id: string) => Object.values(m.screenSchemes).find((sc) => Object.values(sc.screens).includes(id));

  const del = async (kind: 'screen' | 'screenScheme', id: string, name: string) => {
    setBusy(`${kind}-${id}`);
    await run({ type: 'delete', items: [{ kind, id }] }, t('unDeleted', { name }), { label: t('lbDelete', { name }) });
    setBusy(null);
  };
  const reassign = () => {
    // The overview is where screens get assigned again (Change assignment / Merge)
    useStore.getState().go('types');
    const first = Object.keys(m.screenSchemes).find((id) => Object.values(m.itss.mappings).includes(id) && m.screenSchemes[id].projects.every((p) => p === m.project.key) && m.screenSchemes[id].projectCount <= 1);
    if (first) setTimeout(() => open({ type: 'assign', schemeId: first }), 350);
  };

  return (
    <>
      <motion.div className={`hint ${autoDelete ? 'accent' : ''}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
        <CalendarClock size={18} />
        <span>{autoDelete ? t('autoDeleteOn', { d: days }) : t('autoDeleteOff')}</span>
      </motion.div>
      <div className="card" style={{ overflow: 'hidden' }}>
        <AnimatePresence mode="wait" initial={false}>
          {items.length === 0 ? (
            <motion.div key="empty" className="empty" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} transition={spring}>
              <motion.span className="pill pill-accent" style={{ padding: 12 }} initial={{ rotate: -30, scale: 0 }} animate={{ rotate: 0, scale: 1 }} transition={{ ...spring, delay: 0.1 }}><Sparkles size={22} /></motion.span>
              <h2 className="card-title">{t('unEmpty')}</h2>
              <p className="small muted" style={{ maxWidth: 420 }}>{t('unEmptyBody', { key: m.project.key })}</p>
            </motion.div>
          ) : (
            <motion.div key="list" className="table-wrap" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th scope="col">{t('unObject')}</th>
                    <th scope="col">{t('unSince')}</th>
                    <th scope="col">{t('unDeletion')}</th>
                    <th scope="col" style={{ textAlign: 'right' }}>{t('unActions')}</th>
                  </tr>
                </thead>
                <tbody>
                  <AnimatePresence initial={false}>
                    {items.map((u, i) => {
                      const age = Math.max(0, Math.floor((Date.now() - new Date(u.since).getTime()) / DAY));
                      const left = Math.max(0, days - age);
                      const delOn = new Date(new Date(u.since).getTime() + days * DAY).toISOString();
                      return (
                        <motion.tr key={`${u.kind}-${u.id}`} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, x: 60, filter: 'blur(4px)', transition: { duration: 0.35 } }} transition={{ duration: 0.4, ease: easeOut, delay: i * 0.05 }}>
                          <td>
                            <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
                              <span className="pill" style={{ padding: 7 }}>{u.kind === 'screen' ? <FileStack size={15} /> : <Layers size={15} />}</span>
                              <div className="col">
                                <span style={{ fontWeight: 600 }}>{u.name}</span>
                                <span className="xs muted">{u.kind === 'screen' ? t('kindScreen') : t('kindScheme')}{u.createdByApp ? ` · ${t('createdByApp')}` : ''}{u.kind === 'screen' && holderOf(u.id) ? ` · ${t('unInScheme', { name: holderOf(u.id)!.name })}` : ''}</span>
                              </div>
                            </div>
                          </td>
                          <td>
                            <div>{age === 0 ? t('unToday') : t(age === 1 ? 'unDays1' : 'unDays', { n: age })}</div>
                            <div className="xs muted">{t('unSinceDate', { d: formatDate(u.since, lang) })}</div>
                          </td>
                          <td>
                            {autoDelete && u.createdByApp ? (
                              <div className="row" style={{ gap: 12 }}>
                                <Ring value={left} max={days} label={`${left} / ${days}`} />
                                <span className="small">{t('unOn', { d: formatDate(delOn, lang) })}</span>
                              </div>
                            ) : <span className="small muted">{t('unManual')}</span>}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <span className="row" style={{ justifyContent: 'flex-end' }}>
                              <Btn size="sm" variant="ghost" onClick={reassign}>{t('unReassign')}</Btn>
                              {u.createdByApp
                                ? <HoldButton armedLabel={t('unConfirm')} disabled={busy === `${u.kind}-${u.id}`} onConfirm={() => del(u.kind, u.id, u.name)}>{busy === `${u.kind}-${u.id}` ? t('saving') : t('unHold')}</HoldButton>
                                : <span className="xs muted" style={{ maxWidth: 200, textAlign: 'right' }}>{t('unusedNotOurs')}</span>}
                            </span>
                          </td>
                        </motion.tr>
                      );
                    })}
                  </AnimatePresence>
                </tbody>
              </table>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <div className="hint"><Info size={18} /><span>{t('unHint', { key: m.project.key })}</span></div>
    </>
  );
}
