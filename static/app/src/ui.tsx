/**
 * Shared building blocks and motion presets of the Custom UI: the pointer-following app logo, buttons,
 * drawers, segmented controls, switches, choice cards, the progress ring, the hold-to-confirm button, issue
 * type icons and search highlighting.
 *
 * @file        static/app/src/ui.tsx
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import { AnimatePresence, motion, useMotionValue, useSpring, useTransform, animate } from 'framer-motion';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Bookmark, Bug, CheckSquare, Layers, Loader2, X, Zap } from 'lucide-react';
import clsx from 'clsx';
import { useT } from './i18n';

export const spring = { type: 'spring', stiffness: 420, damping: 36, mass: 0.9 } as const;
export const softSpring = { type: 'spring', stiffness: 260, damping: 30 } as const;
export const easeOut = [0.16, 1, 0.3, 1] as const;
/** Modifier key label for shortcuts: ⌘ on Apple devices, Ctrl elsewhere */
export const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl+';

/** SUPERPORT mark. The pupil gently follows the pointer. */
/** The app icon (orange tile, screen with a field). The field drifts gently toward the pointer. */
export function Logo({ size = 44 }: { size?: number }) {
  const ref = useRef<SVGSVGElement>(null);
  const x = useSpring(0, { stiffness: 120, damping: 14 });
  const y = useSpring(0, { stiffness: 120, damping: 14 });
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      const d = Math.hypot(dx, dy) || 1;
      const k = Math.min(1, d / 400) * 60;
      x.set((dx / d) * k);
      y.set((dy / d) * k * 0.8);
    };
    window.addEventListener('pointermove', move);
    return () => window.removeEventListener('pointermove', move);
  }, [x, y]);
  return (
    <svg ref={ref} width={size} height={size} viewBox="0 0 1920 1920" aria-hidden="true" style={{ display: 'block' }}>
      <rect width="1920" height="1920" rx="420" fill="#E34B04" />
      <g fill="none" stroke="#fff" strokeWidth="82">
        <rect x="330" y="330" width="1260" height="1260" rx="210" />
        <path d="M330 660H1590" />
        <motion.rect x="570" y="930" width="780" height="360" rx="105" style={{ x, y }} />
      </g>
      <circle cx="510" cy="495" r="67" fill="#fff" />
    </svg>
  );
}

export function Btn({
  variant = 'quiet', size, loading, icon, children, className, ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'dark' | 'quiet' | 'ghost' | 'danger'; size?: 'sm' | 'xs'; loading?: boolean; icon?: ReactNode;
}) {
  return (
    <button type="button" className={clsx('btn', `btn-${variant}`, size && `btn-${size}`, className)} disabled={loading || rest.disabled} aria-busy={loading || undefined} {...rest}>
      <AnimatePresence mode="popLayout" initial={false}>
        {loading ? (
          <motion.span key="l" initial={{ opacity: 0, scale: 0.5 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.5 }} style={{ display: 'inline-flex' }}>
            <Loader2 size={16} className="spin" />
          </motion.span>
        ) : icon ? (
          <motion.span key="i" initial={{ opacity: 0, scale: 0.5 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.5 }} style={{ display: 'inline-flex' }}>{icon}</motion.span>
        ) : null}
      </AnimatePresence>
      {children}
    </button>
  );
}

