/**
 * Pure domain rules for Screen Self-Service. Used by UI previews, the local mock and the backend.
 * Covers exclusivity, naming, grouping, applying plan steps to a model, unused detection, planning every
 * intent (assign, split, merge, transition, delete and more) and the execution order of steps.
 *
 * @file        src/shared/domain.ts
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import type {
  IssueType, LayoutSave, Op, Plan, PlanStep, PreviewItem, ProjectModel, Screen, ScreenScheme, Tab,
} from './types';
import { OPS } from './types';

export const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

// ---------- Exclusivity ----------

export function onlyProject(o: { projects: string[]; projectCount: number }, key: string) {
  return o.projectCount <= 1 && o.projects.every((p) => p === key);
}

export function screenExclusive(m: ProjectModel, screenId: string) {
  const s = m.screens[screenId];
  return !!s && !s.foreign && onlyProject(s, m.project.key);
}

export function schemeExclusive(m: ProjectModel, schemeId: string) {
  const s = m.screenSchemes[schemeId];
  return !!s && onlyProject(s, m.project.key);
}

export function itssExclusive(m: ProjectModel) {
  return onlyProject(m.itss, m.project.key);
}

export function otherProjects(o: { projects: string[]; projectCount: number }, key: string) {
  return Math.max(o.projectCount, o.projects.length) - (o.projects.includes(key) ? 1 : 0);
}

// ---------- Naming ----------

export const screenName = (key: string, issueType: string, ops: Op[]) =>
  `${key} ${issueType} - ${OPS.filter((o) => ops.includes(o)).join(', ')} - Screen`;
export const schemeName = (key: string, issueType: string) => `${key} ${issueType} - Screen Scheme`;
/** Fields every new screen that creates issues starts with. */
export const CREATE_SEED = ['summary', 'issuetype'] as const;
export const transitionScreenName =(key: string, text: string) => `${key} Transition - ${text.trim()} - Screen`;

/** Collision counter, recalculated on every rename: "X", "X (2)", "X (3)" … */
export function uniqueName(name: string, taken: Set<string>) {
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) {
    const n = `${name} (${i})`;
    if (!taken.has(n.toLowerCase())) return n;
  }
}

// ---------- Overview helpers ----------

export function schemeIdFor(m: ProjectModel, issueTypeId: string) {
  return m.itss.mappings[issueTypeId] ?? m.itss.mappings.default;
}

export interface Group {
  schemeId: string;
  issueTypes: IssueType[];
  title: string;
}

export function groupsOf(m: ProjectModel): Group[] {
  const map = new Map<string, IssueType[]>();
  for (const it of m.issueTypes) {
    const sid = schemeIdFor(m, it.id);
    if (!sid) continue;
    map.set(sid, [...(map.get(sid) ?? []), it]);
  }
  return [...map.entries()]
    .map(([schemeId, its]) => {
      const issueTypes = [...its].sort(byName);
      return { schemeId, issueTypes, title: issueTypes.map((i) => i.name).join(', ') };
    })
    .sort((a, b) => byName(a.issueTypes[0], b.issueTypes[0]));
}

export function effective(scheme: ScreenScheme, op: Op) {
  const explicit = scheme.screens[op];
  return { screenId: explicit ?? scheme.screens.default, inherited: op !== 'default' && !explicit };
}

export function explicitOps(scheme: ScreenScheme, screenId: string): Op[] {
  return OPS.filter((o) => scheme.screens[o] === screenId);
}

// ---------- Plan application (mock execution + hypothetical state for previews) ----------

export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

/** Recompute usage (projects, schemes, workflows) of every screen and scheme from the model itself. */
export function recomputeUsage(m: ProjectModel) {
  const key = m.project.key;
  const usedSchemes = new Set(Object.values(m.itss.mappings));
  for (const sc of Object.values(m.screenSchemes)) {
    if (sc.projects.every((p) => p === key) && sc.projectCount <= 1) {
      sc.projects = usedSchemes.has(sc.id) ? [key] : [];
      sc.projectCount = sc.projects.length;
    }
  }
  for (const s of Object.values(m.screens)) {
    if (s.foreign) continue;
    s.screenSchemeIds = Object.values(m.screenSchemes)
      .filter((sc) => Object.values(sc.screens).includes(s.id))
      .map((sc) => sc.id);
    s.workflowIds = m.workflows.filter((w) => w.transitions.some((t) => t.screenId === s.id)).map((w) => w.id);
    if (s.projectCount <= 1 && s.projects.every((p) => p === key)) {
      const viaScheme = s.screenSchemeIds.some((id) => m.screenSchemes[id]?.projects.length);
      s.projects = viaScheme || s.workflowIds.length ? [key] : [];
      s.projectCount = s.projects.length;
    }
  }
}

