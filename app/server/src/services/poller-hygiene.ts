/**
 * Board-hygiene sweeps — extracted from state-poller.ts (behavior frozen).
 * Queue-orphan drainer, top-level queue starter, auto-accept-on-pass, digest.
 * Selection queries are unchanged; the poll loop in state-poller.ts calls these.
 */
import fs from 'fs'
import type { Database } from 'better-sqlite3'
import type { Objective } from '@operationkit/shared'
import { MAX_CONCURRENT_SESSIONS } from '@operationkit/shared'
import { getDb } from '../db/index.js'
import { startSession } from './session-manager.js'
import { logObjectiveAudit } from './objective-audit.js'
import { broadcast } from '../ws/index.js'
import { insertAlert } from './notifier.js'
import { runCompletionGate, applyGateHandback } from './ci-green-gate.js'
import {
  queueOrphanTtlDays,
  reviewPassTtlDays,
  queueStaleTtlDays,
  reviewStaleTtlDays,
  reviewHardExpiryDays,
  isQueueDrainerEnabled,
  isAutoAcceptEnabled,
  isReviewHardExpiryEnabled,
  childCapPerParent,
  queueDrainerTickCap,
  isTopLevelQueueStarterEnabled,
  topLevelQueueStarterCategories,
  topLevelQueueStarterTickCap,
  topLevelQueueStarterGraceMinutes,
  HYGIENE_DIGEST_DIR,
  HYGIENE_DIGEST_PATH,
} from '../lib/hygiene-config.js'

// ── Board-hygiene sweeps (obj 700595) ────────────────────────────────────────
//
// Three counterweights for the by-design gaps found in 700583/w1-rootcause.md:
//   1b — sweepOrphanedQueueChildren: start queue children a LIVE delegator forgot
//        to PATCH, past QUEUE_ORPHAN_TTL. The missing autonomous starter.
//   2a — sweepAutoAcceptOnPass: advance review + verdict='pass' rows to done after
//        REVIEW_PASS_TTL. Never touches verdict IS NULL (those need a human).
//   2b/2c — writeHygieneDigest: surface stale-review (verdict=null) + stale manual
//        queue cards to a human-readable digest; NEVER auto-closes by default.
// The selection queries are exported as pure functions so the guardrails
// (never `working`, never manual, never verdict-null) are unit-testable without
// spawning sessions.

/**
 * 1b selection — stranded queue children of a LIVE working delegator, older than
 * `ttlDays`. GUARDS baked into the query:
 *  - child.status = 'queue'                    (never a working/review/done child)
 *  - child.session_count = 0                   (never a child that produced work)
 *  - child.parent_id IS NOT NULL               (never a top-level/manual card)
 *  - child.origin != 'manual'                  (belt-and-suspenders vs manual work)
 *  - child.deleted_at IS NULL                  (never a retired row)
 *  - parent.status = 'working' AND delegate_mode = 1  (parent is a live delegator)
 */
export function selectOrphanedQueueChildren(db: Database, ttlDays: number): Objective[] {
  return db
    .prepare(
      `SELECT c.* FROM objectives c
         JOIN objectives p ON p.id = c.parent_id
        WHERE c.status = 'queue'
          AND c.session_count = 0
          AND c.parent_id IS NOT NULL
          AND (c.origin IS NULL OR c.origin != 'manual')
          AND c.deleted_at IS NULL
          AND c.updated_at < datetime('now', ?)
          AND p.status = 'working'
          AND p.delegate_mode = 1
        ORDER BY c.updated_at ASC`,
    )
    .all(`-${ttlDays} days`) as Objective[]
}

/**
 * 2a selection — review rows with a genuine PASS verdict idle past `ttlDays`.
 * `ai_review_verdict = 'pass'` is a SQL equality so it can NEVER match a NULL
 * verdict — verdict=null rows are deliberately excluded (they were never
 * AI-reviewed and genuinely need a human). deleted_at IS NULL keeps it idempotent.
 */
export function selectAutoAcceptCandidates(db: Database, ttlDays: number): Objective[] {
  return db
    .prepare(
      `SELECT * FROM objectives
        WHERE status = 'review'
          AND ai_review_verdict = 'pass'
          AND deleted_at IS NULL
          AND updated_at < datetime('now', ?)
        ORDER BY updated_at ASC`,
    )
    .all(`-${ttlDays} days`) as Objective[]
}

