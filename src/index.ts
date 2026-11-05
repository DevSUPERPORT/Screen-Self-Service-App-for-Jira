/**
 * Forge entry point of the backend. Defines the Custom UI resolvers (strictly validated intents, preview
 * digest checks, layout saves, undo, audit log and configuration), the nightly trigger for housekeeping,
 * personal data reporting and UC-10 auto-deletion of unused screens, and the Rovo agent actions. Every
 * resolver passes the maintenance kill switch and the caller's authorization checks before touching Jira.
 *
 * @file        src/index.ts
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import Resolver from '@forge/resolver';
import type { Intent, LayoutSave, Op, Plan, ProjectModel, Screen, Tab } from './shared/types';
import { OPS } from './shared/types';
import { planDigest } from './shared/digest';
import { executionOrder, groupsOf, effective, itssExclusive, onlyProject, otherProjects, planFor, RuleError, schemeExclusive, screenExclusive } from './shared/domain';
import { AppError, installationScope, jira, route, runtimeLicense } from './backend/jira';
import { callerFrom, requireJiraAdmin, requireProjectAdmin, requireProjectAdminByKey, ADMIN_MODULE } from './backend/auth';
import { maintenanceMode, requireAvailable, STATUS_PAGE_URL } from './backend/maintenance';
import { invalidateCache, loadInstance, loadModel, loadTabs } from './backend/loader';
import { applyLayout, executePlan } from './backend/executor';
import { clearUndo, peekUndo, runUndo, saveUndo, TTL_MS as UNDO_TTL_MS } from './backend/undo';
import { audit, forgetCreated, getConfig, listCreated, pruneAudit, pruneUndo, readAudit, setConfig, SYSTEM_ACCOUNT, unusedSince, validConfig } from './backend/storage';
import { reportPersonalData } from './backend/privacy';

// ---------------------------------------------------------------- helpers

type Result<T> = { ok: true; data: T } | { ok: false; code: string; message: string };

function safe<T>(fn: (req: { payload: unknown; context: unknown }) => Promise<T>) {
  return async (req: { payload: unknown; context: unknown }): Promise<Result<T>> => {
    try {
      return { ok: true, data: await fn(req) };
    } catch (e) {
      if (e instanceof AppError) return { ok: false, code: e.code, message: e.message };
      if (e instanceof RuleError) return { ok: false, code: e.code, message: e.message };
      console.error(e);
      return { ok: false, code: 'error', message: 'Unexpected error. The change was not completed — please reload and try again.' };
    }
  };
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const str = (v: unknown, re = ID) => {
  if (typeof v !== 'string' || !re.test(v)) throw new AppError('invalid', 'Invalid input');
  return v;
};
const optStr = (v: unknown, re = ID) => (v === undefined || v === null || v === '' ? undefined : str(v, re));

/** Strict schema validation of the client's intent. Unknown shapes are rejected outright. */
function validateIntent(raw: unknown): Intent {
  const i = raw as Record<string, unknown>;
  switch (i?.type) {
    case 'assign': {
      const next = i.next as Record<string, unknown>;
      if (!next || typeof next !== 'object') throw new AppError('invalid', 'Invalid input');
      const n: Record<Op, string | undefined> = { default: str(next.default), create: optStr(next.create), edit: optStr(next.edit), view: optStr(next.view) };
      const news = Array.isArray(i.newScreens) ? i.newScreens.slice(0, 4) : [];
      return {
        type: 'assign', schemeId: str(i.schemeId), next: n,
        newScreens: news.map((x: Record<string, unknown>) => ({
          ref: str(x.ref, /^new-[a-z0-9-]{1,40}$/), copyFrom: optStr(x.copyFrom, /^\d{1,12}$/),
          op: OPS.includes(x.op as Op) ? (x.op as Op) : (() => { throw new AppError('invalid', 'Invalid operation'); })(),
          issueType: str(x.issueType, /^.{1,255}$/s),
        })),
      };
    }
    case 'split':
      return { type: 'split', schemeId: str(i.schemeId), issueTypeId: str(i.issueTypeId), mode: i.mode === 'share' ? 'share' : 'copy' };
    case 'merge':
      return { type: 'merge', issueTypeId: str(i.issueTypeId), targetSchemeId: str(i.targetSchemeId) };
    case 'transition':
      return { type: 'transition', screenId: str(i.screenId), workflowId: str(i.workflowId, /^[A-Za-z0-9-]{1,64}$/), transitionId: str(i.transitionId), on: i.on === true };
    case 'newTransitionScreen':
      return { type: 'newTransitionScreen', text: str(i.text, /^[^<>]{1,120}$/), copyFrom: optStr(i.copyFrom, /^\d{1,12}$/) };
    case 'delete':
      if (!Array.isArray(i.items) || i.items.length < 1 || i.items.length > 20) throw new AppError('invalid', 'Invalid input');
      return { type: 'delete', items: i.items.map((x: { kind?: unknown; id?: unknown }) => {
        if (x?.kind !== 'screen' && x?.kind !== 'screenScheme') throw new AppError('invalid', 'Invalid input');
        return { kind: x.kind, id: str(x.id, /^\d{1,12}$/) };
      }) };
    case 'normalizeNames':
      return { type: 'normalizeNames' };
    default:
      throw new AppError('invalid', 'Unknown action');
  }
}

