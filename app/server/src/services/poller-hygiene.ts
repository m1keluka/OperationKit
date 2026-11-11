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
import { scheduleObjectiveWorktreeReap } from './worktree-reaper.js'
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
import { noteStartReason } from './session-start-reasons.js'
import { fanoutManagedChildIds } from './fanout.js'

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
      noteStartReason(obj.id, 'queue_drain', 'top-level-queue-starter')
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
  // obj 715699 — children in an open fan-out group are started by the fan-out
  // tick under the group's own ceiling; starting them here would overshoot it.
  const managed = fanoutManagedChildIds(db)
  candidates = candidates.filter(c => !managed.has(c.id))
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
      noteStartReason(child.id, 'queue_drain', 'orphaned-child-starter')
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
      scheduleObjectiveWorktreeReap(obj.id, { db })
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
        scheduleObjectiveWorktreeReap(obj.id, { db })
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


// ── Zero-token review guard (obj 900510) ─────────────────────────────────────
//
// A worker that produced total_tokens=0, cost=$0 AND no last_session_summary
// never actually ran a model turn worth grading — a genuine turn burns tokens
// on the system prompt alone, so all-zero usage is a reliable signature of a
// session that died before (or without) the normal accounting pipeline running
// (see state-poller.ts's startup sweep fix, obj 900510, for one concrete cause:
// a session that finished in the few seconds a backend self-deploy paused the
// poller). Landing such a row in plain `review` with ai_review_verdict IS NULL
// is indistinguishable from a legitimate pending-human-review card — the
// operator has no way to tell "nothing happened, investigate" from "waiting on
// a human". This sweep makes that silent class VISIBLE: it never deletes or
// retries anything, it only stamps a `blocked` verdict + reason onto a row that
// already carries the all-zero signature, which the hygiene digest and the
// card UI already surface for any other `blocked` row.
//
// Naturally idempotent and self-terminating: once `ai_review_verdict` is set
// the row no longer matches `ai_review_verdict IS NULL`, so a repeat tick never
// re-touches it. delegate_mode is excluded — an orchestrator's "deliverable" is
// orchestration, not tokens, and it has its own parked lifecycle.
export function selectZeroTokenReviewCandidates(db: Database): Objective[] {
  return db
    .prepare(
      `SELECT * FROM objectives
        WHERE status = 'review'
          AND delegate_mode = 0
          AND ai_review_verdict IS NULL
          AND total_tokens = 0
          AND total_cost_usd = 0
          AND last_session_summary IS NULL
          AND deleted_at IS NULL
        ORDER BY updated_at ASC`,
    )
    .all() as Objective[]
}

/**
 * Pure(ish) core: stamp a visible `blocked` verdict on every row
 * {@link selectZeroTokenReviewCandidates} returns. Separated from the throttled
 * `sweepZeroTokenReview` wrapper below (same split as `buildHygieneDigest` /
 * `writeHygieneDigest`) so the actual behavior is unit-testable without fighting
 * a module-level timer.
 */
export function applyZeroTokenReviewBlock(
  db: Database,
  opts: { isSessionAlive?: (sessionId: string) => boolean } = {},
): void {
  const candidates = selectZeroTokenReviewCandidates(db)
  for (const obj of candidates) {
    // obj 900372 — a card moved to `review` while its worker is still running
    // (worker/bot PATCH, CI gate) keeps its session_id until the process exits,
    // and the review session_id sweep accounts its usage THEN (#900371). Its
    // tokens are legitimately still 0 until that happens, so it is not a
    // zero-token death yet — re-checked on the next sweep.
    if (obj.session_id && opts.isSessionAlive) {
      let alive = false
      try { alive = opts.isSessionAlive(obj.session_id) } catch { alive = false }
      if (alive) continue
    }
    const reason =
      'Session ended with 0 recorded tokens, $0 cost, and no summary — the worker ' +
      'never completed a model turn the usual accounting pipeline could extract ' +
      '(e.g. it died during a backend restart window, or crashed before producing ' +
      'any output). Not a deliverable; needs manual investigation rather than human review.'
    db.prepare(
      "UPDATE objectives SET ai_review_verdict = 'blocked', ai_review_findings = ?, updated_at = datetime('now') WHERE id = ? AND ai_review_verdict IS NULL",
    ).run(reason, obj.id)
    try {
      db.prepare(
        "INSERT INTO activity_log (project, workspace, objective_id, session_id, event_type, title, detail) VALUES (?, ?, ?, ?, 'milestone', 'zero_token_review_blocked', ?)",
      ).run(obj.project || 'unknown', obj.workspace, obj.id, obj.session_id, reason)
    } catch (err) {
      console.error(`[state-poller] Failed to log zero-token-review block for obj ${obj.id}:`, err)
    }
    console.warn(
      `[state-poller] Objective ${obj.id} (${obj.session_id ?? 'no session'}) landed in review with 0 tokens / $0 cost / no summary — blocking with a visible reason instead of a silent review.`,
    )
    const updated = db.prepare('SELECT * FROM objectives WHERE id = ?').get(obj.id) as Objective
    if (updated) broadcast({ type: 'objective_updated', payload: updated })
  }
}

let lastZeroTokenReviewSweep = 0
const ZERO_TOKEN_REVIEW_SWEEP_INTERVAL_MS = 60 * 1000

/**
 * Throttled wrapper the poll loop calls every tick (cheap indexed query, but no
 * reason to run it every 3s). See {@link applyZeroTokenReviewBlock} for the
 * actual behavior.
 */
export async function sweepZeroTokenReview(
  opts: { isSessionAlive?: (sessionId: string) => boolean } = {},
): Promise<void> {
  const now = Date.now()
  if (now - lastZeroTokenReviewSweep < ZERO_TOKEN_REVIEW_SWEEP_INTERVAL_MS) return
  lastZeroTokenReviewSweep = now
  applyZeroTokenReviewBlock(getDb(), opts)
}
