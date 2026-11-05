# Screen Self-Service: API reference (Jira Cloud REST v3 + Forge)

Verified on 2026-10-29 against:
- The official Jira Cloud v3 OpenAPI spec (`https://dac-static.atlassian.com/cloud/jira/platform/swagger-v3.v3.json`, version `1001.0.0-SNAPSHOT-f646546…`). This is the source for the REST pages on developer.atlassian.com.
- developer.atlassian.com Forge pages: manifest modules, resolver, bridge, kvs, requestJira, authorize, CLI, changelog.

Conventions:
- `*` marks a required field.
- **UNVERIFIED** means I could not confirm it in official docs. Test it before you rely on it.
- `EXPERIMENTAL` means the spec flags the operation as `x-experimental`.
- Scopes are the classic scopes from the spec ("Current" state). Granular scopes exist too but aren't needed.

All calls go through `api.asApp()` or `api.asUser()` as `.requestJira(route\`...\`)` (see §7).

---

## 0. Permission and scope cheat-sheet

| Area | Jira permission the docs require | Classic scope |
|---|---|---|
| Screens, tabs, tab fields, available fields | Administer Jira (global). Exception: GET tabs and GET tab fields also allow *Administer projects* when `projectKey` is passed and the screen is linked to that project through SS→ITSS | `manage:jira-project` |
| Screen schemes GET / DELETE | Administer Jira | `manage:jira-project` |
| Screen schemes POST / PUT | Administer Jira | **`manage:jira-configuration`** |
| Issue type screen schemes (all) | Administer Jira | `manage:jira-configuration` |
| Workflows (`/workflows*`), workflow usages, workflow schemes | Administer Jira, or *Administer projects* for **project-scoped (team-managed)** workflows only | `manage:jira-configuration` |
| Field schemes (`/config/fieldschemes*`) | Administer Jira | `manage:jira-configuration` |
| `GET /mypermissions`, `GET /project/{key}` | none / Browse projects | `read:jira-work` |
| Forge KVS | n/a | `storage:app` |

Effectively everything is global-admin-only, so the app has to call as the app (`asApp`) and do its own authorization check (§6).

Whether the Forge app user actually holds "Administer Jira" is **UNVERIFIED** in official docs. Community reports say that `manage:jira-configuration` puts the app user in `atlassian-addons-admin`, and that some endpoints still return 403 "Not admin". Smoke-test every write endpoint as the app on the dev site.

---

## 1. Screens

Base path: `/rest/api/3/screens`. Screen IDs are integers.

### List / search
`GET /rest/api/3/screens`

| Query param | Notes |
|---|---|
| `startAt` (int, default 0), `maxResults` (int, default 100) | Pagination |
| `id` (int[], repeat the param) | `id=10000&id=10001` |
| `queryString` (string) | Spec wording: "String used to perform a **case-insensitive partial match** with screen name." So it is a case-insensitive substring match. |
| `scope` (string[], repeat) | `GLOBAL`, `TEMPLATE`, `PROJECT`. Use `scope=GLOBAL` for company-managed screens. |
| `orderBy` | `name`, `-name`, `+name`, `id`, `-id`, `+id` |

Response is a `PageBeanScreen`: `{ startAt, maxResults, total, isLast, nextPage?, self, values: Screen[] }`. A `Screen` is `{ id:int, name, description, scope?: { type: "PROJECT"|"TEMPLATE", project? } }`.

### Create (EXPERIMENTAL)
`POST /rest/api/3/screens` with body `{ "name"*: "unique, ≤255", "description": "≤255" }`.
Returns 201 with a `Screen`. A default field tab is created automatically.

### Update / rename (EXPERIMENTAL)
`PUT /rest/api/3/screens/{screenId}` with body `{ "name"?: "unique", "description"?: "" }`.
Returns 200 with a `Screen`. "Only screens used in classic projects can be updated."

### Delete (EXPERIMENTAL)
`DELETE /rest/api/3/screens/{screenId}` returns 204.
It fails (400) when the screen is used in a screen scheme, a workflow **or a workflow draft**. Only classic-project screens can be deleted.

### Available fields
`GET /rest/api/3/screens/{screenId}/availableFields` returns `[{ id: "customfield_10010", name }]`. These are the fields that can still be added to a tab of this screen.

### Other
- `POST /rest/api/3/screens/addToDefault/{fieldId}` adds a field to the default tab of the *default* screen.
- `GET /rest/api/3/field/{fieldId}/screens` lists the screens a field is on. Its parameters are not detailed here.