/** Defence in depth: re-check every object a step touches against the fresh model. */
function verifyGuard(m: ProjectModel, plan: Plan) {
  const created = new Set(plan.steps.flatMap((s) => (s.kind === 'createScreen' || s.kind === 'createScreenScheme' ? [s.ref] : [])));
  for (const s of plan.steps) {
    const fail = (what: string) => { throw new AppError('locked', `${what} is shared with other projects and can't be changed here`); };
    switch (s.kind) {
      case 'renameScreen': if (!created.has(s.screenId) && !screenExclusive(m, s.screenId)) fail(m.screens[s.screenId]?.name ?? 'Screen'); break;
      case 'deleteScreen':
        if (!screenExclusive(m, s.screenId) || !m.unused.some((u) => u.kind === 'screen' && u.id === s.screenId)) fail(s.name);
        // the app only deletes what it created; deleting other configuration is a Jira-admin right
        if (!m.unused.some((u) => u.kind === 'screen' && u.id === s.screenId && u.createdByApp)) throw new AppError('locked', `"${s.name}" was not created by this app. Only your Jira admin can delete it.`);
        break;
      case 'deleteScreenScheme':
        if (!schemeExclusive(m, s.schemeId)) fail(m.screenSchemes[s.schemeId]?.name ?? 'Screen scheme');
        if (!m.unused.some((u) => u.kind === 'screenScheme' && u.id === s.schemeId && u.createdByApp)) throw new AppError('locked', `"${s.name}" was not created by this app. Only your Jira admin can delete it.`);
        break;
      case 'renameScreenScheme': case 'updateScreenScheme':
        if (!created.has(s.schemeId) && !schemeExclusive(m, s.schemeId)) fail(m.screenSchemes[s.schemeId]?.name ?? 'Screen scheme'); break;
      case 'mapIssueType': if (s.itssId !== m.itss.id || !itssExclusive(m)) fail(m.itss.name); break;
      case 'setTransitionScreen': {
        const wf = m.workflows.find((w) => w.id === s.workflowId);
        if (!wf || !onlyProject(wf, m.project.key)) fail(wf?.name ?? 'Workflow');
        break;
      }
      default: break;
    }
  }
}

// Display names are looked up, never stored. A short in-memory cache, per installation, avoids a lookup per call.
const NAME_TTL_MS = 10 * 60 * 1000;
const nameCache = new Map<string, { name: string; at: number }>();
async function displayNames(accountIds: string[]): Promise<Map<string, string>> {
  const scope = installationScope();
  const out = new Map<string, string>();
  const missing: string[] = [];
  for (const id of accountIds) {
    const hit = nameCache.get(`${scope}|${id}`);
    if (hit && Date.now() - hit.at < NAME_TTL_MS) out.set(id, hit.name); else missing.push(id);
  }
  for (let i = 0; i < missing.length; i += 50) {
    const p = new URLSearchParams();
    for (const id of missing.slice(i, i + 50)) p.append('accountId', id);
    const r = await jira.get<{ values?: { accountId: string; displayName?: string }[] }>(route`/rest/api/3/user/bulk?${p}&maxResults=50`, true).catch(() => null);
    for (const u of r?.values ?? []) {
      const name = u.displayName ?? 'Unknown user';
      out.set(u.accountId, name);
      nameCache.set(`${scope}|${u.accountId}`, { name, at: Date.now() });
    }
  }
  if (nameCache.size > 5000) nameCache.clear();
  return out;
}
async function displayName(accountId: string) {
  return (await displayNames([accountId])).get(accountId) ?? 'Unknown user';
}

/**
 * The app reads usage across the whole site with its own rights. A project admin must not learn the keys of
 * projects they can't browse: those keys are removed (the counts stay, so "shared" is still shown and every
 * exclusivity decision, which is count-based, is unchanged).
 */
