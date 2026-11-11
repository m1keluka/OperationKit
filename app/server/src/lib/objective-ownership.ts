/**
 * Who owns a card created through POST /api/internal/objectives (obj 900208).
 *
 * That route is how a running card makes its children (`cc-live.mjs fanout`,
 * delegator decomposition, follow-ups). It used to insert them with no owner at
 * all — `created_by`, `assigned_user_id` and `agent_key_id` all NULL — so every
 * child spawned with `CC_ACTING_USER_ID` unset, the connector guard refused it as
 * `no_owner`, and a coding child had no GitHub token. It then asked for a
 * `GH_TOKEN` secret even though the parent's owner had GitHub connected.
 *
 * Rule: a child is the parent's work, so it acts for the same person under the
 * same limits.
 *   - `created_by` and `assigned_user_id` are copied as-is, so the delegated-card
 *     test (assigned ≠ creator) gives the child exactly the parent's answer — a
 *     card routed to Casey by Operator does not become Casey's own work one level down.
 *   - `agent_key_id` / `agent_key_label` are copied too. Without them a key whose
 *     allow-list excludes GitHub could reach GitHub by filing a child.
 *   - Only within the parent's workspace. A child filed into a different
 *     workspace is not obviously that person's work there, so it stays ownerless
 *     (and the session prompt says so) rather than carrying a token across.
 *
 * Top-level internal creates (no parent) are unchanged: the route has no caller
 * identity to attribute them to.
 */
import type { Database } from 'better-sqlite3'

export interface InheritedOwnership {
  created_by: number | null
  assigned_user_id: number | null
  agent_key_id: number | null
  agent_key_label: string | null
}

export const NO_OWNERSHIP: InheritedOwnership = {
  created_by: null,
  assigned_user_id: null,
  agent_key_id: null,
  agent_key_label: null,
}

export function inheritedOwnership(
  db: Database,
  parentId: number | null | undefined,
  childWorkspace: string,
): InheritedOwnership {
  if (typeof parentId !== 'number' || parentId <= 0) return NO_OWNERSHIP
  try {
    const row = db
      .prepare(
        'SELECT workspace, created_by, assigned_user_id, agent_key_id, agent_key_label FROM objectives WHERE id = ?',
      )
      .get(parentId) as
      | {
          workspace: string | null
          created_by: number | null
          assigned_user_id: number | null
          agent_key_id: number | null
          agent_key_label: string | null
        }
      | undefined
    if (!row) return NO_OWNERSHIP
    if ((row.workspace || 'example') !== (childWorkspace || 'example')) return NO_OWNERSHIP
    return {
      created_by: row.created_by ?? null,
      assigned_user_id: row.assigned_user_id ?? null,
      agent_key_id: row.agent_key_id ?? null,
      agent_key_label: row.agent_key_label ?? null,
    }
  } catch {
    // Never fail a create over attribution; an ownerless child is today's behavior.
    return NO_OWNERSHIP
  }
}
