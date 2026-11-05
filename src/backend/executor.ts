/**
 * Executes a validated plan against Jira.
 * Jira has no transactions, so every successful step records its inverse ("compensation"). If any later step
 * fails, the inverses run in reverse order and the project ends up exactly as it started. Deletions are the
 * only steps without an inverse; they are planned alone (UC-08), always run last, and are snapshotted first
 * so "Undo" can re-create them (see undo.ts).
 *
 * @file        src/backend/executor.ts
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import type { LayoutSave, Op, PlanStep, ProjectModel, Tab } from '../shared/types';
import { missingFromFieldScheme, onlyProject, screenExclusive } from '../shared/domain';
import { tabsDigest } from '../shared/digest';
import { AppError, jira, route } from './jira';
import { loadTabs } from './loader';
import { audit, forgetCreated, getUnusedSince, isCreated, markCreated } from './storage';

/** Everything needed to bring a deleted screen or screen scheme back ("Undo" after a deletion). */
export type Deleted =
  | { kind: 'screen'; oldId: string; name: string; description?: string; tabs: { name: string; fieldIds: string[] }[]; createdByApp: boolean; since?: string }
  | { kind: 'screenScheme'; oldId: string; name: string; description?: string; screens: Partial<Record<Op, string>>; createdByApp: boolean; since?: string };

type Who = { accountId: string; name: string };
type Undo = { label: string; run: () => Promise<unknown> };

const num = (id: string) => {
  if (!/^\d+$/.test(id)) throw new AppError('invalid', `Unexpected id ${id}`);
  return Number(id);
};

async function copyScreenContent(fromId: string, toId: string) {
  return writeScreenContent(toId, await loadTabs(fromId));
}

/** Fills a freshly created screen (one empty tab) with the given tabs and fields; returns fields Jira refused. */
export async function writeScreenContent(toId: string, src: { name: string; fieldIds: string[] }[]) {
  const tabs = (await jira.get<{ id: number; name: string }[]>(route`/rest/api/3/screens/${toId}/tabs`)) ?? [];
  const skipped: string[] = [];
  for (let i = 0; i < src.length; i++) {
    let tabId: string;
    if (i === 0 && tabs[0]) {
      tabId = String(tabs[0].id);
      if (tabs[0].name !== src[0].name) await jira.put(route`/rest/api/3/screens/${toId}/tabs/${tabId}`, { name: src[0].name });
    } else {
      const t = await jira.post<{ id: number }>(route`/rest/api/3/screens/${toId}/tabs`, { name: src[i].name });
      tabId = String(t!.id);
    }
    for (const f of src[i].fieldIds) {
      // Some fields (e.g. locked app fields) can't be placed on another screen; the copy continues without them
      try { await jira.post(route`/rest/api/3/screens/${toId}/tabs/${tabId}/fields`, { fieldId: f }); } catch { skipped.push(f); }
    }
  }
  return skipped;
}

/** Reads the transition's current screen, writes the new one, returns the previous value. */
async function setTransitionScreen(workflowId: string, transitionId: string, screenId: string | null): Promise<string | null> {
  const read = await jira.post<{ workflows: Record<string, unknown>[]; statuses: Record<string, unknown>[] }>(route`/rest/api/3/workflows`, { workflowIds: [workflowId] });
  const wf = read?.workflows?.[0] as { id: string; version: unknown; description?: string; statuses: unknown[]; transitions: Record<string, unknown>[]; startPointLayout?: unknown; loopedTransitionContainerLayout?: unknown } | undefined;
  if (!wf) throw new AppError('not-found', 'Workflow not found');
  let previous: string | null = null;
  const transitions = wf.transitions.map((t) => {
    if (String(t.id) !== transitionId) return t;
    const ts = t.transitionScreen as { parameters?: { screenId?: string }; params?: { screenId?: string } } | undefined;
    previous = ts?.parameters?.screenId ?? ts?.params?.screenId ?? null;
    const copy = { ...t };
    if (screenId) copy.transitionScreen = { ruleKey: 'system:transition-screen', parameters: { screenId } };
    else delete copy.transitionScreen;
    return copy;
  });
  const statuses = (read!.statuses ?? []).map((s) => {
    const x = s as { id?: string; name: string; statusCategory: string; statusReference: string; description?: string };
    return { id: x.id, name: x.name, statusCategory: x.statusCategory, statusReference: x.statusReference, description: x.description };
  });
  await jira.post(route`/rest/api/3/workflows/update`, {
    statuses,
    workflows: [{
      id: wf.id, version: wf.version, description: wf.description, statuses: wf.statuses, transitions,
      startPointLayout: wf.startPointLayout, loopedTransitionContainerLayout: wf.loopedTransitionContainerLayout,
    }],
  });
  return previous;
}

