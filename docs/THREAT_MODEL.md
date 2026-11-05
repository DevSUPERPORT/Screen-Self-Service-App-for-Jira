# Threat model — Screen Self-Service for Jira

## The core risk

The app holds Jira **admin** scopes (`manage:jira-configuration`) and acts on behalf of **project admins**, who do
not have them. That makes it a *confused deputy* by construction: any path where a caller can steer the app's
authority beyond their own is a privilege escalation. Every control below exists to make the app exactly as
powerful as the caller, for exactly one project, and never more.

## Assets

| Asset | Why it matters |
|---|---|
| Screens, screen schemes, issue type screen schemes (ITSS) of **other** projects | Shared configuration — a change leaks into every project using it |
| Workflows (transition screens) | Shared workflows affect many projects; updates can trigger status migrations |
| Field schemes | Adding a field to a shared field scheme changes other projects' field visibility |
| App storage (config, audit log, "created by app" registry) | Auto-deletion trusts the registry; audit log is evidence |
| Jira data reachable with admin scopes | Read access beyond the caller's rights (information disclosure) |

## Trust boundaries

1. **Browser → resolver** (Forge `invoke`): the payload is attacker-controlled. Forge context (`accountId` from the
   runtime principal, `extension.project`, `moduleKey`) is platform-supplied and trusted.
2. **Rovo → action function**: inputs are produced by an LLM from user text — untrusted and possibly hallucinated.
3. **App → Jira REST** as the app (admin): every call is a potential escalation unless guarded.
4. **Scheduled trigger** (no user): acts only on objects the app itself created.

## Invariants (must never be violated)

| # | Invariant | Enforced by | Proven by |
|---|---|---|---|
| I1 | Identity and project come only from the Forge context, never the payload | `auth.ts` `callerFrom`, `requireProjectAdmin` | `security.test.ts` "project always comes from the Forge context" |
| I2 | Every resolver call re-checks the caller's real Jira permission (ADMINISTER_PROJECTS on that project; ADMINISTER for config) | `permissions/check` with the context accountId on **every** call | `security.test.ts` — 12 denial cases, 0 writes each |
| I3 | No step ever writes to an object reachable from another project | `planFor` rules + `verifyGuard` on fresh state | `properties.test.ts` (generated instances) + `integration.test.ts` (Jira raw state diff of all foreign objects) |
| I4 | The client sends intents, never steps; the backend re-plans from fresh Jira state | `validateIntent` schema + `planFor` | `security.test.ts` malformed / traversal / oversized inputs |
| I5 | What the user previewed is exactly what runs | plan digest (canonical JSON) checked server-side; conflict otherwise | `integration.test.ts` preview == Jira end state; stale preview refused |
| I6 | A failed change never leaves Jira half-changed | compensation stack; mapping step self-restores | `integration.test.ts` failure injection at **every** write |
| I7 | Default screen is never removed; names stay unique and follow the naming scheme | domain rules | `properties.test.ts` |
| I8 | Field scheme writes only when the field scheme belongs to the project alone | `applyLayout` | `security.test.ts`, `integration.test.ts` |
| I9 | Auto-deletion only touches objects the app created, scheme before screen | KVS registry + `nightly()` | code review; live test pending |
| I10 | Rovo actions authorize from context accountId and re-resolve the project key; never trust inputs | `requireProjectAdminByKey` | `security.test.ts` Rovo suite |

## STRIDE

| Threat | Example attack | Mitigation |
|---|---|---|
| **S**poofing | Payload claims `projectId` of another project, or another `accountId` | I1: payload never read for identity/project; accountId from runtime principal |
| | Rovo input names a project the caller doesn't administer | I10: permission check against the resolved project |
| **T**ampering | Client sends a crafted plan touching shared schemes | I4: only intents accepted; re-planned server-side; `verifyGuard` |
| | Ids like `../../admin`, `10001/../x` to reach other endpoints | Strict id regexes; `route` tag encodes every value; `..` segments rejected |
| | Race: Jira changes between preview and confirm | I5 digest → `conflict`, UI reloads |
| | Concurrent native issue-layout edit overwritten | Layout base digest → `conflict` |
| **R**epudiation | "I didn't change that screen" | Audit log: user, time, object, before/after for every step and every rollback |
| **I**nformation disclosure | Project admin reads other projects' config through the app | Only screen *search/preview* for copying (UC-04 requires it); no other cross-project reads exposed; admin audit log only via admin module + ADMINISTER |
| | Stack traces / Jira error bodies leaking | Generic error for unexpected exceptions; Jira messages truncated |
| **D**enial of service | Huge payloads, thousands of delete ids | Size limits (≤20 delete items, ≤50 tabs, ≤120-char names, ≤100-char search) |
| | Jira rate limiting | Bounded concurrency; retry with backoff on 429 (any method) / 5xx (idempotent only) |
| **E**levation of privilege | Non-admin calls resolvers directly via `invoke` | I2 on every call, not only on page load |
| | Project admin calls admin-only resolvers (`saveConfig`) | ADMINISTER required server-side |
| | XSS in names rendered in UI | React escaping; `<`/`>` rejected in transition names; no `dangerouslySetInnerHTML` |

## Residual risks / open items

- Live denial test with a real non-admin account is pending (the available accounts are site admins).
  Unit-level coverage exists (`security.test.ts`).
- Forge app account admin rights are not documented by Atlassian; verified empirically on a SUPERPORT test site.
- Workflow and field scheme endpoints are marked *experimental* by Atlassian; behaviour may change.
- Auto-deletion (`nightly`) is covered by code review only; it can't be triggered on demand from this environment.

## v2.11 additions: undo, health fixes, bulk changes

| Threat | Mitigation |
|---|---|
| Client forges an undo record (e.g. "restore" a screen into another project) | Undo records are written only by the backend, keyed by the caller's runtime `accountId` and the Forge-context project; the `undo` resolver takes no payload. |
| One admin undoes another admin's change | Records are per user; another user gets `not-found` (tested). |
| Undo overwrites someone's later work | Plan undos re-check every precondition, layout undos check digests, restores refuse taken names; refusals write nothing (tested). |
| Bulk change touches a shared screen | `bulkPlan` marks shared screens `locked`; `saveLayouts` re-checks exclusivity per screen through `applyLayout` on fresh state. Max 60 screens per call. |
| `addToFieldScheme` used to widen a shared field scheme or add arbitrary fields | Only the project's own exclusive field scheme, and only fields already on the project's own screens. |