/**
 * Top-level queue starter selection (obj 701663). The missing autonomous starter
 * for a TOP-LEVEL (`parent_id IS NULL`) objective created via the bulk route
 * `POST /api/internal/objectives`, which lands at the schema-default
 * status='queue' and — unlike a routine — is never PATCHed to 'working', so it
 * strands in queue forever (the 14-day distill backlog).
 *
 * GUARDS baked into the query (acceptance #3 — never an unbounded auto-start):
 *  - status = 'queue'                           (never working/review/done)
 *  - parent_id IS NULL                          (top-level only; a delegator's
 *                                                queue CHILD is the queue-drainer's job)
 *  - session_count = 0                          (never a card that already ran)
 *  - deleted_at IS NULL                         (never a retired row)
 *  - origin IN ('job_reply','strategy')         (bulk-route provenance ONLY —
 *                                                excludes 'manual' user cards and
 *                                                'routine' runs, which self-start)
 *  - category IN (<allowlist>)                  (default ['platform']; a general
 *                                                PRD-backlog project is excluded)
 *  - updated_at < now - graceMinutes            (don't race a just-inserted row)
 * Pure + exported so the guardrails are unit-testable without spawning a session,
 * mirroring {@link selectOrphanedQueueChildren}.
 */
export function selectTopLevelQueueStarterCandidates(
  db: Database,
  categories: string[],
  graceMinutes: number,
): Objective[] {
  const cats = categories.length > 0 ? categories : ['platform']
  const catPlaceholders = cats.map(() => '?').join(',')
  return db
    .prepare(
      `SELECT * FROM objectives
        WHERE status = 'queue'
          AND parent_id IS NULL
          AND session_count = 0
          AND deleted_at IS NULL
          AND origin IN ('job_reply','strategy')
          AND category IN (${catPlaceholders})
          AND updated_at < datetime('now', ?)
        ORDER BY updated_at ASC`,
    )
    .all(...cats, `-${graceMinutes} minutes`) as Objective[]
}

// obj 701663 — autonomous top-level queue starter. Flag-gated (DEFAULT ON; see
// isTopLevelQueueStarterEnabled). Bounded per tick and respects the global
// concurrency cap so it can't thunder. Sibling of sweepOrphanedQueueChildren but
// for TOP-LEVEL (parent_id IS NULL) cards, which that child-scoped drainer and
// every other net deliberately never touch.
let lastTopLevelQueueStarterSweep = 0
const TOPLEVEL_QUEUE_STARTER_SWEEP_INTERVAL_MS = 60 * 1000

export async function sweepTopLevelQueueStarter(): Promise<void> {
  const now = Date.now()
  if (now - lastTopLevelQueueStarterSweep < TOPLEVEL_QUEUE_STARTER_SWEEP_INTERVAL_MS) return
  lastTopLevelQueueStarterSweep = now

  const db = getDb()
  if (!isTopLevelQueueStarterEnabled(db)) return

  const categories = topLevelQueueStarterCategories()
  const graceMinutes = topLevelQueueStarterGraceMinutes()
  const tickCap = topLevelQueueStarterTickCap()

  let candidates: Objective[]
  try {
    candidates = selectTopLevelQueueStarterCandidates(db, categories, graceMinutes)
  } catch (err) {
    console.error('[state-poller] toplevel-queue-starter selection failed:', (err as Error).message)
    return
  }
  if (candidates.length === 0) return

  let startedThisTick = 0
  for (const obj of candidates) {
    if (startedThisTick >= tickCap) break

    // Respect the global concurrency cap (count RUNNING-session states only,
    // mirroring the queue-drainer and the PATCH-status start path).
    const active = db
      .prepare("SELECT COUNT(*) as count FROM objectives WHERE status IN ('working', 'ai_review')")
      .get() as { count: number }
    if (active.count >= MAX_CONCURRENT_SESSIONS) break

    try {
      const sessionId = await startSession(obj)
      db.prepare(
        "UPDATE objectives SET status = 'working', session_id = ?, updated_at = datetime('now') WHERE id = ?",
      ).run(sessionId, obj.id)
      logObjectiveAudit(db, {
        objectiveId: obj.id,
        eventType: 'status_change',
        fromStatus: 'queue',
        toStatus: 'working',
        actor: 'state-poller',
        pathway: 'toplevel-queue-starter',
        sessionId,
        titleSnapshot: obj.title ?? null,
        workspace: obj.workspace ?? null,
      })
      const updated = db.prepare('SELECT * FROM objectives WHERE id = ?').get(obj.id) as Objective
      broadcast({ type: 'objective_updated', payload: updated })
      startedThisTick++
      console.warn(
        `[state-poller] toplevel-queue-starter: started top-level queue card #${obj.id} ("${obj.title}") ` +
        `(origin=${obj.origin}, category=${obj.category})`,
      )
    } catch (err) {
      // startSession may enqueue on account exhaustion or throw on a lease
      // conflict — either way, leave the card in queue and retry next tick.
      console.warn(
        `[state-poller] toplevel-queue-starter: start failed for #${obj.id}:`,
        (err as Error).message,
      )
    }
  }
}

