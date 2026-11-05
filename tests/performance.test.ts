/**
 * Large-instance budget: 1,000 projects, 5,000 screen schemes / screens, 300 workflows.
 * Each fake call waits LATENCY ms, so concurrency behaves like the real thing. CPU time is measured separately
 * (zero latency) and only the waiting part is scaled to a realistic Jira Cloud latency.
 *
 * @file        tests/performance.test.ts
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import { describe, expect, it, vi } from 'vitest';
import type { ProjectModel } from '../src/shared/types';
import { ACCOUNTS, buildInstance } from './fixtures';
import { call, useFake } from './harness';

const LATENCY = 20;          // ms per call in the fake
const REAL_LATENCY = 150;    // typical Jira Cloud REST latency seen from Forge
const BUDGET_MS = 8000;      // cold overview load budget at real latency (Forge hard limit: 25 s)

function largeInstance() {
  const s = buildInstance(undefined, 1000);
  let seq = s.seq;
  // every extra project gets its own ITSS with 5 schemes → 5,000 schemes / screens
  for (const p of s.projects.filter((x) => x.id >= 1000)) {
    const itss = { id: ++seq, name: `${p.key} ITSS`, mappings: {} as Record<string, number> };
    for (let k = 0; k < 5; k++) {
      const scr = { id: ++seq, name: `${p.key} Screen ${k}`, tabs: [{ id: ++seq, name: 'Field Tab', fields: ['summary', 'issuetype'] }] };
      const sc = { id: ++seq, name: `${p.key} Scheme ${k}`, screens: { default: scr.id } };
      s.screens.push(scr);
      s.schemes.push(sc);
      itss.mappings[k === 0 ? 'default' : String(k)] = sc.id;
    }
    s.itss.push(itss);
    s.projectItss[p.id] = itss.id;
  }
  for (let w = 0; w < 300; w++) s.workflows.push({ ...structuredClone(s.workflows[1]), id: `wf-bulk-${w}`, name: `Bulk Workflow ${w}` });
  s.seq = seq;
  return s;
}

/**
 * The same load in virtual time: Jira latency is simulated with fake timers, so the measured time is exactly the
 * number of sequential round-trips × LATENCY — independent of how busy the machine running the tests is.
 */
async function virtualLoad() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  try {
    const t0 = Date.now();
    let r: Awaited<ReturnType<typeof call<ProjectModel>>> | undefined;
    void call<ProjectModel>('load', {}, ACCOUNTS.projectAdmin).then((x) => { r = x; });
    while (!r) await vi.advanceTimersByTimeAsync(1);
    expect(r.ok, !r.ok ? r.message : '').toBe(true);
    return Date.now() - t0;
  } finally {
    vi.useRealTimers();
  }
}

async function timedLoad() {
  const t0 = Date.now();
  const r = await call<ProjectModel>('load', {}, ACCOUNTS.projectAdmin);
  expect(r.ok, !r.ok ? r.message : '').toBe(true);
  return Date.now() - t0;
}

describe('large instance', () => {
  it(`cold overview load stays within ${BUDGET_MS} ms at ${REAL_LATENCY} ms Jira latency`, async () => {
    const big = largeInstance();
    // best of 3 for both measurements: other test files run in parallel and steal CPU, which would otherwise
    // be counted (and multiplied) as Jira round-trips
    let cpu = Infinity;
    for (let k = 0; k < 3; k++) { useFake(big); cpu = Math.min(cpu, await timedLoad()); }
    const fake = useFake(big, { latencyMs: LATENCY });
    const rounds = (await virtualLoad()) / LATENCY;               // sequential round-trips on the critical path
    const projected = Math.round(cpu + rounds * REAL_LATENCY);
    console.log(`[perf] calls=${fake.calls} cpu=${cpu}ms rounds≈${rounds.toFixed(1)} → projected cold load ${projected}ms @${REAL_LATENCY}ms`);
    expect(projected).toBeLessThan(BUDGET_MS);

    // warm load in the same container reuses the instance graph (15 s cache)
    const before = fake.calls;
    const warmWall = await timedLoad();
    const warm = Math.round(Math.max(0, warmWall - cpu / 3) * REAL_LATENCY / LATENCY);
    console.log(`[perf] warm: calls=${fake.calls - before} projected ≈${warm}ms`);
    expect(fake.calls - before).toBeLessThan(fake.calls / 4);
  });
});
