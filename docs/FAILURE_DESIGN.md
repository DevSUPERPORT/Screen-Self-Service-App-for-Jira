# Failure design — no half-changed projects

Jira's REST API has no transactions. A split is 4–10 separate calls; any of them can fail (validation, rate
limit, network, a concurrent change). The app guarantees that a failed change leaves Jira exactly as it was.

## 1. Plan → order → execute → compensate

1. **Plan** (`src/shared/domain.ts`): pure, deterministic, identical in browser and backend.
2. **Order** (`executionOrder`): renames of existing objects first (frees names — Jira names are unique), then
   creates with their final names, then rewiring (schemes, mappings, transitions), deletes last.
3. **Execute** (`src/backend/executor.ts`): after each successful step its inverse is pushed on a stack.
4. **Compensate**: on any failure the inverses run in reverse order; result and anything that could not be
   undone are written to the audit log and returned to the user.

| Step | Inverse |
|---|---|
| rename screen / screen scheme | rename back |
| create screen (incl. copied tabs/fields) | delete the screen |
| create screen scheme | delete the scheme |
| update screen scheme assignments | restore previous assignments (explicit `null` = inherits) |
| map issue type (remove + append) | restore previous mapping; **a failed append inside the step restores immediately** |
| set transition screen | restore previous transition screen (read from the workflow during the step) |
| delete | none — deletes are only planned alone (UC-08) and run last |

Found by the failure-injection tests: the mapping step originally had no inverse for its own first write —
a failing append after a successful remove lost the issue type's mapping. Fixed by self-restoring steps.

## 2. Editor saves

`applyLayout` diffs desired vs. live tabs. On failure it re-applies the original layout (recreating any tab removed
on the way) and removes fields it had added to the field scheme.

## 2a. Undo

Undo records live in KVS per user and project (24 h). Plan undos are the executor's own inverse steps, checked
against fresh Jira state first (stale → refused, nothing written) and run through the same compensating
executor. Layout undos check each screen's digest first (all or nothing). Deletion undos re-create the deleted
objects from a pre-delete snapshot: name conflicts are refused up front, and a failure part-way deletes
everything re-created so far (`tests/features.test.ts` injects a failure at every write position).

## 3. Concurrency

| Situation | Behaviour |
|---|---|
| Jira changed between preview and confirm | plan digest differs → `conflict`, UI reloads, user re-confirms |
| Someone changed an assignment the user did **not** touch | steps carry the observed "before" values → digest differs → `conflict` (no lost update); the drawer keeps the user's edits and adopts the new values for untouched operations |
| Stale cache on the backend | every write path drops the instance cache and plans on a fresh Jira read |
| Native issue-layout editor changed the screen meanwhile | layout base digest differs → `conflict`, nothing written |
| Workflow version changed meanwhile | `workflows/update` version check fails → step fails → full rollback |

## 4. Retries

- `429`: retried for every method (request not processed), honouring `Retry-After`.
- `502–504`: retried only for idempotent methods (GET, PUT, DELETE). POSTs are never blindly retried
  (they create objects).
- Exponential backoff with jitter, max 3 retries.

## 5. Tolerated, reported

Copying a screen continues if a single field can't be placed on the new screen (e.g. app-locked fields). The
user gets a warning toast listing them and the audit entry names them.

## Evidence

Verified live on a SUPERPORT test site (29 Oct 2026): a concurrent REST change to an untouched operation made the app refuse the save; an independent REST diff showed only the concurrent change in Jira.


`tests/integration.test.ts` injects a failure at **every** write position of generated scenarios (assign, copy,
split, merge, transitions) and asserts Jira's raw state equals the initial state afterwards. Same for editor saves.
