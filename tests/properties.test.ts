/**
 * Property-based tests of the plan engine over generated instance shapes.
 *
 * @file        tests/properties.test.ts
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Intent, PlanStep, ProjectModel } from '../src/shared/types';
import { OPS } from '../src/shared/types';
import { applySteps, byName, clone, executionOrder, groupsOf, planFor, RuleError, schemeIdFor } from '../src/shared/domain';
import { planDigest } from '../src/shared/digest';
import { modelFor, shapeArb } from './arbs';
import { allowed, candidateIntents } from './intents';

const created = (steps: PlanStep[]) => new Set(steps.flatMap((s) => (s.kind === 'createScreen' || s.kind === 'createScreenScheme' ? [s.ref] : [])));

function tryPlan(m: ProjectModel, i: Intent) {
  try { return planFor(m, i); } catch (e) { if (e instanceof RuleError) return null; throw e; }
}

describe('plan engine invariants', () => {
  it('never plans a change to an object shared with another project', async () => {
    await fc.assert(fc.asyncProperty(shapeArb, fc.nat(), async (shape, seed) => {
      const m = await modelFor(shape);
      for (const i of candidateIntents(m, seed)) {
        const plan = tryPlan(m, i);
        if (!plan) continue;
        expect(allowed(m, i)).toBe(true); // planner accepted ⇒ rules allow it
        const fresh = created(plan.steps);
        for (const s of plan.steps) {
          const scheme = 'schemeId' in s ? m.screenSchemes[s.schemeId] : undefined;
          const screen = 'screenId' in s && s.screenId ? m.screens[s.screenId] : undefined;
          if (s.kind === 'updateScreenScheme' || s.kind === 'renameScreenScheme' || s.kind === 'deleteScreenScheme') {
            expect(fresh.has(s.schemeId) || (scheme!.projectCount <= 1 && scheme!.projects.every((p) => p === 'PROJ'))).toBe(true);
          }
          if (s.kind === 'renameScreen' || s.kind === 'deleteScreen') {
            expect(fresh.has(s.screenId) || (!screen!.foreign && screen!.projectCount <= 1 && screen!.projects.every((p) => p === 'PROJ'))).toBe(true);
          }
          if (s.kind === 'mapIssueType') expect(m.itss.projectCount).toBeLessThanOrEqual(1);
        }
      }
    }), { numRuns: 120 });
  });

  it('keeps defaults, unique names and the naming scheme after every plan', async () => {
    await fc.assert(fc.asyncProperty(shapeArb, fc.nat(), async (shape, seed) => {
      const m = await modelFor(shape);
      for (const i of candidateIntents(m, seed)) {
        const plan = tryPlan(m, i);
        if (!plan) continue;
        const after = applySteps(clone(m), executionOrder(plan.steps));
        for (const sc of Object.values(after.screenSchemes)) expect(sc.screens.default).toBeTruthy();
        const names = Object.values(after.screens).map((s) => s.name.toLowerCase());
        expect(new Set(names).size).toBe(names.length);
        const schemeNames = Object.values(after.screenSchemes).map((s) => s.name.toLowerCase());
        expect(new Set(schemeNames).size).toBe(schemeNames.length);
        // every scheme the plan touched and that is still used by the project follows the naming scheme
        const touched = new Set(plan.steps.flatMap((s) => ('schemeId' in s ? [s.schemeId] : s.kind === 'createScreenScheme' ? [s.ref] : [])));
        for (const g of groupsOf(after)) {
          const sc = after.screenSchemes[g.schemeId];
          if (!touched.has(g.schemeId) || sc.projectCount > 1) continue;
          expect(sc.name).toMatch(new RegExp(`^PROJ ${escape(g.issueTypes[0].name)} - Screen Scheme( \\(\\d+\\))?$`));
          for (const o of OPS) {
            const id = sc.screens[o];
            if (!id || after.screens[id].workflowIds.length || after.screens[id].projectCount > 1) continue;
            // shared screens: named after the alphabetically first issue type among all schemes using them
            const first = after.issueTypes.filter((it) => Object.values(after.screenSchemes[schemeIdFor(after, it.id)]?.screens ?? {}).includes(id)).sort(byName)[0];
            expect(after.screens[id].name).toMatch(new RegExp(`^PROJ ${escape(first.name)} - [a-z, ]+ - Screen( \\(\\d+\\))?$`));
          }
        }
      }
    }), { numRuns: 120 });
  });

  it('is idempotent: re-planning an applied assignment yields no steps', async () => {
    await fc.assert(fc.asyncProperty(shapeArb, fc.nat(), async (shape, seed) => {
      const m = await modelFor(shape);
      for (const i of candidateIntents(m, seed)) {
        if (i.type !== 'assign' || i.newScreens.length) continue;
        const plan = tryPlan(m, i);
        if (!plan) continue;
        const after = applySteps(clone(m), executionOrder(plan.steps));
        expect(planFor(after, i).steps).toEqual([]);
      }
    }), { numRuns: 120 });
  });

  it('produces the same digest for the same state (preview == execution)', async () => {
    await fc.assert(fc.asyncProperty(shapeArb, fc.nat(), async (shape, seed) => {
      const m = await modelFor(shape);
      for (const i of candidateIntents(m, seed)) {
        const a = tryPlan(clone(m), i);
        const b = tryPlan(JSON.parse(JSON.stringify(m)), i);
        expect(a && planDigest(a)).toEqual(b && planDigest(b));
      }
    }), { numRuns: 80 });
  });

  it('split (shared screens) followed by merge back restores the original assignment and names', async () => {
    await fc.assert(fc.asyncProperty(shapeArb, async (shape) => {
      const m0 = await modelFor(shape);
      // canonicalise names first, so "original names" are the naming-scheme names
      let m = m0;
      for (const g of groupsOf(m0)) {
        const p = tryPlan(m, { type: 'assign', schemeId: g.schemeId, next: { ...m.screenSchemes[g.schemeId].screens } as never, newScreens: [] });
        if (p) m = applySteps(clone(m), executionOrder(p.steps));
      }
      for (const g of groupsOf(m)) {
        if (g.issueTypes.length < 2) continue;
        const it = g.issueTypes[g.issueTypes.length - 1];
        const split = tryPlan(m, { type: 'split', schemeId: g.schemeId, issueTypeId: it.id, mode: 'share' });
        if (!split) continue;
        const s1 = applySteps(clone(m), executionOrder(split.steps).map((s) => JSON.parse(JSON.stringify(s))));
        const merge = planFor(s1, { type: 'merge', issueTypeId: it.id, targetSchemeId: g.schemeId });
        const s2 = applySteps(clone(s1), executionOrder(merge.steps));
        expect(schemeIdFor(s2, it.id)).toBe(g.schemeId);
        for (const other of g.issueTypes) expect(schemeIdFor(s2, other.id)).toBe(g.schemeId);
        expect(s2.screenSchemes[g.schemeId].name).toBe(m.screenSchemes[g.schemeId].name);
        for (const id of Object.values(m.screenSchemes[g.schemeId].screens)) expect(s2.screens[id!].name).toBe(m.screens[id!].name);
        expect(s2.issueTypes.slice().sort(byName)).toEqual(m.issueTypes.slice().sort(byName));
      }
    }), { numRuns: 80 });
  });
});

function escape(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

describe('digest', () => {
  it('does not depend on object key order or undefined members', async () => {
    const { canonical } = await import('../src/shared/digest');
    await fc.assert(fc.property(fc.dictionary(fc.string(), fc.oneof(fc.string(), fc.integer(), fc.constant(undefined))), (o) => {
      const reversed = Object.fromEntries(Object.entries(o).reverse());
      expect(canonical(reversed)).toBe(canonical(o));
    }));
  });
});