### Tabs
| Op | Method + path | Body / params | Response |
|---|---|---|---|
| List | `GET /screens/{screenId}/tabs` | `?projectKey=` optional (enables the project-admin path) | `[{ id:int, name }]` (ordered) |
| Bulk list (EXPERIMENTAL) | `GET /screens/tabs?screenId=1&screenId=2&tabId=…&startAt&maxResult` | Note the param is spelled **`maxResult`** (no s), max 100 | page of `{screenId, tabId, tabName}` |
| Create | `POST /screens/{screenId}/tabs` | `{ "name"*: "≤255" }` | 200 `{id, name}` |
| Rename | `PUT /screens/{screenId}/tabs/{tabId}` | `{ "name"*: "…" }` | 200 `{id, name}` |
| Delete | `DELETE /screens/{screenId}/tabs/{tabId}` | – | 204 |
| Move | `POST /screens/{screenId}/tabs/{tabId}/move/{pos}` | **No body**. `pos` is a 0-based integer in the path. | 204 |

### Tab fields
| Op | Method + path | Body / params | Response |
|---|---|---|---|
| List | `GET /screens/{screenId}/tabs/{tabId}/fields` | `?projectKey=` optional | `[{ id: "summary", name }]` (ordered) |
| Add | `POST /screens/{screenId}/tabs/{tabId}/fields` | `{ "fieldId"*: "customfield_10010" }`. Query `skipFieldAssociation` (bool, default false) is undocumented. **UNVERIFIED**: it probably skips the field-scheme association side effect. | 200 `{id, name}` |
| Remove | `DELETE /screens/{screenId}/tabs/{tabId}/fields/{id}` | `id` = field ID (string) | 204 |
| Move | `POST /screens/{screenId}/tabs/{tabId}/fields/{id}/move` | see below | 204 |

Move body (`MoveFieldBean`). Send exactly one of the two keys:
```json
{ "after": "customfield_10010" }          // place directly after this field ID
{ "position": "First" }                   // "Earlier" | "Later" | "First" | "Last"
```
"If `after` and `position` are provided in the request, `position` is ignored."
A 404 also covers the case where the field "can't be moved to the requested position".
There is no "move to tab X" operation. To move a field to another tab, remove it from one tab and add it to the other.

---

## 2. Screen schemes

### Get / filter
`GET /rest/api/3/screenscheme`

Params: `startAt` (default 0), `maxResults` (default **25**), `id` (repeat), `queryString` (case-insensitive partial match on name), `orderBy` (`name`/`id` ±), `expand=issueTypeScreenSchemes`.

Response is a page of `{ id:int, name, description, screens: { default, create?, edit?, view? }, issueTypeScreenSchemes? }`. Screen IDs in `screens` are integers. Only classic-project schemes are returned.

### Create
`POST /rest/api/3/screenscheme`
```json
{ "name": "unique ≤255", "description": "…",
  "screens": { "default": 10017, "create": 10018, "edit": 10019, "view": 10020 } }
```
`screens.default` is required. Values are integers. Returns 201 `{ "id": 10010 }`.

### Update (CRUCIAL: removing an assignment)
`PUT /rest/api/3/screenscheme/{screenSchemeId}` returns 204. All top-level keys are optional.
```json
{ "name": "…", "description": "…",
  "screens": { "default": "10018", "create": "10019", "edit": null, "view": null } }
```
Spec field descriptions (`UpdateScreenTypes`; values are **strings** here, unlike create):
- `create` / `edit` / `view`: "The ID of the … screen. **To remove the screen association, pass a null.**"
- `default`: "When specified, must include a screen ID as a default screen is required."

So pass **JSON `null`** to make an operation fall back to the default screen. Omitting a key should leave it unchanged. That is implied by the spec but **UNVERIFIED**. An empty string is not documented, so don't use it.

### Delete
`DELETE /rest/api/3/screenscheme/{screenSchemeId}` returns 204. It returns 400 if the scheme is used in an issue type screen scheme.

---

## 3. Issue type screen schemes (ITSS)

All under `/rest/api/3/issuetypescreenscheme`. IDs are strings in bodies and responses.

