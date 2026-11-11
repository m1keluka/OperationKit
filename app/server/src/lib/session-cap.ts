/**
 * The concurrent-session cap as enforced by PATCH /:id/status → working, shared
 * with POST /api/objectives {start:true} so create-and-start cannot bypass it
 * (obj 714091).
 *
 * Counts only states that hold a RUNNING session: 'working' (active worker) and
 * 'ai_review' (active AI reviewer). 'review' is excluded: it is parked awaiting a
 * human with no session running, so it must not consume the concurrent-session
 * budget (a review backlog was saturating the cap and blocking the queue).
 */
import type Database from 'better-sqlite3'
import { MAX_CONCURRENT_SESSIONS } from '@operationkit/shared'

export function sessionCapReached(db: Database.Database): boolean {
  const { count } = db
    .prepare("SELECT COUNT(*) as count FROM objectives WHERE status IN ('working', 'ai_review')")
    .get() as { count: number }
  return count >= MAX_CONCURRENT_SESSIONS
}

export const SESSION_CAP_ERROR = `Maximum ${MAX_CONCURRENT_SESSIONS} concurrent sessions reached`
