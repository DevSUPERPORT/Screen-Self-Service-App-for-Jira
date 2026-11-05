/**
 * In-memory Jira Cloud covering every REST endpoint the app uses, with Jira's real constraints:
 * unique screen / screen scheme names, no deleting objects in use, a field only once per screen,
 * optimistic workflow versions, no double issue-type mappings. Supports failure injection at the Nth write
 * and simulated latency (for large-instance benchmarks).
 *
 * @file        tests/fakeJira.ts
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import type { Transport } from '../src/backend/jira';

export interface FTab { id: number; name: string; fields: string[] }
export interface FScreen { id: number; name: string; description?: string; tabs: FTab[] }
export interface FScheme { id: number; name: string; description?: string; screens: { default: number; create?: number; edit?: number; view?: number } }
export interface FItss { id: number; name: string; mappings: Record<string, number> } // issueTypeId|'default' -> scheme
export interface FTransition { id: string; name: string; type: string; toStatusReference: string; links: { fromStatusReference: string | null }[]; transitionScreen?: { ruleKey: string; parameters: { screenId: string } } }
export interface FWorkflow { id: string; name: string; version: { id: string; versionNumber: number }; statuses: { statusReference: string }[]; transitions: FTransition[] }
export interface FProject { id: number; key: string; name: string; style: 'classic' | 'next-gen'; issueTypes: { id: string; name: string }[] }
export interface FWorkflowScheme { id: number; projectIds: number[]; defaultWorkflow: string; issueTypeMappings: Record<string, string> }
export interface FFieldScheme { id: number; name: string; projectIds: number[]; fields: string[] }

export interface FakeState {
  projects: FProject[];
  screens: FScreen[];
  schemes: FScheme[];
  itss: FItss[];
  projectItss: Record<number, number>;
  workflows: FWorkflow[];
  statuses: { id: string; name: string; statusReference: string; statusCategory: string }[];
  workflowSchemes: FWorkflowScheme[];
  fields: { id: string; name: string; custom: boolean; schema?: { type?: string; custom?: string } }[];
  fieldSchemes: FFieldScheme[] | null; // null = site still on legacy field configurations
  globalAdmins: string[];
  projectAdmins: Record<number, string[]>;
  seq: number;
}

export interface FakeOptions { failAtWrite?: number | null; latencyMs?: number; failRead?: RegExp }

const READ_POSTS = [/\/rest\/api\/3\/workflows$/, /\/rest\/api\/3\/permissions\/check$/];

export class FakeJira {
  state: FakeState;
  writes = 0;
  calls = 0;
  log: string[] = [];
  opts: FakeOptions;

  constructor(state: FakeState, opts: FakeOptions = {}) {
    this.state = structuredClone(state);
    this.opts = opts;
  }

  snapshot(): FakeState { return structuredClone(this.state); }

  transport: Transport = async (method, path, body) => {
    this.calls++;
    if (this.opts.latencyMs) await new Promise((r) => setTimeout(r, this.opts.latencyMs));
    const isWrite = method !== 'GET' && !READ_POSTS.some((r) => r.test(path.split('?')[0]));
    if (isWrite) {
      this.writes++;
      this.log.push(`${method} ${path.split('?')[0]}`);
      if (this.opts.failAtWrite && this.writes === this.opts.failAtWrite) return res(400, { errorMessages: ['Injected failure'] });
    }
    try {
      return this.route(method, path, body);
    } catch (e) {
      if (e instanceof HttpError) return res(e.status, { errorMessages: [e.message] });
      throw e;
    }
  };

  private id() { return ++this.state.seq; }
  private screen(id: number | string) { const s = this.state.screens.find((x) => x.id === Number(id)); if (!s) throw new HttpError(404, 'Screen not found'); return s; }
  private scheme(id: number | string) { const s = this.state.schemes.find((x) => x.id === Number(id)); if (!s) throw new HttpError(404, 'Screen scheme not found'); return s; }
  private itss(id: number | string) { const s = this.state.itss.find((x) => x.id === Number(id)); if (!s) throw new HttpError(404, 'ITSS not found'); return s; }
  private project(idOrKey: string) { const p = this.state.projects.find((x) => String(x.id) === idOrKey || x.key === idOrKey); if (!p) throw new HttpError(404, 'Project not found'); return p; }
  private uniqueScreenName(name: string, except?: number) {
    if (this.state.screens.some((s) => s.id !== except && s.name.toLowerCase() === name.toLowerCase())) throw new HttpError(400, `A screen named ${name} already exists`);
  }
  private uniqueSchemeName(name: string, except?: number) {
    if (this.state.schemes.some((s) => s.id !== except && s.name.toLowerCase() === name.toLowerCase())) throw new HttpError(400, `A screen scheme named ${name} already exists`);
  }

  private route(method: string, full: string, body: any): { status: number; text: string } {
    const url = new URL(full, 'https://fake.atlassian.net');
    const p = url.pathname;
    const q = url.searchParams;
    const st = this.state;
    let m: RegExpMatchArray | null;
    const M = (re: RegExp) => (m = p.match(re));

    if (method === 'GET' && this.opts.failRead?.test(p)) return { status: 500, text: JSON.stringify({ errorMessages: ['Injected read failure'] }) };

    // ---------------- auth & users
    if (method === 'POST' && p === '/rest/api/3/permissions/check') {
      const acc = body.accountId as string;
      const global = st.globalAdmins.includes(acc) && body.globalPermissions?.includes('ADMINISTER') ? ['ADMINISTER'] : [];
      const projectPermissions = (body.projectPermissions ?? []).flatMap((pp: { permissions: string[]; projects: number[] }) =>
        pp.permissions.map((perm) => ({ permission: perm, issues: [], projects: pp.projects.filter((pid) => global.length || (st.projectAdmins[pid] ?? []).includes(acc)) })));
      return res(200, { globalPermissions: global, projectPermissions });
    }
    if (method === 'GET' && p === '/rest/api/3/user') return res(200, { displayName: `User ${q.get('accountId')}` });
    if (method === 'GET' && p === '/rest/api/3/user/bulk') return res(200, { values: q.getAll('accountId').map((a) => ({ accountId: a, displayName: `User ${a}` })) });

    // ---------------- projects
    if (method === 'GET' && p === '/rest/api/3/project/search') {
      return res(200, page(st.projects.map((x) => ({ id: String(x.id), key: x.key, name: x.name, style: x.style, simplified: x.style !== 'classic' })), q));
    }
    if (method === 'GET' && M(/^\/rest\/api\/3\/project\/([^/]+)$/)) {
      const pr = this.project(decodeURIComponent(m![1]));
      return res(200, { id: String(pr.id), key: pr.key, name: pr.name, style: pr.style, simplified: pr.style !== 'classic', issueTypes: pr.issueTypes });
    }

    // ---------------- fields & field schemes
    if (method === 'GET' && p === '/rest/api/3/field') return res(200, st.fields);
    if (p.startsWith('/rest/api/3/config/fieldschemes')) {
      if (!st.fieldSchemes) return res(404, { errorMessages: ['Feature flag disabled'] });
      const fss = st.fieldSchemes;
      if (method === 'GET' && p === '/rest/api/3/config/fieldschemes/projects') {
        const pids = q.getAll('projectId').map(Number);
        return res(200, page(pids.flatMap((pid) => fss.filter((f) => f.projectIds.includes(pid)).map((f) => ({ projectId: String(pid), schemeId: String(f.id) }))), q));
      }
      if (p === '/rest/api/3/config/fieldschemes/fields') {
        if (method === 'PUT') {
          const results: unknown[] = [];
          for (const [fieldId, items] of Object.entries(body as Record<string, { schemeIds: number[] }[]>)) for (const it of items) for (const sid of it.schemeIds) {
            const fs = fss.find((x) => x.id === sid);
            if (!fs) { results.push({ fieldId, schemeId: sid, success: false, error: 'not found' }); continue; }
            if (!fs.fields.includes(fieldId)) fs.fields.push(fieldId);
            results.push({ fieldId, schemeId: sid, success: true });
          }
          return res(200, { results });
        }
        if (method === 'DELETE') {
          for (const [fieldId, it] of Object.entries(body as Record<string, { schemeIds: number[] }>)) for (const sid of it.schemeIds) {
            const fs = fss.find((x) => x.id === sid);
            if (fs) fs.fields = fs.fields.filter((f) => f !== fieldId);
          }
          return res(204);
        }
      }
      if (method === 'GET' && M(/^\/rest\/api\/3\/config\/fieldschemes\/(\d+)$/)) {
        const fs = fss.find((x) => x.id === Number(m![1])); if (!fs) throw new HttpError(404, 'nf');
        return res(200, { id: fs.id, name: fs.name });
      }
      if (method === 'GET' && M(/^\/rest\/api\/3\/config\/fieldschemes\/(\d+)\/projects$/)) {
        const fs = fss.find((x) => x.id === Number(m![1]))!;
        return res(200, page(fs.projectIds.map((pid) => { const pr = st.projects.find((x) => x.id === pid)!; return { id: String(pid), key: pr.key }; }), q));
      }
      if (method === 'GET' && M(/^\/rest\/api\/3\/config\/fieldschemes\/(\d+)\/fields$/)) {
        const fs = fss.find((x) => x.id === Number(m![1]))!;
        return res(200, page(fs.fields.map((fieldId) => ({ fieldId })), q));
      }
    }

    // ---------------- screens
    if (p === '/rest/api/3/screens') {
      if (method === 'GET') {
        const ids = q.getAll('id').map(Number);
        const qs = (q.get('queryString') ?? '').toLowerCase();
        const list = st.screens.filter((s) => (!ids.length || ids.includes(s.id)) && (!qs || s.name.toLowerCase().includes(qs)))
          .sort((a, b) => (q.get('orderBy') === 'name' ? a.name.localeCompare(b.name) : a.id - b.id));
        return res(200, page(list.map((s) => ({ id: s.id, name: s.name, description: s.description })), q));
      }
      if (method === 'POST') {
        if (!body?.name || body.name.length > 255) throw new HttpError(400, 'Name required');
        this.uniqueScreenName(body.name);
        const s: FScreen = { id: this.id(), name: body.name, description: body.description, tabs: [{ id: this.id(), name: 'Field Tab', fields: [] }] };
        st.screens.push(s);
        return res(201, { id: s.id, name: s.name });
      }
    }
    if (M(/^\/rest\/api\/3\/screens\/(\d+)$/)) {
      const s = this.screen(m![1]);
      if (method === 'PUT') { if (body.name) { this.uniqueScreenName(body.name, s.id); s.name = body.name; } return res(200, { id: s.id, name: s.name }); }
      if (method === 'DELETE') {
        if (st.schemes.some((sc) => Object.values(sc.screens).includes(s.id))) throw new HttpError(400, 'Screen is used in a screen scheme');
        if (st.workflows.some((w) => w.transitions.some((t) => t.transitionScreen?.parameters.screenId === String(s.id)))) throw new HttpError(400, 'Screen is used in a workflow');
        st.screens = st.screens.filter((x) => x !== s);
        return res(204);
      }
    }
    if (M(/^\/rest\/api\/3\/screens\/(\d+)\/tabs$/)) {
      const s = this.screen(m![1]);
      if (method === 'GET') return res(200, s.tabs.map((t) => ({ id: t.id, name: t.name })));
      if (method === 'POST') {
        if (s.tabs.some((t) => t.name === body.name)) throw new HttpError(400, 'Tab name exists');
        const t: FTab = { id: this.id(), name: body.name, fields: [] };
        s.tabs.push(t);
        return res(200, { id: t.id, name: t.name });
      }
    }
    if (M(/^\/rest\/api\/3\/screens\/(\d+)\/tabs\/(\d+)$/)) {
      const s = this.screen(m![1]);
      const t = s.tabs.find((x) => x.id === Number(m![2])); if (!t) throw new HttpError(404, 'Tab not found');
      if (method === 'PUT') { t.name = body.name; return res(200, { id: t.id, name: t.name }); }
      if (method === 'DELETE') { if (s.tabs.length === 1) throw new HttpError(400, 'A screen needs a tab'); s.tabs = s.tabs.filter((x) => x !== t); return res(204); }
    }
    if (method === 'POST' && M(/^\/rest\/api\/3\/screens\/(\d+)\/tabs\/(\d+)\/move\/(\d+)$/)) {
      const s = this.screen(m![1]);
      const t = s.tabs.find((x) => x.id === Number(m![2]))!;
      s.tabs = s.tabs.filter((x) => x !== t);
      s.tabs.splice(Number(m![3]), 0, t);
      return res(204);
    }
    if (M(/^\/rest\/api\/3\/screens\/(\d+)\/tabs\/(\d+)\/fields$/)) {
      const s = this.screen(m![1]);
      const t = s.tabs.find((x) => x.id === Number(m![2])); if (!t) throw new HttpError(404, 'Tab not found');
      if (method === 'GET') return res(200, t.fields.map((id) => ({ id, name: st.fields.find((f) => f.id === id)?.name ?? id })));
      if (method === 'POST') {
        if (!st.fields.some((f) => f.id === body.fieldId)) throw new HttpError(400, 'Unknown field');
        if (s.tabs.some((x) => x.fields.includes(body.fieldId))) throw new HttpError(400, 'Field already on screen');
        t.fields.push(body.fieldId);
        return res(200, { id: body.fieldId });
      }
    }
    if (method === 'DELETE' && M(/^\/rest\/api\/3\/screens\/(\d+)\/tabs\/(\d+)\/fields\/([^/]+)$/)) {
      const t = this.screen(m![1]).tabs.find((x) => x.id === Number(m![2]))!;
      const f = decodeURIComponent(m![3]);
      if (!t.fields.includes(f)) throw new HttpError(404, 'Field not on tab');
      t.fields = t.fields.filter((x) => x !== f);
      return res(204);
    }
    if (method === 'POST' && M(/^\/rest\/api\/3\/screens\/(\d+)\/tabs\/(\d+)\/fields\/([^/]+)\/move$/)) {
      const t = this.screen(m![1]).tabs.find((x) => x.id === Number(m![2]))!;
      const f = decodeURIComponent(m![3]);
      t.fields = t.fields.filter((x) => x !== f);
      if (body.after) t.fields.splice(t.fields.indexOf(body.after) + 1, 0, f);
      else if (body.position === 'First') t.fields.unshift(f);
      else t.fields.push(f);
      return res(204);
    }

    // ---------------- screen schemes
    if (p === '/rest/api/3/screenscheme') {
      if (method === 'GET') {
        // page first, then expand (an index instead of scanning every ITSS per scheme)
        const ids = q.getAll('id').map(Number);
        const pg = page(ids.length ? st.schemes.filter((s) => ids.includes(s.id)) : st.schemes, q);
        const users = new Map<number, string[]>();
        if (q.get('expand') === 'issueTypeScreenSchemes') for (const i of st.itss) for (const sid of new Set(Object.values(i.mappings))) users.set(sid, [...(users.get(sid) ?? []), String(i.id)]);
        return res(200, { ...pg, values: pg.values.map((s) => ({
          id: s.id, name: s.name, description: s.description, screens: s.screens,
          ...(q.get('expand') === 'issueTypeScreenSchemes' ? { issueTypeScreenSchemes: { values: (users.get(s.id) ?? []).map((id) => ({ id })) } } : {}),
        })) });
      }
      if (method === 'POST') {
        this.uniqueSchemeName(body.name);
        if (!body.screens?.default) throw new HttpError(400, 'Default required');
        for (const v of Object.values(body.screens)) this.screen(v as number);
        const s: FScheme = { id: this.id(), name: body.name, description: body.description, screens: { ...body.screens } };
        st.schemes.push(s);
        return res(201, { id: s.id });
      }
    }
    if (M(/^\/rest\/api\/3\/screenscheme\/(\d+)$/)) {
      const s = this.scheme(m![1]);
      if (method === 'PUT') {
        if (body.name) { this.uniqueSchemeName(body.name, s.id); s.name = body.name; }
        if (body.screens) {
          if ('default' in body.screens && !body.screens.default) throw new HttpError(400, 'Default required');
          for (const o of ['default', 'create', 'edit', 'view'] as const) {
            if (!(o in body.screens)) continue;
            const v = body.screens[o];
            if (v === null) delete s.screens[o];
            else { this.screen(v); s.screens[o] = Number(v); }
          }
        }
        return res(204);
      }
      if (method === 'DELETE') {
        if (st.itss.some((i) => Object.values(i.mappings).includes(s.id))) throw new HttpError(400, 'Screen scheme is used');
        st.schemes = st.schemes.filter((x) => x !== s);
        return res(204);
      }
    }

    // ---------------- issue type screen schemes
    if (method === 'GET' && p === '/rest/api/3/issuetypescreenscheme/project') {
      const pids = q.getAll('projectId').map(Number);
      const byItss = new Map<number, string[]>();
      for (const pid of pids) { const i = st.projectItss[pid]; if (i) byItss.set(i, [...(byItss.get(i) ?? []), String(pid)]); }
      return res(200, page([...byItss].map(([id, projectIds]) => ({ issueTypeScreenScheme: { id: String(id), name: this.itss(id).name }, projectIds })), q));
    }
    if (method === 'GET' && p === '/rest/api/3/issuetypescreenscheme/mapping') {
      const i = this.itss(q.get('issueTypeScreenSchemeId')!);
      return res(200, page(Object.entries(i.mappings).map(([issueTypeId, sid]) => ({ issueTypeScreenSchemeId: String(i.id), issueTypeId, screenSchemeId: String(sid) })), q));
    }
    if (method === 'GET' && p === '/rest/api/3/issuetypescreenscheme') {
      const ids = q.getAll('id').map(Number);
      return res(200, page(st.itss.filter((i) => !ids.length || ids.includes(i.id)).map((i) => ({ id: String(i.id), name: i.name })), q));
    }
    if (M(/^\/rest\/api\/3\/issuetypescreenscheme\/(\d+)\/mapping$/) && method === 'PUT') {
      const i = this.itss(m![1]);
      for (const mp of body.issueTypeMappings) {
        if (mp.issueTypeId === 'default') throw new HttpError(400, 'Use /mapping/default');
        if (mp.issueTypeId in i.mappings) throw new HttpError(400, 'Issue type already mapped');
        this.scheme(mp.screenSchemeId);
        i.mappings[mp.issueTypeId] = Number(mp.screenSchemeId);
      }
      return res(204);
    }
    if (M(/^\/rest\/api\/3\/issuetypescreenscheme\/(\d+)\/mapping\/remove$/) && method === 'POST') {
      const i = this.itss(m![1]);
      for (const it of body.issueTypeIds) { if (!(it in i.mappings)) throw new HttpError(400, 'Not mapped'); delete i.mappings[it]; }
      return res(204);
    }

    // ---------------- workflows
    if (method === 'GET' && p === '/rest/api/3/workflows/search') {
      const pg = page(st.workflows, q);
      return res(200, { ...pg, statuses: st.statuses });
    }
    if (method === 'POST' && p === '/rest/api/3/workflows') {
      const wfs = st.workflows.filter((w) => body.workflowIds.includes(w.id));
      return res(200, { workflows: wfs, statuses: st.statuses });
    }
    if (method === 'POST' && p === '/rest/api/3/workflows/update') {
      for (const u of body.workflows) {
        const w = st.workflows.find((x) => x.id === u.id); if (!w) throw new HttpError(404, 'Workflow not found');
        if (u.version?.versionNumber !== w.version.versionNumber) throw new HttpError(409, 'Version conflict');
        for (const t of u.transitions) if (t.transitionScreen) this.screen(t.transitionScreen.parameters.screenId);
        w.transitions = structuredClone(u.transitions);
        w.version = { id: `v${w.version.versionNumber + 1}`, versionNumber: w.version.versionNumber + 1 };
      }
      return res(200, { workflows: [], statuses: [] });
    }
    if (method === 'GET' && p === '/rest/api/3/workflowscheme/project') {
      const pids = q.getAll('projectId').map(Number);
      return res(200, { values: st.workflowSchemes.filter((ws) => ws.projectIds.some((x) => pids.includes(x))).map((ws) => ({ projectIds: ws.projectIds.filter((x) => pids.includes(x)).map(String), workflowScheme: { id: ws.id, defaultWorkflow: ws.defaultWorkflow, issueTypeMappings: ws.issueTypeMappings } })) });
    }

    throw new Error(`FakeJira: unhandled ${method} ${p}`);
  }
}

class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }
const res = (status: number, body?: unknown) => ({ status, text: body === undefined ? '' : JSON.stringify(body) });
function page<T>(values: T[], q: URLSearchParams) {
  const startAt = Number(q.get('startAt') ?? 0);
  const max = Number(q.get('maxResults') ?? 50);
  const slice = values.slice(startAt, startAt + max);
  return { startAt, maxResults: max, total: values.length, isLast: startAt + slice.length >= values.length, values: slice };
}
