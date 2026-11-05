/**
 * Demo instance for local development outside Jira (mirrors the SUPERPORT app design).
 *
 * @file        static/app/src/api/demo.ts
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import type { AuditEntry, Field, ProjectModel, Screen, Tab } from '@shared/types';

const F = (id: string, name: string, type: string, system = false, locked = false): Field => ({ id, name, type, system, locked });

const fields: Field[] = [
  F('summary', 'Summary', 'System field', true, true),
  F('issuetype', 'Issue type', 'System field', true, true),
  F('description', 'Description', 'System field', true),
  F('priority', 'Priority', 'System field', true),
  F('assignee', 'Assignee', 'System field', true),
  F('reporter', 'Reporter', 'System field', true),
  F('duedate', 'Due date', 'System field', true),
  F('labels', 'Labels', 'System field', true),
  F('components', 'Components', 'System field', true),
  F('fixVersions', 'Fix versions', 'System field', true),
  F('environment', 'Environment', 'System field', true),
  F('attachment', 'Attachment', 'System field', true),
  F('timetracking', 'Time tracking', 'System field', true),
  F('customfield_10234', 'Cost center', 'Single select'),
  F('customfield_10055', 'Approval date', 'Date picker'),
  F('customfield_10061', 'Supplier', 'Single select'),
  F('customfield_10062', 'Delivery date', 'Date picker'),
  F('customfield_10063', 'Delivery address', 'Paragraph'),
  F('customfield_10070', 'Steps to reproduce', 'Paragraph'),
  F('customfield_10071', 'Severity', 'Single select'),
  F('customfield_10016', 'Story points', 'Number'),
  F('customfield_10020', 'Sprint', 'Sprint'),
  F('customfield_10080', 'Approver', 'User picker'),
  F('customfield_10081', 'Rejection reason', 'Paragraph'),
  F('customfield_10082', 'Acceptance criteria', 'Paragraph'),
  F('customfield_10090', 'Budget', 'Number'),
];

let tabSeq = 0;
const T = (name: string, fieldIds: string[]): Tab => ({ id: `tab-${++tabSeq}`, name, fieldIds });

function S(id: string, name: string, tabs: Tab[], extra: Partial<Screen> = {}): Screen {
  return {
    id, name, tabs, tabCount: tabs.length, fieldCount: tabs.reduce((n, t) => n + t.fieldIds.length, 0),
    createdByApp: false, projects: ['PROJ'], projectCount: 1, screenSchemeIds: [], workflowIds: [], ...extra,
  };
}

const sharedProjects = ['PROJ', 'SRV', 'HW', 'MKT', 'OPS', 'FIN', 'HR', 'LEGAL', 'SALES', 'IT', 'DATA', 'WEB', 'APP', 'QA', 'SEC', 'PM', 'CS', 'PR', 'BI', 'ERP', 'CRM', 'LOG', 'PAY', 'DOC'];

export function demoModel(): ProjectModel {
  tabSeq = 0;
  const screens: Screen[] = [
    S('10001', 'PROJ Task - default - Screen', [
      T('General', ['summary', 'issuetype', 'description', 'priority', 'assignee', 'duedate']),
      T('Details', ['customfield_10234', 'labels', 'components', 'customfield_10061', 'customfield_10063']),
      T('Approval', ['customfield_10080', 'customfield_10090', 'customfield_10055']),
    ]),
    S('10002', 'PROJ Task - create - Screen', [
      T('Field Tab', ['summary', 'issuetype', 'description', 'priority', 'assignee', 'customfield_10234']),
    ]),
    S('10003', 'PROJ Task - view - Screen', [
      T('Overview', ['summary', 'issuetype', 'description', 'priority', 'assignee']),
      T('Planning', ['duedate', 'fixVersions', 'customfield_10016', 'customfield_10020']),
      T('Details', ['customfield_10234', 'labels', 'components', 'customfield_10061']),
      T('Approval', ['customfield_10080', 'customfield_10090', 'customfield_10055', 'customfield_10082', 'attachment']),
    ]),
    S('10004', 'PROJ Bug - default - Screen', [
      T('Defect', ['summary', 'issuetype', 'description', 'environment', 'customfield_10070', 'priority']),
      T('Triage', ['customfield_10071', 'assignee', 'components', 'fixVersions', 'labels']),
      T('Files', ['attachment', 'reporter', 'duedate', 'timetracking', 'customfield_10234']),
    ]),
    S('10005', 'PROJ Bug - create, edit - Screen', [
      T('Defect', ['summary', 'issuetype', 'description', 'environment', 'customfield_10070']),
      T('Triage', ['priority', 'customfield_10071', 'components', 'attachment']),
    ]),
    S('10006', 'Default Screen', [
      T('Field Tab', ['summary', 'issuetype', 'description', 'priority', 'assignee', 'labels', 'reporter', 'duedate', 'components', 'fixVersions', 'environment', 'attachment', 'timetracking', 'customfield_10016', 'customfield_10020', 'customfield_10234', 'customfield_10061', 'customfield_10062', 'customfield_10063', 'customfield_10070', 'customfield_10071', 'customfield_10082']),
    ], { projects: sharedProjects, projectCount: 24 }),
    S('10007', 'PROJ Transition - Acceptance - Screen', [T('Field Tab', ['customfield_10080', 'customfield_10055', 'customfield_10082'])]),
    S('10008', 'PROJ Transition - Rejection - Screen', [T('Field Tab', ['customfield_10081', 'assignee'])]),
    S('10009', 'Resolution Screen', [T('Field Tab', ['assignee', 'fixVersions', 'customfield_10081', 'timetracking'])], { projects: sharedProjects.slice(0, 12), projectCount: 12 }),
    S('10010', 'PROJ Bug - view - Screen', [T('Field Tab', ['summary', 'description', 'environment', 'customfield_10070', 'priority', 'customfield_10071', 'assignee', 'components', 'fixVersions', 'labels', 'attachment'])], { projects: [], projectCount: 0, createdByApp: true }),
    S('10011', 'PROJ Transition - Escalation - Screen', [T('Field Tab', ['assignee', 'priority'])], { projects: [], projectCount: 0, createdByApp: true }),
  ];
  const foreign: Screen[] = [
    ['20001', 'SRV Bug - create - Screen', 'SRV', [T('Defect', ['summary', 'description', 'environment', 'customfield_10070', 'priority', 'components', 'attachment'])]],
    ['20002', 'Default Bug Screen', '', [T('Field Tab', ['summary', 'issuetype', 'description', 'environment', 'priority', 'assignee', 'reporter', 'components', 'fixVersions', 'labels', 'attachment', 'customfield_10071'])]],
    ['20003', 'Hardware Bug report - Create', 'HW', [T('Report', ['summary', 'description', 'environment', 'customfield_10070', 'attachment', 'priority']), T('Device', ['components', 'labels', 'customfield_10061', 'customfield_10063', 'reporter'])]],
    ['20004', 'SCRUM: Bug Screen', 'SCRUM', [T('Field Tab', ['summary', 'description', 'priority', 'assignee', 'customfield_10016', 'customfield_10020', 'labels', 'components', 'fixVersions', 'attachment'])]],
    ['20005', 'MKT Campaign - default - Screen', 'MKT', [T('Brief', ['summary', 'description', 'duedate', 'customfield_10090', 'assignee']), T('Approval', ['customfield_10080', 'customfield_10055'])]],
    ['20006', 'OPS Incident - create - Screen', 'OPS', [T('Incident', ['summary', 'description', 'priority', 'customfield_10071', 'environment'])]],
    ['20007', 'FIN Invoice - default - Screen', 'FIN', [T('Invoice', ['summary', 'customfield_10234', 'customfield_10090', 'customfield_10061', 'duedate', 'attachment'])]],
    ['20008', 'HR Onboarding - create - Screen', 'HR', [T('Person', ['summary', 'assignee', 'duedate', 'description'])]],
    ['20009', 'Workflow Screen', '', [T('Field Tab', ['assignee', 'fixVersions'])]],
    ['20010', 'SRV Request - view - Screen', 'SRV', [T('Request', ['summary', 'description', 'priority', 'reporter', 'assignee', 'labels'])]],
    ['20011', 'WEB Story - create, edit - Screen', 'WEB', [T('Story', ['summary', 'description', 'customfield_10082', 'customfield_10016', 'customfield_10020'])]],
    ['20012', 'IT Bug - default - Screen', 'IT', [T('Bug', ['summary', 'description', 'environment', 'priority', 'assignee', 'customfield_10070'])]],
    ['20013', 'DATA Task - default - Screen', 'DATA', [T('Task', ['summary', 'description', 'assignee', 'duedate'])]],
    ['20014', 'QA Test - view - Screen', 'QA', [T('Test', ['summary', 'description', 'customfield_10070', 'customfield_10082'])]],
  ].map(([id, name, proj, tabs]) => S(id as string, name as string, tabs as Tab[], {
    foreign: true, projects: proj ? [proj as string] : [], projectCount: proj ? 1 : (id === '20002' ? 3 : 0),
  }));

  const model: ProjectModel = {
    project: { id: '10000', key: 'PROJ', name: 'Procurement' },
    viewer: { accountId: 'demo', name: 'Alex Demo', isProjectAdmin: true, isJiraAdmin: true },
    issueTypes: [
      { id: 'it-task', name: 'Task' },
      { id: 'it-story', name: 'Story' },
      { id: 'it-bug', name: 'Bug' },
      { id: 'it-epic', name: 'Epic' },
    ],
    itss: {
      id: 'itss-1', name: 'PROJ Issue Type Screen Scheme', projects: ['PROJ'], projectCount: 1,
      mappings: { default: 'sc-3', 'it-task': 'sc-1', 'it-story': 'sc-1', 'it-bug': 'sc-2' },
    },
    screenSchemes: {
      'sc-1': { id: 'sc-1', name: 'PROJ Task - Screen Scheme', screens: { default: '10001', create: '10002', view: '10003' }, createdByApp: true, projects: ['PROJ'], projectCount: 1 },
      'sc-2': { id: 'sc-2', name: 'PROJ Bug - Screen Scheme', screens: { default: '10004', create: '10005', edit: '10005' }, createdByApp: true, projects: ['PROJ'], projectCount: 1 },
      'sc-3': { id: 'sc-3', name: 'Default Screen Scheme', screens: { default: '10006' }, createdByApp: false, projects: sharedProjects, projectCount: 24 },
      'sc-4': { id: 'sc-4', name: 'PROJ Improvement - Screen Scheme', screens: { default: '10010' }, createdByApp: true, projects: [], projectCount: 0 },
    },
    screens: Object.fromEntries([...screens, ...foreign].map((s) => [s.id, s])),
    workflows: [
      {
        id: 'wf-1', name: 'PROJ Workflow', projects: ['PROJ'], projectCount: 1, active: true,
        statuses: [{ id: 'st-1', name: 'Open' }, { id: 'st-2', name: 'In Progress' }, { id: 'st-3', name: 'In Review' }, { id: 'st-4', name: 'Done' }, { id: 'st-5', name: 'Rejected' }],
        transitions: [
          { id: '11', name: 'Start work', from: ['Open'], to: 'In Progress' },
          { id: '21', name: 'Submit for review', from: ['In Progress'], to: 'In Review' },
          { id: '31', name: 'Accept', from: ['In Review'], to: 'Done', screenId: '10007' },
          { id: '41', name: 'Reject', from: ['In Review'], to: 'Rejected', screenId: '10008' },
          { id: '51', name: 'Decline', from: ['Open'], to: 'Rejected', screenId: '10008' },
          { id: '61', name: 'Reopen', from: ['Done', 'Rejected'], to: 'Open' },
        ],
      },
      {
        id: 'wf-2', name: 'PROJ Procurement Workflow (draft)', projects: ['PROJ'], projectCount: 1, active: false,
        statuses: [{ id: 'st-1', name: 'Open' }, { id: 'st-6', name: 'Ordered' }, { id: 'st-4', name: 'Done' }],
        transitions: [
          { id: '11', name: 'Order', from: ['Open'], to: 'Ordered' },
          { id: '21', name: 'Receive goods', from: ['Ordered'], to: 'Done' },
        ],
      },
      {
        id: 'wf-3', name: 'Standard Bug Workflow', projects: sharedProjects.slice(0, 12), projectCount: 12, active: true,
        statuses: [{ id: 'st-1', name: 'Open' }, { id: 'st-7', name: 'Resolved' }],
        transitions: [{ id: '11', name: 'Resolve', from: ['Open'], to: 'Resolved', screenId: '10009' }],
      },
    ],
    fieldScheme: {
      id: 'fs-1', name: 'PROJ Field Scheme', projects: ['PROJ'], projectCount: 1,
      fieldIds: fields.filter((f) => !['customfield_10062', 'customfield_10063'].includes(f.id)).map((f) => f.id),
    },
    fields: Object.fromEntries(fields.map((f) => [f.id, f])),
    unused: [
      { kind: 'screenScheme', id: 'sc-4', name: 'PROJ Improvement - Screen Scheme', since: daysAgo(2), createdByApp: true },
      { kind: 'screen', id: '10010', name: 'PROJ Bug - view - Screen', since: daysAgo(24), createdByApp: true },
      { kind: 'screen', id: '10011', name: 'PROJ Transition - Escalation - Screen', since: daysAgo(6), createdByApp: true },
    ],
    config: { autoDelete: true, days: 30, auditRetentionMonths: 24, projectAccess: 'all', projects: [], crossProjectCopy: true },
    loadedAt: new Date().toISOString(),
  };
  // usage wiring
  for (const sc of Object.values(model.screenSchemes)) for (const id of Object.values(sc.screens)) {
    if (id && !model.screens[id].screenSchemeIds.includes(sc.id)) model.screens[id].screenSchemeIds.push(sc.id);
  }
  for (const wf of model.workflows) for (const t of wf.transitions) if (t.screenId && !model.screens[t.screenId].workflowIds.includes(wf.id)) model.screens[t.screenId].workflowIds.push(wf.id);
  return model;
}

function daysAgo(n: number) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

export function demoAudit(): AuditEntry[] {
  const u = { accountId: 'demo', name: 'Alex Demo' };
  const at = (h: number) => new Date(Date.now() - h * 3600000).toISOString();
  return [
    { id: 'a1', at: at(1), user: u, action: 'Screen edited', object: 'PROJ Task - default - Screen', before: 'General: 5 fields', after: 'General: 6 fields (+ Due date)' },
    { id: 'a2', at: at(26), user: u, action: 'Assignment changed', object: 'PROJ Bug - Screen Scheme', before: 'Edit inherits from Default', after: 'Edit → PROJ Bug - create, edit - Screen' },
    { id: 'a3', at: at(26), user: u, action: 'Screen renamed', object: 'PROJ Bug - create, edit - Screen', before: 'PROJ Bug - create - Screen', after: 'PROJ Bug - create, edit - Screen' },
    { id: 'a4', at: at(52), user: { accountId: 'x', name: 'Jira Admin' }, action: 'Configuration changed', object: 'Auto-deletion', before: 'off', after: 'on · 30 days' },
    { id: 'a5', at: at(150), user: u, action: 'Transition screen assigned', object: 'PROJ Transition - Rejection - Screen', before: '—', after: 'PROJ Workflow: Open → Rejected' },
  ];
}
