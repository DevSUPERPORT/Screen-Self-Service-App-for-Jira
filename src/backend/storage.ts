/**
 * App state in Forge KVS: configuration, audit log, objects created by the app, "unused since" tracking.
 *
 * Personal data: the only personal data the app keeps is the Atlassian accountId of whoever made a change
 * (audit log) and the key of their undo record. Display names are never stored — they are resolved when the
 * log is read. Accounts are reported to Atlassian's personal data reporting API weekly (see privacy.ts), and
 * closed accounts are erased.
 *
 * @file        src/backend/storage.ts
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import { kvs, WhereConditions } from '@forge/kvs';
import type { AppConfig, AuditEntry } from '../shared/types';

const CONFIG = 'config';
export const DEFAULT_CONFIG: AppConfig = {
  autoDelete: false, days: 30, auditRetentionMonths: 24, projectAccess: 'all', projects: [], crossProjectCopy: true,
};

export async function getConfig(): Promise<AppConfig> {
  const c = (await kvs.get(CONFIG)) as Partial<AppConfig> | undefined;
  return { ...DEFAULT_CONFIG, ...(c ?? {}) };
}

const PROJECT_KEY = /^[A-Z][A-Z0-9_]{0,19}$/;

export function validConfig(input: unknown): AppConfig {
  const c = input as Partial<AppConfig>;
  const days = Number(c?.days);
  const months = Number(c?.auditRetentionMonths);
  const access = c?.projectAccess ?? 'all';
  const projects = c?.projects ?? [];
  if (typeof c?.autoDelete !== 'boolean' || !Number.isInteger(days) || days < 1 || days > 365 || ![0, 12, 24, 36].includes(months)) {
    throw new Error('Invalid configuration');
  }
  if ((access !== 'all' && access !== 'selected') || !Array.isArray(projects) || projects.length > 500) throw new Error('Invalid configuration');
  const keys = [...new Set(projects.map((p) => String(p).trim().toUpperCase()))];
  if (keys.some((k) => !PROJECT_KEY.test(k))) throw new Error('Invalid configuration');
  const crossProjectCopy = c?.crossProjectCopy ?? true;
  if (typeof crossProjectCopy !== 'boolean') throw new Error('Invalid configuration');
  return { autoDelete: c.autoDelete, days, auditRetentionMonths: months as AppConfig['auditRetentionMonths'], projectAccess: access, projects: keys.sort(), crossProjectCopy };
}

export async function setConfig(c: AppConfig) {
  await kvs.set(CONFIG, c);
}

/** Paged scan of every key with a prefix. */
export async function scan<T>(prefix: string, each: (key: string, value: T) => void | Promise<void>) {
  let cursor: string | undefined;
  do {
    let q = kvs.query().where('key', WhereConditions.beginsWith(prefix)).limit(100);
    if (cursor) q = q.cursor(cursor);
    const r = await q.getMany<T>();
    for (const x of r.results) await each(x.key, x.value);
    cursor = r.nextCursor;
  } while (cursor);
}

// ---------- created-by-app registry (UC-10 deletes only these) ----------
export type Kind = 'screen' | 'screenScheme';
const createdKey = (kind: Kind, id: string) => `created-${kind}-${id}`;

export async function markCreated(kind: Kind, id: string, projectKey: string) {
  await kvs.set(createdKey(kind, id), { projectKey, at: new Date().toISOString() });
}
export async function isCreated(kind: Kind, id: string) {
  return !!(await kvs.get(createdKey(kind, id)));
}
export async function forgetCreated(kind: Kind, id: string) {
  await kvs.delete(createdKey(kind, id));
  await kvs.delete(`unused-${kind}-${id}`);
}
export async function listCreated(): Promise<{ kind: Kind; id: string; projectKey: string }[]> {
  const out: { kind: Kind; id: string; projectKey: string }[] = [];
  await scan<{ projectKey: string }>('created-', (key, value) => {
    const m = /^created-(screen|screenScheme)-(.+)$/.exec(key);
    if (m) out.push({ kind: m[1] as Kind, id: m[2], projectKey: value.projectKey });
  });
  return out;
}

// ---------- unused-since tracking ----------
export async function getUnusedSince(kind: Kind, id: string) {
  return (await kvs.get(`unused-${kind}-${id}`)) as string | undefined;
}
export async function setUnusedSince(kind: Kind, id: string, since: string) {
  await kvs.set(`unused-${kind}-${id}`, since);
}
export async function unusedSince(kind: Kind, id: string, unused: boolean): Promise<string | undefined> {
  const k = `unused-${kind}-${id}`;
  const cur = (await kvs.get(k)) as string | undefined;
  if (!unused) { if (cur) await kvs.delete(k); return undefined; }
  if (cur) return cur;
  const today = new Date().toISOString().slice(0, 10);
  await kvs.set(k, today);
  return today;
}