export function applySteps(m: ProjectModel, steps: PlanStep[], today = new Date().toISOString()) {
  for (const st of steps) {
    switch (st.kind) {
      case 'createScreen': {
        const src = st.copyFrom ? m.screens[st.copyFrom] : undefined;
        const tabs: Tab[] = src?.tabs
          ? clone(src.tabs).map((t, i) => ({ ...t, id: `${st.ref}-t${i}` }))
          : [{ id: `${st.ref}-t0`, name: 'Field Tab', fieldIds: [...(st.seed ?? [])] }];
        m.screens[st.ref] = {
          id: st.ref, name: st.name, tabs, tabCount: src?.tabCount ?? 1, fieldCount: src?.fieldCount ?? st.seed?.length ?? 0,
          createdByApp: true, projects: [], projectCount: 0, screenSchemeIds: [], workflowIds: [],
        };
        break;
      }
      case 'renameScreen':
        if (m.screens[st.screenId]) m.screens[st.screenId].name = st.to;
        break;
      case 'createScreenScheme':
        m.screenSchemes[st.ref] = {
          id: st.ref, name: st.name, createdByApp: true, projects: [], projectCount: 0,
          screens: { ...(st.screens as ScreenScheme['screens']) },
        };
        break;
      case 'updateScreenScheme':
        m.screenSchemes[st.schemeId].screens = stripUndefined(st.screens);
        break;
      case 'renameScreenScheme':
        m.screenSchemes[st.schemeId].name = st.to;
        break;
      case 'mapIssueType':
        if (st.screenSchemeId) m.itss.mappings[st.issueTypeId] = st.screenSchemeId;
        else delete m.itss.mappings[st.issueTypeId];
        break;
      case 'setTransitionScreen': {
        const t = m.workflows.find((w) => w.id === st.workflowId)?.transitions.find((x) => x.id === st.transitionId);
        if (t) t.screenId = st.screenId ?? undefined;
        break;
      }
      case 'deleteScreen':
        delete m.screens[st.screenId];
        break;
      case 'deleteScreenScheme':
        delete m.screenSchemes[st.schemeId];
        break;
    }
  }
  recomputeUsage(m);
  // Maintain the "unused since" list
  const day = today.slice(0, 10);
  const nowUnused = [
    ...Object.values(m.screens).filter((s) => isUnusedScreen(m, s)).map((s) => ({ kind: 'screen' as const, s })),
    ...Object.values(m.screenSchemes).filter((s) => isUnusedScheme(m, s)).map((s) => ({ kind: 'screenScheme' as const, s })),
  ];
  const prev = new Map(m.unused.map((u) => [`${u.kind}-${u.id}`, u]));
  m.unused = nowUnused.map(({ kind, s }) =>
    prev.get(`${kind}-${s.id}`) ?? {
      kind, id: s.id, name: s.name, createdByApp: s.createdByApp, since: day,
    });
  for (const u of m.unused) u.name = (u.kind === 'screen' ? m.screens[u.id] : m.screenSchemes[u.id])?.name ?? u.name;
  return m;
}

function stripUndefined(s: Record<Op, string | undefined>): ScreenScheme['screens'] {
  const out: ScreenScheme['screens'] = { default: s.default! };
  for (const o of ['create', 'edit', 'view'] as const) if (s[o]) out[o] = s[o];
  return out;
}

const projectPrefix = (m: ProjectModel, name: string) => name.startsWith(`${m.project.key} `) || name.startsWith(`${m.project.key}:`);

