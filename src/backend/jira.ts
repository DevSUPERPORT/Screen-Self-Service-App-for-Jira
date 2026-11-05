/**
 * Thin, safe wrapper around Jira REST.
 * Paths are built with the `route` tag below: every interpolated value is URI-encoded (no path traversal, no
 * query injection), exactly like @forge/api's `route`. The transport is swappable so the same code runs against
 * an in-memory Jira in tests (failure injection, large-instance benchmarks).
 *
 * @file        src/backend/jira.ts
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import api, { assumeTrustedRoute, getAppContext } from '@forge/api';

export class AppError extends Error {
  constructor(public code: 'denied' | 'locked' | 'invalid' | 'not-found' | 'conflict' | 'error' | 'unavailable' | 'unlicensed', message: string, public status?: number) {
    super(message);
  }
}

/** Encodes every interpolation. URLSearchParams are serialised (their values are encoded by URLSearchParams itself). */
export function route(strings: TemplateStringsArray, ...values: unknown[]): string {
  let out = strings[0];
  values.forEach((v, i) => {
    out += (v instanceof URLSearchParams ? v.toString() : encodeURIComponent(String(v))) + strings[i + 1];
  });
  if (out.split('?')[0].split('/').includes('..') || out.split('?')[0].includes('%2E%2E')) throw new AppError('invalid', 'Invalid path');
  return out;
}

export interface TransportResponse { status: number; text: string; retryAfter?: number }
export type Transport = (method: string, path: string, body?: unknown) => Promise<TransportResponse>;

const forgeTransport: Transport = async (method, path, body) => {
  // `path` was produced by our encoding `route` tag above, never from raw input
  const res = await api.asApp().requestJira(assumeTrustedRoute(path), {
    method,
    headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const ra = Number(res.headers.get('Retry-After'));
  return { status: res.status, text: await res.text(), retryAfter: Number.isFinite(ra) ? ra : undefined };
};

let transport: Transport = forgeTransport;
let sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const stats = { calls: 0 };

/** Tests only: route every call through another transport (e.g. the in-memory Jira). */
export function setTransport(t: Transport | null, opts: { sleep?: (ms: number) => Promise<void> } = {}) {
  transport = t ?? forgeTransport;
  if (opts.sleep) sleep = opts.sleep;
}

const IDEMPOTENT = new Set(['GET', 'PUT', 'DELETE']);

async function req<T>(method: string, path: string, body?: unknown, allow404 = false): Promise<T | null> {
  let res: TransportResponse;
  for (let attempt = 0; ; attempt++) {
    stats.calls++;
    res = await transport(method, path, body);
    // 429: the request was not processed — safe to retry any method. 5xx: only idempotent methods.
    const retryable = res.status === 429 || (res.status >= 502 && res.status <= 504 && IDEMPOTENT.has(method));
    if (!retryable || attempt >= 3) break;
    await sleep(res.retryAfter ? res.retryAfter * 1000 : 300 * 2 ** attempt + Math.random() * 200);
  }
  if (res.status === 204) return null;
  if (res.status === 404 && allow404) return null;
  if (res.status < 200 || (res.status >= 300 && res.status !== 207)) {
    let msg = res.text;
    try {
      const j = JSON.parse(res.text);
      msg = [...(j.errorMessages ?? []), ...Object.values(j.errors ?? {})].join(' ') || j.message || res.text;
    } catch { /* keep text */ }
    console.error(`Jira ${method} ${path.split('?')[0]} ${res.status}: ${String(msg).slice(0, 500)}`);
    throw new AppError(res.status === 403 ? 'denied' : res.status === 404 ? 'not-found' : res.status === 409 ? 'conflict' : 'error', `Jira: ${String(msg).slice(0, 300)}`, res.status);
  }
  return res.text ? (JSON.parse(res.text) as T) : null;
}

export const jira = {
  get: <T>(p: string, allow404 = false) => req<T>('GET', p, undefined, allow404),
  post: <T>(p: string, body?: unknown) => req<T>('POST', p, body),
  put: <T>(p: string, body?: unknown) => req<T>('PUT', p, body),
  del: <T>(p: string, body?: unknown) => req<T>('DELETE', p, body),
};

/** Run async jobs with bounded concurrency (Jira rate limits). */
export async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

type Page<T> = { values: T[]; isLast?: boolean; total?: number; maxResults?: number };

/**
 * Offset paging. When the first page reports `total`, the remaining pages are fetched in parallel
 * (bounded) — this is what keeps large instances (thousands of schemes) within the resolver time budget.
 *
 * `strict`: the result feeds a security decision (is this object used by another project?). Silently cutting
 * it off would under-count usage and let a shared object look exclusive, so a truncated read throws instead.
 */
export async function pages<T>(build: (startAt: number) => string, cap = 2000, opts: { strict?: boolean } = {}): Promise<T[]> {
  const tooMany = () => new AppError('error', 'This Jira site has more configuration objects than the app can check safely. Nothing was changed.');
  const first = await jira.get<Page<T>>(build(0));
  const out = [...(first?.values ?? [])];
  const size = first?.values?.length ?? 0;
  if (!size || first?.isLast) return out.slice(0, cap);
  if (first?.total !== undefined) {
    if (opts.strict && first.total > cap) throw tooMany();
    if (out.length >= cap) return out.slice(0, cap);
    const offsets: number[] = [];
    for (let s = size; s < Math.min(first.total, cap); s += size) offsets.push(s);
    const rest = await pool(offsets, 6, (s) => jira.get<Page<T>>(build(s)));
    for (const p of rest) out.push(...(p?.values ?? []));
    return out.slice(0, cap);
  }
  // No total: sequential until isLast
  let startAt = size;
  let complete = false;
  for (;;) {
    if (out.length >= cap) break;
    const page = await jira.get<Page<T>>(build(startAt));
    const vals = page?.values ?? [];
    out.push(...vals);
    startAt += vals.length;
    if (!vals.length || page?.isLast) { complete = true; break; }
  }
  if (opts.strict && !complete && out.length >= cap) throw tooMany();
  return out.slice(0, cap);
}

/**
 * Forge may reuse a warm container across installations of the app, so anything cached at module level is
 * keyed by the installation. Outside the Forge runtime (tests, local demo) there is a single "local" scope.
 */
export function installationScope(): string {
  try { return String(getAppContext().installationAri ?? 'local'); } catch { return 'local'; }
}

/** The Marketplace license of this installation, when Forge provides one (paid apps only). */
export function runtimeLicense(): { isActive?: boolean; active?: boolean } | undefined {
  try { return getAppContext().license; } catch { return undefined; }
}