| Op | Method + path | Params / body | Response |
|---|---|---|---|
| List | `GET /issuetypescreenscheme` | `startAt`, `maxResults` (50), `id` (repeat), `queryString` (case-insensitive partial), `orderBy` (default `id`), `expand=projects` | page of `{id, name, description}` |
| **ITSS for projects** | `GET /issuetypescreenscheme/project?projectId=10000&projectId=…` | `projectId`* (repeat), `startAt`, `maxResults` (50) | page of `{ issueTypeScreenScheme: {id,name,description}, projectIds: string[] }` |
| **Mappings** | `GET /issuetypescreenscheme/mapping?issueTypeScreenSchemeId=…` | `issueTypeScreenSchemeId` (int, repeat), `startAt`, `maxResults` (50). There is **no** issue-type filter, so filter client-side and page until `isLast`. | page of `{ issueTypeScreenSchemeId, issueTypeId: "10001" or "default", screenSchemeId }` |
| Create | `POST /issuetypescreenscheme` | `{ name*, description, issueTypeMappings*: [{issueTypeId:"default", screenSchemeId:"10001"}, {issueTypeId:"10002", screenSchemeId:"10002"}] }`. The `default` entry is required. | 201 `{ id }` |
| Rename | `PUT /issuetypescreenscheme/{id}` | `{ name?, description? }` | 204 |
| Delete | `DELETE /issuetypescreenscheme/{id}` | – | 204 |
| **Append mappings** | `PUT /issuetypescreenscheme/{id}/mapping` | `{ issueTypeMappings*: [{ issueTypeId, screenSchemeId }] }`. A `default` entry is **not** allowed here. | 204 |
| **Remove mappings** | `POST /issuetypescreenscheme/{id}/mapping/remove` | `{ issueTypeIds*: ["10000","10001"] }` | 204 |
| **Update default** | `PUT /issuetypescreenscheme/{id}/mapping/default` | `{ screenSchemeId*: "10010" }` | 204 |
| Projects using ITSS | `GET /issuetypescreenscheme/{id}/project` | `startAt`, `maxResults` (50), `query` (undocumented) | page of `ProjectDetails {id, key, name, projectTypeKey, simplified, avatarUrls, …}` (company-managed only) |
| **Assign to project** | `PUT /issuetypescreenscheme/project` | `{ issueTypeScreenSchemeId: "10001", projectId: "10002" }` | 204 (classic projects only) |

There is no dedicated "update one mapping" endpoint. Whether append overwrites an existing issue-type mapping or returns 400 is **UNVERIFIED**. The safe pattern is `mapping/remove` for that issue type, then `PUT …/mapping`. Note this is non-atomic, so on failure re-append the old mapping.

Typical copy-on-write flow when the ITSS is shared:
1. `GET /issuetypescreenscheme/{id}/project` returns more than one project, so the scheme is shared.
2. `POST /issuetypescreenscheme` with a cloned mapping set.
3. `PUT /issuetypescreenscheme/project` to assign the clone.

---

## 4. Workflows and transition screens (new workflow APIs)

### Read workflows + transitions
`POST /rest/api/3/workflows` (bulk get). It has no query params in the current spec.
```json
{ "workflowIds": [], "workflowNames": ["Workflow 1"],
  "projectAndIssueTypes": [{ "projectId": "10000", "issueTypeId": "10001" }] }
```
Response: `{ workflows: JiraWorkflow[], statuses: JiraWorkflowStatus[] }`.

`GET /rest/api/3/workflows/search` paginates. Params:
- `startAt`, `maxResults`
- `expand=values.transitions` (needed to get transitions)
- `queryString` (case-insensitive partial match on name)
- `orderBy` (`name`/`created`/`updated`)
- `scope` (`GLOBAL` = company-managed, `PROJECT` = team-managed)
- **`isActive`** (bool: `false` gives inactive workflows)
- `projectId` (int: workflows associated with that project)

Response: `{ startAt, maxResults, total, isLast, nextPage, values: JiraWorkflow[], statuses: [] }`.

Relevant `JiraWorkflow` fields:
```
id, name, description, isEditable, scope{type:"GLOBAL"|"PROJECT", project?{id}},
version{ id: uuid, versionNumber: int },  created, updated, taskId?,
statuses[]{ statusReference, layout{x,y}, properties, deprecated, approvalConfiguration? },
transitions[]{ id, name, description, type:"INITIAL"|"GLOBAL"|"DIRECTED",
  toStatusReference, links[]{fromStatusReference, fromPort, toPort},
  transitionScreen?: { id?, ruleKey, parameters: {...} },   // <-- the transition's screen
  actions[], validators[], conditions{operation, conditions[], conditionGroups[]},
  triggers[], properties{}, customIssueEventId? }
```
The transition screen field is **`transitionScreen`**, of type `WorkflowRuleConfiguration { id?, ruleKey*, parameters }`. The rule is documented in `GET /workflows/capabilities` as:
```json
{ "ruleKey": "system:transition-screen", "params": { "screenId": "3" } }
```
That doc example uses `params`, but the schema property is **`parameters`**, so send `{"ruleKey":"system:transition-screen","parameters":{"screenId":"10005"}}` (screenId is a string). Treat this as **UNVERIFIED** until you have seen a live read response.

