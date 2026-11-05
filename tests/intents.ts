/**
 * Generates every intent a project admin could trigger from the UI for a model (valid and invalid ones),
 * and restates independently which of them must be allowed; used by the property and integration tests.
 *
 * @file        tests/intents.ts
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import type { Intent, Op, ProjectModel } from '../src/shared/types';
import { OPS } from '../src/shared/types';
import { groupsOf, schemeExclusive, schemeIdFor, onlyProject, itssExclusive } from '../src/shared/domain';

/** Every intent a project admin could trigger from the UI for this model (valid and invalid ones). */
export function candidateIntents(m: ProjectModel, seed: number): Intent[] {
  const out: Intent[] = [];
  const key = m.project.key;
  const own = Object.values(m.screens).filter((s) => !s.foreign && s.projects.length > 0 && s.projects.every((p) => p === key) && s.workflowIds.length === 0);
  const groups = groupsOf(m);
  const pick = <T,>(arr: T[], k: number) => arr[Math.abs(k) % arr.length];
  for (const [gi, g] of groups.entries()) {
    const sc = m.screenSchemes[g.schemeId];
    // assignments: vary each op deterministically from the seed
    const next = { ...sc.screens } as Record<Op, string | undefined>;
    const newScreens: Extract<Intent, { type: 'assign' }>['newScreens'] = [];
    OPS.forEach((o, k) => {
      const r = (seed >> (k * 2 + gi)) & 3;
      if (o === 'default') { if (r === 3 && own.length) next.default = pick(own, seed + k).id; return; }
      if (r === 0) next[o] = undefined;
      else if (r === 1 && own.length) next[o] = pick(own, seed + k * 7).id;
      else if (r === 2) { const ref = `new-t${gi}${k}`; newScreens.push({ ref, op: o, issueType: g.issueTypes[0].name, copyFrom: (seed & 1) ? sc.screens.default : undefined }); next[o] = ref; }
    });
    out.push({ type: 'assign', schemeId: g.schemeId, next, newScreens });
    for (const it of g.issueTypes) {
      if (g.issueTypes.length > 1) out.push({ type: 'split', schemeId: g.schemeId, issueTypeId: it.id, mode: (seed + gi) % 2 ? 'copy' : 'share' });
      for (const t of groups) if (t.schemeId !== g.schemeId) out.push({ type: 'merge', issueTypeId: it.id, targetSchemeId: t.schemeId });
    }
  }
  for (const w of m.workflows) for (const t of w.transitions) {
    const screen = pick(Object.values(m.screens).filter((s) => !s.foreign && s.projects.every((p) => p === key)), seed + Number(t.id));
    if (screen) out.push({ type: 'transition', screenId: screen.id, workflowId: w.id, transitionId: t.id, on: !t.screenId });
  }
  out.push({ type: 'newTransitionScreen', text: `Gate ${seed % 97}` });
  const schemesUnused = m.unused.filter((u) => u.kind === 'screenScheme');
  if (schemesUnused.length) out.push({ type: 'delete', items: schemesUnused.map((u) => ({ kind: u.kind, id: u.id })) });
  if (m.unused.length) out.push({ type: 'delete', items: m.unused.map((u) => ({ kind: u.kind, id: u.id })) });
  return out;
}

/** Whether the project admin is allowed to run this intent at all (independent re-statement of the rules). */
export function allowed(m: ProjectModel, i: Intent): boolean {
  const key = m.project.key;
  switch (i.type) {
    case 'assign': return schemeExclusive(m, i.schemeId);
    case 'split': case 'merge': return itssExclusive(m) && schemeExclusive(m, i.type === 'split' ? i.schemeId : i.targetSchemeId) && (i.type === 'split' || schemeIdFor(m, i.issueTypeId) !== i.targetSchemeId);
    case 'transition': return onlyProject(m.workflows.find((w) => w.id === i.workflowId)!, key);
    default: return true;
  }
}
