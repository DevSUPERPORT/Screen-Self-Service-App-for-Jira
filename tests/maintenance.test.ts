/**
 * Kill switch (APP_MAINTENANCE). Only SUPERPORT can set it (Forge environment variable); nothing a customer or
 * a caller sends can change or bypass it, and while it is on/readonly nothing is written to Jira.
 *
 * @file        tests/maintenance.test.ts
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { Intent, ProjectModel } from '../src/shared/types';
import { handler, nightly, rovoAddField, rovoListScreens } from '../src/index';
import { maintenanceMode } from '../src/backend/maintenance';
import { ACCOUNTS, buildInstance } from './fixtures';
import { call, useFake } from './harness';
import { kvsStore } from './setup';

const set = (v: string | undefined) => { if (v === undefined) delete process.env.APP_MAINTENANCE; else process.env.APP_MAINTENANCE = v; };
afterEach(() => set(undefined));

const RESOLVERS: [string, unknown, string?][] = [
  ['load', {}], ['loadScreen', { id: '10001' }], ['searchScreens', { query: '' }], ['audit', {}],
  ['execute', { intent: { type: 'newTransitionScreen', text: 'X' }, digest: '00000000' }],
  ['saveLayout', { save: { screenId: '10001', tabs: [{ id: null, name: 'A', fieldIds: [] }] } }],
  ['saveLayouts', { saves: [{ screenId: '10001', tabs: [] }] }], ['addToFieldScheme', { fieldIds: ['summary'] }], ['undo', {}],
  ['loadConfig', {}, 'sss-admin'], ['saveConfig', { config: { autoDelete: false, days: 30, auditRetentionMonths: 24 } }, 'sss-admin'],
];
const WRITES = new Set(['execute', 'saveLayout', 'saveLayouts', 'addToFieldScheme', 'undo', 'saveConfig']);

describe('reading the switch', () => {
  it('maps values and fails closed on anything unknown', () => {
    expect(maintenanceMode({})).toBe('off');
    expect(maintenanceMode({ APP_MAINTENANCE: 'off' })).toBe('off');
    expect(maintenanceMode({ APP_MAINTENANCE: ' ReadOnly ' })).toBe('readonly');
    expect(maintenanceMode({ APP_MAINTENANCE: 'on' })).toBe('on');
    expect(maintenanceMode({ APP_MAINTENANCE: 'of' })).toBe('on');
    expect(maintenanceMode({ APP_MAINTENANCE: 'false' })).toBe('on');
  });
});

describe('APP_MAINTENANCE=on', () => {
  it('refuses every resolver for every caller, even Jira admins, with no Jira writes', async () => {
    set('on');
    for (const who of [ACCOUNTS.projectAdmin, ACCOUNTS.jiraAdmin]) {
      for (const [fn, payload, mod] of RESOLVERS) {
        const fake = useFake(buildInstance());
        expect(await call(fn, payload, who, undefined, mod), fn).toMatchObject({ ok: false, code: 'unavailable' });
        expect(fake.writes, fn).toBe(0);
      }
    }
  });

  it('cannot be switched off or bypassed through anything a caller sends', async () => {
    set('on');
    useFake(buildInstance());
    const hostile = { APP_MAINTENANCE: 'off', maintenance: 'off', mode: 'off', env: { APP_MAINTENANCE: 'off' } };
    for (const [fn, payload, mod] of RESOLVERS) {
      expect(await call(fn, { ...(payload as object), ...hostile }, ACCOUNTS.jiraAdmin, undefined, mod)).toMatchObject({ ok: false, code: 'unavailable' });
    }
    expect(process.env.APP_MAINTENANCE).toBe('on');
  });

  it('tells the UI, and stops Rovo and the nightly job', async () => {
    set('on');
    const fake = useFake(buildInstance());
    expect(await call('availability', {}, ACCOUNTS.projectAdmin)).toMatchObject({ ok: true, data: { mode: 'on', statusUrl: 'https://superapps.statuspage.io' } });
    expect(await rovoListScreens({ projectKey: 'PROJ' }, { principal: { accountId: ACCOUNTS.projectAdmin } })).toMatch(/temporarily unavailable/);
    kvsStore.set('config', { autoDelete: true, days: 1, auditRetentionMonths: 24, projectAccess: 'all', projects: [], crossProjectCopy: true });
    await nightly();
    expect(fake.writes).toBe(0);
    expect(fake.calls).toBe(0); // not even reads
  });

  it('availability still requires a signed-in caller', async () => {
    set('on');
    useFake(buildInstance());
    const r = await handler({ call: { functionKey: 'availability', payload: {} }, context: {} } as never, { principal: {} } as never);
    expect(r).toMatchObject({ ok: false, code: 'denied' });
  });
});

describe('APP_MAINTENANCE=readonly', () => {
  it('serves reads and refuses every write with no Jira writes', async () => {
    set('readonly');
    for (const [fn, payload, mod] of RESOLVERS) {
      const fake = useFake(buildInstance());
      const r = await call(fn, payload, ACCOUNTS.jiraAdmin, undefined, mod);
      if (WRITES.has(fn)) expect(r, fn).toMatchObject({ ok: false, code: 'unavailable' });
      else expect((r as { code?: string }).code, fn).not.toBe('unavailable');
      expect(fake.writes, fn).toBe(0);
    }
  });

  it('Rovo can answer but not change screens', async () => {
    set('readonly');
    const fake = useFake(buildInstance());
    const ctx = { principal: { accountId: ACCOUNTS.projectAdmin } };
    expect(await rovoListScreens({ projectKey: 'PROJ' }, ctx)).toMatch(/Screens of project PROJ/);
    expect(await rovoAddField({ projectKey: 'PROJ', screen: 'x', field: 'summary' }, ctx)).toMatch(/Changes are paused/);
    expect(fake.writes).toBe(0);
  });
});

describe('APP_MAINTENANCE=off (or unset)', () => {
  it('works normally', async () => {
    useFake(buildInstance());
    const r = await call<ProjectModel>('load', {}, ACCOUNTS.projectAdmin);
    expect(r.ok).toBe(true);
    expect(await call('availability', {}, ACCOUNTS.projectAdmin)).toMatchObject({ ok: true, data: { mode: 'off' } });
    const intent: Intent = { type: 'normalizeNames' };
    expect(intent.type).toBe('normalizeNames');
  });
});
