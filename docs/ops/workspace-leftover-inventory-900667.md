# Leftover Example inventory (obj 900667)

Follow-up to consolidation card #900206 / PR #641 (merged 2026-11-05 20:51Z,
`dce41201`). Written **before** any host mutation, as the card requires. Nothing
on the live install was changed by this objective.

## 1. What PR #641 actually shipped

| Shipped | Where |
|---|---|
| `workspace-merge` service: PRAGMA-introspected slug sweep in one transaction, card recount gate, source archived (never deleted), memberships unioned, secrets conflicts left on source | `app/server/src/services/workspace-merge.ts` |
| Vault fold, copy-then-verify, source only renamed to `_archived-<slug>/` | `app/server/src/services/workspace-vault-move.ts` |
| Operator CLI, dry-run by default, `--apply` gated on a verified DB snapshot + vault tar | `app/server/src/scripts/workspace-merge.ts` |
| `workspaces/example` path consumers (contacts index, `internal-vault` contact dirs, 3 cron scripts) made to accept **both** slugs | `services/contacts.ts`, `routes/internal-vault.ts`, `scripts/*.sh` |
| Runbook | `docs/ops/workspace-merge.md` |

PR #641 explicitly did **not** run anything against production ("The live cutover
is Operator's call").

## 2. State of the live install (read on 2026-11-12)

- `GET /api/health` → `commit: 8dda286baf38`. That SHA is not in
  `your-org/operationkit`; it is `m1keluka/OperationKit`
  "chore: sync from upstream (gated) (#82)". That tree **does** contain
  `services/workspace-merge.ts` (15,531 bytes), so PR #641's tool is on the box.
  It does **not** contain the archived-org filter in `routes/projects.ts`.
- **The merge has not been applied.** This session's server-assembled header lists
  the acting admin's memberships as `example, your-org, operationkit`. A real
  `applyMerge` deletes every `user_workspaces` row on the source slug, so an
  `example` membership is direct evidence that the cutover has not been run.
- This card session is scoped to `operationkit` and gets **403
  `workspace_forbidden`** from `/api/internal/objectives?workspace=example` (and
  `your-org`), so it cannot count live `example` rows. The exact live counts come
  from the read-only command in §5. The last full count is #900206's rehearsal
  against a snapshot of the live board: **example = 8,703 cards, your-org = 16,
  operationkit = 403**.

## 3. Why the project selector still shows old Example projects

The board's **Project** picker (`ProjectFilterBar`, fed by `useProjects` →
`GET /api/projects`) has three independent leaks. PR #641 closed none of them:

1. **`GET /api/projects` never looked at the org's `archived` flag.**
   `GET /api/workspaces` hides archived orgs (`listWorkspaces()`), but the
   cross-org project list added in obj 900197 returned every project in every
   workspace for an admin. So even after a clean merge, any project left on the
   archived `example` row stays as a chip in the All-Organizations view.
2. **Same-named projects cannot move.** `projects` has
   `UNIQUE(workspace, name)`. The generic sweep is `UPDATE OR IGNORE`, so an
   `example` project whose name `your-org` already uses stays on `example` — and
   every card filed under it moves to `your-org` while its `project_id` still
   points into the retired org. Those cards then sit under a project the
   `your-org` picker can't show.
3. **Writes keep re-creating `example` data after the merge.** Every create path
   had a hard-coded `|| 'example'` fallback, and routine templates store
   `"workspace": "example"` inside JSON (`routines.objective_template`), which no
   column sweep sees. After a cutover, the next routine fire or workspace-less
   API create files a fresh card into the archived org.

## 4. Leftover reference inventory (code)

### Fixed in this PR

| Reference | Kind | Fix |
|---|---|---|
| `routes/projects.ts` GET | selector leak (§3.1) | hides projects of archived orgs unless `include_archived=1` |
| `routes/projects.ts` POST | new projects in a retired org | 409 + `merged_into` |
| `projects` UNIQUE(workspace,name) | stuck projects (§3.2) | merge **folds** same-named projects: repoints cards to the target's project, **archives** (never deletes) the source; the undo list (card ids) goes in the conflict log; a post-merge invariant (`0` target cards pointing at a source project) rolls back otherwise |
| `routines.objective_template` `$.workspace` | JSON-embedded slug (§3.3) | re-pointed by `json_set` inside the merge transaction |
| `routes/objectives-crud.ts` POST `|| 'example'` | write fallback | `resolveWriteWorkspace()` |
| `routes/internal-create.ts` ×6 `item.workspace || 'example'` | write fallback | `resolveWriteWorkspace()` |
| `services/routine-scheduler.ts` ×3 | write fallback | `resolveWriteWorkspace()` |
| `routes/internal-progress.ts`, `routes/internal-preview.ts`, `routes/admin-jobs.ts` | write/display fallback | `resolveWriteWorkspace()` |
| `services/external-remediation-act.ts` `'example-platform': 'example'` | CI-failure cards for example-platform filed into `example` | `workspaceForRepo()` follows `merged_into` |
| `routes/feed.ts` ×4 | read default + activity insert | `defaultWorkspaceSlug()` / `resolveWriteWorkspace()` |
| no record of where `example` went | — | new nullable `workspaces.merged_into` column; `applyMerge` sets it, `--unarchive` clears it; `canonicalWorkspaceSlug()` follows it |
| `objective.workspace || 'example'` in `prompt-builder.ts`, `prompt-builder-blocks.ts` ×2, `kb-access-prompt.ts`, `session-trust-prompt.ts`, `session-spawn-env.ts` | session workspace for prompt, KB scope and spawn env (review round 2) | `resolveWriteWorkspace(objective.workspace)` |
| `objective.workspace || 'example'` in `secret-requests.ts`, `chat-secret-capture.ts`, `routes/objective-needs-secret.ts` | secret-store scope for requested / pasted secrets (review round 2) | `resolveWriteWorkspace(objective.workspace)` — a secret saved from a pre-merge card lands in `your-org` |
| `row.workspace ?? 'example'` in `session-telemetry.ts`; `objective.workspace || 'example'` in `session-followup.ts` | `activity_log` inserts | `resolveWriteWorkspace()` |
| `lib/objective-ownership.ts` `(ws || 'example') !== (child || 'example')` | parent→child ownership inheritance | both sides through `resolveWorkspaceIn(db, …)`, so a pre-merge parent and a post-merge child still match |
| `db/schema/mentor.ts` `ASSISTANT_OWNER_WORKSPACE || 'example'` | assistant config seeded at boot | `resolveWorkspaceIn(db, …)` (uncached; runs during schema init) |
| `services/routine-auto-pause.ts` `return 'example'` | auto-pause activity row | template slug through `resolveWriteWorkspace`, else `defaultWorkspaceSlug()` |
| `services/ci-followup-cap.ts` `COALESCE(workspace, 'example')` | blocker activity row | `COALESCE(workspace, ?)` bound to `resolveWorkspaceIn(db, null)` |
| `middleware/agent-key-guard.ts` `allow.has('example')` | agent key creating a card with no workspace | checks `defaultWorkspaceSlug()`, which is what the create handler now defaults to |
| `db/schema/development.ts` example `workspace_repos` seed (`example`) | re-seeded on every boot by an existence check — after a merge it would re-create the row in `example` | slug through `canonicalWorkspaceSlugIn(db, …)` before the check and the insert |

