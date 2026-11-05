/**
 * End-to-end through the real resolvers and executor against the in-memory Jira.
 *
 * @file        tests/integration.test.ts
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Intent, ProjectModel } from '../src/shared/types';
import { applySteps, clone, executionOrder, groupsOf, planFor, RuleError } from '../src/shared/domain';
import { planDigest } from '../src/shared/digest';
import type { FakeState } from './fakeJira';
import { ACCOUNTS, buildInstance, foreignPart } from './fixtures';
import { call, useFake } from './harness';
import { candidateIntents } from './intents';
import { shapeArb } from './arbs';

async function load(): Promise<ProjectModel> {
  const r = await call<ProjectModel>('load', {}, ACCOUNTS.projectAdmin);
  if (!r.ok) throw new Error(r.message);
  return r.data;
}

function tryPlan(m: ProjectModel, i: Intent) {
  try { return planFor(m, i); } catch (e) { if (e instanceof RuleError) return null; throw e; }
}

/** Jira configuration with metadata that legitimately changes on a no-op round trip removed (ids, versions, key order). */
function normalize(s: FakeState) {
  return {
    screens: s.screens.map((x) => ({ id: x.id, name: x.name, tabs: x.tabs.map((t) => [t.name, t.fields]) })).sort((a, b) => a.id - b.id),
    schemes: s.schemes.map((x) => ({ id: x.id, name: x.name, screens: Object.entries(x.screens).sort() })).sort((a, b) => a.id - b.id),
    itss: s.itss.map((i) => ({ id: i.id, mappings: Object.entries(i.mappings).sort() })),
    workflows: s.workflows.map((w) => ({ id: w.id, t: w.transitions.map((t) => [t.id, t.transitionScreen?.parameters.screenId ?? null]) })),
    fieldSchemes: (s.fieldSchemes ?? []).map((f) => ({ id: f.id, fields: [...f.fields].sort() })),
  };
}