// 1b — autonomous queue-drainer backstop. Flag-gated (DEFAULT OFF). Bounded per
// tick + per parent, and respects the global concurrency cap so it can't thunder.
let lastQueueDrainerSweep = 0
const QUEUE_DRAINER_SWEEP_INTERVAL_MS = 60 * 1000

export async function sweepOrphanedQueueChildren(): Promise<void> {
  const now = Date.now()
  if (now - lastQueueDrainerSweep < QUEUE_DRAINER_SWEEP_INTERVAL_MS) return
  lastQueueDrainerSweep = now

  const db = getDb()
  if (!isQueueDrainerEnabled(db)) return

  const ttl = queueOrphanTtlDays()
  const perParentCap = childCapPerParent()
  const tickCap = queueDrainerTickCap()

  let candidates: Objective[]
  try {
    candidates = selectOrphanedQueueChildren(db, ttl)
  } catch (err) {
    console.error('[state-poller] queue-drainer selection failed:', (err as Error).message)
    return
  }
  if (candidates.length === 0) return

  const startedPerParent = new Map<number, number>()
  let startedThisTick = 0

  for (const child of candidates) {
    if (startedThisTick >= tickCap) break

    // Respect the global concurrency cap (count RUNNING-session states only,
    // mirroring the PATCH-status start path — review is parked, no session).
    const active = db
      .prepare("SELECT COUNT(*) as count FROM objectives WHERE status IN ('working', 'ai_review')")
      .get() as { count: number }
    if (active.count >= MAX_CONCURRENT_SESSIONS) break

    const parentId = child.parent_id as number
    const perParent = startedPerParent.get(parentId) ?? 0
    if (perParent >= perParentCap) continue

    try {
      const sessionId = await startSession(child)
      db.prepare(
        "UPDATE objectives SET status = 'working', session_id = ?, updated_at = datetime('now') WHERE id = ?",
      ).run(sessionId, child.id)
      logObjectiveAudit(db, {
        objectiveId: child.id,
        eventType: 'status_change',
        fromStatus: 'queue',
        toStatus: 'working',
        actor: 'state-poller',
        pathway: 'queue-orphan-drainer-backstop',
        sessionId,
        titleSnapshot: child.title ?? null,
        workspace: child.workspace ?? null,
      })
      const updated = db.prepare('SELECT * FROM objectives WHERE id = ?').get(child.id) as Objective
      broadcast({ type: 'objective_updated', payload: updated })
      startedPerParent.set(parentId, perParent + 1)
      startedThisTick++
      console.warn(
        `[state-poller] queue-drainer: started orphaned child #${child.id} ("${child.title}") of live delegator #${parentId} (idle > ${ttl}d)`,
      )
    } catch (err) {
      // startSession may enqueue on account exhaustion or throw on a lease
      // conflict — either way, leave the child in queue and try again next tick.
      console.warn(
        `[state-poller] queue-drainer: start failed for child #${child.id}:`,
        (err as Error).message,
      )
    }
  }
}

// 2a — auto-accept-on-pass reaper. Flag-gated (DEFAULT OFF).
let lastAutoAcceptSweep = 0
const AUTO_ACCEPT_SWEEP_INTERVAL_MS = 60 * 1000

