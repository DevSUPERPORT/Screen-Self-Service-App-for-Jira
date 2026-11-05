/**
 * Central zustand store of the Custom UI: boot and reload through the gateway, page and overlay navigation,
 * toasts with Undo actions, and the run, saveLayout, saveLayouts, addToFieldScheme and undo actions that
 * send changes together with the digest of the previewed plan. It also honours the maintenance mode and
 * turns gateway errors into user-facing messages.
 *
 * @file        static/app/src/store.ts
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import { useRef } from 'react';
import { create } from 'zustand';
import type { Intent, LayoutSave, Op, ProjectModel } from '@shared/types';
import { planFor, RuleError } from '@shared/domain';
import { planDigest } from '@shared/digest';
import { gateway, GatewayError, type ExecResult, type LayoutResult, type Mode } from './api/gateway';
import { translate, useLang } from './i18n';

export type Page = 'types' | 'health' | 'transitions' | 'unused' | 'audit' | 'config';

export type Overlay =
  | { type: 'editor'; screenId: string; origin?: { x: number; y: number; w: number; h: number } }
  | { type: 'assign'; schemeId: string; prefill?: { op: Op; screenId: string } }
  | { type: 'copy'; issueTypeId?: string; op?: Op; templateId?: string }
  | { type: 'new'; issueTypeId?: string; op?: Op }
  | { type: 'split'; schemeId: string }
  | { type: 'merge'; schemeId: string }
  | { type: 'locked'; screenId: string }
  | { type: 'transitionAssign'; screenId: string }
  | { type: 'bulk'; screenIds?: string[]; fieldIds?: string[]; action?: 'add' | 'remove' };

export interface Toast { id: number; tone: 'ok' | 'error' | 'info'; text: string; action?: { label: string; run: () => void } }

interface State {
  mode: Mode;
  /** 'unlicensed': paid app without an active Marketplace license on this site */
  status: 'booting' | 'ready' | 'error' | 'unavailable' | 'unlicensed';
  /** SUPERPORT's kill switch (server-side): 'readonly' pauses every change, 'on' takes the app down */
  maintenance: 'off' | 'readonly' | 'on';
  statusUrl: string;
  model: ProjectModel | null;
  error: string | null;
  page: Page;
  overlay: Overlay | null;
  toasts: Toast[];
  palette: boolean;
  dark: boolean;
  hoverScreen: string | null;
  /** ids changed by the last action → brief highlight */
  pulse: string[];
  introDone: boolean;
  boot(): Promise<void>;
  reload(): Promise<void>;
  go(p: Page): void;
  open(o: Overlay | null): void;
  toast(tone: Toast['tone'], text: string, action?: Toast['action']): void;
  dismiss(id: number): void;
  /** pause auto-dismiss while the pointer or focus is on the toasts, so an Undo button never vanishes mid-reach */
  holdToasts(on: boolean): void;
  setPalette(v: boolean): void;
  toggleDark(): void;
  setHover(id: string | null): void;
  /** label: what "Undo: …" will say afterwards */
  run(intent: Intent, okText?: string, opts?: { close?: boolean; model?: ProjectModel; label?: string }): Promise<ExecResult | null>;
  saveLayout(save: LayoutSave, label?: string): Promise<boolean>;
  saveLayouts(saves: LayoutSave[], label: string, okText?: string): Promise<LayoutResult[] | null>;
  addToFieldScheme(fieldIds: string[], label: string, okText?: string): Promise<boolean>;
  undoing: boolean;
  undo(): Promise<void>;
}

let toastSeq = 0;
const toastTimers = new Map<number, ReturnType<typeof setTimeout>>();
let toastsHeld = false;
const scheduleToast = (id: number, ms: number) => {
  clearTimeout(toastTimers.get(id));
  if (!toastsHeld) toastTimers.set(id, setTimeout(() => useStore.getState().dismiss(id), ms));
};
const tt = (k: Parameters<typeof translate>[1], v?: Record<string, string | number>) => translate(useLang.getState().lang, k, v);