async function hideUnbrowsableProjects(m: ProjectModel, c: { accountId: string; jiraAdmin: boolean }) {
  if (c.jiraAdmin) return;
  const own = m.project.key;
  const holders: { projects: string[] }[] = [m.itss, ...Object.values(m.screenSchemes), ...Object.values(m.screens), ...m.workflows, ...(m.fieldScheme ? [m.fieldScheme] : [])];
  const keys = [...new Set(holders.flatMap((h) => h.projects).filter((k) => k !== own))];
  if (!keys.length) return;
  const inst = await loadInstance();
  const idByKey = new Map([...inst.keyById].map(([id, k]) => [k, id]));
  const ids = keys.map((k) => idByKey.get(k)).filter(Boolean).map(Number);
  const allowed = new Set<string>();
  for (let i = 0; i < ids.length; i += 200) {
    const r = await jira.post<{ projectPermissions?: { permission: string; projects?: number[] }[] }>(route`/rest/api/3/permissions/check`, {
      accountId: c.accountId, projectPermissions: [{ permissions: ['BROWSE_PROJECTS'], projects: ids.slice(i, i + 200) }],
    }).catch(() => null);
    for (const pid of r?.projectPermissions?.find((p) => p.permission === 'BROWSE_PROJECTS')?.projects ?? []) {
      const k = inst.keyById.get(String(pid));
      if (k) allowed.add(k);
    }
  }
  for (const h of holders) h.projects = h.projects.filter((k) => k === own || allowed.has(k));
}

async function modelFor(c: { projectId: string; accountId: string; jiraAdmin: boolean; projectAdmin: boolean }) {
  const m = await loadModel(c.projectId, { accountId: c.accountId, isJiraAdmin: c.jiraAdmin, isProjectAdmin: c.projectAdmin });
  m.viewer.name = await displayName(c.accountId);
  m.lastChange = await peekUndo(m.project.key, c.accountId).catch(() => null);
  await hideUnbrowsableProjects(m, c);
  return m;
}

/** UC-04 across projects can be switched off by the Jira admin; then only the project's own screens are visible. */
async function requireCrossProjectCopy(c: { jiraAdmin: boolean }) {
  if (c.jiraAdmin) return;
  if (!(await getConfig()).crossProjectCopy) throw new AppError('denied', 'Your Jira admin has turned off copying screens from other projects.');
}

/** Templates from other projects aren't part of the model — add them (read-only) so the plan can reference them. */
async function withTemplates(m: ProjectModel, ids: (string | undefined)[]) {
  for (const id of ids) {
    if (!id || m.screens[id]) continue;
    await requireCrossProjectCopy({ jiraAdmin: m.viewer.isJiraAdmin });
    const meta = await jira.get<{ values: { id: number; name: string }[] }>(route`/rest/api/3/screens?id=${id}`);
    const s = meta?.values?.[0];
    if (!s) throw new AppError('not-found', 'Template screen not found');
    const tabs = await loadTabs(id);
    m.screens[id] = { id, name: s.name, tabs, tabCount: tabs.length, fieldCount: tabs.reduce((n, t) => n + t.fieldIds.length, 0), createdByApp: false, projects: [], projectCount: 2, screenSchemeIds: [], workflowIds: [], foreign: true };
  }
}

// ---------------------------------------------------------------- resolvers (Custom UI)

const resolver = new Resolver();

// Resolvers that only read. Everything else counts as a write — a new resolver is blocked in read-only mode
// unless it is listed here on purpose.
const READS = new Set(['load', 'loadScreen', 'searchScreens', 'audit', 'loadConfig']);

/** Every resolver passes the kill switch first (see backend/maintenance.ts), then runs inside `safe`. */
function define<T>(name: string, fn: (req: { payload: unknown; context: unknown }) => Promise<T>) {
  resolver.define(name, safe(async (req) => {
    requireAvailable(READS.has(name) ? 'read' : 'write');
    return fn(req);
  }) as never);
}

/** The UI asks first, so it can show "temporarily unavailable" or "read-only" before loading anything. */
resolver.define('availability', safe(async ({ context }) => {
  callerFrom(context);
  return { mode: maintenanceMode(), statusUrl: STATUS_PAGE_URL };
}) as never);

define('load', (async ({ context }) => {
  const c = await requireProjectAdmin(context);
  return modelFor(c);
}));

