import type Database from 'better-sqlite3'

/**
 * Hide the installer's SAMPLE workspaces — and ONLY those (obj 900206).
 *
 * This used to be an unconditional
 * `UPDATE workspaces SET archived = 1 WHERE slug != client_slug`, which on a
 * box that is not a fresh install silently hides every real workspace the
 * moment bootstrap is re-run. That is exactly what happened on the OVH box:
 * `example` (8,703 cards) and `operationkit` (403) were un-archived by hand on
 * 2026-11-04 and were archived again a day later, because a bootstrap re-run
 * could not tell a sample from a business.
 *
 * A workspace that holds cards IS a business. Leave it visible and say so,
 * rather than making an operator re-discover this on every install run.
 */
export function archiveSampleWorkspaces(
  db: Database.Database,
  clientSlug: string,
): { archived: string[]; kept: Array<{ slug: string; cards: number }> } {
  const otherSlugs = (
    db.prepare('SELECT slug FROM workspaces WHERE slug != ? AND archived = 0').all(clientSlug) as Array<{ slug: string }>
  ).map(r => r.slug)
  const archiveOne = db.prepare('UPDATE workspaces SET archived = 1 WHERE slug = ?')
  const cardCount = db.prepare('SELECT COUNT(*) n FROM objectives WHERE workspace = ?')
  const archived: string[] = []
  const kept: Array<{ slug: string; cards: number }> = []
  for (const slug of otherSlugs) {
    const cards = (cardCount.get(slug) as { n: number }).n
    if (cards > 0) {
      kept.push({ slug, cards })
      continue
    }
    archiveOne.run(slug)
    archived.push(slug)
  }
  return { archived, kept }
}