/** A screen is unused when no workflow uses it and every screen scheme holding it is itself unused. */
export function isUnusedScreen(m: ProjectModel, s: Screen) {
  const schemesUnused = s.screenSchemeIds.every((id) => !m.screenSchemes[id] || isUnusedScheme(m, m.screenSchemes[id]));
  return !s.foreign && s.projectCount === 0 && schemesUnused && s.workflowIds.length === 0
    && (s.createdByApp || projectPrefix(m, s.name));
}
export function isUnusedScheme(m: ProjectModel, s: ScreenScheme) {
  return s.projectCount === 0 && !Object.values(m.itss.mappings).includes(s.id)
    && (s.createdByApp || projectPrefix(m, s.name));
}

// ---------- Renaming ----------

/** Rename steps so that names reflect the current assignment, for the given schemes. */
export function renameSteps(m: ProjectModel, schemeIds: string[]): PlanStep[] {
  const key = m.project.key;
  const steps: PlanStep[] = [];
  const renaming = new Map<string, string>(); // screenId -> target base name
  const schemeTargets = new Map<string, string>();
  for (const sid of new Set(schemeIds)) {
    const sc = m.screenSchemes[sid];
    if (!sc || !schemeExclusive(m, sid)) continue;
    const its = m.issueTypes.filter((it) => schemeIdFor(m, it.id) === sid).sort(byName);
    if (!its.length) continue;
    const first = its[0].name;
    schemeTargets.set(sid, schemeName(key, first));
    for (const screenId of new Set(Object.values(sc.screens))) {
      if (!screenId || !screenExclusive(m, screenId)) continue;
      if (m.screens[screenId].workflowIds.length) continue; // also a transition screen: keep its name
      renaming.set(screenId, '');
    }
  }
  // A screen used by several schemes is named after the alphabetically first issue type among ALL of them,
  // with the operations it has in that issue type's scheme (UC-11: "shared screens keep the name of the
  // alphabetically first issue type"). Independent of the order in which schemes were touched.
  for (const screenId of renaming.keys()) {
    const users = m.issueTypes
      .map((it) => ({ it, sid: schemeIdFor(m, it.id) }))
      .filter((x) => x.sid && Object.values(m.screenSchemes[x.sid]?.screens ?? {}).includes(screenId))
      .sort((a, b) => byName(a.it, b.it));
    if (!users.length) { renaming.delete(screenId); continue; }
    renaming.set(screenId, screenName(key, users[0].it.name, explicitOps(m.screenSchemes[users[0].sid], screenId)));
  }
  const taken = new Set(
    Object.values(m.screens).filter((s) => !renaming.has(s.id)).map((s) => s.name.toLowerCase()),
  );
  for (const [id, base] of renaming) {
    const to = uniqueName(base, taken);
    taken.add(to.toLowerCase());
    const from = m.screens[id].name;
    if (from !== to) steps.push({ kind: 'renameScreen', screenId: id, from, to });
  }
  const takenSchemes = new Set(
    Object.values(m.screenSchemes).filter((s) => !schemeTargets.has(s.id)).map((s) => s.name.toLowerCase()),
  );
  for (const [id, base] of schemeTargets) {
    const to = uniqueName(base, takenSchemes);
    takenSchemes.add(to.toLowerCase());
    const from = m.screenSchemes[id].name;
    if (from !== to) steps.push({ kind: 'renameScreenScheme', schemeId: id, from, to });
  }
  return steps;
}