define('loadScreen', (async ({ payload, context }) => {
  const c = await requireProjectAdmin(context);
  const id = str((payload as { id?: unknown })?.id, /^\d{1,12}$/);
  if (!c.jiraAdmin && !(await getConfig()).crossProjectCopy) {
    // copying across projects is off: only the project's own screens can be opened
    const m = await modelFor(c);
    if (!m.screens[id] || m.screens[id].foreign) throw new AppError('denied', 'Your Jira admin has turned off copying screens from other projects.');
  }
  const meta = await jira.get<{ values: { id: number; name: string }[] }>(route`/rest/api/3/screens?id=${id}`);
  const s = meta?.values?.[0];
  if (!s) throw new AppError('not-found', 'Screen not found');
  const tabs = await loadTabs(id);
  const screen: Screen = { id, name: s.name, tabs, tabCount: tabs.length, fieldCount: tabs.reduce((n, t) => n + t.fieldIds.length, 0), createdByApp: false, projects: [], projectCount: 0, screenSchemeIds: [], workflowIds: [], foreign: true };
  return screen;
}));

define('searchScreens', (async ({ payload, context }) => {
  const c = await requireProjectAdmin(context);
  if (!c.jiraAdmin && !(await getConfig()).crossProjectCopy) return { items: [] as Screen[], total: 0, disabled: true };
  const p = payload as { query?: unknown; limit?: unknown };
  const q = typeof p?.query === 'string' ? p.query.slice(0, 100) : '';
  const limit = Math.min(100, Math.max(1, Number(p?.limit) || 10));
  const page = await jira.get<{ values: { id: number; name: string }[]; total: number }>(route`/rest/api/3/screens?queryString=${q}&scope=GLOBAL&startAt=0&maxResults=${limit + 40}&orderBy=name`);
  const items: Screen[] = (page?.values ?? []).map((s) => ({ id: String(s.id), name: s.name, tabCount: 0, fieldCount: 0, createdByApp: false, projects: [], projectCount: 0, screenSchemeIds: [], workflowIds: [], foreign: true }));
  return { items, total: page?.total ?? items.length };
}));

/** A short label the user chose for "Undo: …" — display only, so just bounded and stripped of markup. */
const label = (v: unknown, fallback: string) => (typeof v === 'string' && v.trim() ? v.replace(/[<>]/g, '').trim().slice(0, 140) : fallback);

/** Normalises one layout from the client; applyLayout does the authority checks. */
function cleanSave(save: LayoutSave | undefined) {
  if (!save || typeof save !== 'object') throw new AppError('invalid', 'Invalid input');
  return {
    screenId: str(save.screenId, /^\d{1,12}$/),
    baseDigest: typeof save.baseDigest === 'string' && /^[0-9a-f]{8}$/.test(save.baseDigest) ? save.baseDigest : undefined,
    tabs: Array.isArray(save.tabs) ? save.tabs.slice(0, 50).map((t) => ({ id: t?.id ? String(t.id) : null, name: String(t?.name ?? ''), fieldIds: Array.isArray(t?.fieldIds) ? t.fieldIds.slice(0, 500).map(String) : [] })) : [],
  };
}

define('execute', (async ({ payload, context }) => {
  const c = await requireProjectAdmin(context);
  const intent = validateIntent((payload as { intent?: unknown })?.intent);
  invalidateCache(); // writes always plan against a fresh read of Jira — never a cached or client-side picture
  const m = await modelFor(c);
  if (m.environmentIssue) throw new AppError('denied', 'This project is not supported');
  await withTemplates(m, intent.type === 'assign' ? intent.newScreens.map((n) => n.copyFrom) : intent.type === 'newTransitionScreen' ? [intent.copyFrom] : []);
  const plan = planFor(m, intent);
  // Preview == execution: refuse if the plan differs from the one the user confirmed (Jira changed meanwhile)
  const digest = (payload as { digest?: unknown })?.digest;
  if (typeof digest !== 'string' || !/^[0-9a-f]{8}$/.test(digest)) throw new AppError('invalid', 'Missing preview digest');
  if (digest !== planDigest(plan)) throw new AppError('conflict', 'Jira changed since your preview. The latest state has been loaded — please review and confirm again.');
  verifyGuard(m, plan);
  const who = { accountId: c.accountId, name: m.viewer.name };
  let result: Awaited<ReturnType<typeof executePlan>>;
  try { result = await executePlan(m, executionOrder(plan.steps), who); } finally { invalidateCache(); }
  // the newest change is the one "Undo" refers to (a deletion is undone by re-creating the deleted objects)
  if (result.inverse?.length) await saveUndo(m.project.key, c.accountId, { kind: 'plan', label: label((payload as { label?: unknown })?.label, intent.type), at: new Date().toISOString(), steps: result.inverse });
  else if (result.deleted?.length) await saveUndo(m.project.key, c.accountId, { kind: 'restore', label: label((payload as { label?: unknown })?.label, 'Delete'), at: new Date().toISOString(), items: result.deleted });
  else await clearUndo(m.project.key, c.accountId);
  const model = await modelFor(c);
  return { model, idMap: result.idMap, warnings: result.warnings, preview: plan.preview };
}));