/**
 * There is no "update one mapping" endpoint: remove (if explicit), then append. Two writes — if the append
 * fails after the removal, the previous mapping is put back before the error propagates, so an issue type is
 * never left without its explicit mapping.
 */
async function setMapping(itssId: string, issueTypeId: string, schemeId: string | undefined, previous: string | undefined) {
  const append = (sid: string) => jira.put(route`/rest/api/3/issuetypescreenscheme/${itssId}/mapping`, { issueTypeMappings: [{ issueTypeId, screenSchemeId: sid }] });
  if (previous) await jira.post(route`/rest/api/3/issuetypescreenscheme/${itssId}/mapping/remove`, { issueTypeIds: [issueTypeId] });
  if (!schemeId) return;
  try {
    await append(schemeId);
  } catch (e) {
    if (previous) await append(previous).catch((e2) => console.error('mapping restore failed', e2));
    throw e;
  }
}

/** Runs compensations in reverse; returns the labels of those that failed. */
async function compensate(undo: Undo[]) {
  const failed: string[] = [];
  for (const u of [...undo].reverse()) {
    try { await u.run(); } catch (e) { console.error(`compensation failed: ${u.label}`, e); failed.push(u.label); }
  }
  return failed;
}

export async function executePlan(m: ProjectModel, steps: PlanStep[], who: Who) {
  const key = m.project.key;
  const idMap: Record<string, string> = {};
  const real = (id: string | undefined) => (id ? idMap[id] ?? id : undefined);
  // Current names, kept up to date while steps run (screens and schemes have separate id sequences)
  const screenNames: Record<string, string> = Object.fromEntries(Object.values(m.screens).map((x) => [x.id, x.name]));
  const schemeNames: Record<string, string> = Object.fromEntries(Object.values(m.screenSchemes).map((x) => [x.id, x.name]));
  const name = (id: string) => screenNames[id] ?? id;
  const schemeName = (id: string) => schemeNames[id] ?? id;
  const mappings = { ...m.itss.mappings };
  const undo: Undo[] = [];
  // The same inverses as data — persisted so the user can undo the whole change later (null: not undoable)
  let inverse: PlanStep[] | null = [];
  // deleted objects, captured from Jira right before each delete so the deletion itself can be undone
  const deleted: Deleted[] = [];
  const warnings: string[] = [];
  const logs: Parameters<typeof audit>[1][] = [];

  try {
    for (const st of steps) {
      switch (st.kind) {
        case 'renameScreen': {
          await jira.put(route`/rest/api/3/screens/${num(st.screenId)}`, { name: st.to });
          screenNames[st.screenId] = st.to;
          inverse?.push({ kind: 'renameScreen', screenId: st.screenId, from: st.to, to: st.from });
          undo.push({ label: `rename screen back to ${st.from}`, run: () => jira.put(route`/rest/api/3/screens/${num(st.screenId)}`, { name: st.from }) });
          logs.push({ user: who, action: 'Screen renamed', object: st.to, before: st.from, after: st.to });
          break;
        }
        case 'renameScreenScheme': {
          await jira.put(route`/rest/api/3/screenscheme/${num(st.schemeId)}`, { name: st.to });
          schemeNames[st.schemeId] = st.to;
          inverse?.push({ kind: 'renameScreenScheme', schemeId: st.schemeId, from: st.to, to: st.from });
          undo.push({ label: `rename scheme back to ${st.from}`, run: () => jira.put(route`/rest/api/3/screenscheme/${num(st.schemeId)}`, { name: st.from }) });
          logs.push({ user: who, action: 'Screen scheme renamed', object: st.to, before: st.from, after: st.to });
          break;
        }
        case 'createScreen': {
          const created = await jira.post<{ id: number }>(route`/rest/api/3/screens`, { name: st.name, description: `Created by Screen Self-Service for Jira (${key})` });
          const id = String(created!.id);
          idMap[st.ref] = id;
          screenNames[id] = st.name;
          inverse?.push({ kind: 'deleteScreen', screenId: id, name: st.name });
          undo.push({ label: `delete created screen ${st.name}`, run: async () => { await jira.del(route`/rest/api/3/screens/${id}`); await forgetCreated('screen', id); } });
          await markCreated('screen', id, key);
          const skipped = st.copyFrom ? await copyScreenContent(st.copyFrom, id)
            : st.seed?.length ? await writeScreenContent(id, [{ name: 'Field Tab', fieldIds: st.seed }]) : [];
          if (skipped.length) warnings.push(`${st.name}: ${skipped.length} field(s) could not be copied (${skipped.join(', ')})`);
          logs.push({ user: who, action: 'Screen created', object: st.name, after: st.copyFrom ? `Copy of ${name(st.copyFrom)}${skipped.length ? ` (skipped: ${skipped.join(', ')})` : ''}` : st.seed?.length ? `New screen with ${st.seed.join(', ')}` : 'Empty screen' });
          break;
        }
        case 'createScreenScheme': {
          const screens: Record<string, number> = {};
          for (const o of ['default', 'create', 'edit', 'view'] as Op[]) { const v = real(st.screens[o]); if (v) screens[o] = num(v); }
          const created = await jira.post<{ id: number }>(route`/rest/api/3/screenscheme`, { name: st.name, description: `Created by Screen Self-Service for Jira (${key})`, screens });
          const id = String(created!.id);
          idMap[st.ref] = id;
          schemeNames[id] = st.name;
          inverse?.push({ kind: 'deleteScreenScheme', schemeId: id, name: st.name });
          undo.push({ label: `delete created scheme ${st.name}`, run: async () => { await jira.del(route`/rest/api/3/screenscheme/${id}`); await forgetCreated('screenScheme', id); } });
          await markCreated('screenScheme', id, key);
          logs.push({ user: who, action: 'Screen scheme created', object: st.name });
          break;
        }
        case 'updateScreenScheme': {
          const before = m.screenSchemes[st.schemeId]?.screens ?? { default: '' };
          const toBody = (s: Record<string, string | undefined | null>) => {
            const b: Record<string, string | null> = { default: s.default! };
            for (const o of ['create', 'edit', 'view'] as const) b[o] = s[o] ?? null; // null removes the explicit assignment
            return b;
          };
          const after = toBody({ default: real(st.screens.default), create: real(st.screens.create), edit: real(st.screens.edit), view: real(st.screens.view) });
          await jira.put(route`/rest/api/3/screenscheme/${num(st.schemeId)}`, { screens: after });
          const asOps = (s: Record<string, string | null | undefined>) => ({ default: s.default ?? undefined, create: s.create ?? undefined, edit: s.edit ?? undefined, view: s.view ?? undefined }) as Record<Op, string | undefined>;
          inverse?.push({ kind: 'updateScreenScheme', schemeId: st.schemeId, screens: asOps(before), before: asOps(after) });
          undo.push({ label: `restore assignments of ${schemeName(st.schemeId)}`, run: () => jira.put(route`/rest/api/3/screenscheme/${num(st.schemeId)}`, { screens: toBody(before) }) });
          const fmt = (s: Record<string, string | null | undefined>) => (['default', 'create', 'edit', 'view'] as const).map((o) => `${o}: ${s[o] ? name(s[o]!) : 'inherits'}`).join(' · ');
          logs.push({ user: who, action: 'Assignment changed', object: schemeName(st.schemeId), before: fmt(before), after: fmt(after) });
          break;
        }
        case 'mapIssueType': {
          // null target = drop the explicit mapping (issue type falls back to the default mapping)
          const target = st.screenSchemeId ? real(st.screenSchemeId) : undefined;
          const prev = mappings[st.issueTypeId];
          await setMapping(st.itssId, st.issueTypeId, target, prev);
          if (target) mappings[st.issueTypeId] = target; else delete mappings[st.issueTypeId];
          inverse?.push({ kind: 'mapIssueType', itssId: st.itssId, issueTypeId: st.issueTypeId, screenSchemeId: prev ?? null, from: target ?? null });
          undo.push({ label: `restore mapping of issue type ${st.issueTypeId}`, run: () => setMapping(st.itssId, st.issueTypeId, prev, target) });
          const it = m.issueTypes.find((i) => i.id === st.issueTypeId)?.name ?? st.issueTypeId;
          logs.push({ user: who, action: 'Issue type mapping changed', object: it, before: schemeName(prev ?? m.itss.mappings.default), after: target ? schemeName(target) : `default (${schemeName(m.itss.mappings.default)})` });
          break;
        }
        case 'setTransitionScreen': {
          const screenId = real(st.screenId ?? undefined) ?? null;
          const previous = await setTransitionScreen(st.workflowId, st.transitionId, screenId);
          inverse?.push({ kind: 'setTransitionScreen', workflowId: st.workflowId, transitionId: st.transitionId, screenId: previous, from: screenId });
          undo.push({ label: `restore transition ${st.transitionId}`, run: () => setTransitionScreen(st.workflowId, st.transitionId, previous) });
          const wf = m.workflows.find((w) => w.id === st.workflowId);
          const tr = wf?.transitions.find((x) => x.id === st.transitionId);
          logs.push({ user: who, action: screenId ? 'Transition screen assigned' : 'Transition screen removed', object: `${wf?.name}: ${tr?.name}`, before: previous ? name(previous) : '—', after: screenId ? name(screenId) : '—' });
          break;
        }
        case 'deleteScreenScheme': {
          inverse = null; // the plan inverse can't express re-creation; the snapshot below can
          const cur = (await jira.get<{ values: { id: number; description?: string; screens: Record<string, number> }[] }>(route`/rest/api/3/screenscheme?id=${num(st.schemeId)}`))?.values?.find((x) => String(x.id) === st.schemeId);
          const snap: Deleted = {
            kind: 'screenScheme', oldId: st.schemeId, name: st.name, description: cur?.description,
            screens: Object.fromEntries(Object.entries(cur?.screens ?? m.screenSchemes[st.schemeId]?.screens ?? {}).filter(([, v]) => v != null).map(([o, v]) => [o, String(v)])),
            createdByApp: await isCreated('screenScheme', st.schemeId), since: await getUnusedSince('screenScheme', st.schemeId),
          };
          await jira.del(route`/rest/api/3/screenscheme/${num(st.schemeId)}`);
          deleted.push(snap);
          await forgetCreated('screenScheme', st.schemeId);
          await audit(key, { user: who, action: 'Screen scheme deleted', object: st.name });
          break;
        }
        case 'deleteScreen': {
          inverse = null;
          const cur = (await jira.get<{ values: { id: number; description?: string }[] }>(route`/rest/api/3/screens?id=${num(st.screenId)}`))?.values?.find((x) => String(x.id) === st.screenId);
          const snap: Deleted = {
            kind: 'screen', oldId: st.screenId, name: st.name, description: cur?.description,
            tabs: (await loadTabs(st.screenId)).map((t) => ({ name: t.name, fieldIds: t.fieldIds })),
            createdByApp: await isCreated('screen', st.screenId), since: await getUnusedSince('screen', st.screenId),
          };
          await jira.del(route`/rest/api/3/screens/${num(st.screenId)}`);
          deleted.push(snap);
          await forgetCreated('screen', st.screenId);
          await audit(key, { user: who, action: 'Screen deleted', object: st.name });
          break;
        }
      }
    }
  } catch (e) {
    const failed = await compensate(undo);
    await audit(key, {
      user: who, action: failed.length ? 'Change partly rolled back' : 'Change rolled back',
      object: steps.map((s) => s.kind).join(', ').slice(0, 200),
      after: failed.length ? `Manual check needed: ${failed.join('; ')}` : 'Jira is back to its previous state',
    }).catch(() => {});
    const reason = e instanceof Error ? e.message : String(e);
    throw new AppError('error', failed.length
      ? `The change failed (${reason}) and could not be fully undone: ${failed.join('; ')}. Please check these objects.`
      : `The change failed (${reason}). Nothing was changed — every step was rolled back.`);
  }
  for (const l of logs) await audit(key, l);
  return { idMap, warnings, inverse: inverse && orderInverse(inverse), deleted };
}