function finish(m: ProjectModel, base: PlanStep[], affectedSchemes: string[], extra: PreviewItem[] = []): Plan {
  const hypo = applySteps(clone(m), base);
  const renames = renameSteps(hypo, affectedSchemes);
  const after = applySteps(hypo, renames);
  const steps = [...base, ...renames];
  const preview: PreviewItem[] = [];
  for (const st of steps) {
    if (st.kind === 'createScreen') {
      const finalName = (renames.find((r) => r.kind === 'renameScreen' && r.screenId === st.ref) as { to: string } | undefined)?.to ?? st.name;
      preview.push({ kind: 'new', title: finalName, detail: st.copyFrom ? `copy:${m.screens[st.copyFrom]?.name ?? ''}` : st.seed?.length ? 'seeded' : 'empty' });
    } else if (st.kind === 'createScreenScheme') {
      preview.push({ kind: 'new', title: st.name });
    } else if (st.kind === 'renameScreen' && m.screens[st.screenId]) {
      preview.push({ kind: 'renamed', title: st.to, from: st.from });
    } else if (st.kind === 'renameScreenScheme' && m.screenSchemes[st.schemeId]) {
      preview.push({ kind: 'renamed', title: st.to, from: st.from });
    }
  }
  // Objects that become unused by this plan
  const wasUnused = new Set(m.unused.map((u) => `${u.kind}-${u.id}`));
  for (const u of after.unused) if (!wasUnused.has(`${u.kind}-${u.id}`) && (u.kind === 'screen' ? m.screens[u.id] : m.screenSchemes[u.id])) {
    preview.push({ kind: 'freed', title: u.name });
  }
  preview.push(...extra);
  const guard: Plan['guard'] = { screens: [], screenSchemes: [], itss: false, workflows: [] };
  for (const st of steps) {
    if (st.kind === 'renameScreen' || st.kind === 'deleteScreen') guard.screens.push(st.screenId);
    if (st.kind === 'updateScreenScheme' || st.kind === 'renameScreenScheme' || st.kind === 'deleteScreenScheme') guard.screenSchemes.push(st.schemeId);
    if (st.kind === 'mapIssueType') guard.itss = true;
    if (st.kind === 'setTransitionScreen') guard.workflows.push(st.workflowId);
  }
  return { steps, preview, guard };
}

let refSeq = 0;
export const newRef = () => `new-${Date.now().toString(36)}-${(refSeq++).toString(36)}`;

// UC-03 / UC-04 / UC-05: change assignments (optionally with new screens)
export interface NewScreenSpec { ref: string; copyFrom?: string; op: Op; issueType: string }

export function planAssignment(
  m: ProjectModel, schemeId: string, next: Record<Op, string | undefined>, newScreens: NewScreenSpec[] = [],
): Plan {
  const sc = m.screenSchemes[schemeId];
  const key = m.project.key;
  const norm = { ...next };
  for (const o of ['create', 'edit', 'view'] as const) if (norm[o] === norm.default) norm[o] = undefined;
  const steps: PlanStep[] = [];
  for (const n of newScreens) {
    if (!Object.values(norm).includes(n.ref)) continue;
    const ops = OPS.filter((o) => norm[o] === n.ref);
    // A screen that is used to create issues must hold Summary (and Issue Type), or creating issues fails
    const createsIssues = ops.includes('create') || (ops.includes('default') && !norm.create);
    const seed = !n.copyFrom && createsIssues ? [...CREATE_SEED] : undefined;
    steps.push({ kind: 'createScreen', ref: n.ref, name: screenName(key, n.issueType, ops), copyFrom: n.copyFrom, ...(seed ? { seed } : {}) });
  }
  const changed = OPS.some((o) => (norm[o] ?? undefined) !== (sc.screens[o] ?? undefined));
  if (changed) steps.push({ kind: 'updateScreenScheme', schemeId, screens: norm, before: { default: sc.screens.default, create: sc.screens.create, edit: sc.screens.edit, view: sc.screens.view } });
  const extra: PreviewItem[] = [];
  for (const o of OPS) {
    const was = sc.screens[o];
    const now = norm[o];
    if ((was ?? '') === (now ?? '')) {
      if (o !== 'default' && !now) extra.push({ kind: 'unchanged', title: `op:${o}`, detail: 'inherits' });
      continue;
    }
    if (o !== 'default' && !now) extra.push({ kind: 'changed', title: `op:${o}`, detail: 'inherits' });
    else extra.push({ kind: 'changed', title: `op:${o}`, detail: `screen:${now}` });
  }
  return finish(m, steps, [schemeId], extra);
}