define('saveLayout', (async ({ payload, context }) => {
  const c = await requireProjectAdmin(context);
  const save = cleanSave((payload as { save?: LayoutSave })?.save);
  invalidateCache();
  const m = await modelFor(c);
  if (!m.screens[save.screenId]) throw new AppError('not-found', 'This screen does not belong to the project');
  let r: Awaited<ReturnType<typeof applyLayout>>;
  try { r = await applyLayout(m, save, { accountId: c.accountId, name: m.viewer.name }); } finally { invalidateCache(); }
  await saveUndo(m.project.key, c.accountId, { kind: 'layouts', label: label((payload as { label?: unknown })?.label, m.screens[save.screenId].name), at: new Date().toISOString(), items: [{ screenId: save.screenId, before: r.before, afterDigest: r.afterDigest }], fieldScheme: r.addedToScheme });
  return modelFor(c);
}));

/**
 * Several screens in one go (bulk field changes, health fixes). Each screen is applied — and on failure rolled
 * back — on its own; the result lists every screen, so a partial failure is visible and nothing is half-changed.
 */
define('saveLayouts', (async ({ payload, context }) => {
  const c = await requireProjectAdmin(context);
  const raw = (payload as { saves?: unknown })?.saves;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 60) throw new AppError('invalid', 'Choose between 1 and 60 screens');
  const saves = raw.map((s) => cleanSave(s as LayoutSave));
  if (new Set(saves.map((s) => s.screenId)).size !== saves.length) throw new AppError('invalid', 'A screen appears twice');
  invalidateCache();
  const m = await modelFor(c);
  const who = { accountId: c.accountId, name: m.viewer.name };
  const results: { screenId: string; ok: boolean; code?: string; message?: string }[] = [];
  const done: { screenId: string; before: Tab[]; afterDigest: string }[] = [];
  const addedToScheme = new Set<string>();
  try {
    for (const s of saves) {
      if (!m.screens[s.screenId]) { results.push({ screenId: s.screenId, ok: false, code: 'not-found', message: 'This screen does not belong to the project' }); continue; }
      try {
        const r = await applyLayout(m, s, who);
        done.push({ screenId: s.screenId, before: r.before, afterDigest: r.afterDigest });
        r.addedToScheme.forEach((f) => addedToScheme.add(f));
        // later screens must not try to add the same fields to the field scheme again
        if (m.fieldScheme) m.fieldScheme.fieldIds.push(...r.addedToScheme);
        results.push({ screenId: s.screenId, ok: true });
      } catch (e) {
        // only our own, user-facing messages reach the UI — never raw runtime errors
        if (!(e instanceof AppError)) console.error(e);
        results.push({ screenId: s.screenId, ok: false, code: e instanceof AppError ? e.code : 'error', message: e instanceof AppError ? e.message : 'This screen could not be changed. Nothing was changed on it.' });
      }
    }
  } finally { invalidateCache(); }
  if (done.length) await saveUndo(m.project.key, c.accountId, { kind: 'layouts', label: label((payload as { label?: unknown })?.label, `${done.length} screens`), at: new Date().toISOString(), items: done, fieldScheme: [...addedToScheme] });
  return { model: await modelFor(c), results };
}));

/** Health fix: make fields that are on the project's screens visible by adding them to the project's own field scheme. */
define('addToFieldScheme', (async ({ payload, context }) => {
  const c = await requireProjectAdmin(context);
  const ids = (payload as { fieldIds?: unknown })?.fieldIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100) throw new AppError('invalid', 'Invalid input');
  const fieldIds = ids.map((f) => str(f, /^[A-Za-z0-9_.-]{1,64}$/));
  invalidateCache();
  const m = await modelFor(c);
  if (!m.fieldScheme || !onlyProject(m.fieldScheme, m.project.key)) throw new AppError('locked', 'The field scheme is shared with other projects — ask your Jira admin');
  // only fields that are actually on this project's own screens and missing from its field scheme
  const onOwnScreens = new Set(Object.values(m.screens).filter((s) => screenExclusive(m, s.id)).flatMap((s) => (s.tabs ?? []).flatMap((t) => t.fieldIds)));
  for (const f of fieldIds) if (!m.fields[f] || !onOwnScreens.has(f)) throw new AppError('invalid', `${f} is not on a screen of this project`);
  const missing = fieldIds.filter((f) => !m.fieldScheme!.fieldIds.includes(f));
  if (!missing.length) return { model: m };
  const body = Object.fromEntries(missing.map((f) => [f, [{ schemeIds: [Number(m.fieldScheme!.id)] }]]));
  try {
    const r = await jira.put<{ results?: { fieldId: string; success: boolean }[] }>(route`/rest/api/3/config/fieldschemes/fields`, body);
    const failed = r?.results?.filter((x) => !x.success) ?? [];
    if (failed.length) throw new AppError('error', `Could not add: ${failed.map((x) => x.fieldId).join(', ')}`);
  } finally { invalidateCache(); }
  await audit(m.project.key, { user: { accountId: c.accountId, name: m.viewer.name }, action: 'Fields added to field scheme', object: m.fieldScheme.name, after: missing.map((f) => m.fields[f]?.name ?? f).join(', ') });
  await saveUndo(m.project.key, c.accountId, { kind: 'fieldScheme', label: label((payload as { label?: unknown })?.label, 'Field scheme'), at: new Date().toISOString(), fieldIds: missing });
  return { model: await modelFor(c) };
}));