// ---------- audit log ----------
/** The app itself (auto-deletion) — not a person. */
export const SYSTEM_ACCOUNT = 'app';
const ROVO = ' via Rovo';

type Who = { accountId: string; name?: string; via?: string };
export type StoredAuditEntry = Omit<AuditEntry, 'user'> & { user: Who };

/** Names are personal data: store the accountId only (plus the channel), never the display name. */
function storedUser(u: Who): Who {
  if (u.accountId === SYSTEM_ACCOUNT) return { accountId: SYSTEM_ACCOUNT, name: u.name };
  const via = u.via ?? (u.name?.endsWith(ROVO) ? 'Rovo' : undefined);
  return via ? { accountId: u.accountId, via } : { accountId: u.accountId };
}

export async function audit(projectKey: string, e: Omit<AuditEntry, 'id' | 'at' | 'user'> & { user: Who }) {
  const at = new Date().toISOString();
  const id = `audit-${projectKey}-${at}-${Math.random().toString(36).slice(2, 8)}`;
  // keep the free-text parts bounded
  const clip = (s?: string) => (s && s.length > 500 ? `${s.slice(0, 497)}…` : s);
  const entry: StoredAuditEntry = { ...e, id, at, user: storedUser(e.user), object: clip(e.object) ?? '', before: clip(e.before), after: clip(e.after) };
  await kvs.set(id, entry);
}

/** Every stored entry (for one project, or all), newest first. */
export async function readAuditRaw(projectKey: string | null): Promise<StoredAuditEntry[]> {
  const out: StoredAuditEntry[] = [];
  await scan<StoredAuditEntry>(projectKey ? `audit-${projectKey}-` : 'audit-', (_k, v) => { out.push(v); });
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/** Entries with display names resolved now (names are never stored). */
export async function readAudit(projectKey: string | null, resolveNames: (ids: string[]) => Promise<Map<string, string>>, limit = 200): Promise<AuditEntry[]> {
  const raw = (await readAuditRaw(projectKey)).slice(0, limit);
  const people = [...new Set(raw.map((e) => e.user.accountId).filter((a) => a !== SYSTEM_ACCOUNT && a !== ERASED))];
  const names = people.length ? await resolveNames(people).catch(() => new Map<string, string>()) : new Map<string, string>();
  return raw.map((e) => {
    const base = e.user.accountId === SYSTEM_ACCOUNT ? e.user.name ?? 'Screen Self-Service for Jira'
      : e.user.accountId === ERASED ? 'Former user' : names.get(e.user.accountId) ?? e.user.name ?? 'Unknown user';
    return { ...e, user: { accountId: e.user.accountId, name: e.user.via ? `${base} via ${e.user.via}` : base, via: e.user.via } };
  });
}

export async function pruneAudit(months: number) {
  if (!months) return 0;
  const cutoff = new Date(Date.now() - months * 30.44 * 86400000).toISOString();
  let n = 0;
  await scan<StoredAuditEntry>('audit-', async (key, v) => { if (v.at < cutoff) { await kvs.delete(key); n++; } });
  return n;
}

// ---------- personal data lifecycle ----------
/** What an erased account becomes in the audit log. */
export const ERASED = 'erased-user';

/** Every accountId the app stores, with the time it was last stored. */
export async function storedAccounts(): Promise<Map<string, string>> {
  const seen = new Map<string, string>();
  const note = (id: string, at: string) => { if (id && id !== SYSTEM_ACCOUNT && id !== ERASED && (seen.get(id) ?? '') < at) seen.set(id, at); };
  await scan<StoredAuditEntry>('audit-', (_k, v) => note(v.user?.accountId, v.at));
  await scan<{ at: string }>('undo-', (k, v) => { const id = undoAccount(k); if (id) note(id, v?.at ?? new Date(0).toISOString()); });
  return seen;
}

/** undo-<PROJECTKEY>-<accountId>; project keys never contain "-". */
const undoAccount = (key: string) => /^undo-[A-Z][A-Z0-9_]*-(.+)$/.exec(key)?.[1];

/** Erase a closed account: anonymise its audit entries and drop its undo records. */
export async function eraseAccount(accountId: string) {
  await scan<StoredAuditEntry>('audit-', async (key, v) => {
    if (v.user?.accountId === accountId) await kvs.set(key, { ...v, user: { accountId: ERASED } });
  });
  await scan<unknown>('undo-', async (key) => { if (undoAccount(key) === accountId) await kvs.delete(key); });
}

/** Undo records expire after `ttlMs`; delete them instead of keeping them forever. */
export async function pruneUndo(ttlMs: number) {
  const cutoff = Date.now() - ttlMs;
  let n = 0;
  await scan<{ at?: string }>('undo-', async (key, v) => {
    const at = v?.at ? new Date(v.at).getTime() : 0;
    if (!Number.isFinite(at) || at < cutoff) { await kvs.delete(key); n++; }
  });
  return n;
}