function errorText(e: unknown) {
  if (e instanceof GatewayError) {
    if (e.code === 'conflict') return tt('conflict');
    if (e.code === 'denied') return tt('denied');
    if (e.code === 'unavailable') return tt('maintReadonlyToast');
    if (e.code === 'unlicensed') return tt('licTitle');
    return e.message;
  }
  if (e instanceof RuleError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

/** Read-only maintenance: say so instead of sending a change the server would refuse anyway. */
function pausedForMaintenance() {
  const s = useStore.getState();
  if (s.maintenance === 'off') return false;
  s.toast('info', tt('maintReadonlyToast'));
  return true;
}

export const useStore = create<State>((set, get) => ({
  mode: 'project',
  status: 'booting',
  model: null,
  error: null,
  maintenance: 'off',
  statusUrl: 'https://superapps.statuspage.io',
  page: 'types',
  overlay: null,
  toasts: [],
  palette: false,
  dark: matchMedia('(prefers-color-scheme: dark)').matches,
  hoverScreen: null,
  pulse: [],
  introDone: false,
  undoing: false,

  async boot() {
    try {
      const ctx = await gateway.context();
      if (ctx.locale) useLang.getState().set(ctx.locale.toLowerCase().startsWith('de') ? 'de' : 'en');
      set({ mode: ctx.mode, page: ctx.mode === 'admin' ? 'config' : 'types', dark: ctx.theme ? ctx.theme === 'dark' : get().dark });
      const av = await gateway.availability();
      set({ maintenance: av.mode, statusUrl: av.statusUrl });
      if (av.mode === 'on') { set({ status: 'unavailable' }); return; }
      if (ctx.mode === 'admin') { set({ status: 'ready' }); return; }
      const model = await gateway.load();
      set({ model, status: 'ready' });
    } catch (e) {
      if (e instanceof GatewayError && e.code === 'unavailable') { set({ status: 'unavailable', maintenance: 'on' }); return; }
      if (e instanceof GatewayError && e.code === 'unlicensed') { set({ status: 'unlicensed' }); return; }
      set({ status: 'error', error: errorText(e) });
    }
  },
  async reload() {
    try { set({ model: await gateway.load() }); } catch (e) { get().toast('error', errorText(e)); }
  },
  go: (page) => set({ page }),
  open: (overlay) => set({ overlay }),
  toast(tone, text, action) {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, tone, text, action }] }));
    // a toast with an Undo button stays a little longer so there is time to reach it
    scheduleToast(id, tone === 'error' ? 7000 : action ? 10000 : 4200);
  },
  dismiss: (id) => { clearTimeout(toastTimers.get(id)); toastTimers.delete(id); set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })); },
  holdToasts(on) {
    toastsHeld = on;
    if (on) { toastTimers.forEach((t) => clearTimeout(t)); toastTimers.clear(); }
    else get().toasts.forEach((t) => scheduleToast(t.id, t.action ? 5000 : 2500));
  },
  setPalette: (palette) => set({ palette }),
  toggleDark: () => set((s) => ({ dark: !s.dark })),
  setHover: (hoverScreen) => set({ hoverScreen }),

  async run(intent, okText, opts) {
    if (pausedForMaintenance()) return null;
    const m = get().model;
    if (!m) return null;
    try {
      // The digest of exactly what the user previewed — the backend re-plans on fresh state and must match
      const digest = planDigest(planFor(opts?.model ?? m, intent));
      const res = await gateway.execute(intent, digest, opts?.label);
      const touched = new Set<string>();
      for (const p of res.preview) touched.add(p.title);
      const pulse = [
        ...Object.values(res.model.screens).filter((s) => touched.has(s.name)).map((s) => s.id),
        ...Object.values(res.model.screenSchemes).filter((s) => touched.has(s.name)).map((s) => s.id),
      ];
      set(opts?.close ? { model: res.model, pulse, overlay: null } : { model: res.model, pulse });
      setTimeout(() => set({ pulse: [] }), 2400);
      if (okText) get().toast('ok', okText, undoAction(res.model));
      for (const w of res.warnings ?? []) get().toast('info', w);
      return res;
    } catch (e) {
      get().toast('error', errorText(e));
      if (e instanceof GatewayError && e.code === 'conflict') await get().reload();
      return null;
    }
  },

  async saveLayout(save, label) {
    if (pausedForMaintenance()) return false;
    const m = get().model;
    if (!m) return false;
    try {
      const model = await gateway.saveLayout(save, label);
      set({ model, pulse: [save.screenId] });
      setTimeout(() => set({ pulse: [] }), 2400);
      get().toast('ok', tt('saved'), undoAction(model));
      return true;
    } catch (e) {
      get().toast('error', errorText(e));
      if (e instanceof GatewayError && e.code === 'conflict') await get().reload();
      return false;
    }
  },

  async saveLayouts(saves, label, okText) {
    if (pausedForMaintenance()) return null;
    try {
      const { model, results } = await gateway.saveLayouts(saves, label);
      set({ model, pulse: results.filter((r) => r.ok).map((r) => r.screenId) });
      setTimeout(() => set({ pulse: [] }), 2400);
      const ok = results.filter((r) => r.ok).length;
      if (ok) get().toast(ok === results.length ? 'ok' : 'info', okText ?? (ok === results.length ? tt('bulkDoneAll', { n: ok }) : tt('bulkDone', { ok, n: results.length })), undoAction(model));
      else get().toast('error', results[0]?.message ?? tt('errorTitle'));
      return results;
    } catch (e) {
      get().toast('error', errorText(e));
      if (e instanceof GatewayError && e.code === 'conflict') await get().reload();
      return null;
    }
  },

  async addToFieldScheme(fieldIds, label, okText) {
    if (pausedForMaintenance()) return false;
    try {
      const { model } = await gateway.addToFieldScheme(fieldIds, label);
      set({ model });
      get().toast('ok', okText ?? tt('saved'), undoAction(model));
      return true;
    } catch (e) {
      get().toast('error', errorText(e));
      return false;
    }
  },

  async undo() {
    if (pausedForMaintenance()) return;
    const m = get().model;
    if (!m || get().undoing) return;
    if (!m.lastChange) { get().toast('info', tt('undoNothing')); return; }
    set({ undoing: true });
    try {
      const { model, label } = await gateway.undo();
      set({ model, overlay: null });
      get().toast('ok', tt('undone', { label }));
    } catch (e) {
      get().toast('error', errorText(e));
      await get().reload();
    } finally {
      set({ undoing: false });
    }
  },
}));

/** The toast button that undoes the change just made (only when the backend recorded one). */
function undoAction(model: ProjectModel): Toast['action'] {
  return model.lastChange ? { label: tt('undo'), run: () => void useStore.getState().undo() } : undefined;
}

export const useModel = () => useStore((s) => s.model!);

/** Model for drawers: frozen while the drawer animates out, so it never renders against post-change state. */
export function useDrawerModel() {
  const m = useStore((s) => s.model!);
  const open = useStore((s) => s.overlay);
  const ref = useRef(m);
  if (open) ref.current = m;
  return ref.current;
}
