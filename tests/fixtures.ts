/**
 * Test fixtures: account ids per role, the Shape that describes a generated instance, and buildInstance,
 * which builds a realistic fake Jira (target project PROJ, OTH sharing some configuration, team-managed
 * TEAM, optional extra projects). Also helpers for foreign objects and a caller's Forge context.
 *
 * @file        tests/fixtures.ts
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import type { FakeState, FScheme, FScreen } from './fakeJira';

export const ACCOUNTS = {
  projectAdmin: 'acc-project-admin',
  jiraAdmin: 'acc-jira-admin',
  member: 'acc-member',
  otherAdmin: 'acc-other-admin',
};

const ISSUE_TYPES = [
  { id: '1', name: 'Task' }, { id: '2', name: 'Story' }, { id: '3', name: 'Bug' }, { id: '4', name: 'Sub-task' }, { id: '5', name: 'Epic' },
];

const FIELD_IDS = ['summary', 'issuetype', 'description', 'priority', 'assignee', 'reporter', 'duedate', 'labels', 'components', 'environment', 'attachment',
  ...Array.from({ length: 20 }, (_, i) => `customfield_${10100 + i}`)];

export interface Shape {
  /** group index (0..3) for Task, Story, Bug, Sub-task — same index = same screen scheme */
  groups: [number, number, number, number];
  /** explicit create/edit/view per group: 0 none, 1 own screen, 2 same screen as default */
  ops: [number, number, number][];
  /** if true, group 3 uses a scheme shared with project OTH */
  sharedGroup: boolean;
}

export const DEFAULT_SHAPE: Shape = { groups: [0, 0, 1, 0], ops: [[1, 0, 1], [1, 1, 0], [0, 0, 0], [0, 0, 0]], sharedGroup: false };