define('undo', (async ({ context }) => {
  const c = await requireProjectAdmin(context);
  invalidateCache();
  const m = await modelFor(c);
  let what: string;
  try { what = await runUndo(m, c.accountId, { accountId: c.accountId, name: m.viewer.name }); } finally { invalidateCache(); }
  return { model: await modelFor(c), label: what };
}));

define('audit', (async ({ context }) => {
  const ctx = context as { moduleKey?: string };
  if (ctx?.moduleKey === ADMIN_MODULE) { await requireJiraAdmin(context); return readAudit(null, displayNames); }
  const c = await requireProjectAdmin(context);
  const p = await jira.get<{ key: string }>(route`/rest/api/3/project/${c.projectId}`);
  return readAudit(p!.key, displayNames);
}));

define('loadConfig', (async ({ context }) => { await requireJiraAdmin(context); return getConfig(); }));

define('saveConfig', (async ({ payload, context }) => {
  const c = await requireJiraAdmin(context);
  let next;
  try { next = validConfig((payload as { config?: unknown })?.config); } catch { throw new AppError('invalid', 'Invalid configuration'); }
  const before = await getConfig();
  await setConfig(next);
  const fmt = (x: typeof next) => [
    `auto-delete ${x.autoDelete ? `on · ${x.days} days` : 'off'}`,
    `audit retention ${x.auditRetentionMonths ? `${x.auditRetentionMonths} months` : 'never'}`,
    `projects ${x.projectAccess === 'all' ? 'all' : x.projects.join(', ') || 'none'}`,
    `copy from other projects ${x.crossProjectCopy ? 'on' : 'off'}`,
  ].join(' · ');
  await audit('_admin', { user: { accountId: c.accountId }, action: 'Configuration changed', object: 'Screen Self-Service', before: fmt(before), after: fmt(next) });
  return next;
}));

export const handler = resolver.getDefinitions();

// ---------------------------------------------------------------- nightly: housekeeping + UC-10 auto-deletion

export async function nightly() {
  // kill switch: "on" stops everything, "readonly" only stops what writes to Jira (auto-deletion)
  const mode = maintenanceMode();
  if (mode === 'on') return;
  const cfg = await getConfig();
  // personal data lifecycle first — it must run even when nothing else does
  await reportPersonalData().catch((e) => console.error('personal data report failed', e));
  await pruneUndo(UNDO_TTL_MS).catch((e) => console.error('undo cleanup failed', e));
  if (cfg.auditRetentionMonths) await pruneAudit(cfg.auditRetentionMonths);
  if (!cfg.autoDelete || mode !== 'off') return;
  // no active license (paid app expired): don't touch the customer's Jira any more
  const lic = runtimeLicense();
  if (lic && (lic.isActive === false || (lic.isActive === undefined && lic.active === false))) return;
  const created = await listCreated();
  if (!created.length) return;
  const inst = await loadInstance();
  const today = Date.now();
  const due: typeof created = [];
  for (const o of created) {
    const unused = o.kind === 'screen' ? inst.screenUnused(o.id) : !inst.schemeUsed.has(o.id);
    const since = await unusedSince(o.kind, o.id, unused);
    if (unused && since && new Date(since).getTime() + cfg.days * 86400000 <= today) due.push(o);
  }
  const sys = { accountId: SYSTEM_ACCOUNT, name: 'Screen Self-Service for Jira (auto-deletion)' };
  // screen schemes before screens — Jira refuses to delete screens that are still in a scheme
  for (const o of [...due.filter((d) => d.kind === 'screenScheme'), ...due.filter((d) => d.kind === 'screen')]) {
    try {
      if (o.kind === 'screenScheme') await jira.del(route`/rest/api/3/screenscheme/${o.id}`);
      else await jira.del(route`/rest/api/3/screens/${o.id}`);
      await forgetCreated(o.kind, o.id);
      await audit(o.projectKey, { user: sys, action: o.kind === 'screen' ? 'Screen deleted automatically' : 'Screen scheme deleted automatically', object: o.id, after: `unused for ${cfg.days}+ days` });
    } catch (e) {
      console.error(`auto-delete ${o.kind} ${o.id} failed`, e);
    }
  }
}

