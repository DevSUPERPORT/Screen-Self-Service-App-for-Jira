/**
 * Independent verifier — paste into the browser console on the Jira site (signed in as an admin).
 * Reads Jira's REST API directly (read-only) and compares configuration before/after an action in the app.
 * It does not use any app code: it is the external check that only the target project's objects changed.
 *
 *   await window.sssSnap('before')        // take a snapshot
 *   ...do something in the app...
 *   await window.sssSnap('after')
 *   window.sssDiff('before', 'after', 'SSS')  // → { foreign: [...must be empty], own: [...expected changes] }
 *
 * @file        verify/jira-snapshot.js
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

(() => {
  const j = async (p) => { const r = await fetch(p, { headers: { Accept: 'application/json' } }); if (!r.ok) throw new Error(`${r.status} ${p}`); return r.json(); };
  const all = async (base) => { let out = [], s = 0; for (;;) { const pg = await j(`${base}${base.includes('?') ? '&' : '?'}startAt=${s}&maxResults=100`); out = out.concat(pg.values || []); s += (pg.values || []).length; if (!pg.values?.length || pg.isLast || s >= pg.total) return out; } };

  window.sssSnap = async (label) => {
    const projects = await all('/rest/api/3/project/search');
    const itssRows = [];
    for (let i = 0; i < projects.length; i += 50) itssRows.push(...await all(`/rest/api/3/issuetypescreenscheme/project?${projects.slice(i, i + 50).map((p) => `projectId=${p.id}`).join('&')}`));
    const itssIds = [...new Set(itssRows.map((r) => r.issueTypeScreenScheme.id))];
    const mappings = {};
    for (const id of itssIds) mappings[id] = Object.fromEntries((await all(`/rest/api/3/issuetypescreenscheme/mapping?issueTypeScreenSchemeId=${id}`)).map((m) => [m.issueTypeId, m.screenSchemeId]));
    const schemes = Object.fromEntries((await all('/rest/api/3/screenscheme')).map((s) => [s.id, { name: s.name, screens: s.screens }]));
    const screens = Object.fromEntries((await all('/rest/api/3/screens')).map((s) => [s.id, s.name]));
    const wfs = Object.fromEntries((await all('/rest/api/3/workflows/search?expand=values.transitions')).map((w) => [w.id, { name: w.name, t: w.transitions.map((t) => [t.id, t.transitionScreen?.parameters?.screenId ?? null]) }]));
    const projectOf = Object.fromEntries(itssRows.flatMap((r) => r.projectIds.map((pid) => [pid, r.issueTypeScreenScheme.id])));
    // tabs/fields for every screen used by a scheme of any ITSS (bounded for dev sites)
    const used = new Set(Object.values(mappings).flatMap((m) => Object.values(m)).flatMap((sid) => Object.values(schemes[sid]?.screens || {})).map(String));
    const tabs = {};
    for (const id of used) { const ts = await j(`/rest/api/3/screens/${id}/tabs`); tabs[id] = []; for (const t of ts) tabs[id].push([t.name, (await j(`/rest/api/3/screens/${id}/tabs/${t.id}/fields`)).map((f) => f.id)]); }
    const snap = { at: new Date().toISOString(), projects: projects.map((p) => ({ id: p.id, key: p.key })), projectOf, mappings, schemes, screens, wfs, tabs };
    (window.__sssSnaps ||= {})[label] = snap; // in memory: Jira clears sessionStorage
    return { label, screens: Object.keys(screens).length, schemes: Object.keys(schemes).length, itss: itssIds.length, workflows: Object.keys(wfs).length };
  };

  window.sssDiff = (a, b, key) => {
    const A = window.__sssSnaps[a];
    const B = window.__sssSnaps[b];
    const pid = A.projects.find((p) => p.key === key).id;
    const ownItss = A.projectOf[pid];
    // objects reachable from other projects (in the BEFORE state) are foreign
    const foreignItss = new Set(Object.entries(A.projectOf).filter(([p]) => p !== pid).map(([, i]) => i));
    const foreignSchemes = new Set([...foreignItss].flatMap((i) => Object.values(A.mappings[i] || {})).map(String));
    const foreignScreens = new Set([...foreignSchemes].flatMap((s) => Object.values(A.schemes[s]?.screens || {})).map(String));
    const changes = [];
    const cmp = (kind, id, x, y) => { if (JSON.stringify(x) !== JSON.stringify(y)) changes.push({ kind, id, before: x, after: y }); };
    for (const id of new Set([...Object.keys(A.mappings), ...Object.keys(B.mappings)])) cmp('itss', id, A.mappings[id], B.mappings[id]);
    for (const id of new Set([...Object.keys(A.schemes), ...Object.keys(B.schemes)])) cmp('scheme', id, A.schemes[id], B.schemes[id]);
    for (const id of new Set([...Object.keys(A.screens), ...Object.keys(B.screens)])) cmp('screen', id, A.screens[id], B.screens[id]);
    for (const id of new Set([...Object.keys(A.tabs), ...Object.keys(B.tabs)])) if (A.tabs[id] && B.tabs[id]) cmp('tabs', id, A.tabs[id], B.tabs[id]);
    for (const id of new Set([...Object.keys(A.wfs), ...Object.keys(B.wfs)])) cmp('workflow', id, A.wfs[id], B.wfs[id]);
    const isForeign = (c) => (c.kind === 'itss' && c.id !== String(ownItss))
      || (c.kind === 'scheme' && foreignSchemes.has(c.id))
      || ((c.kind === 'screen' || c.kind === 'tabs') && foreignScreens.has(c.id));
    return { foreign: changes.filter(isForeign), own: changes.filter((c) => !isForeign(c)) };
  };
  return 'sssSnap / sssDiff ready';
})();
