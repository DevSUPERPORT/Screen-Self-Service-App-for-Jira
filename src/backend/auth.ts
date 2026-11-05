/**
 * Authorization. The app holds admin scopes, so it must never do more than the *caller* may do.
 * Identity (accountId) and project come exclusively from the Forge-signed context — never from the payload.
 *
 * @file        src/backend/auth.ts
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import { AppError, jira, route, runtimeLicense } from './jira';
import { getConfig } from './storage';

export interface Caller {
  accountId: string;
  projectId?: string;
  projectKey?: string;
  moduleKey?: string;
}

interface Ctx {
  accountId?: string;
  accountType?: string;
  moduleKey?: string;
  license?: { isActive?: boolean; active?: boolean } | null;
  extension?: { project?: { id?: string | number; key?: string }; type?: string };
}

export const PROJECT_MODULE = 'sss-project-settings';
export const ADMIN_MODULE = 'sss-admin';

/**
 * Marketplace licensing: Forge provides a license only for paid apps. When it is there and not active
 * (expired, cancelled), the app refuses to work. Free installs and development environments have none.
 */
export function requireActiveLicense(context: unknown) {
  const lic = (context as Ctx | undefined)?.license ?? runtimeLicense();
  if (lic && (lic.isActive === false || (lic.isActive === undefined && lic.active === false))) {
    // own code, so the UI can show a clear "license not active" page instead of a permission error
    throw new AppError('unlicensed', 'The license for Screen Self-Service for Jira is not active on this site. Ask your Jira admin to start a trial or renew the subscription.');
  }
}

export function callerFrom(context: unknown): Caller {
  const c = (context ?? {}) as Ctx;
  if (!c.accountId || c.accountType === 'anonymous') throw new AppError('denied', 'Not signed in');
  requireActiveLicense(context);
  const p = c.extension?.project;
  return {
    accountId: c.accountId,
    projectId: p?.id !== undefined ? String(p.id) : undefined,
    projectKey: p?.key,
    moduleKey: c.moduleKey,
  };
}

interface CheckResult {
  globalPermissions?: string[];
  projectPermissions?: { permission: string; projects?: number[] }[];
}

/** Evaluate the caller's real Jira permissions (server-side, by accountId). */
export async function permissionsOf(accountId: string, projectId?: string) {
  const body: Record<string, unknown> = { accountId, globalPermissions: ['ADMINISTER'] };
  if (projectId) body.projectPermissions = [{ permissions: ['ADMINISTER_PROJECTS'], projects: [Number(projectId)] }];
  const r = await jira.post<CheckResult>(route`/rest/api/3/permissions/check`, body);
  const jiraAdmin = !!r?.globalPermissions?.includes('ADMINISTER');
  const projectAdmin = !!projectId && !!r?.projectPermissions?.some((p) => p.permission === 'ADMINISTER_PROJECTS' && p.projects?.includes(Number(projectId)));
  return { jiraAdmin, projectAdmin: projectAdmin || jiraAdmin };
}

/** Project settings page: the project comes from the context of the page the user is on. */
export async function requireProjectAdmin(context: unknown) {
  const caller = callerFrom(context);
  if (caller.moduleKey && caller.moduleKey !== PROJECT_MODULE) throw new AppError('denied', 'Wrong module');
  if (!caller.projectId) throw new AppError('denied', 'No project context');
  const perms = await permissionsOf(caller.accountId, caller.projectId);
  if (!perms.projectAdmin) throw new AppError('denied', 'You need the "Administer Projects" permission for this project');
  await requireProjectEnabled(caller.projectId, caller.projectKey, perms.jiraAdmin);
  return { ...caller, projectId: caller.projectId, ...perms };
}

/**
 * The Jira admin decides which projects' admins may use the app (configuration page). Jira admins can
 * already change all of this in Jira itself, so they are never locked out.
 */
export async function requireProjectEnabled(projectId: string, projectKey: string | undefined, jiraAdmin: boolean) {
  if (jiraAdmin) return;
  const cfg = await getConfig();
  if (cfg.projectAccess !== 'selected') return;
  const key = projectKey ?? (await jira.get<{ key: string }>(route`/rest/api/3/project/${projectId}`, true))?.key;
  if (!key || !cfg.projects.includes(key.toUpperCase())) {
    throw new AppError('denied', 'Your Jira admin has not enabled Screen Self-Service for Jira for this project.');
  }
}

export async function requireJiraAdmin(context: unknown) {
  const caller = callerFrom(context);
  const perms = await permissionsOf(caller.accountId);
  if (!perms.jiraAdmin) throw new AppError('denied', 'Only Jira admins can change this');
  return { ...caller, ...perms };
}

/** Rovo actions: the project key is an input (may be hallucinated) — resolve it, then check the caller against it. */
export async function requireProjectAdminByKey(context: unknown, projectKey: unknown) {
  const caller = callerFrom(normalizeRovoContext(context));
  if (typeof projectKey !== 'string' || !/^[A-Z][A-Z0-9_]{0,19}$/i.test(projectKey.trim())) throw new AppError('invalid', 'Please name a valid project key');
  const p = await jira.get<{ id: string; key: string }>(route`/rest/api/3/project/${projectKey.trim().toUpperCase()}`, true);
  if (!p) throw new AppError('not-found', `Project ${projectKey} not found`);
  const perms = await permissionsOf(caller.accountId, p.id);
  if (!perms.projectAdmin) throw new AppError('denied', `You need the "Administer Projects" permission for ${p.key}`);
  await requireProjectEnabled(p.id, p.key, perms.jiraAdmin);
  return { ...caller, projectId: p.id, projectKey: p.key, ...perms };
}

/** Rovo passes the principal in different shapes across runtime versions. */
export function normalizeRovoContext(context: unknown): Ctx {
  const c = (context ?? {}) as Ctx & { principal?: { accountId?: string } };
  return { ...c, accountId: c.accountId ?? c.principal?.accountId };
}