// ---------------------------------------------------------------- Rovo actions

type RovoPayload = Record<string, unknown> & { context?: { jira?: { projectKey?: string } } };

async function rovoModel(payload: RovoPayload, context: unknown) {
  const key = (payload.projectKey as string | undefined) || payload.context?.jira?.projectKey;
  const c = await requireProjectAdminByKey(context, key);
  invalidateCache();
  const m = await modelFor(c);
  if (m.environmentIssue) throw new AppError('denied', `Screen Self-Service for Jira can't manage ${m.project.key}: ${m.environmentIssue}`);
  return { c, m };
}

function rovoSafe(fn: (payload: RovoPayload, context: unknown) => Promise<string>, kind: 'read' | 'write' = 'write') {
  return async (payload: RovoPayload, context: unknown) => {
    try { requireAvailable(kind); return await fn(payload ?? {}, context); } catch (e) {
      if (e instanceof AppError || e instanceof RuleError) return `I couldn't do that: ${e.message}`;
      console.error(e);
      return 'Something went wrong. Nothing was changed.';
    }
  };
}

function findScreen(m: ProjectModel, q: unknown) {
  const s = String(q ?? '').trim().toLowerCase();
  if (!s) throw new AppError('invalid', 'Which screen do you mean?');
  const list = Object.values(m.screens).filter((x) => !x.foreign);
  const exact = list.find((x) => x.id === s || x.name.toLowerCase() === s);
  if (exact) return exact;
  const hits = list.filter((x) => x.name.toLowerCase().includes(s));
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new AppError('not-found', `No screen of ${m.project.key} matches "${q}". Screens: ${list.map((x) => x.name).join('; ')}`);
  throw new AppError('invalid', `"${q}" matches several screens: ${hits.map((x) => x.name).join('; ')}. Which one?`);
}

function findField(m: ProjectModel, q: unknown) {
  const s = String(q ?? '').trim().toLowerCase();
  if (!s) throw new AppError('invalid', 'Which field do you mean?');
  const all = Object.values(m.fields);
  const exact = all.filter((f) => f.id.toLowerCase() === s || f.name.toLowerCase() === s);
  if (exact.length === 1) return exact[0];
  const hits = (exact.length ? exact : all.filter((f) => f.name.toLowerCase().includes(s))).slice(0, 8);
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new AppError('not-found', `No field matches "${q}".`);
  throw new AppError('invalid', `"${q}" matches several fields: ${hits.map((f) => `${f.name} (${f.id})`).join('; ')}. Which one?`);
}

function describeScreen(m: ProjectModel, s: Screen) {
  const tabs = (s.tabs ?? []).map((t) => `  - Tab "${t.name}": ${t.fieldIds.map((f) => m.fields[f]?.name ?? f).join(', ') || '(empty)'}`).join('\n');
  const uses = groupsOf(m).flatMap((g) => OPS.filter((o) => effective(m.screenSchemes[g.schemeId], o).screenId === s.id).map((o) => `${g.title}/${o}${effective(m.screenSchemes[g.schemeId], o).inherited ? ' (inherited from Default)' : ''}`));
  const trans = m.workflows.flatMap((w) => w.transitions.filter((t) => t.screenId === s.id).map((t) => `${w.name}: ${t.name} (${t.from.join(', ') || 'any'} → ${t.to})`));
  const others = otherProjects(s, m.project.key);
  return [
    `Screen "${s.name}" (id ${s.id}) — ${s.fieldCount} fields on ${s.tabCount} tabs.`,
    others > 0 ? `LOCKED: also used by ${others} other project(s) (${s.projects.filter((p) => p !== m.project.key).slice(0, 10).join(', ')}). Only a Jira admin can change it; the project admin can copy it instead.` : `Editable: used only by ${m.project.key}.`,
    uses.length ? `Used for: ${uses.join(', ')}.` : '',
    trans.length ? `Transition screen on: ${trans.join('; ')}.` : '',
    tabs ? `Content:\n${tabs}` : '',
  ].filter(Boolean).join('\n');
}

