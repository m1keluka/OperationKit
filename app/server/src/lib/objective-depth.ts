/**
 * Transitive `depth` maintenance for the objective DAG (obj 707003, P0-2).
 *
 * WHY THIS EXISTS. `objectives.depth` was written once, by a one-shot boot
 * migration (`db/index.ts`: `UPDATE objectives SET depth = 1 WHERE parent_id IS
 * NOT NULL AND depth = 0`) that assumed no tree was ever deeper than one level.
 * That assumption stopped holding when the Strategy tier landed: the measured
 * board carries real chains of depth 3, but the STORED column only ever held
 * `{0, 1}` — every grandchild was mislabelled a child. Two of the three insert
 * paths (`POST /api/objectives`, the auto-spawned adversarial-review child) never
 * wrote `depth` at all, and the ONE reparent path (`PUT /api/objectives/:id`,
 * which does update `parent_id`) never touched it, so the column drifted further
 * from the truth with every edit.
 *
 * WHY MAINTAIN RATHER THAN DROP. The alternative — drop the column and expose
 * depth as computed — was rejected: `depth` has live *predicate* readers, not
 * just display readers. `routine-scheduler.ts:347` selects it to derive a child's
 * depth, `internal.ts`'s nesting ceiling compares it against
 * `MAX_DELEGATION_DEPTH`, and `prompt-builder` branches the strategy block on
 * depth 0. Those are hot paths on a table with 8.3k rows; making each of them
 * walk a recursive CTE to answer "how deep am I" trades a correctness bug for a
 * performance one. Keeping the column and maintaining it transitively is the
 * smaller change and leaves every existing reader byte-identical — they just
 * start seeing correct values.
 *
 * The definition of truth is one recursive CTE (`TRUE_DEPTH_CTE`), used by all
 * three entry points below, so "stored depth" and "computed depth" cannot drift
 * apart in their definition of a root:
 *
 *   root  = `parent_id IS NULL` **or** a DANGLING `parent_id` (the parent row no
 *           longer exists — 128 such rows on the live board as of 2026-08-19).
 *           Treating a dangling child as a root is what keeps it reachable; the
 *           alternative (leaving it out of the walk) would freeze its depth at
 *           whatever stale value it happens to hold.
 *   cycle = unreachable from any root, therefore never enumerated. The CTE walks
 *           strictly DOWNWARD from roots, so a parent cycle cannot make it loop
 *           forever — those rows are simply skipped and keep their prior depth.
 */

interface DbLike {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[]
    get(...params: unknown[]): unknown
    run(...params: unknown[]): { changes: number }
  }
}

/**
 * The single definition of "true depth". Emits `(id, d)` for every objective
 * reachable from a root. Written as a CTE body (no leading `WITH`) so callers
 * can compose it with `WITH RECURSIVE t(id, d) AS (...)`.
 */
const TRUE_DEPTH_BODY = `
  SELECT id, 0 FROM objectives o
    WHERE o.parent_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM objectives p WHERE p.id = o.parent_id)
  UNION ALL
  SELECT o.id, t.d + 1 FROM objectives o JOIN t ON o.parent_id = t.id
`

/** Full recursive-CTE prefix producing `t(id, d)` = every row's true depth. */
export const TRUE_DEPTH_CTE = `WITH RECURSIVE t(id, d) AS (${TRUE_DEPTH_BODY})`

/**
 * Depth an inserted child should carry: `parent.depth + 1`, or 0 for a top-level
 * row (and for a parent id that does not resolve — a dangling reference is a
 * root by the rule above, so its child would be depth 1, but the child of a
 * MISSING parent is itself a root at 0).
 *
 * This reads the parent's STORED depth rather than recomputing, which is correct
 * because every write path in the server now keeps that stored value true.
 */