`resolveWriteWorkspace(slug)` = the slug resolved through `merged_into` (or the
default when empty). **On an install that never ran a merge it is the identity
function**, so behaviour only changes once the cutover is applied.

### Deliberately left as-is (not a live reference)

Every remaining literal `'example'` in `app/server/src` and `app/client/src` (outside tests and comments) is in this table. A unit test (`workspaces-canonical.test.ts` → "no server source file falls back to the literal example workspace") scans `app/server/src` and fails on any new `|| 'example'`, `?? 'example'` or `COALESCE(…, 'example')`.


| Reference | Why it is safe |
|---|---|
| `DEFAULT 'example'` in `db/index.ts` (objectives), `db/schema/session.ts`, `db/schema/mentor.ts` | SQLite cannot change a column DEFAULT without a table rebuild, and every insert path names the workspace. |
| seed row `example` in `db/schema/workspaces.ts` | `INSERT OR IGNORE`: the archived tombstone already exists, so the seed is a no-op; deleting the row would cascade-delete memberships on the next boot (see #900206). |
| `granola_processed_meetings` CHECK(… 'example' …) | table-rebuild needed; the merge reports it `BLOCKED` and leaves those rows. Granola dedupe history only. |
| `services/contacts.ts`, `routes/internal-vault.ts`, cron scripts | already accept both slugs since PR #641. |
| `app/server/scripts/provision-scoped-doppler-tokens.ts` | one-off Doppler provisioning script; Doppler is retired (CLAUDE.md: "There is no `DOPPLER_TOKEN`"). Not run by the server. |
| `services/loops.ts` `LOOP_PROJECTS` | a label enum for the loops UI's org axis, not a workspace lookup; writes nothing to a workspace. |
| seed routines in `db/index.ts` (`workspace: 'example'` in 3 templates) | `INSERT OR IGNORE` on `routines.name UNIQUE`: on an existing install the rows already exist and the merge re-points their template; on a fresh install there is no merge. `routine-scheduler.ts` also resolves the template slug through `resolveWriteWorkspace()` at fire time. |
| `routes/meeting-queue.ts` `POST /seed` | admin-only demo seed for the granola tables, whose `CHECK` only allows the legacy slugs (see granola row). |
| `scripts/granola-ingest.ts` `: 'example'` | writes `granola_processed_meetings` / `granola_action_items`, whose `CHECK(workspace IN ('example', …))` rejects `your-org`; changing it needs the same table rebuild. Classification label only, not a board workspace. |
| `db/seed.ts` `{ workspace: 'example' }` | dev/bootstrap seed for an empty DB, run by hand. |
| `routes/internal-vault.ts` `case 'example'` | maps a contact to its vault folder; the pre-merge folder must stay readable until the vault fold runs. |
| `client/src/components/AgentsPage.fixture.ts` | test fixture. |

### Vault

The KB tree `workspaces/example/` is folded by the existing `--vault-root` path
(copy-then-verify; collisions land as `.from-example` files; source only renamed).
**No vault data is deleted** by anything in this PR.

## 5. Live leftover count — the read-only command

```bash
docker exec command-center tsx /app/server/src/scripts/workspace-merge.ts --inventory example
docker exec command-center tsx /app/server/src/scripts/workspace-merge.ts --inventory example --json
```

Prints: the `example` row (`archived`, `merged_into`), memberships, rows per slug
column, every `example` project with its card count, cards elsewhere still filed under
an `example` project, routine templates filing into `example`, and other registry rows
whose roots point into `workspaces/example`. `TOTAL leftover references` should read
`0` apart from the `BLOCKED` granola rows and any logged secret conflicts once the
cutover is done. (Needs this PR on the box: the `--inventory` flag is new.)

## 6. Reversible cutover (Operator runs this; nothing here was run)

See `docs/ops/workspace-merge.md` → "Finishing the Example migration (obj 900667)".
