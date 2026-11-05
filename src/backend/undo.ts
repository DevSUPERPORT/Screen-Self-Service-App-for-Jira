/**
 * "Undo last change" — one record per user and project, kept in app storage.
 * Undo only runs when Jira still looks exactly like right after the change; otherwise it is refused
 * (somebody changed things since, and blindly reverting would destroy their work).
 *
 * @file        src/backend/undo.ts
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import { kvs } from '@forge/kvs';
import type { PlanStep, ProjectModel, Tab } from '../shared/types';
import { itssExclusive, onlyProject, schemeExclusive, screenExclusive } from '../shared/domain';
import { tabsDigest } from '../shared/digest';
import { AppError, jira, route } from './jira';
import { applyLayout, executePlan, writeScreenContent, type Deleted } from './executor';
import { loadTabs } from './loader';
import { audit, markCreated, setUnusedSince } from './storage';

export type UndoRecord =
  | { kind: 'plan'; label: string; at: string; steps: PlanStep[] }
  | { kind: 'layouts'; label: string; at: string; items: { screenId: string; before: Tab[]; afterDigest: string }[]; fieldScheme?: string[] }
  | { kind: 'fieldScheme'; label: string; at: string; fieldIds: string[] }
  /** a deletion: the objects as they were, re-created on undo (Jira gives them new ids) */
  | { kind: 'restore'; label: string; at: string; items: Deleted[] };

const key = (projectKey: string, accountId: string) => `undo-${projectKey}-${accountId}`;
export const TTL_MS = 24 * 3600 * 1000;

export async function saveUndo(projectKey: string, accountId: string, rec: UndoRecord) {
  await kvs.set(key(projectKey, accountId), rec);
}

export async function clearUndo(projectKey: string, accountId: string) {
  await kvs.delete(key(projectKey, accountId));
}

export async function peekUndo(projectKey: string, accountId: string): Promise<{ label: string; at: string } | null> {
  const rec = (await kvs.get(key(projectKey, accountId))) as UndoRecord | undefined;
  if (!rec || Date.now() - new Date(rec.at).getTime() > TTL_MS) return null;
  return { label: rec.label, at: rec.at };
}

const stale = () => new AppError('conflict', 'This change can no longer be undone: the affected objects were changed since. Nothing was reverted.');

/** Every inverse step's precondition must still hold on the fresh model. */
function checkPlan(m: ProjectModel, steps: PlanStep[]) {
  for (const s of steps) {
    switch (s.kind) {
      case 'renameScreen': if (m.screens[s.screenId]?.name !== s.from || !screenExclusive(m, s.screenId)) throw stale(); break;
      case 'renameScreenScheme': if (m.screenSchemes[s.schemeId]?.name !== s.from || !schemeExclusive(m, s.schemeId)) throw stale(); break;
      case 'updateScreenScheme': {
        const sc = m.screenSchemes[s.schemeId];
        if (!sc || !schemeExclusive(m, s.schemeId)) throw stale();
        for (const o of ['default', 'create', 'edit', 'view'] as const) if ((sc.screens[o] ?? null) !== (s.before[o] ?? null)) throw stale();
        break;
      }
      case 'mapIssueType': if (s.itssId !== m.itss.id || !itssExclusive(m) || (m.itss.mappings[s.issueTypeId] ?? null) !== s.from) throw stale(); break;
      case 'setTransitionScreen': {
        const wf = m.workflows.find((w) => w.id === s.workflowId);
        if (!wf || !onlyProject(wf, m.project.key) || (wf.transitions.find((t) => t.id === s.transitionId)?.screenId ?? null) !== s.from) throw stale();
        break;
      }
      // only objects this app created for this project may be removed by undo
      case 'deleteScreen': if (!m.screens[s.screenId]?.createdByApp || !screenExclusive(m, s.screenId)) throw stale(); break;
      case 'deleteScreenScheme': if (!m.screenSchemes[s.schemeId]?.createdByApp || !schemeExclusive(m, s.schemeId)) throw stale(); break;
    }
  }
}

