/**
 * Shared contract between the Custom UI, the local mock and the Forge backend.
 * Defines the ProjectModel, plans and plan steps, intents, layout saves, configuration and audit entries.
 *
 * @file        src/shared/types.ts
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

export type Op = 'default' | 'create' | 'edit' | 'view';
export const OPS: Op[] = ['default', 'create', 'edit', 'view'];

export interface Field {
  id: string;
  name: string;
  type: string;
  system: boolean;
  /** Required fields (e.g. summary) can never be removed from a screen. */
  locked?: boolean;
}

export interface Tab {
  id: string;
  name: string;
  fieldIds: string[];
}

export interface Screen {
  id: string;
  name: string;
  tabCount: number;
  fieldCount: number;
  /** Loaded lazily — only for screens the user opens. */
  tabs?: Tab[];
  createdByApp: boolean;
  /** Keys of every project that reaches this screen (schemes + workflows, incl. inactive/drafts). */
  projects: string[];
  /** Total project count when `projects` is truncated (instance-wide shared screens). */
  projectCount: number;
  screenSchemeIds: string[];
  workflowIds: string[];
  /** Global screens of other projects shown in the copy dialog */
  foreign?: boolean;
}

export interface ScreenScheme {
  id: string;
  name: string;
  screens: { default: string; create?: string; edit?: string; view?: string };
  createdByApp: boolean;
  projects: string[];
  projectCount: number;
}

export interface IssueType {
  id: string;
  name: string;
  iconUrl?: string;
}

export interface Itss {
  id: string;
  name: string;
  projects: string[];
  projectCount: number;
  /** issueTypeId -> screenSchemeId; key "default" is the fallback for unmapped issue types */
  mappings: Record<string, string>;
}

export interface Transition {
  id: string;
  name: string;
  from: string[];
  to: string;
  screenId?: string;
}

export interface Workflow {
  id: string;
  name: string;
  /** Workflow id used by Jira for updates (new API) + optimistic version */
  version?: { id: string; versionNumber: number };
  projects: string[];
  projectCount: number;
  active: boolean;
  statuses: { id: string; name: string }[];
  transitions: Transition[];
}

export interface FieldScheme {
  id: string;
  name: string;
  projects: string[];
  projectCount: number;
  fieldIds: string[];
}

export interface UnusedItem {
  kind: 'screen' | 'screenScheme';
  id: string;
  name: string;
  since: string; // ISO date
  createdByApp: boolean;
  detail?: string;
}

export interface AppConfig {
  autoDelete: boolean;
  days: number;
  auditRetentionMonths: 0 | 12 | 24 | 36;
  /** Which projects' admins may use the app: every project, or only the listed project keys. */
  projectAccess: 'all' | 'selected';
  projects: string[];
  /** Whether project admins may see and copy screens of other projects (UC-04). */
  crossProjectCopy: boolean;
}

export interface AuditEntry {
  id: string;
  at: string;
  /** Only the accountId is stored; the display name is resolved when the log is read (personal data). */
  user: { accountId: string; name: string; via?: string };
  action: string;
  object: string;
  before?: string;
  after?: string;
}

export interface Viewer {
  accountId: string;
  name: string;
  isProjectAdmin: boolean;
  isJiraAdmin: boolean;
}

export type EnvironmentIssue = 'team-managed' | 'legacy-field-config' | 'no-permission';

export interface ProjectModel {
  project: { id: string; key: string; name: string };
  viewer: Viewer;
  environmentIssue?: EnvironmentIssue;
  issueTypes: IssueType[];
  itss: Itss;
  screenSchemes: Record<string, ScreenScheme>;
  screens: Record<string, Screen>;
  workflows: Workflow[];
  fieldScheme: FieldScheme | null;
  fields: Record<string, Field>;
  unused: UnusedItem[];
  config: AppConfig;
  loadedAt: string;
  /** this user's most recent undoable change in this project */
  lastChange?: { label: string; at: string } | null;
}

// ---------- Plans: the single source of truth for previews AND execution ----------

export type PlanStep =
  // seed: fields a new, otherwise empty screen starts with (a create screen needs Summary and Issue Type)
  | { kind: 'createScreen'; ref: string; name: string; copyFrom?: string; seed?: string[] }
  | { kind: 'renameScreen'; screenId: string; from: string; to: string }
  | { kind: 'createScreenScheme'; ref: string; name: string; screens: Record<Op, string | undefined> }
  // 'before' / 'from' record what the user saw: part of the digest, so a concurrent change is a conflict, not a lost update
  | { kind: 'updateScreenScheme'; schemeId: string; screens: Record<Op, string | undefined>; before: Record<Op, string | undefined> }
  | { kind: 'renameScreenScheme'; schemeId: string; from: string; to: string }
  // screenSchemeId null = remove the explicit mapping (the issue type falls back to the default mapping; used by undo)
  | { kind: 'mapIssueType'; itssId: string; issueTypeId: string; screenSchemeId: string | null; from: string | null }
  | { kind: 'setTransitionScreen'; workflowId: string; transitionId: string; screenId: string | null; from: string | null }
  | { kind: 'deleteScreen'; screenId: string; name: string }
  | { kind: 'deleteScreenScheme'; schemeId: string; name: string };

export type PreviewKind = 'new' | 'renamed' | 'changed' | 'unchanged' | 'freed' | 'deleted';

export interface PreviewItem {
  kind: PreviewKind;
  title: string;
  detail?: string;
  from?: string;
}

export interface Plan {
  steps: PlanStep[];
  preview: PreviewItem[];
  /** Objects the backend must re-verify as project-exclusive right before executing */
  guard: { screens: string[]; screenSchemes: string[]; itss: boolean; workflows: string[] };
}

/** Desired layout sent when saving the editor. The backend diffs it against Jira's live state. */
export interface LayoutSave {
  screenId: string;
  /** tabsDigest() of the layout the user started editing from — detects concurrent edits (e.g. native issue layout) */
  baseDigest?: string;
  tabs: { id: string | null; name: string; fieldIds: string[] }[];
}

/**
 * What the user wants. The client only ever sends intents; the backend rebuilds the plan from
 * fresh Jira state with the same rules, so a client can never smuggle in arbitrary steps.
 */
export type Intent =
  | { type: 'assign'; schemeId: string; next: Record<Op, string | undefined>; newScreens: { ref: string; copyFrom?: string; op: Op; issueType: string }[] }
  | { type: 'split'; schemeId: string; issueTypeId: string; mode: 'copy' | 'share' }
  | { type: 'merge'; issueTypeId: string; targetSchemeId: string }
  | { type: 'transition'; screenId: string; workflowId: string; transitionId: string; on: boolean }
  | { type: 'newTransitionScreen'; text: string; copyFrom?: string }
  // Screens and screen schemes have separate id sequences in Jira — always qualify by kind
  | { type: 'delete'; items: { kind: 'screen' | 'screenScheme'; id: string }[] }
  // Health fix: bring every name of the project back in line with the naming scheme
  | { type: 'normalizeNames' };
