/**
 * Local demo gateway (outside Jira). Only loaded in development builds — see gateway.ts.
 *
 * @file        static/app/src/api/demoGateway.ts
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import type { LayoutSave, ProjectModel } from '@shared/types';
import { applySteps, clone, executionOrder, layoutChanges, missingFromFieldScheme, planFor } from '@shared/domain';
import { planDigest, tabsDigest } from '@shared/digest';
import { demoAudit, demoModel } from './demo';
import { GatewayError, type Gateway } from './gateway';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms + Math.random() * ms * 0.4));
let db = demoModel();
let auditLog = demoAudit();
// demo undo: a snapshot of the whole demo instance before the last change
let undoSnap: { db: ProjectModel; label: string } | null = null;
const remember = (label: string) => { undoSnap = { db: clone(db), label }; };
const withLast = (m: ProjectModel) => ({ ...m, lastChange: undoSnap ? { label: undoSnap.label, at: new Date().toISOString() } : null });

function log(action: string, object: string, before?: string, after?: string) {
  auditLog = [{ id: crypto.randomUUID(), at: new Date().toISOString(), user: { accountId: 'demo', name: 'Alex Demo' }, action, object, before, after }, ...auditLog];
}

export const demoGateway: Gateway = {
  live: false,
  async context() {
    const mode = new URLSearchParams(location.search).get('mode') === 'admin' ? 'admin' : 'project';
    return { mode };
  },
  // ?maintenance=readonly|on previews the kill-switch screens in the local demo
  async availability() {
    const v = new URLSearchParams(location.search).get('maintenance');
    return { mode: v === 'on' || v === 'readonly' ? v : 'off', statusUrl: 'https://superapps.statuspage.io' };
  },
  async load() { await wait(500); return withLast(clone(db)); },
  async loadScreen(id) { await wait(180); return clone(db.screens[id]); },
  async searchScreens(query, limit) {
    await wait(160);
    const q = query.trim().toLowerCase();
    const match = Object.values(db.screens).filter((s) => !q || s.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name));
    return { items: clone(match.slice(0, limit + 40)), total: match.length };
  },
  async execute(intent, digest, label) {
    await wait(650);
    const plan = planFor(db, intent);
    if (digest !== planDigest(plan)) throw new GatewayError('conflict', 'Changed since preview');
    remember(label ?? intent.type);
    const idMap: Record<string, string> = {};
    let seq = Math.max(...Object.keys(db.screens).map(Number).filter(Boolean)) + 1;
    for (const st of plan.steps) if (st.kind === 'createScreen' || st.kind === 'createScreenScheme') idMap[st.ref] = st.kind === 'createScreen' ? String(seq++) : `sc-${seq++}`;
    const steps = JSON.parse(JSON.stringify(executionOrder(plan.steps)).replace(/new-[a-z0-9-]+/g, (r) => idMap[r] ?? r));
    db = applySteps(db, steps);
    for (const st of plan.steps) {
      if (st.kind === 'renameScreen') log('Screen renamed', st.to, st.from, st.to);
      if (st.kind === 'createScreen') log('Screen created', st.name, undefined, st.copyFrom ? `copy of ${db.screens[st.copyFrom]?.name}` : 'empty');
      if (st.kind === 'updateScreenScheme') log('Assignment changed', db.screenSchemes[st.schemeId]?.name ?? st.schemeId);
      if (st.kind === 'mapIssueType') log('Issue type mapping changed', db.issueTypes.find((i) => i.id === st.issueTypeId)?.name ?? '', undefined, st.screenSchemeId ? db.screenSchemes[idMap[st.screenSchemeId] ?? st.screenSchemeId]?.name : 'default');
      if (st.kind === 'setTransitionScreen') log(st.screenId ? 'Transition screen assigned' : 'Transition screen removed', st.workflowId, undefined, st.transitionId);
      if (st.kind === 'deleteScreen' || st.kind === 'deleteScreenScheme') log('Deleted', st.name);
    }
    db.loadedAt = new Date().toISOString();
    return { model: withLast(clone(db)), idMap, preview: plan.preview };
  },
  async saveLayout(save, label) {
    await wait(700);
    remember(label ?? 'edit');
    applyDemoLayout(save);
    return withLast(clone(db));
  },
  async saveLayouts(saves, label) {
    await wait(900);
    remember(label ?? 'bulk');
    const results = saves.map((sv) => { try { applyDemoLayout(sv); return { screenId: sv.screenId, ok: true }; } catch (e) { return { screenId: sv.screenId, ok: false, code: (e as GatewayError).code, message: (e as Error).message }; } });
    return { model: withLast(clone(db)), results };
  },
  async addToFieldScheme(fieldIds, label) {
    await wait(500);
    remember(label ?? 'fields');
    if (db.fieldScheme) db.fieldScheme.fieldIds.push(...fieldIds.filter((f) => !db.fieldScheme!.fieldIds.includes(f)));
    return { model: withLast(clone(db)) };
  },
  async undo() {
    await wait(600);
    if (!undoSnap) throw new GatewayError('not-found', 'There is nothing to undo.');
    const { db: prev, label } = undoSnap;
    db = prev;
    undoSnap = null;
    log('Change undone', label);
    return { model: withLast(clone(db)), label };
  },
  async audit() { await wait(250); return clone(auditLog); },
  async loadConfig() { await wait(250); return clone(db.config); },
  async saveConfig(c) {
    await wait(500);
    log('Configuration changed', 'Auto-deletion', `${db.config.autoDelete ? 'on' : 'off'} · ${db.config.days}`, `${c.autoDelete ? 'on' : 'off'} · ${c.days}`);
    db.config = clone(c);
    return clone(db.config);
  },
};

function applyDemoLayout(save: LayoutSave) {
  {
    const s = db.screens[save.screenId];
    if (!s || s.foreign || !s.projects.every((p) => p === db.project.key)) throw new GatewayError('locked', 'Screen is shared');
    if (save.baseDigest && save.baseDigest !== tabsDigest(s.tabs ?? [])) throw new GatewayError('conflict', 'Changed elsewhere');
    const n = layoutChanges(s.tabs ?? [], save.tabs);
    const all = save.tabs.flatMap((t) => t.fieldIds);
    const missing = missingFromFieldScheme(db, all);
    if (missing.length && db.fieldScheme) db.fieldScheme.fieldIds.push(...missing);
    let k = 0;
    s.tabs = save.tabs.map((t) => ({ id: t.id ?? `tab-new-${Date.now()}-${k++}`, name: t.name, fieldIds: t.fieldIds }));
    s.tabCount = s.tabs.length;
    s.fieldCount = all.length;
    log('Screen edited', s.name, undefined, `${n} changes`);
    db.loadedAt = new Date().toISOString();
  }
}
