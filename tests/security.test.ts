/**
 * Privilege-escalation and input-abuse tests. Every refused call must also leave Jira untouched (0 writes).
 *
 * @file        tests/security.test.ts
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import { describe, expect, it } from 'vitest';
import type { Intent, ProjectModel } from '../src/shared/types';
import { groupsOf, planFor } from '../src/shared/domain';
import { planDigest } from '../src/shared/digest';
import { handler, rovoAddField, rovoExplainScreen, rovoListScreens, rovoRemoveField } from '../src/index';
import { ACCOUNTS, buildInstance } from './fixtures';
import { call, useFake } from './harness';

const SHARED = { groups: [0, 0, 1, 3], ops: [[1, 0, 1], [1, 1, 0], [0, 0, 0], [0, 0, 0]], sharedGroup: true } as never;

async function adminModel() {
  const r = await call<ProjectModel>('load', {}, ACCOUNTS.projectAdmin);
  if (!r.ok) throw new Error(r.message);
  return r.data;
}

describe('who may call what', () => {
  const resolvers: [string, unknown][] = [
    ['load', {}], ['loadScreen', { id: '10001' }], ['searchScreens', { query: 'a' }], ['audit', {}],
    ['execute', { intent: { type: 'newTransitionScreen', text: 'X' }, digest: '00000000' }],
    ['saveLayout', { save: { screenId: '10001', tabs: [{ id: null, name: 'A', fieldIds: [] }] } }],
  ];
  for (const who of [ACCOUNTS.member, ACCOUNTS.otherAdmin]) {
    for (const [fn, payload] of resolvers) {
      it(`${fn} is denied for ${who}`, async () => {
        const fake = useFake(buildInstance());
        const r = await call(fn, payload, who);
        expect(r).toMatchObject({ ok: false, code: 'denied' });
        expect(fake.writes).toBe(0);
      });
    }
  }

  it('anonymous callers are denied', async () => {
    const fake = useFake(buildInstance());
    const r = await handler({ call: { functionKey: 'load', payload: {} }, context: { extension: { project: { id: '100', key: 'PROJ' } } } } as never, { principal: {} } as never);
    expect(r).toMatchObject({ ok: false, code: 'denied' });
    expect(fake.writes).toBe(0);
  });

  it('the project always comes from the Forge context, never from the payload', async () => {
    const fake = useFake(buildInstance());
    // project admin of PROJ, but the page context is OTH: denied even if the payload claims PROJ
    const r = await call('load', { projectId: '100', projectKey: 'PROJ' }, ACCOUNTS.projectAdmin, { id: '101', key: 'OTH' });
    expect(r).toMatchObject({ ok: false, code: 'denied' });
    expect(fake.writes).toBe(0);
  });

  it('configuration is Jira-admin only, and validated', async () => {
    const fake = useFake(buildInstance());
    const cfg = { autoDelete: true, days: 30, auditRetentionMonths: 12 };
    expect(await call('saveConfig', { config: cfg }, ACCOUNTS.projectAdmin, undefined, 'sss-admin')).toMatchObject({ ok: false, code: 'denied' });
    expect(await call('loadConfig', {}, ACCOUNTS.projectAdmin, undefined, 'sss-admin')).toMatchObject({ ok: false, code: 'denied' });
    for (const bad of [{ ...cfg, days: 0 }, { ...cfg, days: 9999 }, { ...cfg, autoDelete: 'yes' }, { ...cfg, auditRetentionMonths: 7 }, null, 'x']) {
      expect(await call('saveConfig', { config: bad }, ACCOUNTS.jiraAdmin, undefined, 'sss-admin')).toMatchObject({ ok: false, code: 'invalid' });
    }
    expect(await call('saveConfig', { config: cfg }, ACCOUNTS.jiraAdmin, undefined, 'sss-admin')).toMatchObject({ ok: true, data: cfg });
    expect(fake.writes).toBe(0); // config lives in app storage, never in Jira
  });

  it('a project admin cannot read the instance-wide audit log through the admin module key', async () => {
    useFake(buildInstance());
    expect(await call('audit', {}, ACCOUNTS.projectAdmin, undefined, 'sss-admin')).toMatchObject({ ok: false, code: 'denied' });
  });
});

describe('hostile intents from a legitimate project admin', () => {
  async function expectRefused(intent: unknown, code: string, digest: string | null = '00000000') {
    const fake = useFake(buildInstance(SHARED));
    await adminModel();
    const w = fake.writes;
    const r = await call('execute', { intent, digest: digest ?? undefined }, ACCOUNTS.projectAdmin);
    expect(r, JSON.stringify(intent)).toMatchObject({ ok: false, code });
    expect(fake.writes).toBe(w);
  }

  it('cannot change a screen scheme shared with another project', async () => {
    useFake(buildInstance(SHARED));
    const m = await adminModel();
    const shared = groupsOf(m).find((g) => g.title === 'Sub-task')!;
    const sc = m.screenSchemes[shared.schemeId];
    await expectRefused({ type: 'assign', schemeId: sc.id, next: { ...sc.screens, create: sc.screens.default }, newScreens: [] }, 'locked');
    await expectRefused({ type: 'split', schemeId: groupsOf(m).find((g) => g.title === 'Epic')!.schemeId, issueTypeId: '5', mode: 'copy' }, 'locked');
  });

  it('cannot move an issue type onto a shared scheme, or assign another project\'s screen', async () => {
    useFake(buildInstance(SHARED));
    const m = await adminModel();
    const shared = groupsOf(m).find((g) => g.title === 'Sub-task')!;
    const own = groupsOf(m).find((g) => g.title === 'Bug')!;
    await expectRefused({ type: 'merge', issueTypeId: '3', targetSchemeId: shared.schemeId }, 'locked');
    const foreignScreen = Object.values(m.screens).find((s) => s.name === 'Default Screen')!;
    await expectRefused({ type: 'assign', schemeId: own.schemeId, next: { default: foreignScreen.id }, newScreens: [] }, 'invalid');
  });

  it('cannot change a transition of a shared workflow', async () => {
    useFake(buildInstance(SHARED));
    const m = await adminModel();
    const wf = m.workflows.find((w) => w.name === 'Shared Bug Workflow')!;
    const screen = Object.values(m.screens).find((s) => s.name.startsWith('PROJ Transition'))!;
    await expectRefused({ type: 'transition', screenId: screen.id, workflowId: wf.id, transitionId: wf.transitions[0].id, on: true }, 'locked');
  });

  it('rejects malformed, oversized and traversal inputs', async () => {
    for (const bad of [
      null, 'x', { type: 'drop-table' }, { type: 'assign' }, { type: 'assign', schemeId: '../../admin', next: { default: '1' }, newScreens: [] },
      { type: 'assign', schemeId: '10006', next: { default: '10001/../../x' }, newScreens: [] },
      { type: 'assign', schemeId: '10006', next: { default: '10004' }, newScreens: [{ ref: 'evil', op: 'create', issueType: 'Task' }] },
      { type: 'assign', schemeId: '10006', next: { default: '10004' }, newScreens: [{ ref: 'new-a', op: 'hack', issueType: 'Task' }] },
      { type: 'newTransitionScreen', text: '<script>alert(1)</script>' },
      { type: 'newTransitionScreen', text: 'x'.repeat(500) },
      { type: 'delete', items: [{ kind: 'project', id: '100' }] },
      { type: 'delete', items: [{ kind: 'screen', id: '../1' }] },
      { type: 'delete', items: Array.from({ length: 50 }, () => ({ kind: 'screen', id: '1' })) },
    ]) await expectRefused(bad, 'invalid');
  });

  it('cannot delete objects that are in use', async () => {
    useFake(buildInstance(SHARED));
    const m = await adminModel();
    const used = m.screenSchemes[groupsOf(m).find((g) => g.title === 'Bug')!.schemeId];
    await expectRefused({ type: 'delete', items: [{ kind: 'screenScheme', id: used.id }] }, 'invalid');
    await expectRefused({ type: 'delete', items: [{ kind: 'screen', id: used.screens.default }] }, 'invalid');
  });

  it('requires the digest of what was previewed', async () => {
    useFake(buildInstance(SHARED));
    const m = await adminModel();
    const g = groupsOf(m).find((x) => x.title === 'Story, Task')!;
    const intent: Intent = { type: 'split', schemeId: g.schemeId, issueTypeId: '2', mode: 'copy' };
    await expectRefused(intent, 'invalid', null);
    await expectRefused(intent, 'conflict', 'deadbeef');
    // and with the right digest it works
    const fake = useFake(buildInstance(SHARED));
    const m2 = await adminModel();
    const ok = await call('execute', { intent, digest: planDigest(planFor(m2, intent)) }, ACCOUNTS.projectAdmin);
    expect(ok.ok).toBe(true);
    expect(fake.writes).toBeGreaterThan(0);
  });

  it('cannot edit a shared screen, remove a required field, or inject unknown fields', async () => {
    const fake = useFake(buildInstance(SHARED));
    const m = await adminModel();
    const sharedScreen = Object.values(m.screens).find((s) => s.name === 'Default Screen')!;
    const own = m.screenSchemes[groupsOf(m).find((g) => g.title === 'Bug')!.schemeId].screens.default;
    const ownTabs = m.screens[own].tabs!;
    const w = fake.writes;
    expect(await call('saveLayout', { save: { screenId: sharedScreen.id, tabs: [{ id: null, name: 'X', fieldIds: [] }] } }, ACCOUNTS.projectAdmin)).toMatchObject({ ok: false });
    expect(await call('saveLayout', { save: { screenId: own, tabs: ownTabs.map((t) => ({ ...t, fieldIds: t.fieldIds.filter((f) => f !== 'summary') })) } }, ACCOUNTS.projectAdmin)).toMatchObject({ ok: false, code: 'invalid' });
    expect(await call('saveLayout', { save: { screenId: own, tabs: [{ ...ownTabs[0], fieldIds: [...ownTabs[0].fieldIds, 'customfield_99999'] }] } }, ACCOUNTS.projectAdmin)).toMatchObject({ ok: false, code: 'invalid' });
    expect(await call('saveLayout', { save: { screenId: '../10001', tabs: [] } }, ACCOUNTS.projectAdmin)).toMatchObject({ ok: false, code: 'invalid' });
    expect(fake.writes).toBe(w);
  });
});

describe('Rovo actions treat every input as hostile', () => {
  const ctx = (accountId?: string) => ({ principal: accountId ? { accountId } : undefined });

  it('refuses callers without project admin rights, whatever project key they name', async () => {
    const fake = useFake(buildInstance());
    for (const [who, key] of [[ACCOUNTS.member, 'PROJ'], [ACCOUNTS.otherAdmin, 'PROJ'], [undefined, 'PROJ']] as const) {
      const out = await rovoAddField({ projectKey: key, screen: 'Legacy 0 Default', field: 'labels' }, ctx(who));
      expect(out).toMatch(/couldn't do that/i);
    }
    expect(fake.writes).toBe(0);
  });

  it('rejects malformed project keys and never builds paths from them', async () => {
    const fake = useFake(buildInstance());
    for (const key of ['PROJ/../OTH', 'PROJ?expand=x', '../../rest', '', 'A'.repeat(40), 42]) {
      const out = await rovoListScreens({ projectKey: key as never }, ctx(ACCOUNTS.jiraAdmin));
      expect(out).toMatch(/couldn't do that/i);
    }
    expect(fake.writes).toBe(0);
  });

  it('refuses to change shared screens or remove required fields, and reports ambiguity instead of guessing', async () => {
    const fake = useFake(buildInstance(SHARED));
    expect(await rovoAddField({ projectKey: 'PROJ', screen: 'Shared Ops Screen', field: 'labels' }, ctx(ACCOUNTS.projectAdmin))).toMatch(/shared|couldn't/i);
    expect(await rovoRemoveField({ projectKey: 'PROJ', screen: 'PROJ Legacy 1 Default', field: 'summary' }, ctx(ACCOUNTS.projectAdmin))).toMatch(/can't be removed|couldn't/i);
    expect(await rovoAddField({ projectKey: 'PROJ', screen: 'Legacy', field: 'labels' }, ctx(ACCOUNTS.projectAdmin))).toMatch(/matches several screens/);
    expect(await rovoAddField({ projectKey: 'PROJ', screen: 'PROJ Legacy 1 Default', field: 'Custom' }, ctx(ACCOUNTS.projectAdmin))).toMatch(/matches several fields/);
    expect(fake.writes).toBe(0);
  });

  it('does the requested change for a project admin, through the same guards as the UI', async () => {
    const fake = useFake(buildInstance());
    const out = await rovoAddField({ projectKey: 'PROJ', screen: 'PROJ Legacy 1 Default', field: 'customfield_10118' }, ctx(ACCOUNTS.projectAdmin));
    expect(out).toMatch(/Added/);
    expect(fake.state.screens.find((s) => s.name === 'PROJ Legacy 1 Default')!.tabs[0].fields).toContain('customfield_10118');
    // field was outside the project's field scheme and the scheme is exclusive → added there too
    expect(fake.state.fieldSchemes![0].fields).toContain('customfield_10118');
    expect(await rovoExplainScreen({ projectKey: 'PROJ', screen: 'PROJ Legacy 1 Default' }, ctx(ACCOUNTS.projectAdmin))).toMatch(/Editable: used only by PROJ/);
  });
});
