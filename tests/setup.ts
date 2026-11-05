/**
 * In-memory @forge/kvs for tests.
 * Registered as the Vitest setup file, so every test uses a Map-backed kvs (exported as kvsStore) with
 * prefix queries and cursors instead of Forge storage.
 *
 * @file        tests/setup.ts
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import { vi } from 'vitest';

export const kvsStore = new Map<string, unknown>();

vi.mock('@forge/kvs', () => {
  const query = () => {
    let prefix = '';
    let lim = 100;
    let start = 0;
    const q = {
      where: (_k: string, cond: { prefix: string }) => { prefix = cond.prefix; return q; },
      limit: (n: number) => { lim = n; return q; },
      cursor: (c: string) => { start = Number(c); return q; },
      getMany: async () => {
        const keys = [...kvsStore.keys()].filter((k) => k.startsWith(prefix)).sort();
        const slice = keys.slice(start, start + lim);
        return { results: slice.map((key) => ({ key, value: kvsStore.get(key) })), nextCursor: start + lim < keys.length ? String(start + lim) : undefined };
      },
    };
    return q;
  };
  return {
    kvs: {
      get: async (k: string) => kvsStore.get(k),
      set: async (k: string, v: unknown) => { kvsStore.set(k, structuredClone(v)); },
      delete: async (k: string) => { kvsStore.delete(k); },
      query,
    },
    WhereConditions: { beginsWith: (prefix: string) => ({ prefix }) },
  };
});