/** Text that morphs (blur + slide) whenever its value changes — used for renames. */
export function Morph({ text, className }: { text: string; className?: string }) {
  return (
    <span className={className} style={{ display: 'inline-grid' }}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={text}
          initial={{ opacity: 0, y: 8, filter: 'blur(6px)' }}
          animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          exit={{ opacity: 0, y: -8, filter: 'blur(6px)' }}
          transition={{ duration: 0.45, ease: easeOut }}
          style={{ gridArea: '1/1' }}
        >
          {text}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

/** Rolling number (odometer feel). */
export function Num({ value }: { value: number }) {
  const mv = useMotionValue(value);
  const rounded = useTransform(mv, (v) => Math.round(v).toString());
  useEffect(() => { const c = animate(mv, value, { duration: 0.5, ease: easeOut }); return c.stop; }, [value, mv]);
  return <motion.span>{rounded}</motion.span>;
}

const IT_STYLE: Record<string, { bg: string; icon: ReactNode }> = {
  bug: { bg: '#D9442B', icon: <Bug size={11} strokeWidth={2.5} /> },
  story: { bg: '#5E8F3E', icon: <Bookmark size={10} strokeWidth={2.5} /> },
  epic: { bg: '#7A5AB5', icon: <Zap size={10} strokeWidth={2.5} /> },
  task: { bg: '#3A7BD5', icon: <CheckSquare size={10} strokeWidth={2.5} /> },
};
export function ItIcon({ name, url }: { name: string; url?: string }) {
  if (url) return <img src={url} alt="" width={16} height={16} style={{ borderRadius: 4 }} />;
  const n = name.toLowerCase();
  const s = Object.entries(IT_STYLE).find(([k]) => n.includes(k) || (k === 'task' && n.includes('aufgabe')))?.[1] ?? { bg: '#6B6860', icon: <Layers size={10} strokeWidth={2.5} /> };
  return <span className="it-icon" style={{ background: s.bg }} aria-hidden="true">{s.icon}</span>;
}

export function Drawer({ open, onClose, children, wide, label }: { open: boolean; onClose: () => void; children: ReactNode; wide?: boolean; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const mobile = typeof window !== 'undefined' && window.matchMedia('(max-width: 720px)').matches;
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
      if (e.key === 'Tab' && ref.current) {
        const f = ref.current.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', onKey, true);
    const t = setTimeout(() => ref.current?.querySelector<HTMLElement>('[data-autofocus], input, button:not(.drawer-close)')?.focus(), 260);
    return () => { window.removeEventListener('keydown', onKey, true); clearTimeout(t); prev?.focus?.(); };
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div className="scrim" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }} />
          <motion.div
            ref={ref}
            role="dialog"
            aria-modal="true"
            aria-label={label}
            className={clsx('drawer', wide && 'wide')}
            initial={mobile ? { y: '100%' } : { x: 60, opacity: 0, scale: 0.98 }}
            animate={mobile ? { y: 0 } : { x: 0, opacity: 1, scale: 1 }}
            exit={mobile ? { y: '100%' } : { x: 60, opacity: 0, scale: 0.98 }}
            transition={spring}
          >
            {children}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

export function DrawerHead({ eyebrow, title, onClose }: { eyebrow?: ReactNode; title: ReactNode; onClose: () => void }) {
  const t = useT();
  return (
    <div className="drawer-head">
      <div className="grow col" style={{ gap: 4 }}>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h2 className="drawer-title">{title}</h2>
      </div>
      <button type="button" className="btn btn-ghost btn-icon btn-sm drawer-close" onClick={onClose} aria-label={t('close')}><X size={18} /></button>
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; label: string }) {
  const id = useId();
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)}>
          {value === o.value && <motion.span layoutId={`seg-${id}`} className="seg-thumb" transition={spring} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className="switch" onClick={() => onChange(!on)}>
      <motion.span layout className="knob" transition={spring} />
    </button>
  );
}

export function Choice({ checked, onSelect, title, body, badge }: { checked: boolean; onSelect: () => void; title: ReactNode; body: ReactNode; badge?: ReactNode }) {
  return (
    <button type="button" role="radio" aria-checked={checked} className="choice" onClick={onSelect}>
      <span className="radio-dot">
        <AnimatePresence>{checked && <motion.i initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} transition={spring} />}</AnimatePresence>
      </span>
      <span className="col" style={{ gap: 2 }}>
        <span className="row wrap"><span style={{ fontWeight: 600 }}>{title}</span>{badge}</span>
        <span className="muted" style={{ fontSize: 14 }}>{body}</span>
      </span>
    </button>
  );
}

