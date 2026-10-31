/**
 * Server-side twin guard for "Living docs — {name}" cards (obj 712948).
 *
 * The docs-breathe routine files one sibling card per living repo. Its prompt now
 * tells it to skip a repo whose card is still open, but a prompt is advisory: the
 * model drifted into "Living docs stub — X" / "Living docs — X (stub)" variants and
 * re-filed a twin every morning (22 queued twins by Aug 27). This guard makes the
 * rule structural on POST /api/internal/objectives — while a card for the same
 * normalized {name} is open in the workspace, a new one is refused and the open
 * card's id is returned instead.
 */
import type { Database } from 'better-sqlite3'

/** "Living docs — foo", "Living docs stub — foo", "Living docs — foo (stub)", with any
 *  dash (—, –, -) — the variants the routine actually produced. */
export const LIVING_DOCS_TITLE_RE = /^Living docs(?: stub)?\s*[—–-]\s*(.+?)(?:\s*\(stub\))?\s*$/i

/** Normalized repo name from a living-docs title, or null when it is not one. */
export function livingDocsName(title: string | null | undefined): string | null {
  const m = LIVING_DOCS_TITLE_RE.exec((title || '').trim())
  if (!m) return null
  const name = m[1].trim().toLowerCase()
  return name || null
}

export interface OpenLivingDocsCard {
  id: number
  title: string
  status: string
}

/** The oldest open (not done/cancelled, not soft-deleted) living-docs card for `name`
 *  in `workspace`, or null. */
export function findOpenLivingDocsCard(db: Database, workspace: string, name: string): OpenLivingDocsCard | null {
  const rows = db
    .prepare(
      `SELECT id, title, status FROM objectives
        WHERE workspace = ? AND title LIKE 'Living docs%'
          AND status NOT IN ('done', 'cancelled') AND deleted_at IS NULL
        ORDER BY id ASC`,
    )
    .all(workspace) as OpenLivingDocsCard[]
  return rows.find((r) => livingDocsName(r.title) === name) ?? null
}

/** A refused twin still carries a signal ("this repo still needs docs"). For a card
 *  nobody has started, record it as ONE dated line per day on the open card — never
 *  a follow-up message, which would start a worker. Returns true when a line was added. */
export function noteStillPending(db: Database, card: OpenLivingDocsCard, today = new Date().toISOString().slice(0, 10)): boolean {
  if (card.status !== 'queue' && card.status !== 'planning') return false
  const row = db.prepare('SELECT description FROM objectives WHERE id = ?').get(card.id) as { description?: string } | undefined
  const desc = row?.description || ''
  const line = `- still pending as of ${today} (duplicate living-docs card refused)`
  if (desc.includes(line)) return false
  db.prepare("UPDATE objectives SET description = ?, updated_at = datetime('now') WHERE id = ?").run(`${desc}\n${line}`, card.id)
  return true
}
