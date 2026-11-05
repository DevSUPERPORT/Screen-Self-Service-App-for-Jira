/**
 * Builds the ProjectModel for one project from live Jira data, including the instance-wide usage graph
 * needed to decide exclusivity: screen → screen scheme → issue type screen scheme → projects, and
 * screen → workflows (active + inactive) → workflow schemes → projects.
 *
 * @file        src/backend/loader.ts
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import type { EnvironmentIssue, Field, ProjectModel, Screen, ScreenScheme, Tab, Workflow } from '../shared/types';
import { AppError, installationScope, jira, pages, pool, route } from './jira';
import { getConfig, isCreated, unusedSince } from './storage';

interface JProject { id: string; key: string; name: string; style?: string; simplified?: boolean; issueTypes?: { id: string; name: string; iconUrl?: string; subtask?: boolean }[] }
interface JScreenScheme { id: number; name: string; screens: { default: number; create?: number; edit?: number; view?: number }; issueTypeScreenSchemes?: { values?: { id: string }[] } | { id: string }[] }
interface JWorkflow {
  id: string; name: string; version?: { id: string; versionNumber: number }; scope?: { type: string };
  transitions?: { id: string; name: string; type?: string; toStatusReference: string; links?: { fromStatusReference?: string | null }[]; transitionScreen?: { parameters?: { screenId?: string }; params?: { screenId?: string } } | null }[];
}
interface JStatus { id: string; name: string; statusReference: string }

const MAX_KEYS = 40;
const ids = (name: string, values: (string | number)[]) => {
  const p = new URLSearchParams();
  for (const v of values) p.append(name, String(v));
  return p;
};

// Warm Forge containers are reused: keep instance-wide data for a few seconds, and drop it after every write.
// Keys carry the installation, so one site's data can never be served to another.
const cache = new Map<string, { at: number; value: Promise<unknown> }>();
function memo<T>(name: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const key = `${installationScope()}|${name}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>;
  const value = fn().catch((e) => { cache.delete(key); throw e; });
  cache.set(key, { at: Date.now(), value });
  return value;
}
export function invalidateCache() {
  const scope = `${installationScope()}|`;
  for (const k of [...cache.keys()]) if (k.startsWith(scope)) cache.delete(k);
}

export const loadInstance = () => memo('instance', 15000, loadInstanceFresh);

// Hard limits of a single scan. Beyond them the app refuses to judge exclusivity (fails closed) instead of guessing.
const MAX_PROJECTS = 10000;
const MAX_SCHEMES = 50000;
const MAX_WORKFLOWS = 10000;

/** Everything that is instance-wide. */
async function loadInstanceFresh() {
  // Archived projects still use their schemes and workflows, so they count as "other projects" too.
  const projects = await pages<JProject>((s) => route`/rest/api/3/project/search?startAt=${s}&maxResults=100&status=live&status=archived`, MAX_PROJECTS, { strict: true });
  const keyById = new Map(projects.map((p) => [String(p.id), p.key]));

  const chunks: string[][] = [];
  for (let i = 0; i < projects.length; i += 50) chunks.push(projects.slice(i, i + 50).map((p) => String(p.id)));
  // Four independent instance scans run concurrently (each one pages in parallel internally)
  type ItssRow = { issueTypeScreenScheme: { id: string }; projectIds: string[] };
  type WfPage = { values: JWorkflow[]; statuses?: JStatus[]; isLast?: boolean; total?: number };
  type WsRow = { projectIds: string[]; workflowScheme: { defaultWorkflow?: string; issueTypeMappings?: Record<string, string> } };
  const wfPage = (startAt: number) => jira.get<WfPage>(route`/rest/api/3/workflows/search?startAt=${startAt}&maxResults=50&expand=values.transitions&scope=GLOBAL`);
  const [itssRows, schemes, wfPages, wsRows] = await Promise.all([
    pool(chunks, 6, (chunk) => pages<ItssRow>((s) => route`/rest/api/3/issuetypescreenscheme/project?${ids('projectId', chunk)}&startAt=${s}&maxResults=50`, 2000, { strict: true })),
    pages<JScreenScheme>((s) => route`/rest/api/3/screenscheme?startAt=${s}&maxResults=100&expand=issueTypeScreenSchemes`, MAX_SCHEMES, { strict: true }),
    (async () => {
      const first = await wfPage(0);
      const per = first?.values?.length ?? 0;
      if (!per || first?.isLast) return [first];
      // Without a total we can't prove we saw every workflow — and an unseen workflow could use a "free" screen
      if (first?.total === undefined || first.total > MAX_WORKFLOWS) throw new AppError('error', 'This Jira site has more workflows than the app can check safely. Nothing was changed.');
      const offsets: number[] = [];
      for (let s = per; s < first.total; s += per) offsets.push(s);
      return [first, ...(await pool(offsets, 6, wfPage))];
    })(),
    // No error is swallowed here: a project whose workflows can't be read would make a shared workflow (and its
    // transition screens) look exclusive. A chunk that fails is retried project by project; any failure aborts.
    pool(chunks, 6, async (chunk) => {
      try {
        return await jira.get<{ values?: WsRow[] }>(route`/rest/api/3/workflowscheme/project?${ids('projectId', chunk)}`);
      } catch {
        const rows = await pool(chunk, 3, (pid) => jira.get<{ values?: WsRow[] }>(route`/rest/api/3/workflowscheme/project?projectId=${pid}`));
        return { values: rows.flatMap((r) => r?.values ?? []) };
      }
    }),
  ]);

  // ITSS → projects
  const itssProjects = new Map<string, Set<string>>();
  const projectItss = new Map<string, string>();
  for (const v of itssRows.flat()) {
    const set = itssProjects.get(v.issueTypeScreenScheme.id) ?? new Set<string>();
    for (const pid of v.projectIds) { const k = keyById.get(String(pid)); if (k) { set.add(k); projectItss.set(k, v.issueTypeScreenScheme.id); } }
    itssProjects.set(v.issueTypeScreenScheme.id, set);
  }

  // screen schemes with the ITSS that reference them
  const schemeProjects = new Map<string, Set<string>>();
  const schemeUsed = new Set<string>();
  for (const sc of schemes) {
    const raw = sc.issueTypeScreenSchemes;
    const list = Array.isArray(raw) ? raw : raw?.values ?? [];
    const set = new Set<string>();
    for (const it of list) { schemeUsed.add(String(sc.id)); for (const k of itssProjects.get(String(it.id)) ?? []) set.add(k); }
    schemeProjects.set(String(sc.id), set);
  }

  // workflows (all, incl. inactive) + which projects use them
  const workflows: JWorkflow[] = [];
  const statuses = new Map<string, JStatus>();
  for (const page of wfPages) {
    for (const st of page?.statuses ?? []) statuses.set(st.statusReference, st);
    workflows.push(...(page?.values ?? []));
  }
  const workflowProjects = new Map<string, Set<string>>();
  const projectWorkflows = new Map<string, Set<string>>();
  // project → workflows: the workflow scheme endpoint returns exact projectIds and workflow names per scheme
  const wfIdByName = new Map(workflows.map((w) => [w.name, w.id]));
  for (const v of wsRows.flatMap((r) => r?.values ?? [])) {
    const names = [v.workflowScheme.defaultWorkflow, ...Object.values(v.workflowScheme.issueTypeMappings ?? {})].filter(Boolean) as string[];
    const wfIds = [...new Set(names.map((n) => wfIdByName.get(n)).filter(Boolean) as string[])];
    const keys = v.projectIds.map((pid) => keyById.get(String(pid))).filter(Boolean) as string[];
    for (const w of wfIds) {
      const set = workflowProjects.get(w) ?? new Set<string>();
      keys.forEach((k) => set.add(k));
      workflowProjects.set(w, set);
    }
    for (const k of keys) {
      const set = projectWorkflows.get(k) ?? new Set<string>();
      wfIds.forEach((w) => set.add(w));
      projectWorkflows.set(k, set);
    }
  }

  // screen → schemes / workflows
  const screenSchemesOf = new Map<string, Set<string>>();
  for (const sc of schemes) for (const sid of Object.values(sc.screens ?? {})) {
    if (sid === undefined || sid === null) continue;
    const set = screenSchemesOf.get(String(sid)) ?? new Set<string>();
    set.add(String(sc.id));
    screenSchemesOf.set(String(sid), set);
  }
  const screenWorkflowsOf = new Map<string, Set<string>>();
  for (const w of workflows) for (const t of w.transitions ?? []) {
    const sid = t.transitionScreen?.parameters?.screenId ?? t.transitionScreen?.params?.screenId;
    if (!sid) continue;
    const set = screenWorkflowsOf.get(String(sid)) ?? new Set<string>();
    set.add(w.id);
    screenWorkflowsOf.set(String(sid), set);
  }

  const screenProjects = (sid: string) => {
    const set = new Set<string>();
    for (const sc of screenSchemesOf.get(sid) ?? []) for (const k of schemeProjects.get(sc) ?? []) set.add(k);
    for (const w of screenWorkflowsOf.get(sid) ?? []) for (const k of workflowProjects.get(w) ?? []) set.add(k);
    return set;
  };

  /** Unused: no workflow and every screen scheme holding the screen is unused. */
  const screenUnused = (sid: string) => !screenWorkflowsOf.has(sid) && [...(screenSchemesOf.get(sid) ?? [])].every((sc) => !schemeUsed.has(sc));

  return { screenUnused, projects, keyById, itssProjects, projectItss, schemes, schemeProjects, schemeUsed, workflows, statuses, workflowProjects, projectWorkflows, screenSchemesOf, screenWorkflowsOf, screenProjects };
}

