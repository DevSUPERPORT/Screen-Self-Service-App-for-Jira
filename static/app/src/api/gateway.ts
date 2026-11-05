/**
 * Gateway between the Custom UI and the backend. Inside Jira it invokes the Forge resolvers through
 * @forge/bridge; outside Jira it lazily loads the demo gateway in development (or VITE_DEMO) builds and
 * refuses in production bundles. It also opens the Screen Assistant Rovo agent.
 *
 * @file        static/app/src/api/gateway.ts
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import type { AppConfig, AuditEntry, Intent, LayoutSave, PreviewItem, ProjectModel, Screen } from '@shared/types';

export type Mode = 'project' | 'admin';

export interface ExecResult {
  model: ProjectModel;
  /** temporary refs ("new-…") -> real ids, so the UI can open freshly created screens */
  idMap: Record<string, string>;
  preview: PreviewItem[];
  /** non-fatal notes, e.g. fields that could not be copied onto a new screen */
  warnings?: string[];
}

export interface SearchResult { items: Screen[]; total: number; disabled?: boolean }
export interface LayoutResult { screenId: string; ok: boolean; code?: string; message?: string }

export interface Gateway {
  readonly live: boolean;
  context(): Promise<{ mode: Mode; locale?: string; theme?: 'light' | 'dark' }>;
  /** SUPERPORT's kill switch, decided on the server: off, readonly or on */
  availability(): Promise<{ mode: 'off' | 'readonly' | 'on'; statusUrl: string }>;
  load(): Promise<ProjectModel>;
  loadScreen(id: string): Promise<Screen>;
  searchScreens(query: string, limit: number): Promise<SearchResult>;
  /** digest = planDigest() of the plan the user previewed; the backend refuses if Jira changed since */
  execute(intent: Intent, digest: string, label?: string): Promise<ExecResult>;
  saveLayout(save: LayoutSave, label?: string): Promise<ProjectModel>;
  /** several screens at once; every screen succeeds or is rolled back on its own */
  saveLayouts(saves: LayoutSave[], label?: string): Promise<{ model: ProjectModel; results: LayoutResult[] }>;
  addToFieldScheme(fieldIds: string[], label?: string): Promise<{ model: ProjectModel }>;
  undo(): Promise<{ model: ProjectModel; label: string }>;
  audit(): Promise<AuditEntry[]>;
  loadConfig(): Promise<AppConfig>;
  saveConfig(c: AppConfig): Promise<AppConfig>;
}

export class GatewayError extends Error {
  constructor(public code: 'conflict' | 'denied' | 'locked' | 'invalid' | 'not-found' | 'error' | 'unavailable' | 'unlicensed', message: string) {
    super(message);
  }
}

// ---------------- Forge (inside Jira) ----------------

async function call<T>(fn: string, payload?: unknown): Promise<T> {
  const { invoke } = await import('@forge/bridge');
  const res = (await invoke(fn, payload as never)) as { ok: true; data: T } | { ok: false; code: GatewayError['code']; message: string };
  if (!res || !res.ok) throw new GatewayError((res as { code: GatewayError['code'] })?.code ?? 'error', (res as { message?: string })?.message ?? 'Request failed');
  return res.data;
}

const forgeGateway: Gateway = {
  live: true,
  async context() {
    const { view } = await import('@forge/bridge');
    const ctx = (await view.getContext()) as { moduleKey?: string; locale?: string; theme?: { colorMode?: string } };
    try { await view.theme.enable(); } catch { /* theming optional */ }
    return {
      mode: ctx.moduleKey?.includes('admin') ? 'admin' : 'project',
      locale: ctx.locale,
      theme: ctx.theme?.colorMode === 'dark' ? 'dark' : 'light',
    };
  },
  availability: () => call('availability'),
  load: () => call('load'),
  loadScreen: (id) => call('loadScreen', { id }),
  searchScreens: (query, limit) => call('searchScreens', { query, limit }),
  execute: (intent, digest, label) => call('execute', { intent, digest, label }),
  saveLayout: (save, label) => call('saveLayout', { save, label }),
  saveLayouts: (saves, label) => call('saveLayouts', { saves, label }),
  addToFieldScheme: (fieldIds, label) => call('addToFieldScheme', { fieldIds, label }),
  undo: () => call('undo'),
  audit: () => call('audit'),
  loadConfig: () => call('loadConfig'),
  saveConfig: (c) => call('saveConfig', { config: c }),
};

// ---------------- Outside Jira ----------------

// The local demo (mock data, no Jira) exists only in development builds. Production bundles don't contain it:
// `import.meta.env.DEV` is a build-time constant, so the dynamic import below is removed from them entirely.
// (`VITE_DEMO=1 npm run build` builds a demo bundle on purpose.)
const DEMO = import.meta.env.DEV || import.meta.env.VITE_DEMO === '1';

function lazyGateway(load: () => Promise<Gateway>): Gateway {
  const via = <K extends keyof Gateway>(k: K) => async (...args: unknown[]) => {
    const g = await load();
    return (g[k] as unknown as (...a: unknown[]) => unknown)(...args);
  };
  return {
    live: false,
    context: via('context'), availability: via('availability'), load: via('load'), loadScreen: via('loadScreen'), searchScreens: via('searchScreens'),
    execute: via('execute'), saveLayout: via('saveLayout'), saveLayouts: via('saveLayouts'), addToFieldScheme: via('addToFieldScheme'),
    undo: via('undo'), audit: via('audit'), loadConfig: via('loadConfig'), saveConfig: via('saveConfig'),
  } as Gateway;
}

/** A production bundle opened outside Jira: say so instead of showing anything. */
const outsideJira = (): Gateway => {
  const no = async () => { throw new GatewayError('denied', 'Open Screen Self-Service for Jira from your Jira project settings.'); };
  return { live: false, context: async () => ({ mode: 'project' }), availability: no, load: no, loadScreen: no, searchScreens: no, execute: no, saveLayout: no, saveLayouts: no, addToFieldScheme: no, undo: no, audit: no, loadConfig: no, saveConfig: no };
};

export const inForge = typeof window !== 'undefined' && !!(window as unknown as { __bridge?: unknown }).__bridge;
export const gateway: Gateway = inForge ? forgeGateway
  : DEMO ? lazyGateway(() => import('./demoGateway').then((m) => m.demoGateway)) : outsideJira();

export const ROVO_AGENT = { key: 'screen-assistant', name: 'Screen Assistant' };

/** Opens Rovo chat with our agent. Returns false when Rovo isn't available (outside Jira / not enabled). */
export async function askRovo(prompt?: string): Promise<boolean> {
  if (!inForge) return false;
  try {
    const { rovo } = await import('@forge/bridge');
    if (!(await rovo.isEnabled())) return false;
    await rovo.open({ type: 'forge', agentKey: ROVO_AGENT.key, agentName: ROVO_AGENT.name, prompt });
    return true;
  } catch {
    return false;
  }
}