export const rovoListScreens = rovoSafe(async (payload, context) => {
  const { m } = await rovoModel(payload, context);
  const lines = [`Screens of project ${m.project.key} (${m.project.name}):`];
  for (const g of groupsOf(m)) {
    const sc = m.screenSchemes[g.schemeId];
    lines.push(`\n• ${g.title} — screen scheme "${sc.name}" (${schemeExclusive(m, sc.id) ? 'editable' : `shared with ${otherProjects(sc, m.project.key)} other projects, locked`})`);
    for (const o of OPS) {
      const e = effective(sc, o);
      lines.push(`  - ${o}: ${e.inherited ? `inherits from Default (${m.screens[e.screenId]?.name})` : m.screens[e.screenId]?.name}${!e.inherited && !screenExclusive(m, e.screenId) ? ' [locked]' : ''}`);
    }
  }
  const tr = m.workflows.flatMap((w) => w.transitions.filter((t) => t.screenId).map((t) => `  - ${m.screens[t.screenId!]?.name ?? t.screenId}: ${w.name} → ${t.name}`));
  if (tr.length) lines.push('\nTransition screens:', ...tr);
  if (m.unused.length) lines.push(`\n${m.unused.length} unused object(s) — ask me about unused screens for details.`);
  return lines.join('\n');
}, 'read');

export const rovoExplainScreen = rovoSafe(async (payload, context) => {
  const { m } = await rovoModel(payload, context);
  const s = findScreen(m, payload.screen);
  if (!s.tabs) { s.tabs = await loadTabs(s.id); }
  return describeScreen(m, s);
}, 'read');

export const rovoUnusedScreens = rovoSafe(async (payload, context) => {
  const { m } = await rovoModel(payload, context);
  if (!m.unused.length) return `${m.project.key} has no unused screens or screen schemes.`;
  const day = 86400000;
  return [`Unused objects of ${m.project.key}${m.config.autoDelete ? ` (auto-deletion after ${m.config.days} days is ON)` : ' (auto-deletion is off)'}:`,
    ...m.unused.map((u) => {
      const del = m.config.autoDelete && u.createdByApp ? `, scheduled deletion ${new Date(new Date(u.since).getTime() + m.config.days * day).toISOString().slice(0, 10)}` : '';
      return `- ${u.kind === 'screen' ? 'Screen' : 'Screen scheme'} "${u.name}", unused since ${u.since}${del}`;
    })].join('\n');
}, 'read');

async function rovoEditField(payload: RovoPayload, context: unknown, add: boolean) {
  const { c, m } = await rovoModel(payload, context);
  const s = findScreen(m, payload.screen);
  if (!screenExclusive(m, s.id)) throw new AppError('locked', `"${s.name}" is shared with ${otherProjects(s, m.project.key)} other project(s). Only a Jira admin can change it.`);
  const f = findField(m, payload.field);
  const tabs = (s.tabs ?? (await loadTabs(s.id))).map((t) => ({ ...t, fieldIds: [...t.fieldIds] }));
  const holder = tabs.find((t) => t.fieldIds.includes(f.id));
  if (add) {
    if (holder) return `"${f.name}" is already on "${s.name}" (tab "${holder.name}"). Nothing changed.`;
    const tabQ = String(payload.tab ?? '').trim().toLowerCase();
    const tab = (tabQ && tabs.find((t) => t.name.toLowerCase() === tabQ)) || tabs[0];
    tab.fieldIds.push(f.id);
  } else {
    if (!holder) return `"${f.name}" is not on "${s.name}". Nothing changed.`;
    if (f.locked) throw new AppError('invalid', `"${f.name}" can't be removed from a screen.`);
    holder.fieldIds = holder.fieldIds.filter((x) => x !== f.id);
  }
  let r: Awaited<ReturnType<typeof applyLayout>>;
  try { r = await applyLayout(m, { screenId: s.id, tabs: tabs.map((t) => ({ id: t.id, name: t.name, fieldIds: t.fieldIds })) }, { accountId: c.accountId, name: `${m.viewer.name} via Rovo` }); } finally { invalidateCache(); }
  // a change made through Rovo can be undone in the app like any other
  await saveUndo(m.project.key, c.accountId, { kind: 'layouts', label: `Rovo: ${add ? 'add' : 'remove'} ${f.name} on ${s.name}`, at: new Date().toISOString(), items: [{ screenId: s.id, before: r.before, afterDigest: r.afterDigest }], fieldScheme: r.addedToScheme });
  return add ? `Added "${f.name}" to "${s.name}".` : `Removed "${f.name}" from "${s.name}".`;
}

export const rovoAddField = rovoSafe((p, ctx) => rovoEditField(p, ctx, true));
export const rovoRemoveField = rovoSafe((p, ctx) => rovoEditField(p, ctx, false));
