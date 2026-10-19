// Scratchpad engine — a dead-simple, per-USER human markdown store.
//
// One row per user in the `scratchpads` table (user_id PRIMARY KEY): a single free-text
// markdown blob Mike (or any authenticated user) types into. Strictly per-account —
// every read/write is keyed off the authenticated user id, so two users never see each
// other's content.
//
// Agents must NEVER write here — this is a human-only surface. There is deliberately no
// internal/localhost write path and no session-facing helper; the only writer is the
// authenticated PUT /api/scratchpad route (see routes/scratchpad.ts).
import { getDb } from '../db/index.js'

export interface Scratchpad {
  content: string
  updated_at: string
}

// Return the user's scratchpad content, or '' when they have no row yet.
export function getScratchpad(userId: number): string {
  const row = getDb()
    .prepare('SELECT content FROM scratchpads WHERE user_id = ?')
    .get(userId) as { content: string } | undefined
  return row?.content ?? ''
}

// Return content + updated_at for the user; content '' and updated_at null when no row.
// (The route surfaces updated_at; getScratchpad stays the spec'd string-only accessor.)
export function getScratchpadRow(userId: number): { content: string; updated_at: string | null } {
  const row = getDb()
    .prepare('SELECT content, updated_at FROM scratchpads WHERE user_id = ?')
    .get(userId) as { content: string; updated_at: string } | undefined
  return { content: row?.content ?? '', updated_at: row?.updated_at ?? null }
}

// UPSERT the user's scratchpad content and stamp updated_at. Returns the new
// updated_at so the caller can echo it back without a second read.
export function setScratchpad(userId: number, content: string): string {
  const db = getDb()
  db.prepare(
    `INSERT INTO scratchpads (user_id, content, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
  ).run(userId, content)
  const row = db
    .prepare('SELECT updated_at FROM scratchpads WHERE user_id = ?')
    .get(userId) as { updated_at: string }
  return row.updated_at
}