export type Instance = Awaited<ReturnType<typeof loadInstanceFresh>>;

const keysOf = (set: Set<string> | undefined, own: string) => {
  const arr = [...(set ?? [])].sort((a, b) => (a === own ? -1 : b === own ? 1 : a.localeCompare(b)));
  return { projects: arr.slice(0, MAX_KEYS), projectCount: arr.length };
};

const TYPE_LABEL: Record<string, string> = {
  select: 'Single select', multiselect: 'Multi select', textfield: 'Short text', textarea: 'Paragraph', datepicker: 'Date picker',
  datetime: 'Date time', float: 'Number', userpicker: 'User picker', multiuserpicker: 'Multi user picker', labels: 'Labels',
  radiobuttons: 'Radio buttons', multicheckboxes: 'Checkboxes', url: 'URL', cascadingselect: 'Cascading select', 'gh-sprint': 'Sprint',
};

export const loadFields = () => memo('fields', 120000, loadFieldsFresh);

async function loadFieldsFresh(): Promise<Record<string, Field>> {
  const list = (await jira.get<{ id: string; name: string; custom: boolean; schema?: { type?: string; custom?: string; system?: string } }[]>(route`/rest/api/3/field`)) ?? [];
  const out: Record<string, Field> = {};
  for (const f of list) {
    const c = f.schema?.custom?.split(':').pop();
    out[f.id] = {
      id: f.id, name: f.name, system: !f.custom,
      type: f.custom ? TYPE_LABEL[c ?? ''] ?? (c ?? f.schema?.type ?? 'Custom') : 'System field',
      locked: f.id === 'summary' || f.id === 'issuetype',
    };
  }
  return out;
}