/**
 * Undo order: rewire first (so created objects become unused), then delete created schemes, then created
 * screens, then rename back — renames last, because the names they restore may be held by the created objects.
 */
export function orderInverse(inverse: PlanStep[]): PlanStep[] {
  const rank = (s: PlanStep) => (s.kind === 'deleteScreenScheme' ? 1 : s.kind === 'deleteScreen' ? 2 : s.kind === 'renameScreen' || s.kind === 'renameScreenScheme' ? 3 : 0);
  return [...inverse].reverse().map((s, i) => ({ s, i })).sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i).map((x) => x.s);
}

// ------------------------------------------------------------------ editor (UC-02)

/** Minimal diff from `current` to `desired`. Tabs with id null are created. */
async function applyDiff(screenId: string, current: Tab[], desired: LayoutSave['tabs']) {
  const tabIds: string[] = [];
  for (const t of desired) {
    if (t.id && current.some((c) => c.id === String(t.id))) {
      const cur = current.find((c) => c.id === String(t.id))!;
      if (cur.name !== t.name.trim()) await jira.put(route`/rest/api/3/screens/${screenId}/tabs/${t.id}`, { name: t.name.trim() });
      tabIds.push(String(t.id));
    } else {
      const created = await jira.post<{ id: number }>(route`/rest/api/3/screens/${screenId}/tabs`, { name: t.name.trim() });
      tabIds.push(String(created!.id));
    }
  }
  const wanted = new Set(desired.flatMap((t) => t.fieldIds));
  const where = new Map<string, string>();
  for (const c of current) for (const f of c.fieldIds) where.set(f, c.id);
  // remove fields that leave their tab (moved or removed) — a field can only be on a screen once
  for (let i = 0; i < desired.length; i++) for (const f of desired[i].fieldIds) {
    const was = where.get(f);
    if (was && was !== tabIds[i]) { await jira.del(route`/rest/api/3/screens/${screenId}/tabs/${was}/fields/${f}`); where.delete(f); }
  }
  for (const [f, tab] of [...where]) if (!wanted.has(f)) { await jira.del(route`/rest/api/3/screens/${screenId}/tabs/${tab}/fields/${f}`); where.delete(f); }
  for (let i = 0; i < desired.length; i++) for (const f of desired[i].fieldIds) {
    if (!where.has(f)) await jira.post(route`/rest/api/3/screens/${screenId}/tabs/${tabIds[i]}/fields`, { fieldId: f });
  }
  for (const c of current) if (!tabIds.includes(c.id)) await jira.del(route`/rest/api/3/screens/${screenId}/tabs/${c.id}`);
  const now = (await jira.get<{ id: number }[]>(route`/rest/api/3/screens/${screenId}/tabs`))?.map((t) => String(t.id)) ?? [];
  if (now.join() !== tabIds.join()) for (let i = 0; i < tabIds.length; i++) await jira.post(route`/rest/api/3/screens/${screenId}/tabs/${tabIds[i]}/move/${i}`);
  for (let i = 0; i < desired.length; i++) {
    const want = desired[i].fieldIds;
    const have = ((await jira.get<{ id: string }[]>(route`/rest/api/3/screens/${screenId}/tabs/${tabIds[i]}/fields`)) ?? []).map((f) => f.id);
    if (have.join() === want.join()) continue;
    for (let k = 0; k < want.length; k++) {
      await jira.post(route`/rest/api/3/screens/${screenId}/tabs/${tabIds[i]}/fields/${want[k]}/move`, k === 0 ? { position: 'First' } : { after: want[k - 1] });
    }
  }
}

