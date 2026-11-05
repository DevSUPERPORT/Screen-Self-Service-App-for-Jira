/**
 * Audit log page: loads the app's audit entries through the gateway, filters them by free text, and groups
 * them by day with expandable before and after details.
 *
 * @file        static/app/src/views/Audit.tsx
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import type { AuditEntry } from '@shared/types';
import { gateway } from '../api/gateway';
import { useStore } from '../store';
import { useLang, useT } from '../i18n';
import { easeOut, spring } from '../ui';

export function Audit() {
  const t = useT();
  const lang = useLang((s) => s.lang);
  const loadedAt = useStore((s) => s.model?.loadedAt);
  const [items, setItems] = useState<AuditEntry[] | null>(null);
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => { gateway.audit().then(setItems).catch(() => setItems([])); }, [loadedAt]);

  const filtered = (items ?? []).filter((e) => !q || `${e.action} ${e.object} ${e.user.name} ${e.before ?? ''} ${e.after ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  const days = new Map<string, AuditEntry[]>();
  for (const e of filtered) {
    const d = new Date(e.at).toLocaleDateString(lang === 'de' ? 'de-DE' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    days.set(d, [...(days.get(d) ?? []), e]);
  }
  let idx = 0;
  return (
    <>
      <div className="input-wrap" style={{ maxWidth: 420 }}>
        <Search size={16} />
        <input className="input" placeholder={t('auditFilter')} aria-label={t('auditFilter')} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {!items && <div className="col" style={{ gap: 10 }}>{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 64 }} />)}</div>}
      {items && filtered.length === 0 && <div className="empty muted">{t('auditEmpty')}</div>}
      <div className="timeline">
        {[...days.entries()].map(([day, list]) => (
          <div key={day}>
            <div className="tl-day">{day}</div>
            {list.map((e) => {
              const i = idx++;
              const open = openId === e.id;
              return (
                <motion.div key={e.id} className="tl-item" initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.4, ease: easeOut, delay: Math.min(i * 0.04, 0.4) }}>
                  <span className="tl-dot"><i /></span>
                  <button type="button" className="tl-card" aria-expanded={open} onClick={() => setOpenId(open ? null : e.id)}>
                    <div className="row wrap" style={{ justifyContent: 'space-between' }}>
                      <span><strong style={{ fontWeight: 600 }}>{e.action}</strong> · {e.object}</span>
                      <span className="xs muted">{e.user.name} · {new Date(e.at).toLocaleTimeString(lang === 'de' ? 'de-DE' : 'en-GB', { hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                    <AnimatePresence initial={false}>
                      {open && (e.before || e.after) && (
                        <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={spring} style={{ overflow: 'hidden' }}>
                          <div className="diff">
                            <div className="b"><div className="xs muted">{t('before')}</div>{e.before ?? '—'}</div>
                            <div className="a"><div className="xs muted">{t('after')}</div>{e.after ?? '—'}</div>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </button>
                </motion.div>
              );
            })}
          </div>
        ))}
      </div>
    </>
  );
}