How to *remove* a transition screen: omit `transitionScreen` or send `null`. **UNVERIFIED**, because the docs don't say which.

### Which schemes / projects use a workflow
These endpoints use cursor pagination (`nextPageToken`, `maxResults` 1-200, default 50) and need Administer Jira:
- `GET /rest/api/3/workflow/{workflowId}/workflowSchemes` returns `{ workflowId, workflowSchemes: { values: [{id}], nextPageToken } }`
- `GET /rest/api/3/workflow/{workflowId}/projectUsages` returns `{ workflowId, projects: { values: [{id}], nextPageToken } }`
- `GET /rest/api/3/workflow/{workflowId}/project/{projectId}/issueTypeUsages` returns `{ issueTypes: { values: [{id}], nextPageToken } }`
- `GET /rest/api/3/workflowscheme/{workflowSchemeId}/projectUsages` lists the projects using a scheme
- `POST /rest/api/3/workflowscheme/read` with `{ "projectIds": ["10047"], "workflowSchemeIds": [] }` returns `[{ id, name, scope, version, defaultWorkflow{id,name,…}, workflowsForIssueTypes[{ issueTypeIds[], workflow{id,name,…} }] }]`. This is the **project → workflow per issue type** lookup.
- `GET /rest/api/3/workflowscheme/project?projectId=…` (legacy shape) returns no ID when the project uses the Default Workflow Scheme.
- Shortcut: `POST /workflows` with `projectAndIssueTypes` gives the workflow for each project/issue type directly.

Inactive workflows: use `GET /workflows/search?isActive=false`.

Drafts: the new APIs expose **no draft concept**. The legacy `GET /rest/api/3/workflow/search` (with `expand=hasDraftWorkflow,schemes,projects`) was deprecated, "will be removed on June 1, 2026", so assume it is gone. The `draft` flag in `/workflow/rule/config` is removed on 2026-11-02. Treat drafts as unsupported. Screen delete can still fail because of a "workflow draft" (§1).

### Update a transition's screen
`POST /rest/api/3/workflows/update` sends the **whole workflow** (`id`, `version`, `statuses`, `transitions` are required per workflow).
```json
{
  "statuses": [ /* WorkflowStatusUpdate {id?, name*, statusCategory*, statusReference*, description} for every status the workflow uses (copy from read response) */ ],
  "workflows": [{
    "id": "<workflow id>",
    "version": { "id": "<version.id from read>", "versionNumber": 7 },
    "description": "…",
    "startPointLayout": {…}, "loopedTransitionContainerLayout": {…},
    "statuses":    [ /* {statusReference*, properties*, layout, approvalConfiguration?} — copy */ ],
    "transitions": [ /* copy every transition; on the target one set: */
      { "id": "21", "name": "Resolve", "type": "DIRECTED", "toStatusReference": "…",
        "links": [...], "actions": [...], "validators": [...], "conditions": {...},
        "triggers": [...], "properties": {...},
        "transitionScreen": { "ruleKey": "system:transition-screen", "parameters": { "screenId": "10005" } } }
    ]
  }]
}
```
- Response: `{ workflows: JiraWorkflow[], statuses: [], taskId? }`. If `taskId` is set, poll `GET /rest/api/3/task/{taskId}`. Status migrations on active workflows run async.
- Version handling: pass the `version` object exactly as read. It is an optimistic lock, so re-read and retry on conflict. The exact error code is **UNVERIFIED**.
- Before writing, validate with `POST /rest/api/3/workflows/update/validation`: `{ "payload": <same body>, "validationOptions": { "levels": ["WARNING","ERROR"] } }` returns `WorkflowValidationErrorList`.
- Permissions per spec: "Administer Jira" for all (incl. global/company-managed) workflows. *Administer projects* only covers project-scoped (team-managed) workflows.
- Shared workflows: changing one changes every project and scheme using it. Check `projectUsages` first and copy-on-write if it is shared (`POST /rest/api/3/workflows/create`). That endpoint isn't detailed here, so read its spec before use.

