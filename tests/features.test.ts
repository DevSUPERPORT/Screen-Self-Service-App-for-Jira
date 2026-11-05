/**
 * Bulk field changes, health checks + fixes, and undo — against the in-memory Jira.
 *
 * @file        tests/features.test.ts
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Intent, ProjectModel } from '../src/shared/types';
import { groupsOf, planFor, RuleError } from '../src/shared/domain';
import { planDigest } from '../src/shared/digest';
import { bulkPlan, bulkPresets, healthChecks } from '../src/shared/bulk';
import type { FakeState } from './fakeJira';
import { ACCOUNTS, buildInstance, foreignPart } from './fixtures';
import { call, useFake } from './harness';
import { markCreated } from '../src/backend/storage';
import { candidateIntents } from './intents';
import { shapeArb } from './arbs';

const SHARED = { groups: [0, 0, 1, 3], ops: [[1, 0, 1], [1, 1, 0], [0, 0, 0], [0, 0, 0]], sharedGroup: true } as never;

async function load(who = ACCOUNTS.projectAdmin): Promise<ProjectModel> {
  const r = await call<ProjectModel>('load', {}, who);
  if (!r.ok) throw new Error(r.message);
  return r.data;
}
const tryPlan = (m: ProjectModel, i: Intent) => { try { return planFor(m, i); } catch (e) { if (e instanceof RuleError) return null; throw e; } };
function normalize(s: FakeState) {
  return {
    screens: s.screens.map((x) => ({ id: x.id, name: x.name, tabs: x.tabs.map((t) => [t.name, t.fields]) })).sort((a, b) => a.id - b.id),
    schemes: s.schemes.map((x) => ({ id: x.id, name: x.name, screens: Object.entries(x.screens).sort() })).sort((a, b) => a.id - b.id),
    itss: s.itss.map((i) => ({ id: i.id, mappings: Object.entries(i.mappings).sort() })),
    workflows: s.workflows.map((w) => ({ id: w.id, t: w.transitions.map((t) => [t.id, t.transitionScreen?.parameters.screenId ?? null]) })),
    fieldSchemes: (s.fieldSchemes ?? []).map((f) => ({ id: f.id, fields: [...f.fields].sort() })),
  };
}

describe('bulk field changes', () => {
  it('adds fields to every chosen screen, skips what is already there, never touches shared screens', async () => {
    const fake = useFake(buildInstance(SHARED));
    const m = await load();
    const presets = bulkPresets(m);
    const sharedScreen = Object.values(m.screens).find((s) => s.name === 'Shared Ops Screen')!;
    const targets = [...presets.createEdit, sharedScreen.id];
    const items = bulkPlan(m, { action: 'add', fieldIds: ['labels', 'customfield_10118'], screenIds: targets, tab: { mode: 'named', name: 'Details' } });
    expect(items.find((i) => i.screenId === sharedScreen.id)!.status).toBe('locked');
    const foreignBefore = foreignPart(fake.snapshot());
    const saves = items.filter((i) => i.status === 'change').map((i) => i.save!);
    const r = await call<{ results: { ok: boolean }[] }>('saveLayouts', { saves, label: 'bulk' }, ACCOUNTS.projectAdmin);
    expect(r.ok && r.data.results.every((x) => x.ok)).toBe(true);
    for (const id of presets.createEdit) {
      const s = fake.state.screens.find((x) => x.id === Number(id))!;
      const fields = s.tabs.flatMap((t) => t.fields);
      expect(fields).toContain('labels');
      expect(fields).toContain('customfield_10118');
      const item = items.find((i) => i.screenId === id)!;
      if (item.fields.length) expect(s.tabs.find((t) => t.name === 'Details')).toBeTruthy();
    }
    // the new custom field was outside the (exclusive) field scheme → added exactly once
    expect(fake.state.fieldSchemes![0].fields.filter((f) => f === 'customfield_10118')).toHaveLength(1);
    expect(foreignPart(fake.snapshot())).toEqual(foreignBefore);
  });

  it('never removes required fields', async () => {
    useFake(buildInstance());
    const m = await load();
    const items = bulkPlan(m, { action: 'remove', fieldIds: ['summary', 'description'], screenIds: bulkPresets(m).all, tab: { mode: 'first' } });
    for (const i of items) {
      expect(i.fields).not.toContain('summary');
      if (i.save) expect(i.save.tabs.some((t) => t.fieldIds.includes('summary'))).toBe(true);
    }
  });

  it('reports partial failures per screen and leaves the failed screen untouched', async () => {
    const dry = useFake(buildInstance());
    let m = await load();
    const ids = bulkPresets(m).all.slice(0, 2);
    const saves = bulkPlan(m, { action: 'add', fieldIds: ['environment'], screenIds: ids, tab: { mode: 'first' } }).filter((i) => i.save).map((i) => i.save!);
    expect(saves.length).toBe(2);
    const w0 = dry.writes;
    await call('saveLayouts', { saves }, ACCOUNTS.projectAdmin);
    const writesFirst = dry.log.slice(w0).findIndex((l) => l.includes(`/screens/${saves[1].screenId}/`));
    // fail the first write that touches the second screen
    const fake = useFake(buildInstance());
    m = await load();
    const before = normalize(fake.snapshot());
    fake.writes = 0;
    fake.opts.failAtWrite = writesFirst + 1;
    const r = await call<{ results: { screenId: string; ok: boolean }[] }>('saveLayouts', { saves }, ACCOUNTS.projectAdmin);
    fake.opts.failAtWrite = null;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.results.map((x) => x.ok)).toEqual([true, false]);
    const after = normalize(fake.snapshot());
    const s2 = (st: ReturnType<typeof normalize>) => st.screens.find((s) => s.id === Number(saves[1].screenId));
    expect(s2(after)).toEqual(s2(before));
    expect(after.screens.find((s) => s.id === Number(saves[0].screenId))!.tabs.flatMap((t) => t[1] as string[])).toContain('environment');
  });

  it('cannot be used on another project or with stale layouts', async () => {
    const fake = useFake(buildInstance());
    const m = await load();
    const id = bulkPresets(m).all[0];
    const save = bulkPlan(m, { action: 'add', fieldIds: ['environment'], screenIds: [id], tab: { mode: 'first' } })[0].save!;
    expect(await call('saveLayouts', { saves: [save] }, ACCOUNTS.member)).toMatchObject({ ok: false, code: 'denied' });
    expect(await call('saveLayouts', { saves: [save, save] }, ACCOUNTS.projectAdmin)).toMatchObject({ ok: false, code: 'invalid' });
    fake.state.screens.find((s) => s.id === Number(id))!.tabs[0].fields.reverse();
    const r = await call<{ results: { ok: boolean; code?: string }[] }>('saveLayouts', { saves: [save] }, ACCOUNTS.projectAdmin);
    expect(r.ok && r.data.results[0]).toMatchObject({ ok: false, code: 'conflict' });
  });
});

describe('undo', () => {
  it('restores Jira exactly after any undoable change', async () => {
    await fc.assert(fc.asyncProperty(shapeArb, fc.nat(), fc.nat(), async (shape, seed, pick) => {
      const fake = useFake(buildInstance(shape));
      const m = await load();
      const intents = candidateIntents(m, seed).filter((i) => i.type !== 'delete' && tryPlan(m, i)?.steps.length);
      if (!intents.length) return;
      const intent = intents[pick % intents.length];
      const before = normalize(fake.snapshot());
      const r = await call('execute', { intent, digest: planDigest(planFor(m, intent)), label: 'x' }, ACCOUNTS.projectAdmin);
      expect(r.ok).toBe(true);
      expect((await load()).lastChange?.label).toBe('x');
      const u = await call('undo', {}, ACCOUNTS.projectAdmin);
      expect(u.ok, !u.ok ? u.message : '').toBe(true);
      expect(normalize(fake.snapshot())).toEqual(before);
      expect((await load()).lastChange).toBeNull();
    }), { numRuns: 60 });
  });

  it('undoes a bulk change and the field scheme additions it made', async () => {
    const fake = useFake(buildInstance());
    const m = await load();
    const before = normalize(fake.snapshot());
    const saves = bulkPlan(m, { action: 'add', fieldIds: ['customfield_10119'], screenIds: bulkPresets(m).all, tab: { mode: 'named', name: 'Extra' } }).filter((i) => i.save).map((i) => i.save!);
    expect((await call('saveLayouts', { saves }, ACCOUNTS.projectAdmin)).ok).toBe(true);
    expect(normalize(fake.snapshot())).not.toEqual(before);
    expect((await call('undo', {}, ACCOUNTS.projectAdmin)).ok).toBe(true);
    expect(normalize(fake.snapshot())).toEqual(before);
  });

  it('refuses when the objects changed since, and is per user', async () => {
    const fake = useFake(buildInstance());
    const m = await load();
    const g = groupsOf(m).find((x) => x.issueTypes.length > 1)!;
    const intent: Intent = { type: 'split', schemeId: g.schemeId, issueTypeId: g.issueTypes[1].id, mode: 'copy' };
    expect((await call('execute', { intent, digest: planDigest(planFor(m, intent)) }, ACCOUNTS.projectAdmin)).ok).toBe(true);
    expect(await call('undo', {}, ACCOUNTS.jiraAdmin)).toMatchObject({ ok: false, code: 'not-found' }); // someone else's change
    // somebody renames a screen the undo would touch
    const renamed = fake.state.screens.find((s) => s.name.startsWith(`PROJ ${g.issueTypes[0].name}`))!;
    renamed.name = 'Renamed meanwhile';
    const w = fake.writes;
    expect(await call('undo', {}, ACCOUNTS.projectAdmin)).toMatchObject({ ok: false, code: 'conflict' });
    expect(fake.writes).toBe(w);
  });
});

describe('health checks', () => {
  it('finds names out of sync and fixes them in one step', async () => {
    useFake(buildInstance());
    const m = await load();
    const names = healthChecks(m).find((c) => c.id === 'names');
    expect(names?.items.length).toBeGreaterThan(0); // the fixture uses legacy names
    const intent: Intent = { type: 'normalizeNames' };
    expect((await call('execute', { intent, digest: planDigest(planFor(m, intent)) }, ACCOUNTS.projectAdmin)).ok).toBe(true);
    expect(healthChecks(await load()).find((c) => c.id === 'names')).toBeUndefined();
  });

  it('finds a create screen without Summary and fixes it', async () => {
    const st = buildInstance();
    const fake = useFake(st);
    let m = await load();
    const g = groupsOf(m).find((x) => m.screenSchemes[x.schemeId].screens.create)!;
    const createId = Number(m.screenSchemes[g.schemeId].screens.create);
    const s = fake.state.screens.find((x) => x.id === createId)!;
    s.tabs[0].fields = s.tabs[0].fields.filter((f) => f !== 'summary');
    m = await load();
    const check = healthChecks(m).find((c) => c.id === 'missing-summary')!;
    expect(check.severity).toBe('error');
    expect(check.fix?.kind).toBe('layouts');
    const r = await call<{ results: { ok: boolean }[] }>('saveLayouts', { saves: (check.fix as { saves: never[] }).saves }, ACCOUNTS.projectAdmin);
    expect(r.ok && r.data.results.every((x) => x.ok)).toBe(true);
    expect(fake.state.screens.find((x) => x.id === createId)!.tabs[0].fields[0]).toBe('summary');
    expect(healthChecks(await load()).find((c) => c.id === 'missing-summary')).toBeUndefined();
  });

  it('flags a transition screen without fields and points to the Transition screens page', async () => {
    const fake = useFake(buildInstance());
    const m0 = await load();
    const tr = m0.workflows.flatMap((w) => w.transitions).find((x) => x.screenId)!;
    expect(healthChecks(m0).find((c) => c.id === 'empty-transition')).toBeUndefined();
    const s = fake.state.screens.find((x) => String(x.id) === tr.screenId)!;
    for (const tab of s.tabs) tab.fields = [];
    const check = healthChecks(await load()).find((c) => c.id === 'empty-transition')!;
    expect(check.severity).toBe('warning');
    expect(check.items.map((i) => i.id)).toContain(tr.screenId);
    expect(check.items.find((i) => i.id === tr.screenId)!.detail).toContain(tr.name);
    expect(check.fix).toEqual({ kind: 'navigate', page: 'transitions' });
  });

  it('finds fields hidden by the field scheme and makes them visible — only on own screens', async () => {
    const fake = useFake(buildInstance());
    const m0 = await load();
    const own = bulkPresets(m0).all[0];
    fake.state.screens.find((x) => x.id === Number(own))!.tabs[0].fields.push('customfield_10119'); // not in the field scheme
    const m = await load();
    const check = healthChecks(m).find((c) => c.id === 'hidden-fields')!;
    expect(check.items.map((i) => i.id)).toContain('customfield_10119');
    expect(await call('addToFieldScheme', { fieldIds: ['customfield_10118'] }, ACCOUNTS.projectAdmin)).toMatchObject({ ok: false, code: 'invalid' }); // not on a screen
    expect((await call('addToFieldScheme', { fieldIds: (check.fix as { fieldIds: string[] }).fieldIds }, ACCOUNTS.projectAdmin)).ok).toBe(true);
    expect(fake.state.fieldSchemes![0].fields).toContain('customfield_10119');
    expect(healthChecks(await load()).find((c) => c.id === 'hidden-fields')).toBeUndefined();
    // and it can be undone
    expect((await call('undo', {}, ACCOUNTS.projectAdmin)).ok).toBe(true);
    expect(fake.state.fieldSchemes![0].fields).not.toContain('customfield_10119');
  });

  it('removes empty tabs', async () => {
    const fake = useFake(buildInstance());
    const m0 = await load();
    const own = bulkPresets(m0).all[0];
    fake.state.screens.find((x) => x.id === Number(own))!.tabs.push({ id: 99999, name: 'Empty', fields: [] });
    const m = await load();
    const check = healthChecks(m).find((c) => c.id === 'empty-tabs')!;
    const r = await call<{ results: { ok: boolean }[] }>('saveLayouts', { saves: (check.fix as { saves: never[] }).saves }, ACCOUNTS.projectAdmin);
    expect(r.ok && r.data.results.every((x) => x.ok)).toBe(true);
    expect(fake.state.screens.find((x) => x.id === Number(own))!.tabs.some((t) => t.name === 'Empty')).toBe(false);
  });
});

describe('undoing a deletion', () => {
  const byName = (s: FakeState) => ({
    screens: s.screens.map((x) => ({ name: x.name, tabs: x.tabs.map((t) => [t.name, t.fields]) })).sort((a, b) => a.name.localeCompare(b.name)),
    schemes: s.schemes.map((x) => ({ name: x.name, screens: Object.entries(x.screens).map(([o, id]) => [o, s.screens.find((y) => y.id === id)?.name]).sort() })).sort((a, b) => a.name.localeCompare(b.name)),
  });
  const del = async (m: ProjectModel, items: { kind: 'screen' | 'screenScheme'; id: string }[]) => {
    const intent: Intent = { type: 'delete', items };
    return call('execute', { intent, digest: planDigest(planFor(m, intent)), label: 'Delete leftovers' }, ACCOUNTS.projectAdmin);
  };
  // UC-08: the app only deletes what it created — mark the fixture leftovers as created by the app
  const loadAppCreated = async () => {
    for (const u of (await load()).unused) await markCreated(u.kind, u.id, 'PROJ');
    return load();
  };

  it('refuses to delete unused objects the app did not create, with no write', async () => {
    const fake = useFake(buildInstance());
    const m = await load();
    expect(m.unused.length).toBeGreaterThan(0);
    const w = fake.writes;
    const intent: Intent = { type: 'delete', items: m.unused.map((u) => ({ kind: u.kind, id: u.id })) };
    expect(() => planFor(m, intent)).toThrow(/not created by this app/);
    expect(await call('execute', { intent, digest: '00000000' }, ACCOUNTS.projectAdmin)).toMatchObject({ ok: false });
    expect(fake.writes).toBe(w);
  });

  it('brings deleted screens and schemes back with their tabs, fields, assignments and "unused since"', async () => {
    const fake = useFake(buildInstance());
    const m = await loadAppCreated();
    const before = byName(fake.snapshot());
    const sinceBefore = Object.fromEntries(m.unused.map((u) => [u.name, u.since]));
    const items = m.unused.map((u) => ({ kind: u.kind, id: u.id }));
    expect(items.length).toBe(2);
    expect((await del(m, items)).ok).toBe(true);
    expect((await load()).unused).toEqual([]);
    expect((await load()).lastChange?.label).toBe('Delete leftovers');
    const u = await call<{ label: string }>('undo', {}, ACCOUNTS.projectAdmin);
    expect(u.ok, !u.ok ? u.message : '').toBe(true);
    expect(byName(fake.snapshot())).toEqual(before); // same objects, same content (Jira gives them new ids)
    const after = await load();
    expect(Object.fromEntries(after.unused.map((x) => [x.name, x.since]))).toEqual(sinceBefore);
    expect(after.lastChange).toBeNull();
  });

  it('restores a scheme onto the screen it used when only the scheme was deleted', async () => {
    const fake = useFake(buildInstance());
    const m = await loadAppCreated();
    const before = byName(fake.snapshot());
    const scheme = m.unused.find((x) => x.kind === 'screenScheme')!;
    expect((await del(m, [{ kind: 'screenScheme', id: scheme.id }])).ok).toBe(true);
    expect((await call('undo', {}, ACCOUNTS.projectAdmin)).ok).toBe(true);
    expect(byName(fake.snapshot())).toEqual(before);
  });

  it('refuses when the name is taken again, and rolls back a restore that fails half-way', async () => {
    const fake = useFake(buildInstance());
    const m = await loadAppCreated();
    expect((await del(m, m.unused.map((u) => ({ kind: u.kind, id: u.id })))).ok).toBe(true);
    const afterDelete = byName(fake.snapshot());

    // someone creates a screen with the deleted name meanwhile → nothing is written
    fake.state.screens.push({ id: 99901, name: 'PROJ Old - view - Screen', tabs: [{ id: 99902, name: 'Field Tab', fields: [] }] });
    const w = fake.writes;
    expect(await call('undo', {}, ACCOUNTS.projectAdmin)).toMatchObject({ ok: false, code: 'conflict' });
    expect(fake.writes).toBe(w);
    fake.state.screens = fake.state.screens.filter((s) => s.id !== 99901);

  });

  it('is all or nothing when Jira fails at any point of the restore', async () => {
    let failures = 0;
    for (let k = 1; k <= 8; k++) {
      const fake = useFake(buildInstance());
      const m = await loadAppCreated();
      const before = byName(fake.snapshot());
      expect((await del(m, m.unused.map((u) => ({ kind: u.kind, id: u.id })))).ok).toBe(true);
      const afterDelete = byName(fake.snapshot());
      fake.opts.failAtWrite = fake.writes + k;
      const r = await call('undo', {}, ACCOUNTS.projectAdmin);
      if (r.ok) {
        // a failed field write is tolerated (reported as skipped); everything else must be back
        expect(byName(fake.snapshot()).schemes).toEqual(before.schemes);
      } else {
        failures++;
        expect(byName(fake.snapshot())).toEqual(afterDelete);
      }
    }
    expect(failures).toBeGreaterThan(0);
  });

  it('is per user: nobody else can undo my deletion', async () => {
    useFake(buildInstance());
    const m = await loadAppCreated();
    expect((await del(m, m.unused.map((u) => ({ kind: u.kind, id: u.id })))).ok).toBe(true);
    expect(await call('undo', {}, ACCOUNTS.jiraAdmin)).toMatchObject({ ok: false, code: 'not-found' });
  });
});