export function depthForParent(db: DbLike, parentId: number | null | undefined): number {
  if (parentId == null) return 0
  const parent = db.prepare('SELECT depth FROM objectives WHERE id = ?').get(parentId) as
    | { depth: number | null }
    | undefined
  if (!parent) return 0
  return (parent.depth ?? 0) + 1
}

/**
 * Recompute `depth` for `rootId` and every descendant, after a REPARENT.
 *
 * A reparent is the only operation that can invalidate depths it does not
 * directly touch: moving a node changes the depth of its whole subtree. Scoped
 * to the moved subtree rather than the table, so the cost is proportional to the
 * edit, not to the board.
 *
 * Returns the number of rows whose depth actually changed.
 */
export function recomputeSubtreeDepth(db: DbLike, rootId: number): number {
  const row = db.prepare('SELECT id, parent_id, depth FROM objectives WHERE id = ?').get(rootId) as
    | { id: number; parent_id: number | null; depth: number | null }
    | undefined
  if (!row) return 0

  const rootDepth = depthForParent(db, row.parent_id)
  let changed = 0

  // Breadth-first, with an explicit `seen` set so a parent cycle introduced by a
  // bad reparent terminates instead of walking forever.
  const seen = new Set<number>([rootId])
  let level: Array<{ id: number; depth: number }> = [{ id: rootId, depth: rootDepth }]
  const childrenOf = db.prepare('SELECT id FROM objectives WHERE parent_id = ?')
  const setDepth = db.prepare('UPDATE objectives SET depth = ? WHERE id = ? AND depth IS NOT ?')

  while (level.length > 0) {
    const next: Array<{ id: number; depth: number }> = []
    for (const node of level) {
      changed += setDepth.run(node.depth, node.id, node.depth).changes
      for (const child of childrenOf.all(node.id) as { id: number }[]) {
        if (seen.has(child.id)) continue
        seen.add(child.id)
        next.push({ id: child.id, depth: node.depth + 1 })
      }
    }
    level = next
  }
  return changed
}

/**
 * Whole-table transitive backfill, run once per boot from the migration block.
 *
 * Replaces the one-shot `depth = 1` normalization, which could not express any
 * tree deeper than one level. Idempotent: it recomputes rather than patches, so
 * a second run changes nothing. Rows unreachable from a root (i.e. inside a
 * parent cycle) are left alone rather than guessed at.
 *
 * Returns the number of rows whose depth actually changed — the boot log prints
 * it, so a drift that reappears is visible instead of silent.
 */
export function backfillAllDepths(db: DbLike): number {
  // MATERIALIZE first. Referencing a recursive CTE from both the SET subquery
  // and the WHERE of a single UPDATE lets SQLite re-evaluate the whole walk
  // per row — O(rows × board) at boot on an 8.3k-row table. A temp table makes
  // it one walk plus an indexed join.
  db.prepare('DROP TABLE IF EXISTS _depth_backfill').run()
  db.prepare(
    `CREATE TEMP TABLE _depth_backfill AS ${TRUE_DEPTH_CTE} SELECT id, d FROM t`,
  ).run()
  db.prepare('CREATE UNIQUE INDEX _depth_backfill_id ON _depth_backfill(id)').run()
  const res = db
    .prepare(
      `UPDATE objectives
          SET depth = (SELECT d FROM _depth_backfill b WHERE b.id = objectives.id)
        WHERE EXISTS (
          SELECT 1 FROM _depth_backfill b
           WHERE b.id = objectives.id AND b.d IS NOT objectives.depth
        )`,
    )
    .run()
  db.prepare('DROP TABLE _depth_backfill').run()
  return res.changes
}

/** Rows whose `parent_id` points at an objective that no longer exists. */
export function danglingParentRows(db: DbLike): Array<{ id: number; parent_id: number }> {
  return db
    .prepare(
      `SELECT id, parent_id FROM objectives o
        WHERE o.parent_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM objectives p WHERE p.id = o.parent_id)
        ORDER BY o.id`,
    )
    .all() as Array<{ id: number; parent_id: number }>
}