export async function sweepAutoAcceptOnPass(): Promise<void> {
  const now = Date.now()
  if (now - lastAutoAcceptSweep < AUTO_ACCEPT_SWEEP_INTERVAL_MS) return
  lastAutoAcceptSweep = now

  const db = getDb()
  if (!isAutoAcceptEnabled(db)) return

  const ttl = reviewPassTtlDays()
  let candidates: Objective[]
  try {
    candidates = selectAutoAcceptCandidates(db, ttl)
  } catch (err) {
    console.error('[state-poller] auto-accept selection failed:', (err as Error).message)
    return
  }

  for (const obj of candidates) {
    try {
      // ── CI-green gate (obj 704785) ────────────────────────────────────────
      // A `pass` verdict is a judgement about the DIFF; it says nothing about the
      // checks. This reaper would otherwise convert a stale pass into `done` on top
      // of a red PR. It has already been idle for the TTL, so a `hold` here would
      // just re-park it in the same place — the gate's own escalate/complete-with-red
      // outcomes are what apply. On a genuine required failure we leave it in review
      // and let the escalation reach Operator.
      const gate = await runCompletionGate(db, obj, { pathway: 'auto-accept-on-pass-ttl', alert: insertAlert })
      if (gate.blocked) {
        applyGateHandback(db, obj, gate, { broadcast })
        console.warn(
          `[state-poller] auto-accept-on-pass: HELD #${obj.id} — ${gate.decision.reason}`,
        )
        continue
      }
      db.prepare(
        "UPDATE objectives SET status = 'done', updated_at = datetime('now') WHERE id = ?",
      ).run(obj.id)
      logObjectiveAudit(db, {
        objectiveId: obj.id,
        eventType: 'status_change',
        fromStatus: 'review',
        toStatus: 'done',
        actor: 'state-poller',
        pathway: 'auto-accept-on-pass-ttl',
        sessionId: obj.session_id ?? null,
        titleSnapshot: obj.title ?? null,
        workspace: obj.workspace ?? null,
      })
      const updated = db.prepare('SELECT * FROM objectives WHERE id = ?').get(obj.id) as Objective
      broadcast({ type: 'objective_updated', payload: updated })
      console.warn(
        `[state-poller] auto-accept-on-pass: review→done for #${obj.id} ("${obj.title}") (verdict=pass, idle > ${ttl}d)`,
      )
    } catch (err) {
      console.warn(
        `[state-poller] auto-accept-on-pass: failed for #${obj.id}:`,
        (err as Error).message,
      )
    }
  }
}

export interface HygieneDigest {
  markdown: string
  staleReviewCount: number
  staleQueueCount: number
  hardExpiredIds: number[]
}

/**
 * 2b/2c — build (and optionally apply the flag-gated hard-expiry of) the board
 * hygiene digest. Pure w.r.t. the filesystem: returns the markdown + counts so a
 * caller (and tests) can assert on it. The hard-expiry mutation is applied INSIDE
 * this function only when `applyHardExpiry` is true (the caller passes the flag
 * state); any rows it closes are listed in the digest so nothing vanishes silently.
 */
