# Data Security & Privacy answers: Screen Self-Service for Jira

Answers for the Marketplace listing's *Privacy & Security* tab and the Atlassian security questionnaire. Each answer is based on the
code in this repository (paths given), so it can be checked. Last reviewed 5 Nov 2026.

## Hosting and data flow

| Question | Answer |
|---|---|
| Where does the app run? | Entirely on Atlassian Forge (Atlassian-hosted compute and storage). **Runs on Atlassian**: the manifest declares no external egress and no remote backends. |
| Does the app send data outside Atlassian? | **No.** There are no `fetch` calls to external hosts, no analytics and no third-party services. The UI loads no CDN assets. |
| Does the app store data outside Atlassian? | **No.** Everything is in Forge hosted storage (KVS) of the customer's installation. |
| Data residency | Supported: Forge hosted storage follows the host product's data residency location. |
| Sub-processors | None besides Atlassian. |

## What data the app stores (Forge KVS, per installation)

| Data | Contents | Personal data? | Retention |
|---|---|---|---|
| Settings | Auto-deletion on/off and days, audit retention, allowed project keys, copy switch (`src/backend/storage.ts`) | No | Until changed or uninstalled |
| Audit log | Time, **Atlassian account ID** of the user who made the change, action, object name, before/after summary of the configuration (`AuditEntry` in `src/shared/types.ts`) | Account ID only. Display names are **not stored**; they're looked up when the log is read | Default **24 months**, configurable (12/24/36 months or never) by the Jira admin; older entries are deleted nightly |
| Undo records | Snapshot of the screens/schemes touched by the user's last change, keyed by project and account ID (`src/backend/undo.ts`) | Account ID in the key | **24 hours**, then deleted nightly |
| Created-objects registry | IDs of screens/schemes the app created and when they became unused (for automatic clean-up) | No | Until the object is deleted or the app is uninstalled |
| Privacy job marker | Time of the last personal-data report (`src/backend/privacy.ts`) | No | Overwritten weekly |

The app does **not** store issue content, issue data, attachments, comments, emails or user profile data.

## Personal data handling

| Question | Answer |
|---|---|
| Which personal data? | Atlassian account IDs of users who change screens through the app (audit log, undo records). |
| Personal Data Reporting API | **Implemented.** A scheduled job reports stored account IDs to Atlassian weekly. For closed accounts it replaces audit entries with "Former user" and deletes their undo records (`src/backend/privacy.ts`). |
| Can a customer delete data? | The Jira admin sets audit retention. Uninstalling the app deletes all of its data (see below). On request, SUPERPORT support can explain how to remove specific entries. |
| GDPR role | The customer is the controller; SUPERPORT doesn't receive the data. The app processes it only inside the customer's Atlassian site. |

## Security controls

| Control | Implementation |
|---|---|
| Authentication | Forge-signed context only; user identity and project are never taken from the request payload (`src/backend/auth.ts`). |
| Authorization (no privilege escalation) | Every resolver re-checks the caller's real Jira permissions with `POST /rest/api/3/permissions/check`: *Administer Projects* for project pages, *Administer Jira* for configuration. Rovo actions check the same way, and also refuse projects the user doesn't administer (verified live on 5 Nov 2026). |
| Changes limited to the user's project | Before every write, the app reloads Jira state and verifies that every screen, scheme and workflow it touches belongs to that project alone. Shared objects are refused. If any read fails or is truncated, the app writes nothing (fails closed). |
| Input validation | Strict intent schema; REST paths built with Forge `route` (encoded, no path traversal); errors to the UI carry no stack traces. |
| Deletion safety | Only objects the app created, and only when unused. Every deletion can be undone for 24 hours. |
| Licensing | When the Marketplace license isn't active, every resolver, Rovo action and the nightly job refuses (`requireActiveLicense`). |
| Kill switch | SUPERPORT can make the app read-only or unavailable via the Forge environment variable `APP_MAINTENANCE` during incidents. Customers see a notice and a link to the status page. |
| Encryption | In transit and at rest, provided by Atlassian Forge. |
| Dependencies | Only permissive licenses (MIT/ISC/BSD/Apache). Remaining `npm audit` findings are inside Atlassian's own dev tooling packages and are not in the shipped bundle. |
| Tests | 80 automated tests, including security (non-admins, other projects' admins, anonymous users, payload spoofing, hostile Rovo inputs: all refused with zero writes), rollback on failure, and performance. |

## Uninstall and data deletion

When the app is uninstalled, Atlassian soft-deletes its Forge hosted storage and deletes it permanently after the retention period
(currently 28 days; see Atlassian's [hosted storage data lifecycle](https://developer.atlassian.com/platform/forge/storage-reference/hosted-storage-data-lifecycle/)).
Within the first 21 days, a customer can ask Atlassian to recover it. The Jira configuration the app created (screens, schemes)
belongs to the customer's Jira and stays.

## Security contact and incidents

- Security reports: [mail@superport.digital](mailto:mail@superport.digital) (subject "Security"), see [SECURITY.md](../SECURITY.md)
- Status and incident communication: https://superapps.statuspage.io/
- Vendor: SUPERPORT P.C., Sorou 22, 151 25 Marousi (Athens), Greece · [App EULA & privacy policy](https://www.superport.digital/en/apps/eula)
- SUPERPORT notifies affected customers of a security incident without undue delay, and within 72 hours where GDPR applies.