export async function loadTabs(screenId: string): Promise<Tab[]> {
  const tabs = (await jira.get<{ id: number; name: string }[]>(route`/rest/api/3/screens/${screenId}/tabs`)) ?? [];
  return pool(tabs, 6, async (t) => {
    const fields = (await jira.get<{ id: string }[]>(route`/rest/api/3/screens/${screenId}/tabs/${t.id}/fields`)) ?? [];
    return { id: String(t.id), name: t.name, fieldIds: fields.map((f) => f.id) };
  });
}

async function screenNames(idList: string[]) {
  const out = new Map<string, string>();
  for (let i = 0; i < idList.length; i += 50) {
    const vals = await pages<{ id: number; name: string }>((s) => route`/rest/api/3/screens?${ids('id', idList.slice(i, i + 50))}&startAt=${s}&maxResults=100`);
    for (const v of vals) out.set(String(v.id), v.name);
  }
  return out;
}

export async function loadModel(projectId: string, viewer: { accountId: string; isJiraAdmin: boolean; isProjectAdmin: boolean }): Promise<ProjectModel> {
  // Independent reads start together; the instance graph and fields are only awaited when the project qualifies
  const instP = loadInstance();
  const fieldsP = loadFields();
  instP.catch(() => {}); fieldsP.catch(() => {});
  const [project, fsLink] = await Promise.all([
    jira.get<JProject>(route`/rest/api/3/project/${projectId}?expand=issueTypes`),
    jira.get<{ values: { projectId: string; schemeId: string }[] }>(route`/rest/api/3/config/fieldschemes/projects?projectId=${projectId}`, true).catch(() => null),
  ]);
  if (!project) throw new AppError('not-found', 'Project not found');
  const key = project.key;
  const base: ProjectModel = {
    project: { id: String(project.id), key, name: project.name },
    viewer: { accountId: viewer.accountId, name: '', isJiraAdmin: viewer.isJiraAdmin, isProjectAdmin: viewer.isProjectAdmin },
    issueTypes: [], itss: { id: '', name: '', projects: [], projectCount: 0, mappings: {} },
    screenSchemes: {}, screens: {}, workflows: [], fieldScheme: null, fields: {}, unused: [],
    config: await getConfig(), loadedAt: new Date().toISOString(),
  };
  const blocked = (environmentIssue: EnvironmentIssue): ProjectModel => ({ ...base, environmentIssue });
  if (project.style === 'next-gen' || project.simplified) return blocked('team-managed');

  // Field schemes only (legacy field configurations are not supported)
  if (!fsLink) return blocked('legacy-field-config');

  const [inst, fields] = await Promise.all([instP, fieldsP]);

  // field scheme
  let fieldScheme: ProjectModel['fieldScheme'] = null;
  const fsId = fsLink.values?.[0]?.schemeId;
  if (fsId) {
    const [meta, fsProjects, fsFields] = await Promise.all([
      jira.get<{ id: number; name: string }>(route`/rest/api/3/config/fieldschemes/${fsId}`),
      pages<{ key: string }>((s) => route`/rest/api/3/config/fieldschemes/${fsId}/projects?startAt=${s}&maxResults=100`),
      pages<{ fieldId: string }>((s) => route`/rest/api/3/config/fieldschemes/${fsId}/fields?startAt=${s}&maxResults=100`, 10000),
    ]);
    fieldScheme = {
      id: String(fsId), name: meta?.name ?? `Field scheme ${fsId}`, ...keysOf(new Set(fsProjects.map((p) => p.key)), key),
      fieldIds: fsFields.map((f) => f.fieldId),
    };
  }

  // issue type screen scheme of the project + mappings
  const itssId = inst.projectItss.get(key);
  if (!itssId) throw new AppError('not-found', 'No issue type screen scheme found for this project');
  const [itssMeta, mappings] = await Promise.all([
    jira.get<{ values: { id: string; name: string }[] }>(route`/rest/api/3/issuetypescreenscheme?id=${itssId}`),
    pages<{ issueTypeId: string; screenSchemeId: string }>((s) => route`/rest/api/3/issuetypescreenscheme/mapping?issueTypeScreenSchemeId=${itssId}&startAt=${s}&maxResults=50`),
  ]);
  const issueTypes = (project.issueTypes ?? []).map((it) => ({ id: String(it.id), name: it.name, iconUrl: it.iconUrl }));
  const itss = {
    id: itssId, name: itssMeta?.values?.[0]?.name ?? 'Issue type screen scheme', ...keysOf(inst.itssProjects.get(itssId), key),
    mappings: Object.fromEntries(mappings.map((m) => [String(m.issueTypeId), String(m.screenSchemeId)])),
  };

  // screen schemes in use + unused ones carrying the project prefix
  const prefixed = (name: string) => name.startsWith(`${key} `) || name.startsWith(`${key}:`) || name.startsWith(`${key}-`);
  const schemeById = new Map(inst.schemes.map((s) => [String(s.id), s]));
  const schemeIds = new Set(Object.values(itss.mappings));
  for (const s of inst.schemes) if (prefixed(s.name) && !inst.schemeUsed.has(String(s.id))) schemeIds.add(String(s.id));
  const screenSchemes: Record<string, ScreenScheme> = {};
  for (const id of schemeIds) {
    const s = schemeById.get(id);
    if (!s) continue;
    const scr: ScreenScheme['screens'] = { default: String(s.screens.default) };
    for (const o of ['create', 'edit', 'view'] as const) if (s.screens[o] !== undefined && s.screens[o] !== null) scr[o] = String(s.screens[o]);
    screenSchemes[id] = { id, name: s.name, screens: scr, createdByApp: await isCreated('screenScheme', id), ...keysOf(inst.schemeProjects.get(id), key) };
  }

  // the project's workflows (via its workflow scheme)
  const wfIds = inst.projectWorkflows.get(key) ?? new Set<string>();
  const statusName = (ref?: string | null) => (ref ? inst.statuses.get(ref)?.name ?? ref : '');
  const workflows: Workflow[] = inst.workflows.filter((w) => wfIds.has(w.id)).map((w) => ({
    id: w.id, name: w.name, version: w.version, active: true, ...keysOf(inst.workflowProjects.get(w.id), key),
    statuses: [...new Set((w.transitions ?? []).flatMap((t) => [t.toStatusReference, ...(t.links ?? []).map((l) => l.fromStatusReference ?? '')]).filter(Boolean))]
      .map((r) => ({ id: r, name: statusName(r) })),
    transitions: (w.transitions ?? []).filter((t) => t.type !== 'INITIAL').map((t) => ({
      id: String(t.id), name: t.name, to: statusName(t.toStatusReference),
      from: (t.links ?? []).map((l) => statusName(l.fromStatusReference)).filter(Boolean),
      screenId: t.transitionScreen?.parameters?.screenId ?? t.transitionScreen?.params?.screenId ?? undefined,
    })),
  }));

  // screens: referenced by those schemes + transitions + prefixed unused screens
  const screenIds = new Set<string>();
  for (const s of Object.values(screenSchemes)) for (const v of Object.values(s.screens)) if (v) screenIds.add(v);
  for (const w of workflows) for (const t of w.transitions) if (t.screenId) screenIds.add(t.screenId);
  const prefixedScreens = await pages<{ id: number; name: string }>((s) => route`/rest/api/3/screens?queryString=${key}&scope=GLOBAL&startAt=${s}&maxResults=100`, 1000).catch(() => []);
  for (const s of prefixedScreens) {
    const id = String(s.id);
    if (prefixed(s.name) && inst.screenUnused(id)) screenIds.add(id);
  }
  const names = await screenNames([...screenIds]);
  const screens: Record<string, Screen> = {};
  await pool([...screenIds].filter((id) => names.has(id)), 8, async (id) => {
    const usage = keysOf(inst.screenProjects(id), key);
    const exclusiveOrUnused = usage.projectCount === 0 || (usage.projectCount === 1 && usage.projects[0] === key);
    // Tabs are loaded eagerly for the project's own screens (editor + counts) and lazily for shared ones
    const tabs = await loadTabs(id).catch(() => [] as Tab[]);
    screens[id] = {
      id, name: names.get(id)!, tabs: exclusiveOrUnused ? tabs : undefined, tabCount: tabs.length,
      fieldCount: tabs.reduce((n, t) => n + t.fieldIds.length, 0), createdByApp: await isCreated('screen', id),
      ...usage, screenSchemeIds: [...(inst.screenSchemesOf.get(id) ?? [])].filter((s) => screenSchemes[s]),
      workflowIds: [...(inst.screenWorkflowsOf.get(id) ?? [])],
    };
  });

  // unused objects with the project prefix (+ "unused since" tracking)
  const unused: ProjectModel['unused'] = [];
  for (const s of Object.values(screens)) {
    const isUnused = inst.screenUnused(s.id) && prefixed(s.name);
    const since = await unusedSince('screen', s.id, isUnused);
    if (isUnused && since) unused.push({ kind: 'screen', id: s.id, name: s.name, since, createdByApp: s.createdByApp });
  }
  for (const s of Object.values(screenSchemes)) {
    const isUnused = !inst.schemeUsed.has(s.id) && prefixed(s.name);
    const since = await unusedSince('screenScheme', s.id, isUnused);
    if (isUnused && since) unused.push({ kind: 'screenScheme', id: s.id, name: s.name, since, createdByApp: s.createdByApp });
  }

  return { ...base, issueTypes, itss, screenSchemes, screens, workflows, fieldScheme, fields, unused };
}