// UC-11: split off issue type
export function planSplit(m: ProjectModel, schemeId: string, issueTypeId: string, mode: 'copy' | 'share'): Plan {
  const key = m.project.key;
  const it = m.issueTypes.find((i) => i.id === issueTypeId)!;
  const sc = m.screenSchemes[schemeId];
  const steps: PlanStep[] = [];
  const screens: Record<Op, string | undefined> = { default: undefined, create: undefined, edit: undefined, view: undefined };
  if (mode === 'copy') {
    const refs = new Map<string, string>();
    for (const o of OPS) {
      const sid = sc.screens[o];
      if (!sid) continue;
      if (!refs.has(sid)) {
        // Deterministic refs: the client's preview and the backend's re-plan must produce identical plans
        const ref = `new-split-${issueTypeId.toLowerCase()}-${refs.size}`;
        refs.set(sid, ref);
        steps.push({ kind: 'createScreen', ref, name: screenName(key, it.name, explicitOps(sc, sid)), copyFrom: sid });
      }
      screens[o] = refs.get(sid);
    }
  } else {
    for (const o of OPS) screens[o] = sc.screens[o];
  }
  const ref = `new-split-${issueTypeId.toLowerCase()}-scheme`;
  steps.push({ kind: 'createScreenScheme', ref, name: schemeName(key, it.name), screens });
  steps.push({ kind: 'mapIssueType', itssId: m.itss.id, issueTypeId, screenSchemeId: ref, from: m.itss.mappings[issueTypeId] ?? null });
  const remaining = m.issueTypes.filter((i) => i.id !== issueTypeId && schemeIdFor(m, i.id) === schemeId);
  const extra: PreviewItem[] = [
    { kind: 'changed', title: 'mapping', detail: `${it.name}` },
    { kind: 'unchanged', title: 'remaining', detail: remaining.map((r) => r.name).join(', ') },
  ];
  return finish(m, steps, [schemeId, ref], extra);
}

// UC-12: merge issue type into another group's screen scheme
export function planMerge(m: ProjectModel, issueTypeId: string, targetSchemeId: string): Plan {
  const from = schemeIdFor(m, issueTypeId);
  const steps: PlanStep[] = [{ kind: 'mapIssueType', itssId: m.itss.id, issueTypeId, screenSchemeId: targetSchemeId, from: m.itss.mappings[issueTypeId] ?? null }];
  return finish(m, steps, [from, targetSchemeId]);
}

// UC-06
export function planTransition(m: ProjectModel, screenId: string, workflowId: string, transitionId: string, on: boolean): Plan {
  const current = m.workflows.find((w) => w.id === workflowId)?.transitions.find((t) => t.id === transitionId)?.screenId ?? null;
  return finish(m, [{ kind: 'setTransitionScreen', workflowId, transitionId, screenId: on ? screenId : null, from: current }], []);
}

export function planNewTransitionScreen(m: ProjectModel, text: string, copyFrom?: string): Plan {
  const taken = new Set(Object.values(m.screens).map((s) => s.name.toLowerCase()));
  const name = uniqueName(transitionScreenName(m.project.key, text), taken);
  return finish(m, [{ kind: 'createScreen', ref: 'new-transition', name, copyFrom }], []);
}

// UC-08: manual deletion (schemes before screens)
export function planDelete(m: ProjectModel, items: { kind: 'screen' | 'screenScheme'; id: string }[]): Plan {
  const schemes = items.filter((x) => x.kind === 'screenScheme' && m.screenSchemes[x.id]).map((x) => x.id);
  const screens = items.filter((x) => x.kind === 'screen' && m.screens[x.id]).map((x) => x.id);
  const steps: PlanStep[] = [
    ...schemes.map((id) => ({ kind: 'deleteScreenScheme' as const, schemeId: id, name: m.screenSchemes[id].name })),
    ...screens.map((id) => ({ kind: 'deleteScreen' as const, screenId: id, name: m.screens[id].name })),
  ];
  const plan = finish(m, steps, []);
  plan.preview = steps.map((s) => ({ kind: 'deleted', title: (s as { name: string }).name }));
  return plan;
}

// ---------- Editor ----------

export interface LayoutOp {
  kind: 'addTab' | 'renameTab' | 'deleteTab' | 'moveTab' | 'addField' | 'removeField' | 'moveField';
  tab?: string; name?: string; field?: string; position?: number; after?: string | null;
}

