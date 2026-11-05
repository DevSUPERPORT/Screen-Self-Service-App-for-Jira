/**
 * fast-check arbitraries shared by the property tests: random instance shapes, and modelFor, which loads
 * the ProjectModel for a shape through the real load resolver against the in-memory Jira.
 *
 * @file        tests/arbs.ts
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import fc from 'fast-check';
import type { ProjectModel } from '../src/shared/types';
import { buildInstance, ACCOUNTS, type Shape } from './fixtures';
import { call, useFake } from './harness';

export const shapeArb: fc.Arbitrary<Shape> = fc.record({
  groups: fc.tuple(fc.integer({ min: 0, max: 3 }), fc.integer({ min: 0, max: 3 }), fc.integer({ min: 0, max: 3 }), fc.integer({ min: 0, max: 3 })),
  ops: fc.array(fc.tuple(fc.integer({ min: 0, max: 2 }), fc.integer({ min: 0, max: 2 }), fc.integer({ min: 0, max: 2 })), { minLength: 4, maxLength: 4 }),
  sharedGroup: fc.boolean(),
}) as fc.Arbitrary<Shape>;

export async function modelFor(shape: Shape): Promise<ProjectModel> {
  useFake(buildInstance(shape));
  const r = await call<ProjectModel>('load', {}, ACCOUNTS.projectAdmin);
  if (!r.ok) throw new Error(r.message);
  return r.data;
}