/** For the copy dialog: case-insensitive substring search across the instance, own screens first. */
export async function searchScreens(m: ProjectModel, query: string, limit: number) {
  const q = query.trim().slice(0, 100);
  const all = await pages<{ id: number; name: string }>((s) => route`/rest/api/3/screens?queryString=${q}&scope=GLOBAL&startAt=${s}&maxResults=100&orderBy=name`, 500);
  const own: Screen[] = [];
  const rest: Screen[] = [];
  for (const s of all) {
    const id = String(s.id);
    const known = m.screens[id];
    if (known && !known.foreign && known.projects.length > 0 && known.projectCount <= 1 && known.projects.every((p) => p === m.project.key)) own.push({ ...known, tabs: undefined });
    else rest.push({ id, name: s.name, tabCount: known?.tabCount ?? 0, fieldCount: known?.fieldCount ?? 0, createdByApp: false, projects: known?.projects ?? [], projectCount: known?.projectCount ?? 0, screenSchemeIds: [], workflowIds: [], foreign: true });
  }
  const page = rest.slice(0, Math.min(limit, 100));
  // counts for the visible page only
  await pool(page.filter((s) => !s.tabCount), 5, async (s) => {
    const tabs = await loadTabs(s.id).catch(() => []);
    s.tabCount = tabs.length;
    s.fieldCount = tabs.reduce((n, t) => n + t.fieldIds.length, 0);
  });
  return { own, all: page, total: rest.length };
}