describe('execute against Jira', () => {
  it('never changes anything outside the project, and Jira ends up exactly where the preview said', async () => {
    await fc.assert(fc.asyncProperty(shapeArb, fc.nat(), fc.nat(), async (shape, seed, pickIdx) => {
      const fake = useFake(buildInstance(shape));
      const pre = await load();
      const intents = candidateIntents(pre, seed).filter((i) => tryPlan(pre, i)?.steps.length);
      if (!intents.length) return;
      const intent = intents[pickIdx % intents.length];
      const plan = planFor(pre, intent);
      const foreignBefore = foreignPart(fake.snapshot());

      const r = await call<{ model: ProjectModel; idMap: Record<string, string> }>('execute', { intent, digest: planDigest(plan) }, ACCOUNTS.projectAdmin);
      expect(r.ok, !r.ok ? r.message : '').toBe(true);
      if (!r.ok) return;

      // 1. Nothing shared with other projects changed (checked on Jira's raw state, not the app's model)
      expect(foreignPart(fake.snapshot())).toEqual(foreignBefore);

      // 2. Preview == execution: Jira's state equals the plan applied to the previewed model
      const ids = r.data.idMap;
      const subst = JSON.parse(JSON.stringify(executionOrder(plan.steps)).replace(/new-[a-z0-9-]+/g, (x) => ids[x] ?? x));
      const expected = applySteps(clone(pre), subst);
      const actual = await load();
      expect(actual.itss.mappings).toEqual(expected.itss.mappings);
      for (const g of groupsOf(expected)) {
        expect(actual.screenSchemes[g.schemeId]?.name).toBe(expected.screenSchemes[g.schemeId].name);
        expect(actual.screenSchemes[g.schemeId]?.screens).toEqual(expected.screenSchemes[g.schemeId].screens);
        for (const id of Object.values(expected.screenSchemes[g.schemeId].screens)) expect(actual.screens[id!]?.name).toBe(expected.screens[id!].name);
      }
      for (const w of expected.workflows) expect(actual.workflows.find((x) => x.id === w.id)!.transitions.map((t) => t.screenId ?? null)).toEqual(w.transitions.map((t) => t.screenId ?? null));
      expect(actual.unused.map((u) => `${u.kind}:${u.name}`).sort()).toEqual(expected.unused.map((u) => `${u.kind}:${u.name}`).sort());
    }), { numRuns: 150 });
  });

  it('rolls back completely when Jira fails at any step', async () => {
    await fc.assert(fc.asyncProperty(shapeArb, fc.nat(), fc.nat(), async (shape, seed, pickIdx) => {
      // Dry run to count the writes this scenario needs
      const dry = useFake(buildInstance(shape));
      const pre = await load();
      const intents = candidateIntents(pre, seed).filter((i) => i.type !== 'delete' && tryPlan(pre, i)?.steps.length);
      if (!intents.length) return;
      const intent = intents[pickIdx % intents.length];
      const digest = planDigest(planFor(pre, intent));
      const writesBefore = dry.writes;
      const ok = await call('execute', { intent, digest }, ACCOUNTS.projectAdmin);
      expect(ok.ok).toBe(true);
      const needed = dry.writes - writesBefore;

      for (let k = 1; k <= needed; k++) {
        const fake = useFake(buildInstance(shape));
        const m = await load();
        const before = normalize(fake.snapshot());
        fake.writes = 0;
        fake.opts.failAtWrite = k;
        const r = await call<{ warnings: string[] }>('execute', { intent, digest: planDigest(planFor(m, intent)) }, ACCOUNTS.projectAdmin);
        if (r.ok) {
          // Only tolerated: a single field that couldn't be placed on a copied screen — reported as a warning
          expect(fake.log[k - 1]).toMatch(/\/tabs\/\d+\/fields$/);
          expect(r.data.warnings.length).toBeGreaterThan(0);
          continue;
        }
        fake.opts.failAtWrite = null;
        // Field-level copy failures are tolerated by design (skipped fields), everything else must be undone
        if (r.ok === false && !/rolled back/.test(r.message)) throw new Error(`write ${k}/${needed}: ${r.message}`);
        expect(normalize(fake.snapshot()), `failure at write ${k}/${needed} of ${intent.type}`).toEqual(before);
      }
    }), { numRuns: 60 });
  });

  it('refuses to run when Jira changed after the preview', async () => {
    const fake = useFake(buildInstance());
    const m = await load();
    const g = groupsOf(m).find((x) => x.issueTypes.length > 1)!;
    const intent: Intent = { type: 'split', schemeId: g.schemeId, issueTypeId: g.issueTypes[1].id, mode: 'copy' };
    const digest = planDigest(planFor(m, intent));
    // Someone renames a screen of that scheme in Jira meanwhile
    fake.state.screens.find((s) => s.id === Number(m.screenSchemes[g.schemeId].screens.default))!.name = 'Renamed elsewhere';
    const before = normalize(fake.snapshot());
    const r = await call('execute', { intent, digest }, ACCOUNTS.projectAdmin);
    expect(r).toMatchObject({ ok: false, code: 'conflict' });
    expect(normalize(fake.snapshot())).toEqual(before);
  });
});

describe('concurrent changes are conflicts, never lost updates', () => {
  it('refuses when an assignment the user did not touch was changed in Jira after the preview', async () => {
    const fake = useFake(buildInstance());
    const m = await load();
    const g = groupsOf(m).find((x) => m.screenSchemes[x.schemeId].projectCount === 1)!;
    const sc = m.screenSchemes[g.schemeId];
    // the user previews: Create → inherits from Default
    const intent: Intent = { type: 'assign', schemeId: sc.id, next: { ...sc.screens, create: undefined } as never, newScreens: [] };
    const digest = planDigest(planFor(m, intent));
    // meanwhile someone sets View explicitly in Jira
    const raw = fake.state.schemes.find((s) => s.id === Number(sc.id))!;
    const other = fake.state.screens.find((s) => s.name.startsWith('PROJ Legacy') && s.id !== raw.screens.default)!;
    raw.screens.view = other.id;
    const before = normalize(fake.snapshot());
    const r = await call('execute', { intent, digest }, ACCOUNTS.projectAdmin);
    expect(r).toMatchObject({ ok: false, code: 'conflict' });
    expect(normalize(fake.snapshot())).toEqual(before); // the concurrent View change survives
  });
});

