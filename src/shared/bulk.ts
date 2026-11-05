/**
 * Bulk field changes and configuration health checks. Pure functions: the UI uses them for previews,
 * the backend recomputes them from fresh Jira state before anything is written.
 *
 * @file        src/shared/bulk.ts
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import type { LayoutSave, Op, ProjectModel, Tab } from './types';
import { OPS } from './types';
import { effective, groupsOf, missingFromFieldScheme, onlyProject, renameSteps, schemeExclusive, screenExclusive } from './domain';
import { tabsDigest } from './digest';

// ------------------------------------------------------------------ bulk field changes

export interface BulkSpec {
  action: 'add' | 'remove';
  fieldIds: string[];
  screenIds: string[];
  /** where added fields go: the first tab, or a tab with this name (created when missing) */
  tab: { mode: 'first' } | { mode: 'named'; name: string };
}

export type BulkStatus = 'change' | 'noop' | 'locked' | 'blocked';

export interface BulkItem {
  screenId: string;
  name: string;
  status: BulkStatus;
  /** fields that will actually be added / removed on this screen */
  fields: string[];
  /** fields skipped on this screen and why (already there, required, not there) */
  skipped: { fieldId: string; reason: 'present' | 'required' | 'absent' }[];
  reason?: string;
  save?: LayoutSave;
}

export function bulkPlan(m: ProjectModel, spec: BulkSpec): BulkItem[] {
  const fieldIds = [...new Set(spec.fieldIds)].filter((f) => m.fields[f]);
  const fsShared = !!m.fieldScheme && !onlyProject(m.fieldScheme, m.project.key);
  return [...new Set(spec.screenIds)].map((screenId): BulkItem => {
    const s = m.screens[screenId];
    if (!s) return { screenId, name: screenId, status: 'blocked', fields: [], skipped: [], reason: 'not-found' };
    if (!screenExclusive(m, screenId)) return { screenId, name: s.name, status: 'locked', fields: [], skipped: [], reason: 'shared' };
    const tabs: Tab[] = (s.tabs ?? []).map((t) => ({ ...t, fieldIds: [...t.fieldIds] }));
    if (!tabs.length) return { screenId, name: s.name, status: 'blocked', fields: [], skipped: [], reason: 'no-tabs' };
    const onScreen = new Set(tabs.flatMap((t) => t.fieldIds));
    const fields: string[] = [];
    const skipped: BulkItem['skipped'] = [];
    let newTab: { id: null; name: string; fieldIds: string[] } | null = null;
    if (spec.action === 'add') {
      let target: { fieldIds: string[] } = tabs[0];
      if (spec.tab.mode === 'named') {
        const name = spec.tab.name.trim();
        const found = tabs.find((t) => t.name.toLowerCase() === name.toLowerCase());
        if (found) target = found;
        else { newTab = { id: null, name, fieldIds: [] }; target = newTab; }
      }
      for (const f of fieldIds) {
        if (onScreen.has(f)) { skipped.push({ fieldId: f, reason: 'present' }); continue; }
        target.fieldIds.push(f);
        fields.push(f);
      }
    } else {
      for (const f of fieldIds) {
        if (!onScreen.has(f)) { skipped.push({ fieldId: f, reason: 'absent' }); continue; }
        if (m.fields[f]?.locked) { skipped.push({ fieldId: f, reason: 'required' }); continue; }
        for (const t of tabs) t.fieldIds = t.fieldIds.filter((x) => x !== f);
        fields.push(f);
      }
    }
    if (!fields.length) return { screenId, name: s.name, status: 'noop', fields, skipped };
    // fields new to the project's field scheme can only be added when the scheme belongs to the project
    if (spec.action === 'add' && fsShared && missingFromFieldScheme(m, fields).length) {
      return { screenId, name: s.name, status: 'blocked', fields, skipped, reason: 'field-scheme-shared' };
    }
    const desired = [...tabs.map((t) => ({ id: t.id as string | null, name: t.name, fieldIds: t.fieldIds })), ...(newTab && newTab.fieldIds.length ? [newTab] : [])];
    return { screenId, name: s.name, status: 'change', fields, skipped, save: { screenId, tabs: desired, baseDigest: tabsDigest(s.tabs ?? []) } };
  });
}

/** Ready-made target sets, so a busy admin picks "all create screens" instead of ticking boxes. */
export function bulkPresets(m: ProjectModel) {
  const byOp: Record<Op, Set<string>> = { default: new Set(), create: new Set(), edit: new Set(), view: new Set() };
  for (const g of groupsOf(m)) {
    const sc = m.screenSchemes[g.schemeId];
    for (const o of OPS) { const id = effective(sc, o).screenId; if (screenExclusive(m, id)) byOp[o].add(id); }
  }
  const all = new Set(Object.values(byOp).flatMap((s) => [...s]));
  return { all: [...all], create: [...byOp.create], edit: [...byOp.edit], view: [...byOp.view], createEdit: [...new Set([...byOp.create, ...byOp.edit])] };
}

// ------------------------------------------------------------------ health checks

export type CheckId = 'missing-summary' | 'empty-transition' | 'hidden-fields' | 'names' | 'empty-tabs' | 'unused';

export interface Check {
  id: CheckId;
  severity: 'error' | 'warning' | 'info';
  /** objects affected, for display */
  items: { id: string; name: string; detail?: string }[];
  /** what pressing "Fix" does, or null when the project admin can't fix it here */
  fix: { kind: 'layouts'; saves: LayoutSave[] } | { kind: 'intent'; intent: { type: 'normalizeNames' } } | { kind: 'fieldScheme'; fieldIds: string[] } | { kind: 'navigate'; page: 'unused' | 'transitions' } | null;
  /** why there is no fix (e.g. shared field scheme) */
  blocked?: 'field-scheme-shared' | 'shared-screen';
}

