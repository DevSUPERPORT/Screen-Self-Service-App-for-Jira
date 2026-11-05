/**
 * Kill switch for incidents (e.g. a vulnerability): SUPERPORT can take the app down for every customer at once.
 *
 * The switch is the Forge environment variable APP_MAINTENANCE of the app's environment:
 *   off (or unset) — normal operation
 *   readonly       — everything can be viewed, nothing can be changed (no writes to Jira, no auto-deletion)
 *   on             — the app refuses every request; the UI shows "temporarily unavailable"
 *
 * Who can flip it: only the app's owner, with the Forge CLI / developer console (`forge variables set`) followed by
 * a deploy — in practice through the SUPERPORT ops panel. Customers, Jira admins and anyone who reads the Custom UI
 * bundle cannot: the value lives in Atlassian's runtime, is read only on the server, and the app has no resolver,
 * setting or URL that changes it. The app never contacts Statuspage and holds no Statuspage or Forge credentials.
 *
 * Fail closed: a value that isn't one of the three known ones is treated as "on".
 *
 * @file        src/backend/maintenance.ts
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import { AppError } from './jira';

export type MaintenanceMode = 'off' | 'readonly' | 'on';

/** Public status page shown to users while the app is unavailable. */
export const STATUS_PAGE_URL = 'https://superapps.statuspage.io';

const VAR = 'APP_MAINTENANCE';

export function maintenanceMode(env: Record<string, string | undefined> = process.env): MaintenanceMode {
  const raw = (env[VAR] ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'off') return 'off';
  if (raw === 'readonly' || raw === 'read-only') return 'readonly';
  return 'on';
}

export const UNAVAILABLE_MESSAGE = 'Screen Self-Service for Jira is temporarily unavailable: we’ve paused it for maintenance to keep your data safe. Nothing you’ve saved is lost, and your Jira is not affected. Status: ' + STATUS_PAGE_URL;
export const READONLY_MESSAGE = 'Changes are paused for maintenance to keep your data safe. You can still view everything. Status: ' + STATUS_PAGE_URL;

/** Throws when the app is down (any request) or read-only (requests that change something). */
export function requireAvailable(kind: 'read' | 'write') {
  const mode = maintenanceMode();
  if (mode === 'on') throw new AppError('unavailable', UNAVAILABLE_MESSAGE);
  if (mode === 'readonly' && kind === 'write') throw new AppError('unavailable', READONLY_MESSAGE);
}
