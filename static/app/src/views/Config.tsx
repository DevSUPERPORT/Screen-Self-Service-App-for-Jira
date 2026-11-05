/**
 * Jira admin configuration page (UC-10): automatic deletion of unused screens and its waiting period, audit
 * log retention, which projects may use the app, and cross-project copying. Input is checked in the UI and
 * saved through the gateway; the backend enforces Jira admin rights on every call.
 *
 * @file        static/app/src/views/Config.tsx
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { Lock, Minus, Plus } from 'lucide-react';
import type { AppConfig } from '@shared/types';
import { gateway } from '../api/gateway';
import { useStore } from '../store';
import { useT } from '../i18n';
import { Btn, Segmented, Switch, easeOut, spring } from '../ui';

const PROJECT_KEY = /^[A-Z][A-Z0-9_]{0,19}$/;

/** UC-10 — Jira admins only (the backend enforces this on every call). */
export function Config() {
  const t = useT();
  const toast = useStore((s) => s.toast);
  const [saved, setSaved] = useState<AppConfig | null>(null);
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [keysText, setKeysText] = useState('');
  useEffect(() => { gateway.loadConfig().then((c) => { setSaved(c); setCfg(c); setKeysText(c.projects.join(', ')); }).catch((e) => toast('error', e.message)); }, [toast]);
  // project keys typed as free text: "proj, SUP hr" → ['PROJ', 'SUP', 'HR']
  const tokens = [...new Set(keysText.split(/[\s,;]+/).map((k) => k.trim().toUpperCase()).filter(Boolean))];
  const keys = tokens.filter((k) => PROJECT_KEY.test(k));
  const badKeys = tokens.filter((k) => !PROJECT_KEY.test(k));
  if (!cfg || !saved) return <div className="col" style={{ gap: 16 }}>{[0, 1].map((i) => <div key={i} className="skeleton" style={{ height: 180 }} />)}</div>;
  const next: AppConfig = { ...cfg, projects: [...keys].sort() };
  const dirty = JSON.stringify(next) !== JSON.stringify(saved);
  const setDays = (d: number) => setCfg({ ...cfg, days: Math.max(1, Math.min(365, d)) });
  const save = async () => {
    setBusy(true);
    try { const c = await gateway.saveConfig(next); setSaved(c); setCfg(c); setKeysText(c.projects.join(', ')); toast('ok', t('cfgSaved')); } catch (e) { toast('error', (e as Error).message); }
    setBusy(false);
  };
  return (
    <div className="col" style={{ gap: 20, maxWidth: 820 }}>
      <motion.section className="card card-pad col" style={{ gap: 18 }} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
        <div className="row" style={{ alignItems: 'flex-start', gap: 20 }}>
          <div className="col grow" style={{ gap: 4 }}>
            <h2 className="card-title">{t('cfgAutoTitle')}</h2>
            <p className="small muted">{t('cfgAutoBody')}</p>
          </div>
          <span className="row"><span className="small">{t('cfgActive')}</span><Switch on={cfg.autoDelete} label={t('cfgActive')} onChange={(v) => setCfg({ ...cfg, autoDelete: v })} /></span>
        </div>
        <motion.div className="row wrap" style={{ gap: 14 }} animate={{ opacity: cfg.autoDelete ? 1 : 0.4 }} transition={{ duration: 0.3 }}>
          <span>{t('cfgAfter')}</span>
          <div className="stepper">
            <button type="button" aria-label="−" disabled={!cfg.autoDelete} onClick={() => setDays(cfg.days - 1)}><Minus size={16} /></button>
            <span className="num" aria-live="polite">
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span key={cfg.days} initial={{ y: 18, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -18, opacity: 0 }} transition={spring}>{cfg.days}</motion.span>
              </AnimatePresence>
            </span>
            <button type="button" aria-label="+" disabled={!cfg.autoDelete} onClick={() => setDays(cfg.days + 1)}><Plus size={16} /></button>
          </div>
          <span>{t('cfgDaysUnused')}</span>
          <span className="row" style={{ gap: 6 }}>
            {[14, 30, 60, 90].map((d) => <button key={d} type="button" className="pill" disabled={!cfg.autoDelete} style={{ border: 0, cursor: 'pointer', background: cfg.days === d ? 'var(--accent-soft)' : undefined }} onClick={() => setDays(d)}>{d}</button>)}
          </span>
        </motion.div>
        <p className="xs muted">{t('cfgDefault')}</p>
      </motion.section>

      <motion.section className="card card-pad col" style={{ gap: 16 }} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.06 }}>
        <div className="col" style={{ gap: 4 }}>
          <h2 className="card-title">{t('cfgRetention')}</h2>
          <p className="small muted">{t('cfgRetentionBody')}</p>
        </div>
        <div className="row wrap" style={{ gap: 14 }}>
          <span>{t('cfgRetentionAfter')}</span>
          <Segmented value={String(cfg.auditRetentionMonths)} label={t('cfgRetention')} onChange={(v) => setCfg({ ...cfg, auditRetentionMonths: Number(v) as AppConfig['auditRetentionMonths'] })}
            options={[{ value: '0', label: t('cfgNever') }, ...[12, 24, 36].map((n) => ({ value: String(n), label: t('cfgMonths', { n }) }))]} />
        </div>
      </motion.section>

      <motion.section className="card card-pad col" style={{ gap: 16 }} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.09 }}>
        <div className="col" style={{ gap: 4 }}>
          <h2 className="card-title">{t('cfgAccess')}</h2>
          <p className="small muted">{t('cfgAccessBody')}</p>
        </div>
        <Segmented value={cfg.projectAccess} label={t('cfgAccess')} onChange={(v) => setCfg({ ...cfg, projectAccess: v as AppConfig['projectAccess'] })}
          options={[{ value: 'all', label: t('cfgAccessAll') }, { value: 'selected', label: t('cfgAccessSelected') }]} />
        <AnimatePresence initial={false}>
          {cfg.projectAccess === 'selected' && (
            <motion.div className="col" style={{ gap: 6, overflow: 'hidden' }} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.3, ease: easeOut }}>
              <label className="label" htmlFor="cfg-projects" style={{ margin: 0 }}>{t('cfgAccessLabel')}</label>
              <input id="cfg-projects" className="input" value={keysText} placeholder={t('cfgAccessPlaceholder')} autoComplete="off" spellCheck={false}
                onChange={(e) => setKeysText(e.target.value)}
                aria-invalid={badKeys.length > 0} aria-describedby="cfg-projects-hint" />
              <p id="cfg-projects-hint" className={`xs ${badKeys.length ? '' : 'muted'}`} style={badKeys.length ? { color: 'var(--danger)' } : undefined}>
                {badKeys.length ? t('cfgAccessInvalid', { keys: badKeys.join(', ') }) : keys.length ? keys.join(' · ') : t('cfgAccessNone')}
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.section>

      <motion.section className="card card-pad col" style={{ gap: 14 }} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.12 }}>
        <div className="row" style={{ alignItems: 'flex-start', gap: 20 }}>
          <div className="col grow" style={{ gap: 4 }}>
            <h2 className="card-title">{t('cfgCrossCopy')}</h2>
            <p className="small muted">{t('cfgCrossCopyBody')}</p>
          </div>
          <Switch on={cfg.crossProjectCopy} label={t('cfgCrossCopy')} onChange={(v) => setCfg({ ...cfg, crossProjectCopy: v })} />
        </div>
      </motion.section>

      <motion.section className="card card-pad col" style={{ gap: 14 }} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}>
        <div className="col" style={{ gap: 4 }}>
          <h2 className="card-title">{t('cfgShared')}</h2>
          <p className="small muted">{t('cfgSharedBody')}</p>
        </div>
        <div className="row wrap">
          <span className="pill pill-accent" style={{ padding: '8px 14px', fontSize: 14 }}><Lock size={14} />{t('cfgLock')}</span>
        </div>
      </motion.section>

      <AnimatePresence>
        {dirty && (
          <motion.div className="savebar" initial={{ y: 100, x: '-50%', opacity: 0 }} animate={{ y: 0, x: '-50%', opacity: 1 }} exit={{ y: 100, x: '-50%', opacity: 0 }} transition={{ ...spring }}>
            <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3, ease: easeOut }}>{t('unsavedMany')}</motion.span>
            <Btn variant="ghost" size="sm" onClick={() => { setCfg(saved); setKeysText(saved.projects.join(', ')); }}>{t('discard')}</Btn>
            <Btn variant="primary" size="sm" loading={busy} disabled={badKeys.length > 0} onClick={save}>{t('save')}</Btn>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