/** Countdown ring for scheduled deletions. */
export function Ring({ value, max, label }: { value: number; max: number; label: string }) {
  const r = 18, c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, value / max));
  const tone = pct < 0.25 ? 'var(--danger)' : 'var(--accent-bright)';
  return (
    <div className="ring" role="img" aria-label={label}>
      <svg width="44" height="44" viewBox="0 0 44 44" aria-hidden="true">
        <circle cx="22" cy="22" r={r} fill="none" stroke="var(--line)" strokeWidth="4" />
        <motion.circle cx="22" cy="22" r={r} fill="none" stroke={tone} strokeWidth="4" strokeLinecap="round" strokeDasharray={c}
          initial={{ strokeDashoffset: c }} animate={{ strokeDashoffset: c * (1 - pct) }} transition={{ duration: 1.1, ease: easeOut, delay: 0.15 }} />
      </svg>
      <span className="ring-n">{value}</span>
    </div>
  );
}

/**
 * Destructive confirmation that works for everyone:
 * - press and hold (pointer, Enter or Space) for `ms` — the fill shows progress, or
 * - a quick press arms the button ("click again"), a second press within 4 s confirms
 *   (no timed gesture required — WCAG 2.1.1 / 2.5.1 friendly).
 */
export function HoldButton({ onConfirm, children, armedLabel, ms = 1100, disabled }: { onConfirm: () => void; children: ReactNode; armedLabel: ReactNode; ms?: number; disabled?: boolean }) {
  const [holding, setHolding] = useState(false);
  const [armed, setArmed] = useState(false);
  const timer = useRef<number>();
  const disarm = useRef<number>();
  const fired = useRef(false);
  // a ref, not state: a quick click releases before React re-renders
  const down = useRef(false);
  useEffect(() => () => { window.clearTimeout(timer.current); window.clearTimeout(disarm.current); }, []);
  const confirm = () => { fired.current = true; down.current = false; setHolding(false); setArmed(false); window.clearTimeout(disarm.current); onConfirm(); };
  const start = () => {
    if (disabled) return;
    fired.current = false;
    down.current = true;
    setHolding(true);
    timer.current = window.setTimeout(confirm, ms);
  };
  const release = () => {
    if (!down.current) return;
    down.current = false;
    window.clearTimeout(timer.current);
    setHolding(false);
    if (fired.current) return;
    // short press: arm, or confirm when already armed
    if (armed) { confirm(); return; }
    setArmed(true);
    window.clearTimeout(disarm.current);
    disarm.current = window.setTimeout(() => setArmed(false), 4000);
  };
  const cancel = () => { down.current = false; window.clearTimeout(timer.current); setHolding(false); };
  return (
    <button
      type="button"
      className={clsx('btn btn-quiet btn-sm hold', (holding || armed) && 'holding')}
      disabled={disabled}
      aria-live="polite"
      onPointerDown={start} onPointerUp={release} onPointerLeave={cancel} onPointerCancel={cancel}
      onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); start(); } }}
      onKeyUp={(e) => { if (e.key === 'Enter' || e.key === ' ') release(); }}
    >
      <motion.span className="hold-fill" initial={false} animate={{ scaleX: holding || armed ? 1 : 0 }} transition={holding ? { duration: ms / 1000, ease: 'linear' } : { duration: 0.25 }} />
      {/* both labels share one grid cell, so the button is always as wide as the longer one and never clips */}
      <span className="hold-labels">
        <span style={{ visibility: armed ? 'hidden' : 'visible' }}>{children}</span>
        <span style={{ visibility: armed ? 'visible' : 'hidden' }} aria-hidden={!armed}>{armedLabel}</span>
      </span>
    </button>
  );
}

/** Pointer-follow glow for cards. */
export function useGlow() {
  return {
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      const r = e.currentTarget.getBoundingClientRect();
      e.currentTarget.style.setProperty('--mx', `${e.clientX - r.left}px`);
      e.currentTarget.style.setProperty('--my', `${e.clientY - r.top}px`);
    },
  };
}

export function Highlight({ text, q }: { text: string; q: string }) {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return <>{text}</>;
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>;
}

export const stagger = (i: number, base = 0.04) => ({ delay: Math.min(i * base, 0.4) });
