# Merging one workspace into another (`workspace-merge`)

Operator runbook for `app/server/src/scripts/workspace-merge.ts`. Written for
obj 900206 — folding **`example` into `your-org`** while leaving **`operationkit`**
alone — but the tool takes slugs, so it generalises.

> **The golden rule of this tool: it never deletes anything.** The source
> workspace row is *archived*, not dropped. The source vault tree is *renamed*,
> not removed. Rows that cannot move are *left where they are* and logged.
> Every run that mutates writes a restorable DB snapshot first.

---

## Why a tool and not a few `UPDATE`s

The workspace slug is denormalised across ~30 tables, and that set grows with
every migration. A hand-written statement list is wrong the moment someone adds
a table. `workspace-merge` therefore derives its targets by **PRAGMA
introspection** (`listWorkspaceColumns`), so a table added next month is swept
next month. Three live hazards it exists to handle:

1. **Deleting the source `workspaces` row destroys data on the NEXT BOOT.**
   `initWorkspacesSchema()` runs
   `DELETE FROM user_workspaces WHERE workspace NOT IN (SELECT slug FROM workspaces)`
   at startup, and `workspace_repos` / `workspace_integrations` / `dev_items`
   are `ON DELETE CASCADE` against it. Archive, never delete.
2. **`granola_processed_meetings.workspace` has `CHECK(workspace IN ('example', …))`
   that does not list `your-org`,** and SQLite cannot `ALTER` a CHECK. The
   tool detects this, reports the table as `BLOCKED: check-constraint`, leaves
   those rows on the source and carries on — rather than aborting the merge.
3. **`secrets` has `UNIQUE(scope_type, workspace, user_id, key)`.** When both
   workspaces hold the same key, the *target's* value must win and must not be
   touched. The tool's `UPDATE OR IGNORE` leaves the source row in place and
   names the key (never the value) in the conflict log.

## What moves, and how

| Thing | Behaviour |
|---|---|
| Cards (`objectives`) | `UPDATE … SET workspace`. **Ids, `parent_id`, history, `assigned_user_id`, `session_id` are untouched** — nothing is re-keyed, so history and assignments survive by construction. |
| Memberships (`user_workspaces`) | **Union, not move.** Missing users are added to the target; overlapping users keep the *most permissive* of the two rows (`admin` beats `member`, `can_use_assistant` ORs, `objective_visibility='all'` beats `'own'`). Nobody loses access. Source rows are then dropped so the roster is clean. |
| Per-user connectors (`workspace_user` secrets, `user_google`, `user_github_token`) | Re-scoped **per user** — `user_id` is part of the unique key, so two users' credentials for the same key never merge. |
| Workspace secrets / settings | Moved when the target has no value; **left on the source and logged** when it does. The target is never overwritten. |
| Every other slug-carrying table | Swept generically, same conflict rule. |
| Vault / KB tree | Copy-then-verify (see below). |
| Source workspace row | `archived = 1`, **only after** the card counts reconcile. |

### Vault fold (`--vault-root`)

Every file under `<vault-root>/<from>/` is copied to the same relative path
under `<vault-root>/<to>/`:

- destination path free → copied;
- destination exists and is **byte-identical** (sha256) → skipped as a duplicate;
- destination exists and **differs** → landed beside it as
  `<stem>.from-<from-slug><ext>` and recorded in the conflict log.

Nothing is overwritten and nothing is deleted. With `--retire-source-vault`, the
source tree is **renamed** to `<vault-root>/_archived-<from>/` — and only once
`copied + collisions === files`.

---

## Procedure

Run from inside the app container (it is where `better-sqlite3`, `tsx` and the
DB live):

```bash
docker exec -it command-center sh -lc '
  cd /app && tsx server/src/scripts/workspace-merge.ts --help 2>/dev/null || true'
```

### 0. Un-archive `operationkit` (independent of the merge)

```bash
docker exec command-center tsx /app/server/src/scripts/workspace-merge.ts \
  --unarchive operationkit                 # dry run: prints the current row
docker exec command-center tsx /app/server/src/scripts/workspace-merge.ts \
  --unarchive operationkit --apply
```

This flips `workspaces.archived` and nothing else. No `operationkit` card, file
or membership is read or written.

### 1. Dry run the merge (default — writes nothing)

```bash
docker exec command-center tsx /app/server/src/scripts/workspace-merge.ts \
  --from example --to your-org \
  --vault-root /home/operator/second-brain/workspaces
```

Read the output before going further:

- `cards: example=N your-org=M -> your-org=N+M` — this is the number step 3
  must reproduce exactly.
- any `[BLOCKED: check-constraint]` table — those rows stay behind, by design.
- `conflict=` counts — each one is a value the target already owns.
- `vault: … renamed=` — each one becomes a `.from-example` file.

### 2. Backups

Step 3 refuses to mutate without them, and takes them itself: a
`PRAGMA integrity_check`-verified SQLite snapshot (via the same
`backupDatabase()` the install backup uses) plus a `tar.gz` of the source vault
tree, both written to `--backup-dir` and printed. Point `--backup-dir` at real
storage, not `/tmp`.

### 3. Apply

```bash
docker exec command-center tsx /app/server/src/scripts/workspace-merge.ts \
  --from example --to your-org \
  --vault-root /home/operator/second-brain/workspaces \
  --backup-dir /home/operator/backups/ws-merge-$(date +%F) \
  --apply
```

The DB half runs in **one transaction** that ends with a recount. If
`example != 0` or `your-org != N+M`, the transaction **rolls back** and the
command exits 1 with nothing changed — including the archive flag.

Add `--retire-source-vault` only once you are satisfied with the fold; it is a
rename, so it is still reversible.

### 4. Restart and verify

```bash
curl -s -X POST http://localhost:3002/api/internal/deploy -d '{"mode":"backend"}' \
  -H 'Content-Type: application/json'
curl -s 'http://localhost:3002/api/internal/objectives?fields=minimal' \
  | jq -r '.[].workspace' | sort | uniq -c
```

Expect `example` to be absent, `your-org` to carry the summed count, and
`operationkit` to be unchanged. Then in the UI: the board **Org filter** should
offer *Example Growth* and *Operation Kit* and no longer offer *Example*.

## Rolling back

1. Stop the container.
2. Copy the snapshot from `--backup-dir` over `/app/data/command-center.db`.
3. If `--retire-source-vault` ran, rename `_archived-example/` back to `example/`.
   Otherwise the source tree was never moved. The `.from-example` files added to
   the destination are listed in `conflicts-<ts>.json` and can be removed.
4. Start the container.

Nothing in this procedure deletes vault data, so step 3 is always a rename.

## Logging policy

The conflict log records **identifiers only** — table names, unique-key columns,
secret *names*, user ids, relative file paths. No secret value and no file
content is printed to the console or written to the log.
