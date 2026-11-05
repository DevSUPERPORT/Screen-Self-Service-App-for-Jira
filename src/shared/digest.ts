/**
 * Content digests that tie a preview to its execution.
 * The client sends the digest of the plan it showed; the backend rebuilds the plan from fresh Jira state and
 * refuses to run anything that differs ("what you saw is what runs").
 *
 * @file        src/shared/digest.ts
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import type { Plan, Tab } from './types';

/** FNV-1a 32-bit — tiny, deterministic, identical in browser and Forge runtime. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Temporary refs ("new-…") are random per planning run — replace them by their order of appearance. */
export function normalizeRefs(json: string): string {
  const seen = new Map<string, string>();
  return json.replace(/new-[a-z0-9-]+/g, (r) => {
    if (!seen.has(r)) seen.set(r, `#${seen.size}`);
    return seen.get(r)!;
  });
}

/** JSON with sorted keys and undefined dropped — object key order must not change the digest. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

export function planDigest(plan: Plan): string {
  return fnv1a(normalizeRefs(canonical(plan.steps)));
}

/** Digest of a screen layout as Jira holds it (tab ids, names, field order). */
export function tabsDigest(tabs: Pick<Tab, 'id' | 'name' | 'fieldIds'>[]): string {
  return fnv1a(JSON.stringify(tabs.map((t) => [String(t.id), t.name, t.fieldIds])));
}