/** Count changes between two layouts, for the "unsaved changes" bar. */
export function layoutChanges(a: Tab[], b: LayoutSave['tabs']): number {
  let n = 0;
  const aIds = a.map((t) => t.id);
  const bIds = b.map((t) => t.id).filter(Boolean) as string[];
  n += b.filter((t) => !t.id).length;
  n += aIds.filter((id) => !bIds.includes(id)).length;
  if (aIds.filter((id) => bIds.includes(id)).join() !== bIds.join()) n++;
  for (const t of b) {
    const old = a.find((x) => x.id === t.id);
    if (!old) { n += t.fieldIds.length; continue; }
    if (old.name !== t.name) n++;
    const added = t.fieldIds.filter((f) => !old.fieldIds.includes(f));
    const removed = old.fieldIds.filter((f) => !t.fieldIds.includes(f));
    n += added.length + removed.length;
    const keep = old.fieldIds.filter((f) => t.fieldIds.includes(f));
    if (keep.join() !== t.fieldIds.filter((f) => old.fieldIds.includes(f)).join()) n++;
  }
  return n;
}

/** Fields on the screen that aren't in the project's field scheme (added on save if exclusive). */
export function missingFromFieldScheme(m: ProjectModel, fieldIds: string[]) {
  if (!m.fieldScheme) return [];
  const have = new Set(m.fieldScheme.fieldIds);
  return fieldIds.filter((f) => !have.has(f) && !m.fields[f]?.system);
}

// ---------- Intent -> Plan (+ validation). Runs identically in the browser and on the backend. ----------

export class RuleError extends Error {
  constructor(public code: 'locked' | 'invalid' | 'not-found', message: string) { super(message); }
}