/** Screens the project uses for its issue types (deduplicated), with the operations each serves. */
function projectScreens(m: ProjectModel) {
  const uses = new Map<string, Set<Op>>();
  for (const g of groupsOf(m)) {
    const sc = m.screenSchemes[g.schemeId];
    for (const o of OPS) { const id = effective(sc, o).screenId; uses.set(id, (uses.get(id) ?? new Set()).add(o)); }
  }
  return uses;
}

export function healthChecks(m: ProjectModel): Check[] {
  const out: Check[] = [];
  const uses = projectScreens(m);
  const own = [...uses.keys()].filter((id) => screenExclusive(m, id) && m.screens[id]?.tabs);

  // 1. A create screen without Summary makes "Create issue" fail for that issue type
  const noSummary = [...uses].filter(([id, ops]) => ops.has('create') && m.screens[id]?.tabs && !m.screens[id].tabs!.some((t) => t.fieldIds.includes('summary')));
  if (noSummary.length) {
    const fixable = noSummary.filter(([id]) => screenExclusive(m, id));
    out.push({
      id: 'missing-summary', severity: 'error',
      items: noSummary.map(([id]) => ({ id, name: m.screens[id].name })),
      fix: fixable.length ? { kind: 'layouts', saves: fixable.map(([id]) => {
        const tabs = m.screens[id].tabs!;
        return { screenId: id, baseDigest: tabsDigest(tabs), tabs: tabs.map((t, i) => ({ id: t.id, name: t.name, fieldIds: i === 0 ? ['summary', ...t.fieldIds] : t.fieldIds })) };
      }) } : null,
      blocked: fixable.length ? undefined : 'shared-screen',
    });
  }

  // 2. A transition screen without fields pops up an empty dialog every time the transition runs
  const onTransitions = new Map<string, string[]>();
  for (const w of m.workflows) for (const tr of w.transitions) {
    if (tr.screenId) onTransitions.set(tr.screenId, [...(onTransitions.get(tr.screenId) ?? []), tr.name]);
  }
  const emptyTransition = [...onTransitions].filter(([id]) => {
    const s = m.screens[id];
    return s && (s.tabs ? s.tabs.every((t) => !t.fieldIds.length) : s.fieldCount === 0);
  });
  if (emptyTransition.length) {
    out.push({
      id: 'empty-transition', severity: 'warning',
      items: emptyTransition.map(([id, names]) => ({ id, name: m.screens[id].name, detail: [...new Set(names)].join(', ') })),
      fix: { kind: 'navigate', page: 'transitions' },
    });
  }

  // 3. Fields on a screen but missing from the project's field scheme are invisible to users
  const fieldsOnScreens = [...new Set(own.flatMap((id) => m.screens[id].tabs!.flatMap((t) => t.fieldIds)))];
  const hidden = missingFromFieldScheme(m, fieldsOnScreens);
  if (hidden.length && m.fieldScheme) {
    const exclusive = onlyProject(m.fieldScheme, m.project.key);
    out.push({
      id: 'hidden-fields', severity: 'warning',
      items: hidden.map((f) => ({ id: f, name: m.fields[f]?.name ?? f, detail: own.filter((id) => m.screens[id].tabs!.some((t) => t.fieldIds.includes(f))).map((id) => m.screens[id].name).join(', ') })),
      fix: exclusive ? { kind: 'fieldScheme', fieldIds: hidden } : null,
      blocked: exclusive ? undefined : 'field-scheme-shared',
    });
  }

  // 4. Names that no longer follow the naming scheme ("(2)" leftovers, legacy names)
  const schemeIds = [...new Set(Object.values(m.itss.mappings))].filter((id) => schemeExclusive(m, id));
  const renames = renameSteps(m, schemeIds);
  if (renames.length) {
    out.push({
      id: 'names', severity: 'info',
      items: renames.flatMap((r) => (r.kind === 'renameScreen' ? [{ id: r.screenId, name: r.from, detail: r.to }] : r.kind === 'renameScreenScheme' ? [{ id: r.schemeId, name: r.from, detail: r.to }] : [])),
      fix: { kind: 'intent', intent: { type: 'normalizeNames' } },
    });
  }

  // 5. Empty tabs clutter the issue view
  const emptyTabScreens = own.filter((id) => { const t = m.screens[id].tabs!; return t.length > 1 && t.some((x) => !x.fieldIds.length); });
  if (emptyTabScreens.length) {
    out.push({
      id: 'empty-tabs', severity: 'info',
      items: emptyTabScreens.map((id) => ({ id, name: m.screens[id].name, detail: m.screens[id].tabs!.filter((t) => !t.fieldIds.length).map((t) => t.name).join(', ') })),
      fix: { kind: 'layouts', saves: emptyTabScreens.map((id) => {
        const tabs = m.screens[id].tabs!;
        const kept = tabs.filter((t) => t.fieldIds.length);
        return { screenId: id, baseDigest: tabsDigest(tabs), tabs: (kept.length ? kept : [tabs[0]]).map((t) => ({ id: t.id, name: t.name, fieldIds: t.fieldIds })) };
      }) },
    });
  }

  // 6. Leftovers nobody uses
  if (m.unused.length) {
    out.push({ id: 'unused', severity: 'info', items: m.unused.map((u) => ({ id: u.id, name: u.name, detail: u.kind })), fix: { kind: 'navigate', page: 'unused' } });
  }
  return out;
}