### Project-scoped workflow editing by project admins
Company-managed permission schemes have project permissions **`EDIT_WORKFLOW`** ("Edit workflows") and `VIEW_READONLY_WORKFLOW`. They are listed in the spec's permission keys under "Administration permissions" next to `ADMINISTER_PROJECTS` and `EDIT_ISSUE_LAYOUT`.

The Atlassian KB ("Use the Edit Workflows permission in company-managed projects") says the permission "allows non-admins to edit workflows that are **not shared** with any other projects". It also needs Browse projects.

The REST docs for `/workflows/update` do **not** mention `EDIT_WORKFLOW`. Whether a user with it can call the API as themselves is **UNVERIFIED**. Our app calls asApp, so you can mirror this rule:

> allow the transition-screen edit if the user has ADMINISTER_PROJECTS (or EDIT_WORKFLOW) **and** the workflow is used by this project only.

---

## 5. Field schemes (new model; public but EXPERIMENTAL)

They are public in the v3 spec under `/rest/api/3/config/fieldschemes`. Every operation is flagged `x-experimental`. All need Administer Jira and `manage:jira-configuration`. Every one documents **"404 Returned if the feature flag is disabled."**

The legacy `/rest/api/3/fieldconfiguration*` and `/fieldconfigurationscheme*` endpoints are all marked `deprecated: true` with "Deprecated, use Field schemes". No removal date is given in the spec.

