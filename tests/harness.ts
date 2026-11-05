/**
 * Test harness: useFake resets the in-memory Jira, KVS and caches, and call invokes a resolver through the
 * real Forge handler with a signed-context-like caller, exactly like Forge does.
 *
 * @file        tests/harness.ts
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import { setTransport } from '../src/backend/jira';
import { invalidateCache } from '../src/backend/loader';
import { handler } from '../src/index';
import { FakeJira, type FakeOptions, type FakeState } from './fakeJira';
import { ctxFor } from './fixtures';
import { kvsStore } from './setup';

/** Fresh fake Jira + empty KVS + cold caches. */
export function useFake(state: FakeState, opts: FakeOptions = {}) {
  const fake = new FakeJira(state, opts);
  setTransport(fake.transport, { sleep: async () => {} });
  invalidateCache();
  kvsStore.clear();
  return fake;
}

type Res<T> = { ok: true; data: T } | { ok: false; code: string; message: string };

/** Invokes a resolver exactly like Forge does: identity from the runtime principal, project from the context. */
export async function call<T = any>(fn: string, payload: unknown, accountId: string, project?: { id: string; key: string }, moduleKey?: string): Promise<Res<T>> {
  const c = ctxFor(accountId, project);
  const context = moduleKey ? { ...c.event.context, moduleKey } : c.event.context;
  return handler({ call: { functionKey: fn, payload }, context } as never, c.runtime as never) as Promise<Res<T>>;
}