export function buildHygieneDigest(
  db: Database,
  opts: {
    reviewStaleDays: number
    queueStaleDays: number
    hardExpiryDays: number
    applyHardExpiry: boolean
    nowIso: string
  },
): HygieneDigest {
  // (i) stale review with verdict=null — idle beyond reviewStaleDays. These are
  //     surfaced ONLY; never auto-closed (unless hard-expiry is armed, below).
  const staleReview = db
    .prepare(
      `SELECT id, title, workspace, project, updated_at FROM objectives
        WHERE status = 'review'
          AND ai_review_verdict IS NULL
          AND deleted_at IS NULL
          AND updated_at < datetime('now', ?)
        ORDER BY updated_at ASC
        LIMIT 50`,
    )
    .all(`-${opts.reviewStaleDays} days`) as {
    id: number
    title: string
    workspace: string | null
    project: string | null
    updated_at: string
  }[]

  // (ii) stale MANUAL queue cards — top-level (parent_id IS NULL) idle beyond
  //      queueStaleDays. Never auto-started/closed — the deliberate human gate.
  const staleQueue = db
    .prepare(
      `SELECT id, title, workspace, project, updated_at FROM objectives
        WHERE status = 'queue'
          AND parent_id IS NULL
          AND deleted_at IS NULL
          AND updated_at < datetime('now', ?)
        ORDER BY updated_at ASC
        LIMIT 50`,
    )
    .all(`-${opts.queueStaleDays} days`) as {
    id: number
    title: string
    workspace: string | null
    project: string | null
    updated_at: string
  }[]

  // Optional hard-expiry backstop (flag default OFF): soft-close verdict=null
  // review items older than hardExpiryDays to done, pathway=review-hard-expiry.
  const hardExpiredIds: number[] = []
  if (opts.applyHardExpiry) {
    const expired = db
      .prepare(
        `SELECT * FROM objectives
          WHERE status = 'review'
            AND ai_review_verdict IS NULL
            AND deleted_at IS NULL
            AND updated_at < datetime('now', ?)
          ORDER BY updated_at ASC`,
      )
      .all(`-${opts.hardExpiryDays} days`) as Objective[]
    for (const obj of expired) {
      try {
        // ── CI-green gate, RECORD-ONLY (obj 704785) ─────────────────────────
        // This path exists SPECIFICALLY to break review limbo after N days. Holding
        // here would re-create the deadlock the sweeper exists to break, so the gate
        // runs in `record-only` mode: it never blocks, but it still writes the
        // durable "completed with a non-green PR" row that the pr-health digest
        // renders — so nothing closes here unseen. Fired without awaiting precisely
        // because it cannot change the outcome; buildHygieneDigest stays synchronous.
        void runCompletionGate(db, obj, { mode: 'record-only', pathway: 'review-hard-expiry' })
        db.prepare(
          "UPDATE objectives SET status = 'done', updated_at = datetime('now') WHERE id = ?",
        ).run(obj.id)
        logObjectiveAudit(db, {
          objectiveId: obj.id,
          eventType: 'status_change',
          fromStatus: 'review',
          toStatus: 'done',
          actor: 'state-poller',
          pathway: 'review-hard-expiry',
          sessionId: obj.session_id ?? null,
          titleSnapshot: obj.title ?? null,
          workspace: obj.workspace ?? null,
        })
        hardExpiredIds.push(obj.id)
      } catch (err) {
        console.warn(`[state-poller] review-hard-expiry failed for #${obj.id}:`, (err as Error).message)
      }
    }
  }

  const fmtRow = (r: { id: number; title: string; workspace: string | null; project: string | null; updated_at: string }) =>
    `- #${r.id} — ${r.title} (${r.workspace ?? '?'}/${r.project ?? '-'}) — idle since ${r.updated_at} UTC`

  const lines: string[] = []
  lines.push('# Board hygiene digest')
  lines.push('')
  lines.push(`_Generated ${opts.nowIso} — obj 700595. Read-only surfacing; nothing here is auto-closed unless explicitly noted._`)
  lines.push('')
  lines.push(`## Stale review (verdict=null, idle > ${opts.reviewStaleDays}d) — ${staleReview.length}`)
  lines.push('These finished-looking cards were never AI-reviewed and need a human decision. NOT auto-closed.')
  lines.push('')
  lines.push(...(staleReview.length ? staleReview.map(fmtRow) : ['- (none)']))
  lines.push('')
  lines.push(`## Stale manual queue (top-level, idle > ${opts.queueStaleDays}d) — ${staleQueue.length}`)
  lines.push('Manual holding-area cards nobody has started. The deliberate human gate — NOT auto-started or auto-closed.')
  lines.push('')
  lines.push(...(staleQueue.length ? staleQueue.map(fmtRow) : ['- (none)']))
  lines.push('')
  if (opts.applyHardExpiry) {
    lines.push(`## Hard-expired review items (verdict=null, > ${opts.hardExpiryDays}d) — ${hardExpiredIds.length}`)
    lines.push('The hard-expiry flag is ARMED — these verdict=null review items were soft-closed to done (pathway=review-hard-expiry):')
    lines.push('')
    lines.push(...(hardExpiredIds.length ? hardExpiredIds.map((id) => `- #${id} → done (review-hard-expiry)`) : ['- (none)']))
  } else {
    lines.push(`## Hard-expiry backstop — DISABLED (digest-only)`)
    lines.push(`Enable via settings.hygiene_review_hard_expiry_enabled=1 to soft-close verdict=null review items older than ${opts.hardExpiryDays}d.`)
  }
  lines.push('')

  return {
    markdown: lines.join('\n'),
    staleReviewCount: staleReview.length,
    staleQueueCount: staleQueue.length,
    hardExpiredIds,
  }
}

// 2b/2c writer wrapper — throttled to once per hour; writes the digest file. The
// hard-expiry mutation inside is flag-gated (DEFAULT OFF): digest-only by default.
let lastDigestWrite = 0
const DIGEST_WRITE_INTERVAL_MS = 60 * 60 * 1000

export function writeHygieneDigest(): void {
  const now = Date.now()
  if (now - lastDigestWrite < DIGEST_WRITE_INTERVAL_MS) return
  lastDigestWrite = now

  const db = getDb()
  try {
    const digest = buildHygieneDigest(db, {
      reviewStaleDays: reviewStaleTtlDays(),
      queueStaleDays: queueStaleTtlDays(),
      hardExpiryDays: reviewHardExpiryDays(),
      applyHardExpiry: isReviewHardExpiryEnabled(db),
      nowIso: new Date().toISOString(),
    })
    fs.mkdirSync(HYGIENE_DIGEST_DIR, { recursive: true })
    fs.writeFileSync(HYGIENE_DIGEST_PATH, digest.markdown, 'utf8')
    if (digest.hardExpiredIds.length > 0) {
      console.warn(
        `[state-poller] hygiene digest: hard-expiry ARMED closed ${digest.hardExpiredIds.length} verdict=null review item(s)`,
      )
    }
  } catch (err) {
    console.error('[state-poller] writeHygieneDigest failed:', (err as Error).message)
  }
}