/** UC-02: apply the desired layout as a minimal diff against Jira's live state, with rollback. */
export async function applyLayout(m: ProjectModel, save: LayoutSave, who: Who) {
  const key = m.project.key;
  const screenId = save.screenId;
  if (!screenExclusive(m, screenId)) throw new AppError('locked', 'This screen is shared with other projects');
  if (!Array.isArray(save.tabs) || save.tabs.length === 0 || save.tabs.length > 50) throw new AppError('invalid', 'A screen needs at least one tab');
  const seen = new Set<string>();
  for (const t of save.tabs) {
    if (typeof t.name !== 'string' || !t.name.trim() || t.name.length > 255) throw new AppError('invalid', 'Tab names must be 1–255 characters');
    if (t.id !== null && !/^\d+$/.test(String(t.id))) throw new AppError('invalid', 'Bad tab id');
    for (const f of t.fieldIds) {
      if (typeof f !== 'string' || !m.fields[f]) throw new AppError('invalid', `Unknown field ${f}`);
      if (seen.has(f)) throw new AppError('invalid', `Field ${f} appears twice`);
      seen.add(f);
    }
  }
  const current = await loadTabs(screenId);
  // Someone (e.g. the native issue layout editor) changed this screen since the user opened it
  if (save.baseDigest && save.baseDigest !== tabsDigest(current)) {
    throw new AppError('conflict', 'This screen was changed elsewhere while you were editing. The latest version has been loaded — please redo your change.');
  }
  for (const t of save.tabs) if (t.id && !current.some((c) => c.id === String(t.id))) throw new AppError('conflict', 'A tab was removed in the meantime');
  // Required fields must stay on the screen
  for (const c of current) for (const f of c.fieldIds) if (m.fields[f]?.locked && !seen.has(f)) throw new AppError('invalid', `${m.fields[f].name} can't be removed`);

  // Field scheme first: new fields must be visible. Only if the field scheme belongs to this project alone.
  const missing = missingFromFieldScheme(m, [...seen].filter((f) => !current.some((t) => t.fieldIds.includes(f))));
  let addedToScheme: string[] = [];
  if (missing.length) {
    if (!m.fieldScheme || !onlyProject(m.fieldScheme, key)) throw new AppError('locked', 'The field scheme is shared — ask your Jira admin to add these fields first');
    const body = Object.fromEntries(missing.map((f) => [f, [{ schemeIds: [Number(m.fieldScheme!.id)] }]]));
    const r = await jira.put<{ results?: { fieldId: string; success: boolean; error?: string }[] }>(route`/rest/api/3/config/fieldschemes/fields`, body);
    const failed = r?.results?.filter((x) => !x.success) ?? [];
    addedToScheme = missing.filter((f) => !failed.some((x) => x.fieldId === f));
    if (failed.length) {
      await removeFromFieldScheme(m, addedToScheme);
      throw new AppError('error', `Could not add to the field scheme: ${failed.map((x) => x.fieldId).join(', ')}. Nothing was changed.`);
    }
  }

  try {
    await applyDiff(screenId, current, save.tabs);
  } catch (e) {
    // Roll back to the layout we started from (tabs deleted on the way are recreated)
    let restored = true;
    try {
      const now = await loadTabs(screenId);
      await applyDiff(screenId, now, current.map((t) => ({ id: now.some((n) => n.id === t.id) ? t.id : null, name: t.name, fieldIds: t.fieldIds })));
      await removeFromFieldScheme(m, addedToScheme);
    } catch (e2) {
      console.error('layout rollback failed', e2);
      restored = false;
    }
    await audit(key, { user: who, action: restored ? 'Screen edit rolled back' : 'Screen edit partly rolled back', object: m.screens[screenId]?.name ?? screenId }).catch(() => {});
    const reason = e instanceof Error ? e.message : String(e);
    throw new AppError('error', restored
      ? `Saving failed (${reason}). The screen was restored to how it was.`
      : `Saving failed (${reason}) and the screen could not be fully restored. Please check it.`);
  }
  if (addedToScheme.length) await audit(key, { user: who, action: 'Fields added to field scheme', object: m.fieldScheme!.name, after: addedToScheme.map((f) => m.fields[f]?.name ?? f).join(', ') });
  const fmt = (tabs: { name: string; fieldIds: string[] }[]) => tabs.map((t) => `${t.name}: ${t.fieldIds.length}`).join(' · ');
  await audit(key, { user: who, action: 'Screen edited', object: m.screens[screenId]?.name ?? screenId, before: fmt(current), after: fmt(save.tabs) });
  // What undo needs: the layout before, and a digest of the layout as Jira now holds it
  const after = await loadTabs(screenId);
  return { before: current, afterDigest: tabsDigest(after), addedToScheme };
}

async function removeFromFieldScheme(m: ProjectModel, fields: string[]) {
  if (!fields.length || !m.fieldScheme) return;
  const body = Object.fromEntries(fields.map((f) => [f, { schemeIds: [Number(m.fieldScheme!.id)] }]));
  await jira.del(route`/rest/api/3/config/fieldschemes/fields`, body);
}