export async function runUndo(m: ProjectModel, accountId: string, who: { accountId: string; name: string }) {
  const projectKey = m.project.key;
  const rec = (await kvs.get(key(projectKey, accountId))) as UndoRecord | undefined;
  if (!rec || Date.now() - new Date(rec.at).getTime() > TTL_MS) throw new AppError('not-found', 'There is nothing to undo.');

  if (rec.kind === 'plan') {
    checkPlan(m, rec.steps);
    await executePlan(m, rec.steps, who); // rolls itself back if any step fails
  } else if (rec.kind === 'layouts') {
    // check every screen first — all or nothing
    const live = await Promise.all(rec.items.map((i) => loadTabs(i.screenId).catch(() => null)));
    rec.items.forEach((i, k) => { if (!live[k] || tabsDigest(live[k]!) !== i.afterDigest || !screenExclusive(m, i.screenId)) throw stale(); });
    for (const [k, i] of rec.items.entries()) {
      const now = live[k]!;
      await applyLayout(m, {
        screenId: i.screenId, baseDigest: i.afterDigest,
        tabs: i.before.map((t) => ({ id: now.some((n) => n.id === t.id) ? t.id : null, name: t.name, fieldIds: t.fieldIds })),
      }, who);
    }
    if (rec.fieldScheme?.length && m.fieldScheme) await removeFromScheme(m, rec.fieldScheme);
  } else if (rec.kind === 'restore') {
    await restoreDeleted(m, rec.items, who);
  } else {
    if (!m.fieldScheme || !onlyProject(m.fieldScheme, projectKey)) throw stale();
    if (!rec.fieldIds.every((f) => m.fieldScheme!.fieldIds.includes(f))) throw stale();
    await removeFromScheme(m, rec.fieldIds);
  }
  await clearUndo(projectKey, accountId);
  await audit(projectKey, { user: who, action: 'Change undone', object: rec.label });
  return rec.label;
}

/**
 * Re-creates deleted screens (with their tabs and fields) and screen schemes (pointing at the same screens,
 * or at the re-created ones). All or nothing: on any failure everything re-created so far is deleted again.
 */
async function restoreDeleted(m: ProjectModel, items: Deleted[], who: { accountId: string; name: string }) {
  const key = m.project.key;
  const screens = items.filter((i): i is Extract<Deleted, { kind: 'screen' }> => i.kind === 'screen');
  const schemes = items.filter((i): i is Extract<Deleted, { kind: 'screenScheme' }> => i.kind === 'screenScheme');
  // names must still be free — somebody may have created an object with that name since
  for (const s of screens) {
    const hit = (await jira.get<{ values: { name: string }[] }>(route`/rest/api/3/screens?queryString=${s.name}`))?.values ?? [];
    if (hit.some((x) => x.name.toLowerCase() === s.name.toLowerCase())) throw new AppError('conflict', `A screen named "${s.name}" exists again, so the deletion can't be undone. Nothing was changed.`);
  }
  for (const s of schemes) {
    if (Object.values(m.screenSchemes).some((x) => x.name.toLowerCase() === s.name.toLowerCase())) throw new AppError('conflict', `A screen scheme named "${s.name}" exists again, so the deletion can't be undone. Nothing was changed.`);
  }
  const newId: Record<string, string> = {};
  const created: { kind: 'screen' | 'screenScheme'; id: string }[] = [];
  try {
    for (const s of screens) {
      const r = await jira.post<{ id: number }>(route`/rest/api/3/screens`, { name: s.name, description: s.description || undefined });
      const id = String(r!.id);
      created.push({ kind: 'screen', id });
      newId[s.oldId] = id;
      const skipped = await writeScreenContent(id, s.tabs);
      if (s.createdByApp) await markCreated('screen', id, key);
      if (s.since) await setUnusedSince('screen', id, s.since);
      await audit(key, { user: who, action: 'Screen restored', object: s.name, after: skipped.length ? `skipped: ${skipped.join(', ')}` : undefined });
    }
    for (const s of schemes) {
      const body: Record<string, number> = {};
      for (const [o, sid] of Object.entries(s.screens)) {
        const target = newId[sid!] ?? sid!;
        // a screen the scheme pointed to (and that wasn't restored with it) must still exist
        if (!newId[sid!] && !m.screens[target]) {
          const hit = (await jira.get<{ values: { id: number }[] }>(route`/rest/api/3/screens?id=${target}`))?.values ?? [];
          if (!hit.length) throw new AppError('conflict', `The screen used by "${s.name}" no longer exists, so the scheme can't be restored.`);
        }
        body[o] = Number(target);
      }
      const r = await jira.post<{ id: number }>(route`/rest/api/3/screenscheme`, { name: s.name, description: s.description || undefined, screens: body });
      const id = String(r!.id);
      created.push({ kind: 'screenScheme', id });
      if (s.createdByApp) await markCreated('screenScheme', id, key);
      if (s.since) await setUnusedSince('screenScheme', id, s.since);
      await audit(key, { user: who, action: 'Screen scheme restored', object: s.name });
    }
  } catch (e) {
    // schemes before screens: Jira won't delete a screen a scheme still uses
    for (const c of [...created].reverse()) {
      await (c.kind === 'screen' ? jira.del(route`/rest/api/3/screens/${c.id}`) : jira.del(route`/rest/api/3/screenscheme/${c.id}`)).catch(() => {});
    }
    throw e instanceof AppError ? e : new AppError('error', `Restoring failed (${e instanceof Error ? e.message : String(e)}). Nothing was changed.`);
  }
}

async function removeFromScheme(m: ProjectModel, fieldIds: string[]) {
  const body = Object.fromEntries(fieldIds.map((f) => [f, { schemeIds: [Number(m.fieldScheme!.id)] }]));
  await jira.del(route`/rest/api/3/config/fieldschemes/fields`, body);
}