| Op | Method + path | Params / body | Response |
|---|---|---|---|
| List schemes | `GET /config/fieldschemes` | `projectId` (int[], repeat), `query` (case-insensitive name/description), `startAt`, `maxResults` (50, max 100) | page of `{ id:int, name, description, isDefault, fieldsCount, links{associations, projects}, matchedFilters? }` |
| Get one | `GET /config/fieldschemes/{id}` | – | `{ id, name, description, isDefault, fieldsCount, links }` |
| Create | `POST /config/fieldschemes` | `{ name*, description }`. Starts with a minimal default field set, not a copy. | `{ id, name, description, links }` |
| Clone | `POST /config/fieldschemes/{id}/clone` | `{ name*, description }` | same as create |
| Update | `PUT /config/fieldschemes/{id}` | `{ name?, description? }` | 200 |
| Delete | `DELETE /config/fieldschemes/{id}` | – | `{ id, deleted }` |
| **Projects of a scheme** | `GET /config/fieldschemes/{id}/projects` | `projectId` (filter, repeat), `startAt`, `maxResults` (≤100) | page of `{ id, key, name, avatarUrls, deleted }` |
| **Scheme of a project** | `GET /config/fieldschemes/projects?projectId=10000` | `projectId`* (repeat), paging | page of `{ projectId, schemeId }` ("temporary API … when transitioning from the legacy field configuration APIs") |
| Assign projects | `PUT /config/fieldschemes/projects` | `{ "<schemeId>": { "projectIds": [10000] } }` | 200 / 204 / **207** partial `{results[{projectId, schemeId, success, error}]}` |
| **Is field in scheme?** | `GET /config/fieldschemes/{id}/fields?fieldId=customfield_10010` | `fieldId` (repeat), paging. An empty `values` means it is not in the scheme. | page of `{ fieldId, restrictedToWorkTypes[], parameters{description,isRequired,rendererType}, workTypeParameters[], allowedOperations[] }` |
| **Add field to scheme(s)** | `PUT /config/fieldschemes/fields` | `{ "customfield_10010": [{ "schemeIds": [10000], "restrictedToWorkTypes": [10001] }] }`. Omitting `restrictedToWorkTypes` means all work types. Max 100 fields per request and 50 schemes per item. | 200/204/**207** `{results[{fieldId, schemeId, workTypeIds, success, error}]}` |
| Remove field | `DELETE /config/fieldschemes/fields` (with body) | `{ "customfield_10010": { "schemeIds": [10000] } }` | 200/204/207 |
| Field params | `GET /config/fieldschemes/{id}/fields/{fieldId}/parameters`; `PUT` / `DELETE /config/fieldschemes/fields/parameters` | required / description / renderer per work type | – |

Always check for **207** and inspect `results[].success`.

**Detecting legacy vs new model** (official docs give no explicit flag, so this is derived from the spec):
1. `GET /rest/api/3/config/fieldschemes?maxResults=1`. A **404** ("feature flag is disabled") means the site still uses legacy field configurations.
2. Otherwise `GET /config/fieldschemes/projects?projectId=<id>` gives the project's `schemeId`.

Atlassian says the rollout is progressive (2026) and there is no official per-site detection endpoint. Treat the 404 heuristic as **UNVERIFIED** in practice.

Why it matters: adding a field to a screen does not make it usable if the field isn't in the project's field scheme. Check with `/fields?fieldId=` and offer `PUT /config/fieldschemes/fields`.

---

## 6. Permissions and project type

### Check the caller (as the user)
`GET /rest/api/3/mypermissions?projectKey=ABC&permissions=ADMINISTER_PROJECTS,ADMINISTER`
- `permissions` is required (comma-separated). `projectId` wins over `projectKey`.
- Response: `{ permissions: { ADMINISTER_PROJECTS: { id, key, name, type:"PROJECT", description, havePermission: true }, ADMINISTER: { …, type:"GLOBAL", havePermission } } }`
- 404 if the project isn't found or the user can't see it.
- Other useful keys: `EDIT_WORKFLOW`, `BROWSE_PROJECTS`.

```js
import api, { route } from '@forge/api';
// inside a resolver (user-initiated) — asUser is evaluated as the caller
const res = await api.asUser().requestJira(
  route`/rest/api/3/mypermissions?projectId=${projectId}&permissions=ADMINISTER_PROJECTS,ADMINISTER`,
  { headers: { Accept: 'application/json' } });
const { permissions } = await res.json();
const allowed = permissions.ADMINISTER_PROJECTS?.havePermission || permissions.ADMINISTER?.havePermission;
```
- `asUser()` calls Jira "as the user of the app". It needs the user to have granted the app access. Otherwise the call throws and, if uncaught, the UI prompts for consent.
- Docs: `asUser()` "is only available in modules that support the UI kit". The project settings page, admin page and their resolvers qualify.
- **Not available** in `scheduledTrigger` (no user principal). Use `asApp()` there.
- `asApp()` under the app identity would return the *app's* permissions. Never use it for this check.

Alternatives:
- Forge `authorize()` from `@forge/api` evaluates the current user and is meant for "verify user permissions before making requests using the asApp method":
  ```js
  import { authorize } from '@forge/api';
  const r = await authorize().onJira([{ permissions: ['ADMINISTER_PROJECTS'], projects: [projectId] }]);
  ```
  The exact return shape and support for admin keys are **UNVERIFIED**.
- `POST /rest/api/3/permissions/check` with `{ accountId, globalPermissions:["ADMINISTER"], projectPermissions:[{permissions:["ADMINISTER_PROJECTS"], projects:[10000]}] }` returns `{ globalPermissions:[], projectPermissions:[{permission, projects:[], issues:[]}] }`. It can check *another* user (e.g. `context.accountId` from a scheduled job or Rovo action) when called asApp, but that needs Administer Jira for the caller.

### Project type (company-managed vs team-managed)
`GET /rest/api/3/project/{projectIdOrKey}` returns:
- `style`: `"classic"` (company-managed) or `"next-gen"` (team-managed)
- `simplified`: boolean, `true` = team-managed
- `projectTypeKey`: `software` | `service_desk` | `business` | `product_discovery`

Gate the app on `style === 'classic'` (or `simplified === false`).

---

## 7. Forge manifest, resolver, bridge, storage

```yaml
app:
  id: ari:cloud:ecosystem::app/<filled by forge register>
  runtime:
    name: nodejs24.x            # allowed: nodejs24.x (recommended), nodejs22.x, nodejs20.x
permissions:
  scopes:
    - read:jira-work            # mypermissions, project
    - manage:jira-project       # screens, tabs, tab fields, screen scheme GET/DELETE
    - manage:jira-configuration # screen scheme POST/PUT, ITSS, workflows, field schemes
    - storage:app               # @forge/kvs
modules:
  jira:projectSettingsPage:
    - key: sss-project-settings
      resource: main
      resolver:
        function: resolver
      title: Screen Self-Service
      layout: native              # Custom UI: native | blank | basic(deprecated)
      # displayConditions: {...}  # optional
  jira:adminPage:
    - key: sss-admin
      resource: main
      resolver:
        function: resolver
      title: Screen Self-Service (admin)
      # useAsConfig: true  -> "Configure" button in Manage apps (no sidebar entry)
  scheduledTrigger:
    - key: sss-nightly
      function: nightly
      interval: day               # fiveMinute | hour | day | week
  function:
    - key: resolver
      handler: index.handler
    - key: nightly
      handler: index.nightly
      timeoutSeconds: 900         # scheduled/async max 900
resources:
  - key: main                     # ≤23 chars
    path: static/main/build       # dir with index.html
    tunnel:
      port: 3000                  # forge tunnel proxies Custom UI to local dev server
```
- `render: native` is only for UI Kit. Omit it for Custom UI.
- `jira:projectSettingsPage` extension context: `extension.type`, `extension.project.id`, `extension.project.key`, `extension.project.type`, `location`. The docs **don't state** who can see the page or whether it shows for team-managed projects (**UNVERIFIED**; enforce it yourself).
- `jira:adminPage` context: `type`, `location`. Visibility restricted to Jira admins is **UNVERIFIED** in the docs.
- Scheduled trigger: the handler is `({ context }) => {}`. The return value is ignored, errors are not retried, there is no user context, duplicates are possible, and it starts about 5 min after deploy. Max 5 triggers per app.

### Resolver (backend)
```js
import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
const resolver = new Resolver();
resolver.define('getScreens', async ({ payload, context }) => {
  const accountId = context.accountId;
  const projectId = context.extension?.project?.id;   // trust THIS, not payload.projectId
  // 1) authz via asUser mypermissions (§6)  2) do work via asApp
  const r = await api.asApp().requestJira(route`/rest/api/3/screens?queryString=${payload.q}&scope=GLOBAL`);
  return r.json();
});
export const handler = resolver.getDefinitions();
```
- `context` fields: `accountId`, `accountType`, `cloudId`, `localId`, `environmentId`, `environmentType`, `installContext`, `installation`, `license`, and `extension` (module-specific, carries `project`).
- App-context-security doc: resolver context parameters are "guaranteed to be secure, unalterable, and valid to be used for authorization".
- Client-side `view.getContext()` "is able to be modified in the browser and is not guaranteed to be secure". `payload` is client-controlled.
- Always build paths with the `route` tag. It encodes interpolations and blocks path traversal.

### Bridge (Custom UI frontend)
```js
import { invoke, view } from '@forge/bridge';
const ctx = await view.getContext();   // { accountId, cloudId, siteUrl, extension:{project:{id,key,type}}, localId, moduleKey, locale, timezone, theme }
const data = await invoke('getScreens', { q: 'bug' }); // display only — never use ctx for authz
```

### Storage: use `@forge/kvs`
`@forge/api`'s `storage` is "legacy". The migration guide says feature updates stopped 2025-03-17. Community reports point to a removal notice (CHANGE-3252, June 2026; not confirmed on the changelog page).
```js
import { kvs, WhereConditions } from '@forge/kvs';
await kvs.set('audit#ABC#2026-10-29T10:00Z', { by: accountId, op: 'moveField' });
await kvs.get('key');  await kvs.delete('key');
const { results, nextCursor } = await kvs.query()
  .where('key', WhereConditions.beginsWith('audit#ABC#')).limit(50).getMany();
```
Values can be any JSON type except `null`. Secrets go in `kvs.setSecret`. Size limits are on the platform quotas page (not copied here).

---

## 8. Rovo agent + actions

```yaml
modules:
  rovo:agent:
    - key: sss-agent
      name: Screen Self-Service        # ≤30 chars
      description: Helps project admins manage screens
      prompt: resource:agent-res;prompts/agent.txt   # or inline string (resource path needs CLI ≥10.6.0)
      conversationStarters:
        - Which fields are on the Bug create screen?
        - Add Story Points to the edit screen
      actions:
        - sss-list-screen-fields
        - sss-add-field
      # followUpPrompt: …   skills: [...] (preview)
  action:
    - key: sss-add-field
      name: Add field to screen
      function: rovoAddField
      actionVerb: UPDATE               # GET | CREATE | UPDATE | DELETE | TRIGGER
      description: Adds a field to a screen tab of the current project
      inputs:
        screenId:
          title: Screen ID
          type: string                 # string | integer | number | boolean
          required: true
          description: The screen to modify
        fieldId:
          title: Field ID
          type: string
          required: true
          description: e.g. customfield_10016
  function:
    - key: rovoAddField
      handler: index.rovoAddField
resources:
  - key: agent-res
    path: resource/agent
```
- The handler is `export async function rovoAddField(payload, context)`.
- `payload` holds the inputs as top-level keys plus `payload.context = { cloudId, moduleKey, jira: { url, resourceType, issueKey, issueId, issueType, issueTypeId, projectKey, projectId } }`. The `jira` block is only present when invoked in a Jira context (e.g. from an issue).
- Docs: inputs are "subject to hallucination" and an app "should never rely on values passed as inputs to perform critical checks like authorization". They also say "If you need a user's `accountId` read it from the `context`". That is the second argument; the exact property path is **UNVERIFIED** (likely `context.principal.accountId` or `context.accountId`).
- The project may be absent (e.g. chat outside a project). Require an explicit project key input, then re-check permissions with `asUser` mypermissions or with `permissions/check` + accountId. Whether `asUser()` works inside action functions is **UNVERIFIED**.
- Confirmation: official docs **do not** describe a confirmation dialog. Community posts say non-GET verbs show a "Confirm" step (**UNVERIFIED**).
- Documented rule: agents triggered by automation rules will not invoke CREATE/UPDATE/DELETE/TRIGGER actions.
- Action payload limit is 5 MB.

---

## 9. Forge CLI

**Node constraint (blocking).** Forge CLI changelog, 26 Oct 2026: "The Forge CLI now requires Node.js 22.23.4, 24.22.1, 26.12.1 or newer". Node 20 is unsupported.

Our **Node 24.18 is below 24.22.1**, so upgrade Node before installing or using the CLI. The deployed runtime is chosen separately via `app.runtime.name: nodejs24.x`.

```bash
npm install -g @forge/cli
forge --version

forge login
#   The human does this. Prompts for Atlassian email + API token.
#   Create the token at https://id.atlassian.com/manage-profile/security/api-tokens
#   via "Create API token with scopes", app = Forge. Don't use sudo.

forge register "Screen Self-Service"
#   Rewrites app.id in manifest.yml.
#   Re-running issues a NEW id and disconnects envs, variables and storage.
#   Options: --developer-space-id <id>, -y/--accept-terms, --personal

forge deploy -e development
#   Options: --non-interactive, -f/--no-verify

forge install --site <site>.atlassian.net --product Jira -e development
#   Short flags: -s / -p / -e

forge install --upgrade -e development --site <site>.atlassian.net --product Jira
#   Required after scope/module changes. --upgrade code = code only.
#   --confirm-scopes skips the scope prompt. forge install list shows installs.

forge tunnel -e development
#   Hot reload + logs. No Docker needed (Cloudflare tunnel, CLI ≥10.1).
#   Custom UI uses resources[].tunnel.port.
#   Manifest changes still need forge deploy (+ install --upgrade if scopes/modules changed).
```

---

## Sources
- Jira v3 OpenAPI spec: https://dac-static.atlassian.com/cloud/jira/platform/swagger-v3.v3.json (REST groups: screens, screen-tabs, screen-tab-fields, screen-schemes, issue-type-screen-schemes, workflows, workflow-schemes, field-schemes, permissions, projects)
- https://developer.atlassian.com/platform/forge/manifest-reference/modules/jira-project-settings-page/
- https://developer.atlassian.com/platform/forge/manifest-reference/modules/jira-admin-page/
- https://developer.atlassian.com/platform/forge/manifest-reference/modules/scheduled-trigger/
- https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-agent/
- https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-action/
- https://developer.atlassian.com/platform/forge/manifest-reference/ and /resources/
- https://developer.atlassian.com/platform/forge/runtime-reference/forge-resolver/
- https://developer.atlassian.com/platform/forge/app-context-security/
- https://developer.atlassian.com/platform/forge/apis-reference/fetch-api-product.requestjira/
- https://developer.atlassian.com/platform/forge/runtime-reference/authorize-api/
- https://developer.atlassian.com/platform/forge/apis-reference/ui-api-bridge/invoke/ and /view/
- https://developer.atlassian.com/platform/forge/storage-reference/kvs/ and /kvs-api/, /kvs-migration-from-legacy/
- https://developer.atlassian.com/platform/forge/getting-started/, /changelog/, /cli-reference/{install,register,deploy,tunnel}/, /tunneling/
- https://developer.atlassian.com/cloud/jira/platform/scopes-for-oauth-2-3LO-and-forge-apps/
- https://support.atlassian.com/jira/kb/use-the-edit-workflows-permission-in-company-managed-projects-in-jira-cloud
- Community (non-official, used only for items marked UNVERIFIED): Rovo actionVerb confirm thread (community.developer.atlassian.com/t/whats-the-impact-of-actionverb-in-rovo-action/86069); legacy storage retirement thread (…/102951); asApp admin 403 thread (…/92463)