/** A realistic instance: target project PROJ (id 100) + OTH (101, shares some config) + team-managed TEAM (102). */
export function buildInstance(shape: Shape = DEFAULT_SHAPE, extraProjects = 0): FakeState {
  let seq = 10000;
  const id = () => ++seq;
  const screens: FScreen[] = [];
  const schemes: FScheme[] = [];
  const fields = FIELD_IDS.map((f) => ({ id: f, name: f.startsWith('customfield') ? `Custom ${f.slice(12)}` : f[0].toUpperCase() + f.slice(1), custom: f.startsWith('customfield'), schema: { type: 'string', custom: f.startsWith('customfield') ? 'com.atlassian:textfield' : undefined } }));
  const mkScreen = (name: string, n = 5): FScreen => {
    const s: FScreen = { id: id(), name, tabs: [{ id: id(), name: 'Field Tab', fields: ['summary', 'issuetype', ...FIELD_IDS.slice(2, 2 + n)] }] };
    screens.push(s);
    return s;
  };
  // Shared defaults (used by every project)
  const defScreen = mkScreen('Default Screen', 8);
  const defScheme: FScheme = { id: id(), name: 'Default Screen Scheme', screens: { default: defScreen.id } };
  schemes.push(defScheme);

  // PROJ groups
  const groupScheme = new Map<number, FScheme>();
  const usedGroups = [...new Set(shape.groups)].sort();
  let sharedScheme: FScheme | null = null;
  for (const g of usedGroups) {
    if (shape.sharedGroup && g === 3) {
      const s = mkScreen('Shared Ops Screen', 4);
      sharedScheme = { id: id(), name: 'Shared Ops Screen Scheme', screens: { default: s.id } };
      schemes.push(sharedScheme);
      groupScheme.set(g, sharedScheme);
      continue;
    }
    const d = mkScreen(`PROJ Legacy ${g} Default`, 6);
    const sc: FScheme = { id: id(), name: `PROJ Legacy ${g} Scheme`, screens: { default: d.id } };
    const ops = shape.ops[g] ?? [0, 0, 0];
    (['create', 'edit', 'view'] as const).forEach((o, k) => {
      if (ops[k] === 1) sc.screens[o] = mkScreen(`PROJ Legacy ${g} ${o}`, 3 + k).id;
      if (ops[k] === 2) sc.screens[o] = d.id;
    });
    schemes.push(sc);
    groupScheme.set(g, sc);
  }
  const itssProj = { id: id(), name: 'PROJ ITSS', mappings: { default: defScheme.id } as Record<string, number> };
  shape.groups.forEach((g, i) => { itssProj.mappings[ISSUE_TYPES[i].id] = groupScheme.get(g)!.id; });
  const itssOth = { id: id(), name: 'OTH ITSS', mappings: { default: defScheme.id, ...(sharedScheme ? { '1': sharedScheme.id } : {}) } as Record<string, number> };
  const itssDefault = { id: id(), name: 'Default Issue Type Screen Scheme', mappings: { default: defScheme.id } as Record<string, number> };

  // unused leftovers with the PROJ prefix
  const leftover = mkScreen('PROJ Old - view - Screen', 2);
  const leftoverScheme: FScheme = { id: id(), name: 'PROJ Old - Screen Scheme', screens: { default: leftover.id } };
  schemes.push(leftoverScheme);

  // workflows
  const statuses = ['Open', 'In Progress', 'Done', 'Rejected'].map((n, i) => ({ id: String(i + 1), name: n, statusReference: `ref-${i}`, statusCategory: i === 2 ? 'DONE' : 'TODO' }));
  const trScreen = mkScreen('PROJ Transition - Review - Screen', 2);
  const resolveScreen = mkScreen('Resolution Screen', 2);
  const wfProj = {
    id: 'wf-proj', name: 'PROJ Workflow', version: { id: 'v1', versionNumber: 1 }, statuses: statuses.map((s) => ({ statusReference: s.statusReference })),
    transitions: [
      { id: '1', name: 'Create', type: 'INITIAL', toStatusReference: 'ref-0', links: [] },
      { id: '11', name: 'Start', type: 'DIRECTED', toStatusReference: 'ref-1', links: [{ fromStatusReference: 'ref-0' }] },
      { id: '21', name: 'Finish', type: 'DIRECTED', toStatusReference: 'ref-2', links: [{ fromStatusReference: 'ref-1' }], transitionScreen: { ruleKey: 'system:transition-screen', parameters: { screenId: String(trScreen.id) } } },
      { id: '31', name: 'Reject', type: 'DIRECTED', toStatusReference: 'ref-3', links: [{ fromStatusReference: 'ref-0' }] },
    ],
  };
  const wfShared = {
    id: 'wf-shared', name: 'Shared Bug Workflow', version: { id: 'v1', versionNumber: 1 }, statuses: statuses.map((s) => ({ statusReference: s.statusReference })),
    transitions: [{ id: '11', name: 'Resolve', type: 'DIRECTED', toStatusReference: 'ref-2', links: [{ fromStatusReference: 'ref-0' }], transitionScreen: { ruleKey: 'system:transition-screen', parameters: { screenId: String(resolveScreen.id) } } }],
  };

  const projects = [
    { id: 100, key: 'PROJ', name: 'Procurement', style: 'classic' as const, issueTypes: ISSUE_TYPES },
    { id: 101, key: 'OTH', name: 'Other', style: 'classic' as const, issueTypes: ISSUE_TYPES },
    { id: 102, key: 'TEAM', name: 'Team', style: 'next-gen' as const, issueTypes: ISSUE_TYPES.slice(0, 2) },
  ];
  const projectItss: Record<number, number> = { 100: itssProj.id, 101: itssOth.id };
  for (let i = 0; i < extraProjects; i++) {
    const pid = 1000 + i;
    projects.push({ id: pid, key: `X${i}`, name: `Extra ${i}`, style: 'classic', issueTypes: ISSUE_TYPES });
    projectItss[pid] = itssDefault.id;
  }

  return {
    projects,
    screens,
    schemes,
    itss: [itssProj, itssOth, itssDefault],
    projectItss,
    workflows: [wfProj, wfShared],
    statuses,
    workflowSchemes: [
      { id: 1, projectIds: [100], defaultWorkflow: 'PROJ Workflow', issueTypeMappings: { '3': 'Shared Bug Workflow' } },
      { id: 2, projectIds: [101, ...Array.from({ length: extraProjects }, (_, i) => 1000 + i)], defaultWorkflow: 'Shared Bug Workflow', issueTypeMappings: {} },
    ],
    fields,
    fieldSchemes: [
      { id: 1, name: 'PROJ Field Scheme', projectIds: [100], fields: FIELD_IDS.slice(0, 25) },
      { id: 2, name: 'Default Field Scheme', projectIds: [101], fields: FIELD_IDS },
    ],
    globalAdmins: [ACCOUNTS.jiraAdmin],
    projectAdmins: { 100: [ACCOUNTS.projectAdmin], 101: [ACCOUNTS.otherAdmin] },
    seq,
  };
}

/** Everything in Jira that does NOT belong exclusively to PROJ — must never change through the app. */
export function foreignPart(s: FakeState, projectId = 100) {
  const ownItss = s.projectItss[projectId];
  const otherItss = s.itss.filter((i) => i.id !== ownItss);
  const otherSchemeIds = new Set(otherItss.flatMap((i) => Object.values(i.mappings)));
  const otherScreenIds = new Set(s.schemes.filter((sc) => otherSchemeIds.has(sc.id)).flatMap((sc) => Object.values(sc.screens)));
  const sharedWf = s.workflows.filter((w) => s.workflowSchemes.some((ws) => (ws.defaultWorkflow === w.name || Object.values(ws.issueTypeMappings).includes(w.name)) && ws.projectIds.some((p) => p !== projectId)));
  for (const w of sharedWf) for (const t of w.transitions) if (t.transitionScreen) otherScreenIds.add(Number(t.transitionScreen.parameters.screenId));
  return {
    itss: otherItss,
    schemes: s.schemes.filter((sc) => otherSchemeIds.has(sc.id)),
    screens: s.screens.filter((x) => otherScreenIds.has(x.id)),
    workflows: sharedWf,
    fieldSchemes: (s.fieldSchemes ?? []).filter((f) => f.projectIds.some((p) => p !== projectId)),
  };
}

export const ctxFor = (accountId: string, project = { id: '100', key: 'PROJ' }) => ({
  event: { context: { moduleKey: 'sss-project-settings', extension: { type: 'jira:projectSettingsPage', project } } },
  runtime: { principal: { accountId } },
});
