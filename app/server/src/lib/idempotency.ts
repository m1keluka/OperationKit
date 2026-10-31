/**
 * Idempotency-Key support for agent-facing POSTs (obj 714091).
 *
 * An orchestrator that retries a timed-out POST /api/objectives must not create a
 * second card. With an `Idempotency-Key` header, the first request's final
 * response (status + body) is stored per (user, scope, key) for 24h and replayed
 * verbatim to any repeat — the handler does not run again.
 *
 *  - Same key, DIFFERENT body           → 422 (the key is bound to one request).
 *  - Same key while the first is in flight → 409 (no double execution).
 *  - 5xx responses are NOT stored, so a retry after a server error re-executes.
 *  - No header → behaviour is exactly as before.
 *
 * Usage, first thing in a handler:
 *     if (beginIdempotent(req, res, 'POST /api/objectives')) return
 */
import crypto from 'crypto'
import type { Response } from 'express'
import { getDb } from '../db/index.js'
import type { AuthRequest } from '../middleware/auth.js'

export const IDEMPOTENCY_HEADER = 'idempotency-key'
export const IDEMPOTENCY_WINDOW = '-1 day'
const KEY_PATTERN = /^[\x21-\x7e]{1,255}$/

/**
 * Who owns a key namespace (obj 714100). Two Grok Bots on the same user each
 * hold their own agent key, so the same Idempotency-Key from both must NOT
 * collide: the namespace is (user_id, principal), folded into the stored scope.
 */
export function idempotencyPrincipal(req: AuthRequest): string {
  if (req.agentKey) return `agent_key:${req.agentKey.id}`
  if (req.authVia === 'legacy_api_key') return 'legacy'
  return 'session'
}

function requestHash(body: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex')
}

/**
 * Returns true when the response has already been sent (replay, conflict or a
 * malformed key) and the handler must return immediately. Returns false when the
 * handler should proceed; its eventual res.json() is then recorded.
 */
export function beginIdempotent(req: AuthRequest, res: Response, route: string): boolean {
  const raw = req.get(IDEMPOTENCY_HEADER)
  if (raw === undefined) return false
  const key = raw.trim()
  if (!KEY_PATTERN.test(key)) {
    res.status(400).json({ error: 'Idempotency-Key must be 1-255 printable ASCII characters' })
    return true
  }
  const userId = req.user!.id
  const scope = `${idempotencyPrincipal(req)} ${route}`
  const hash = requestHash(req.body)
  const db = getDb()

  db.prepare(
    `DELETE FROM idempotency_keys WHERE user_id = ? AND scope = ? AND idem_key = ?
       AND created_at < datetime('now', ?)`,
  ).run(userId, scope, key, IDEMPOTENCY_WINDOW)

  // Claim the key synchronously (Node is single-threaded, so check-and-insert
  // here cannot interleave with another request) before any await in the handler.
  const claimed = db
    .prepare(
      `INSERT OR IGNORE INTO idempotency_keys (user_id, scope, idem_key, request_hash) VALUES (?, ?, ?, ?)`,
    )
    .run(userId, scope, key, hash).changes === 1

  if (!claimed) {
    const row = db
      .prepare(
        `SELECT request_hash, status_code, response_body FROM idempotency_keys
          WHERE user_id = ? AND scope = ? AND idem_key = ?`,
      )
      .get(userId, scope, key) as { request_hash: string; status_code: number | null; response_body: string | null }
    if (row.request_hash !== hash) {
      res.status(422).json({ error: 'Idempotency-Key was already used with a different request body' })
      return true
    }
    if (row.status_code == null) {
      res.status(409).json({ error: 'A request with this Idempotency-Key is still in progress — retry shortly' })
      return true
    }
    res.set('Idempotent-Replayed', 'true')
    res.status(row.status_code).type('application/json').send(row.response_body ?? 'null')
    return true
  }

  const originalJson = res.json.bind(res)
  res.json = ((body: unknown) => {
    try {
      if (res.statusCode >= 500) {
        db.prepare('DELETE FROM idempotency_keys WHERE user_id = ? AND scope = ? AND idem_key = ?')
          .run(userId, scope, key)
      } else {
        db.prepare(
          `UPDATE idempotency_keys SET status_code = ?, response_body = ?
            WHERE user_id = ? AND scope = ? AND idem_key = ?`,
        ).run(res.statusCode, JSON.stringify(body), userId, scope, key)
      }
    } catch (err) {
      console.error('[idempotency] failed to record response:', (err as Error).message)
    }
    return originalJson(body)
  }) as Response['json']

  // A handler that throws (or never calls res.json) must not leave the key
  // claimed-in-flight for 24h.
  res.on('finish', () => {
    try {
      db.prepare(
        `DELETE FROM idempotency_keys WHERE user_id = ? AND scope = ? AND idem_key = ? AND status_code IS NULL`,
      ).run(userId, scope, key)
    } catch { /* best-effort */ }
  })
  return false
}
