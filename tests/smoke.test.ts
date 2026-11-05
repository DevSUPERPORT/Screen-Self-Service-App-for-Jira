/**
 * Smoke test: loads the project model through the load resolver against the in-memory Jira and checks the
 * basics, such as the project key, issue type groups and screen and scheme exclusivity.
 *
 * @file        tests/smoke.test.ts
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import { describe, expect, it } from 'vitest';
import type { ProjectModel } from '../src/shared/types';
import { groupsOf, schemeExclusive, screenExclusive } from '../src/shared/domain';
import { buildInstance, ACCOUNTS } from './fixtures';
import { call, useFake } from './harness';

describe('loader against the in-memory Jira', () => {
  it('builds the project model with correct exclusivity', async () => {
    useFake(buildInstance({ groups: [0, 0, 1, 3], ops: [[1, 0, 1], [1, 1, 0], [0, 0, 0], [0, 0, 0]], sharedGroup: true }));
    const r = await call<ProjectModel>('load', {}, ACCOUNTS.projectAdmin);
    expect(r.ok).toBe(true);
    const m = (r as { data: ProjectModel }).data;
    expect(m.environmentIssue).toBeUndefined();
    expect(m.project.key).toBe('PROJ');
    const groups = groupsOf(m);
    // Task+Story share group 0, Bug group 1, Sub-task the shared scheme, Epic the shared default
    expect(groups.map((g) => g.title).sort()).toEqual(['Bug', 'Epic', 'Story, Task', 'Sub-task'].sort());
    const shared = groups.find((g) => g.title === 'Sub-task')!;
    expect(schemeExclusive(m, shared.schemeId)).toBe(false);
    const own = groups.find((g) => g.title === 'Bug')!;
    expect(schemeExclusive(m, own.schemeId)).toBe(true);
    expect(screenExclusive(m, m.screenSchemes[own.schemeId].screens.default)).toBe(true);
    // the shared workflow is not editable, the project workflow is
    expect(m.workflows.find((w) => w.name === 'PROJ Workflow')!.projectCount).toBe(1);
    expect(m.workflows.find((w) => w.name === 'Shared Bug Workflow')!.projectCount).toBe(2);
    // leftovers with the PROJ prefix are reported unused
    expect(m.unused.map((u) => u.name).sort()).toEqual(['PROJ Old - Screen Scheme', 'PROJ Old - view - Screen']);
    expect(m.fieldScheme?.projectCount).toBe(1);
  });

  it('reports team-managed and legacy field configuration sites instead of half-working', async () => {
    useFake(buildInstance());
    const team = await call<ProjectModel>('load', {}, ACCOUNTS.jiraAdmin, { id: '102', key: 'TEAM' });
    expect(team.ok && team.data.environmentIssue).toBe('team-managed');
    const legacy = buildInstance();
    legacy.fieldSchemes = null;
    useFake(legacy);
    const l = await call<ProjectModel>('load', {}, ACCOUNTS.projectAdmin);
    expect(l.ok && l.data.environmentIssue).toBe('legacy-field-config');
  });
});
