/**
 * Marketplace-readiness guarantees: fail closed, licensing, Jira-admin control, personal data, privacy of
 * other projects, and safe new create screens. Every refusal must leave Jira untouched (0 writes).
 *
 * @file        tests/marketplace.test.ts
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
import { handler, rovoListScreens } from '../src/index';
import { pages, setTransport } from '../src/backend/jira';
import { audit, readAuditRaw, pruneUndo } from '../src/backend/storage';
import { reportPersonalData } from '../src/backend/privacy';
import { ACCOUNTS, buildInstance, ctxFor } from './fixtures';
import { call, useFake } from './harness';
import { kvsStore } from './setup';

async function load(who = ACCOUNTS.projectAdmin) {
  const r = await call<ProjectModel>('load', {}, who);
  if (!r.ok) throw new Error(r.message);
  return r.data;
}
const setConfig = (c: Record<string, unknown>) =>
  kvsStore.set('config', { autoDelete: false, days: 30, auditRetentionMonths: 24, projectAccess: 'all', projects: [], crossProjectCopy: true, ...c });

describe('fails closed when usage across the site cannot be read completely', () => {
  it('refuses to load and to change anything when workflow schemes cannot be read', async () => {
    const fake = useFake(buildInstance(), { failRead: /workflowscheme\/project/ });
    expect(await call('load', {}, ACCOUNTS.projectAdmin)).toMatchObject({ ok: false });
    const r = await call('execute', { intent: { type: 'newTransitionScreen', text: 'X' }, digest: '00000000' }, ACCOUNTS.projectAdmin);
    expect(r).toMatchObject({ ok: false });
    expect(fake.writes).toBe(0);
  });

  it('a strict scan throws instead of silently cutting the result', async () => {
    setTransport(async () => ({ status: 200, text: JSON.stringify({ values: [{ id: 1 }], total: 5, isLast: false }) }), { sleep: async () => {} });
    await expect(pages((s) => `/x?startAt=${s}`, 3, { strict: true })).rejects.toThrow(/more configuration objects/);
    await expect(pages((s) => `/x?startAt=${s}`, 3)).resolves.toHaveLength(3);
    // no total: keeps paging until the cap, then refuses
    setTransport(async () => ({ status: 200, text: JSON.stringify({ values: [{ id: 1 }], isLast: false }) }), { sleep: async () => {} });
    await expect(pages((s) => `/x?startAt=${s}`, 3, { strict: true })).rejects.toThrow(/more configuration objects/);
  });
});

describe('licensing', () => {
  const invoke = (license: unknown) => {
    const c = ctxFor(ACCOUNTS.projectAdmin);
    // Forge passes the license with the runtime payload; @forge/resolver puts it on the context
    return handler({ call: { functionKey: 'load', payload: {} }, context: c.event.context } as never, { ...c.runtime, license } as never) as Promise<{ ok: boolean; code?: string }>;
  };
  it('refuses when the Marketplace license is not active', async () => {
    const fake = useFake(buildInstance());
    expect(await invoke({ isActive: false })).toMatchObject({ ok: false, code: 'unlicensed' });
    expect(fake.writes).toBe(0);
  });
  it('works with an active license and without one (free app, development)', async () => {
    useFake(buildInstance());
    expect(await invoke({ isActive: true })).toMatchObject({ ok: true });
    expect(await invoke(undefined)).toMatchObject({ ok: true });
  });
});

describe('Jira admin decides which projects may use the app', () => {
  it('denies project admins of projects that are not enabled, in the app and in Rovo', async () => {
    const fake = useFake(buildInstance());
    setConfig({ projectAccess: 'selected', projects: ['OTH'] });
    expect(await call('load', {}, ACCOUNTS.projectAdmin)).toMatchObject({ ok: false, code: 'denied' });
    expect(await rovoListScreens({ projectKey: 'PROJ' }, { principal: { accountId: ACCOUNTS.projectAdmin } })).toMatch(/not enabled/);
    expect(fake.writes).toBe(0);
  });
  it('allows enabled projects, and Jira admins always', async () => {
    useFake(buildInstance());
    setConfig({ projectAccess: 'selected', projects: ['PROJ'] });
    expect(await call('load', {}, ACCOUNTS.projectAdmin)).toMatchObject({ ok: true });
    setConfig({ projectAccess: 'selected', projects: [] });
    expect(await call('load', {}, ACCOUNTS.jiraAdmin)).toMatchObject({ ok: true });
  });
  it('validates the project list', async () => {
    useFake(buildInstance());
    const base = { autoDelete: false, days: 30, auditRetentionMonths: 24, crossProjectCopy: true };
    for (const bad of [{ projectAccess: 'some', projects: [] }, { projectAccess: 'selected', projects: ['../x'] }, { projectAccess: 'selected', projects: 'PROJ' }]) {
      expect(await call('saveConfig', { config: { ...base, ...bad } }, ACCOUNTS.jiraAdmin, undefined, 'sss-admin')).toMatchObject({ ok: false, code: 'invalid' });
    }
    const ok = await call('saveConfig', { config: { ...base, projectAccess: 'selected', projects: ['proj', 'PROJ', 'OTH'] } }, ACCOUNTS.jiraAdmin, undefined, 'sss-admin');
    expect(ok).toMatchObject({ ok: true, data: { projects: ['OTH', 'PROJ'] } });
  });
});

describe('other projects', () => {
  it('a project admin never sees keys of projects they cannot browse; counts and locks stay', async () => {
    useFake(buildInstance());
    const admin = await load(ACCOUNTS.jiraAdmin);
    const pa = await load(ACCOUNTS.projectAdmin);
    const foreign = (m: ProjectModel) => Object.values(m.screens).flatMap((s) => s.projects).filter((k) => k !== 'PROJ');
    expect(foreign(admin).length).toBeGreaterThan(0); // the fixture does share objects with other projects
    expect(foreign(pa)).toEqual([]);
    for (const id of Object.keys(admin.screens)) expect(pa.screens[id].projectCount).toBe(admin.screens[id].projectCount);
  });
  it('copying from other projects can be switched off', async () => {
    const fake = useFake(buildInstance());
    setConfig({ crossProjectCopy: false });
    const s = await call<{ items: unknown[]; disabled?: boolean }>('searchScreens', { query: '' }, ACCOUNTS.projectAdmin);
    expect(s).toMatchObject({ ok: true, data: { items: [], disabled: true } });
    const foreignId = String(fake.state.screens.find((x) => x.name === 'Default Screen')!.id);
    const m = await load();
    if (!m.screens[foreignId] || m.screens[foreignId].foreign) {
      expect(await call('loadScreen', { id: foreignId }, ACCOUNTS.projectAdmin)).toMatchObject({ ok: false, code: 'denied' });
    }
  });
});

describe('personal data', () => {
  it('the audit log stores accountIds only and resolves names when read', async () => {
    useFake(buildInstance());
    await audit('PROJ', { user: { accountId: 'acc-1', name: 'Alex Example via Rovo' }, action: 'Screen edited', object: 'S' });
    const raw = await readAuditRaw('PROJ');
    expect(JSON.stringify(raw)).not.toContain('Alex');
    expect(raw[0].user).toEqual({ accountId: 'acc-1', via: 'Rovo' });
    const r = await call<{ user: { name: string } }[]>('audit', {}, ACCOUNTS.projectAdmin);
    expect(r.ok && r.data[0].user.name).toBe('User acc-1 via Rovo');
  });

  it('reports stored accounts weekly and erases closed ones', async () => {
    useFake(buildInstance());
    await audit('PROJ', { user: { accountId: 'acc-open' }, action: 'A', object: 'x' });
    await audit('PROJ', { user: { accountId: 'acc-closed' }, action: 'B', object: 'y' });
    kvsStore.set('undo-PROJ-acc-closed', { at: new Date().toISOString() });
    const seen: string[] = [];
    const report = async (a: { accountId: string }[]) => { seen.push(...a.map((x) => x.accountId)); return [{ accountId: 'acc-closed', status: 'closed' as const }]; };
    const r = await reportPersonalData(report);
    expect(seen.sort()).toEqual(['acc-closed', 'acc-open']);
    expect(r).toMatchObject({ erased: 1, skipped: false });
    const raw = await readAuditRaw('PROJ');
    expect(raw.map((e) => e.user.accountId).sort()).toEqual(['acc-open', 'erased-user']);
    expect(kvsStore.has('undo-PROJ-acc-closed')).toBe(false);
    // within a week it does not report again
    expect(await reportPersonalData(report)).toMatchObject({ skipped: true });
  });

  it('expired undo records are deleted', async () => {
    useFake(buildInstance());
    kvsStore.set('undo-PROJ-old', { at: new Date(Date.now() - 3 * 86400000).toISOString() });
    kvsStore.set('undo-PROJ-new', { at: new Date().toISOString() });
    expect(await pruneUndo(86400000)).toBe(1);
    expect([...kvsStore.keys()].filter((k) => k.startsWith('undo-'))).toEqual(['undo-PROJ-new']);
  });
});

describe('new create screens', () => {
  it('start with Summary and Issue Type, so creating issues keeps working', async () => {
    const fake = useFake(buildInstance());
    const m = await load();
    const g = groupsOf(m).find((x) => m.screenSchemes[x.schemeId].projectCount <= 1)!;
    const sc = m.screenSchemes[g.schemeId];
    const intent: Intent = { type: 'assign', schemeId: sc.id, next: { ...sc.screens, create: 'new-c1' } as never, newScreens: [{ ref: 'new-c1', op: 'create', issueType: g.issueTypes[0].name }] };
    const plan = planFor(m, intent);
    expect(plan.preview.some((p) => p.kind === 'new' && p.detail === 'seeded')).toBe(true);
    const r = await call<{ idMap: Record<string, string> }>('execute', { intent, digest: planDigest(plan) }, ACCOUNTS.projectAdmin);
    expect(r.ok, !r.ok ? r.message : '').toBe(true);
    const created = fake.state.screens.find((s) => String(s.id) === (r.ok ? r.data.idMap['new-c1'] : ''))!;
    expect(created.tabs[0].fields).toEqual(['summary', 'issuetype']);
  });
});