export function planFor(m: ProjectModel, intent: import('./types').Intent): Plan {
  const key = m.project.key;
  switch (intent.type) {
    case 'assign': {
      const sc = m.screenSchemes[intent.schemeId];
      if (!sc || !Object.values(m.itss.mappings).includes(sc.id)) throw new RuleError('not-found', 'Screen scheme is not used by this project');
      if (!schemeExclusive(m, sc.id)) throw new RuleError('locked', 'Screen scheme is shared with other projects');
      if (!intent.next.default) throw new RuleError('invalid', 'Default is mandatory');
      const refs = new Set(intent.newScreens.map((n) => n.ref));
      for (const o of OPS) {
        const id = intent.next[o];
        if (!id || refs.has(id)) continue;
        // Only screens of the own project may be assigned; everything else goes through a copy (UC-03/04)
        const s = m.screens[id];
        if (!s || s.foreign || !onlyProject(s, key)) throw new RuleError('invalid', `Screen ${id} is not a screen of ${key}`);
      }
      for (const n of intent.newScreens) {
        if (!/^new-[a-z0-9-]+$/.test(n.ref)) throw new RuleError('invalid', 'Bad reference');
        if (n.copyFrom && !m.screens[n.copyFrom]) throw new RuleError('not-found', 'Template screen not found');
        if (!m.issueTypes.some((i) => i.name === n.issueType)) throw new RuleError('invalid', 'Unknown issue type');
      }
      return planAssignment(m, sc.id, intent.next, intent.newScreens);
    }
    case 'split': {
      if (!itssExclusive(m)) throw new RuleError('locked', 'Issue type screen scheme is shared');
      if (!schemeExclusive(m, intent.schemeId)) throw new RuleError('locked', 'Screen scheme is shared');
      const members = m.issueTypes.filter((i) => schemeIdFor(m, i.id) === intent.schemeId);
      if (members.length < 2 || !members.some((i) => i.id === intent.issueTypeId)) throw new RuleError('invalid', 'Issue type is not part of this group');
      return planSplit(m, intent.schemeId, intent.issueTypeId, intent.mode);
    }
    case 'merge': {
      if (!itssExclusive(m)) throw new RuleError('locked', 'Issue type screen scheme is shared');
      if (!m.issueTypes.some((i) => i.id === intent.issueTypeId)) throw new RuleError('not-found', 'Unknown issue type');
      if (!Object.values(m.itss.mappings).includes(intent.targetSchemeId)) throw new RuleError('invalid', 'Target is not used by this project');
      if (!schemeExclusive(m, intent.targetSchemeId)) throw new RuleError('locked', 'Target screen scheme is shared');
      if (schemeIdFor(m, intent.issueTypeId) === intent.targetSchemeId) throw new RuleError('invalid', 'Already uses this scheme');
      return planMerge(m, intent.issueTypeId, intent.targetSchemeId);
    }
    case 'transition': {
      const wf = m.workflows.find((w) => w.id === intent.workflowId);
      if (!wf || !wf.transitions.some((t) => t.id === intent.transitionId)) throw new RuleError('not-found', 'Transition not found');
      if (!onlyProject(wf, key)) throw new RuleError('locked', 'Workflow is shared with other projects');
      const s = m.screens[intent.screenId];
      if (!s || s.foreign || !onlyProject(s, key)) throw new RuleError('invalid', 'Screen is not a screen of this project');
      return planTransition(m, intent.screenId, intent.workflowId, intent.transitionId, intent.on);
    }
    case 'newTransitionScreen': {
      const text = intent.text.trim();
      if (!text || text.length > 120 || /[<>]/.test(text)) throw new RuleError('invalid', 'Please enter a name (max. 120 characters)');
      if (intent.copyFrom && !m.screens[intent.copyFrom]) throw new RuleError('not-found', 'Template screen not found');
      return planNewTransitionScreen(m, text, intent.copyFrom);
    }
    case 'normalizeNames': {
      const ids = [...new Set(Object.values(m.itss.mappings))].filter((id) => schemeExclusive(m, id));
      return finish(m, [], ids);
    }
    case 'delete': {
      const schemeIds = intent.items.filter((x) => x.kind === 'screenScheme').map((x) => x.id);
      for (const { kind, id } of intent.items) {
        const u = m.unused.find((x) => x.id === id && x.kind === kind);
        if (!u) throw new RuleError('invalid', 'Only unused objects of this project can be deleted');
        // Deleting configuration is a Jira-admin right; the app only cleans up what it created itself
        if (!u.createdByApp) throw new RuleError('locked', `"${u.name}" was not created by this app. Only your Jira admin can delete it.`);
        const obj = u.kind === 'screen' ? m.screens[id] : m.screenSchemes[id];
        if (!obj || !onlyProject(obj, key)) throw new RuleError('locked', 'Object is not exclusive to this project');
        if (u.kind === 'screen') {
          // Jira refuses to delete a screen that is still part of a screen scheme
          const holder = Object.values(m.screenSchemes).find((sc) => Object.values(sc.screens).includes(id) && !schemeIds.includes(sc.id));
          if (holder) throw new RuleError('invalid', `Delete the screen scheme "${holder.name}" first — it still contains this screen.`);
        }
      }
      return planDelete(m, intent.items);
    }
  }
}

/**
 * Order steps for execution against Jira, where names must be unique at every moment:
 * 1. rename existing objects (frees names), 2. create objects with their final names,
 * 3. rewire schemes, mappings and transitions, 4. delete (screen schemes before screens).
 */
export function executionOrder(steps: PlanStep[]): PlanStep[] {
  const finalName = new Map<string, string>();
  for (const s of steps) {
    if (s.kind === 'renameScreen') finalName.set(s.screenId, s.to);
    if (s.kind === 'renameScreenScheme') finalName.set(s.schemeId, s.to);
  }
  const created = new Set(steps.flatMap((s) => (s.kind === 'createScreen' || s.kind === 'createScreenScheme' ? [s.ref] : [])));
  const rank = (s: PlanStep) => ({
    renameScreen: 0, renameScreenScheme: 0, createScreen: 1, createScreenScheme: 2, updateScreenScheme: 3,
    mapIssueType: 4, setTransitionScreen: 5, deleteScreenScheme: 6, deleteScreen: 7,
  })[s.kind];
  return steps
    .filter((s) => !((s.kind === 'renameScreen' && created.has(s.screenId)) || (s.kind === 'renameScreenScheme' && created.has(s.schemeId))))
    .map((s) => (s.kind === 'createScreen' || s.kind === 'createScreenScheme' ? { ...s, name: finalName.get(s.ref) ?? s.name } : s))
    .map((s, i) => ({ s, i }))
    .sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i)
    .map((x) => x.s);
}