describe('screen editor against Jira', () => {
  const layoutArb = fc.record({ moveFirstToNewTab: fc.boolean(), removeOne: fc.boolean(), addCount: fc.integer({ min: 0, max: 3 }), reverse: fc.boolean() });

  it('applies the exact layout, detects concurrent edits, and rolls back on any failure', async () => {
    await fc.assert(fc.asyncProperty(layoutArb, async (l) => {
      const dry = useFake(buildInstance());
      const m = await load();
      const sc = m.screenSchemes[groupsOf(m).find((g) => m.screenSchemes[g.schemeId].projectCount === 1)!.schemeId];
      const screenId = sc.screens.default;
      const tabs = clone(m.screens[screenId].tabs!);
      const desired = tabs.map((t) => ({ id: t.id as string | null, name: t.name, fieldIds: [...t.fieldIds] }));
      const free = Object.keys(m.fields).filter((f) => !tabs.some((t) => t.fieldIds.includes(f)));
      desired[0].fieldIds.push(...free.slice(0, l.addCount));
      if (l.removeOne) desired[0].fieldIds = desired[0].fieldIds.filter((f) => !m.fields[f]?.locked).slice(1).concat(desired[0].fieldIds.filter((f) => m.fields[f]?.locked));
      if (l.reverse) desired[0].fieldIds.reverse();
      if (l.moveFirstToNewTab) { const f = desired[0].fieldIds.find((x) => !m.fields[x].locked)!; desired[0].fieldIds = desired[0].fieldIds.filter((x) => x !== f); desired.push({ id: null, name: 'Details', fieldIds: [f] }); }
      const { tabsDigest } = await import('../src/shared/digest');
      const save = { screenId, tabs: desired, baseDigest: tabsDigest(tabs) };

      const w0 = dry.writes;
      const ok = await call('saveLayout', { save }, ACCOUNTS.projectAdmin);
      expect(ok.ok, !ok.ok ? ok.message : '').toBe(true);
      const got = dry.state.screens.find((s) => s.id === Number(screenId))!.tabs.map((t) => [t.name, t.fields]);
      expect(got).toEqual(desired.map((t) => [t.name, t.fieldIds]));
      const needed = dry.writes - w0;

      // concurrent edit → conflict, nothing written
      const c = useFake(buildInstance());
      await load();
      c.state.screens.find((s) => s.id === Number(screenId))!.tabs[0].fields.reverse();
      const cw = c.writes;
      expect(await call('saveLayout', { save }, ACCOUNTS.projectAdmin)).toMatchObject({ ok: false, code: 'conflict' });
      expect(c.writes).toBe(cw);

      for (let k = 1; k <= needed; k++) {
        const fake = useFake(buildInstance());
        await load();
        const before = normalize(fake.snapshot());
        fake.writes = 0;
        fake.opts.failAtWrite = k;
        const r = await call('saveLayout', { save }, ACCOUNTS.projectAdmin);
        expect(r.ok).toBe(false);
        fake.opts.failAtWrite = null;
        expect(normalize(fake.snapshot()).screens.map((s) => [s.name, s.tabs]), `failure at write ${k}/${needed}`).toEqual(before.screens.map((s) => [s.name, s.tabs]));
        expect(normalize(fake.snapshot()).fieldSchemes).toEqual(before.fieldSchemes);
      }
    }), { numRuns: 60 });
  });
});
