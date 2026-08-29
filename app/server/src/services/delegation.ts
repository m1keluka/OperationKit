import fs from 'fs'
import { getDb } from '../db/index.js'
import { isStrategyTierEnabled } from './strategy-governance.js'
import { runMachineStatusUpdate } from '../lib/status-lock.js'
import type { Objective } from '@command-center/shared'

// Wake-on-completion for delegator orchestration.
//
// A delegator-mode objective (delegate_mode === true) decomposes its work
// into child worker objectives (parent_id = the delegator's id). When a worker
// session finishes and session-intel has summarized it, wakeDelegator() is
// called. It does two things:
//   1. Appends the worker's result to the delegator's NOTES.md — the durable
//      truth. The delegator reconstructs its full state from this on every wake.
//   2. Fires a single, debounced sendFollowUp nudge so the delegator resumes and
//      processes the finished worker(s) — no polling, no wasted budget.
//
// The NOTES.md append is authoritative; the nudge is best-effort. Coalescing
// several near-simultaneous completions into one wake therefore loses nothing —
// the woken delegator sees every appended [child-complete] entry at once.
//
// P0-1 (obj 707004) closed the READ half of that promise. Before it, the claim
// above was only true if the delegator voluntarily re-read NOTES.md: the server
// wrote the file and never read it back, and the wake message named zero
// children. Combined with a debounce that coalesced N completions into ONE wake,
// a delegator could silently drop finished work (measured: delegator 706936
// double-spawned W3 as 706948/706949). Now fireWake() re-reads the parent's
// NOTES.md, emits EVERY [child-complete] block appended since the previous wake
// inline in the follow-up, and prefixes an explicit
// "N children complete since your last wake, M summarized below" count line so a
// shortfall is detectable by the delegator instead of invisible.

// Overridable via CC_OBJ_MEMORY_BASE so tests can point the NOTES.md append at a
// scratch dir instead of the real objective-memory tree. Defaults to prod path.
const OBJ_MEMORY_BASE = process.env.CC_OBJ_MEMORY_BASE || '/home/operator/ai-workspace/objective-memory'
const WAKE_DEBOUNCE_MS = 4000

// Strategy Layer dark-launch flag — now the ONE shared helper (isStrategyTierEnabled,
// env CC_STRATEGY_TIER OR settings.strategy_tier_enabled). Read at the point of use
// (mirrors routes/internal.ts / state-poller / prompt-builder). When off, the wake
// message is the original worker-oriented [child-complete] text — byte-identical.

/**
 * A strategy node is a delegator whose CHILDREN are themselves delegators
 * (projects), i.e. it orchestrates projects rather than tasks. We detect it by
 * the children's delegate_mode — NOT by depth alone, because an ordinary
 * top-level delegator is also depth 0/delegate_mode 1 and must keep the original
 * worker-oriented wake message.
 */
export function isStrategyNode(db: ReturnType<typeof getDb>, parentId: number): boolean {
  const row = db
    .prepare('SELECT 1 AS x FROM objectives WHERE parent_id = ? AND delegate_mode = 1 LIMIT 1')
    .get(parentId) as { x: number } | undefined
  return !!row
}

/** The [child-complete] payload fireWake() carries into a wake message. */
export interface PendingChildResults {
  /** Rendered `### [child-complete] …` blocks, in NOTES.md order. */
  blocks: string[]
  /** How many children completed since the previous wake (may exceed blocks.length). */
  completeCount: number
  /** Total [child-complete] blocks present in the parent's NOTES.md. */
  totalInNotes?: number
}

/** Hard ceiling on inlined blocks so one wake can't blow the prompt budget. */
const MAX_INLINE_BLOCKS = 20

/**
 * The follow-up message sent to a re-woken delegator. A strategy node (P3) runs
 * the PROJECT decision loop; an ordinary delegator runs the worker accept/iterate
 * loop. The non-strategy branch is the exact pre-P3 text (flag-off equivalence)
 * whenever `pending` is omitted or carries nothing.
 *
 * When `pending` is supplied, EVERY pending block is emitted (P0-1) under an
 * explicit count line, so the delegator can compare "N children complete" against
 * the blocks it can actually see and detect a shortfall rather than assume it saw
 * everything.
 */
export function buildWakeMessage(
  isStrategy: boolean,
  trustStage = 0,
  pending?: PendingChildResults,
): string {
  const head = buildWakeHeader(isStrategy, trustStage)
  const tail = renderPendingSection(pending)
  return tail ? `${head}\n${tail}` : head
}

/**
 * The count line + inlined blocks. Returns '' when there is nothing pending, so
 * the message stays byte-identical to the pre-P0-1 text in that case.
 */
export function renderPendingSection(pending?: PendingChildResults): string {
  if (!pending || pending.completeCount <= 0) return ''
  const blocks = pending.blocks.slice(-MAX_INLINE_BLOCKS)
  const n = pending.completeCount
  const m = blocks.length
  const lines = [
    '',
    `${n} ${n === 1 ? 'child' : 'children'} complete since your last wake, ${m} summarized below` +
      (pending.totalInNotes != null ? ` (${pending.totalInNotes} total in NOTES.md).` : '.'),
  ]
  if (m < n) {
    lines.push(
      `SHORTFALL: ${n - m} completed ${n - m === 1 ? 'child is' : 'children are'} NOT inlined here — read NOTES.md for the rest before deciding.`,
    )
  }
  lines.push('', ...blocks.map(b => b.trim()))
  return lines.join('\n')
}

function buildWakeHeader(isStrategy: boolean, trustStage = 0): string {
  if (isStrategy) {
    // At trust_stage<=0 the human gate is ARMED and HARD-enforced server-side: the
    // batch spawn route REFUSES any project spawn that lacks an owner-approved
    // Decision Request (obj 700030, Part B). So the wake instructs the strategy to
    // park EVERY project decision — not merely "if armed". Stage 1+ (not yet wired)
    // would relax this; today every live strategy is stage 0.
    const gateArmed = (trustStage ?? 0) <= 0
    const gateLine = gateArmed
      ? 'The human gate IS ARMED: you may NOT spawn a project directly. PARK a Decision Request (POST /api/internal/objectives/<your-id>/decision) for the next project and await Operator’s approval — the spawn route will refuse you otherwise.'
      : 'If a human gate is armed for this decision, PAUSE and request sign-off instead of spawning.'
    return [
      '[project-complete] One or more of your PROJECTS has finished.',
      'Read your NOTES.md — the PROJECT REGISTRY and the appended [child-complete] entries hold each project outcome.',
      'Run the DECISION LOOP: pull the finished project’s result + metrics, judge whether it moved the strategy goal,',
      'then decide the NEXT project (spawn ONE, delegate_mode:true) — or, if the goal is met, write your final synthesis and stop.',
      'Spawn AT MOST ONE new project per wake unless explicitly batching. Update NOTES.md, then end your turn.',
      gateLine,
    ].join('\n')
  }
  return [
    '[child-complete] One or more of your worker objectives has finished.',
    'Read your NOTES.md — the CHILD REGISTRY and the appended [child-complete] entries hold the latest worker outcomes.',
    'For each finished worker: evaluate its summary/output, then ACCEPT (mark it done), ITERATE (send corrections), or ESCALATE.',
    'Spawn the next queued worker if you are under 5 in flight. Update NOTES.md, then end your turn.',
    'If every worker is accepted or escalated, write your final synthesis and stop.',
  ].join('\n')
}

// Per-parent timers: coalesce bursts of completions AND prevent duplicate
// --resume respawns when multiple workers finish within the debounce window.
const pendingWake = new Map<number, ReturnType<typeof setTimeout>>()

// P0-1: in-memory mirror of the [child-complete] blocks appended since this
// parent's last successful wake. NOTES.md is the durable truth and is what
// fireWake prefers; this set is the fallback for when the file is unreadable
// (permissions, a wiped objective-memory dir) so a coalesced burst still names
// every child. Never drained by a SKIPPED wake — a parent parked in review keeps
// its pending children until it is genuinely revived.
const pendingChildren = new Map<number, { id: number; block: string }[]>()

/** Rendered NOTES.md entry for one completed child. Shared by the append and the wake. */
export function formatChildEntry(child: Objective): string {
  const verdict = (child as Objective & { ai_review_verdict?: string | null }).ai_review_verdict
  const reviewFindings = (child as Objective & { ai_review_findings?: string | null }).ai_review_findings
  return [
    '',
    `### [child-complete] #${child.id} — ${child.title}`,
    `- when: ${new Date().toISOString()}`,
    `- status: ${child.status}`,
    ...(verdict ? [`- independent_review: ${verdict.toUpperCase()}${verdict === 'pass' ? ' — passed, safe to accept (mark done)' : ' — did NOT pass; escalate or re-scope, do not silently accept'}`] : []),
    `- summary: ${child.last_session_summary || '(none extracted)'}`,
    ...(verdict && verdict !== 'pass' && reviewFindings ? [`- review_findings: ${reviewFindings.slice(0, 500)}`] : []),
    ...(child.has_blockers ? ['- has_blockers: yes — review before accepting'] : []),
    '',
  ].join('\n')
}

export function notesPathFor(parentId: number): string {
  return `${OBJ_MEMORY_BASE}/${parentId}/NOTES.md`
}

export function appendChildResult(parentId: number, child: Objective): void {
  const dir = `${OBJ_MEMORY_BASE}/${parentId}`
  const notes = `${dir}/NOTES.md`
  const entry = formatChildEntry(child)
  // Record in the pending set FIRST: even if the filesystem write fails, the
  // next wake still names this child instead of silently dropping it.
  const bucket = pendingChildren.get(parentId) ?? []
  if (!bucket.some(b => b.id === child.id)) bucket.push({ id: child.id, block: entry })
  pendingChildren.set(parentId, bucket)
  try {
    fs.mkdirSync(dir, { recursive: true })
    try { fs.chmodSync(dir, 0o777) } catch {}
    fs.appendFileSync(notes, entry)
    try { fs.chmodSync(notes, 0o666) } catch {}
  } catch (err) {
    console.warn(`[delegation] failed to append child result to ${notes}:`, (err as Error).message)
  }
}

/**
 * The READ half (P0-1 / G2). Parses every `### [child-complete] …` block out of a
 * delegator's NOTES.md. Exported so the parse is unit-testable independently of
 * the filesystem.
 */
export function parseChildCompleteBlocks(notesText: string): string[] {
  const blocks: string[] = []
  let current: string[] | null = null
  for (const line of notesText.split('\n')) {
    if (line.startsWith('### [child-complete]')) {
      if (current) blocks.push(current.join('\n').trimEnd())
      current = [line]
    } else if (current) {
      // A new non-child-complete heading ends the block.
      if (/^#{1,3} /.test(line)) {
        blocks.push(current.join('\n').trimEnd())
        current = null
      } else {
        current.push(line)
      }
    }
  }
  if (current) blocks.push(current.join('\n').trimEnd())
  return blocks
}

/** Reads and parses the parent's NOTES.md [child-complete] blocks. [] if unreadable. */
export function readChildCompleteBlocks(parentId: number): string[] {
  try {
    return parseChildCompleteBlocks(fs.readFileSync(notesPathFor(parentId), 'utf8'))
  } catch {
    return []
  }
}

// How many NOTES.md [child-complete] blocks this parent had already been shown.
// Blocks beyond this index are "since the last wake".
const notesBlocksDelivered = new Map<number, number>()

/**
 * Collect everything this parent should be told about on THIS wake, preferring
 * the durable NOTES.md read-back and falling back to the in-memory pending set.
 * Pure-ish: does not mutate the delivered marker (see commitWakeDelivery).
 */
export function collectPendingForWake(parentId: number): PendingChildResults & { notesTotal: number } {
  const notesBlocks = readChildCompleteBlocks(parentId)
  const alreadyDelivered = notesBlocksDelivered.get(parentId) ?? 0
  // A NOTES.md that shrank (rotated/rewritten by the delegator) must not make the
  // slice negative-length; clamp the marker to the current file.
  const since = Math.min(alreadyDelivered, notesBlocks.length)
  const fresh = notesBlocks.slice(since)
  const memory = pendingChildren.get(parentId) ?? []

  if (fresh.length > 0) {
    // Durable path. A child whose append FAILED exists only in memory — union it
    // in so a filesystem hiccup can't drop it.
    const seen = new Set(fresh.map(b => childIdOf(b)).filter((v): v is number => v != null))
    const extra = memory.filter(m => !seen.has(m.id)).map(m => m.block.trim())
    const blocks = [...fresh, ...extra]
    return { blocks, completeCount: blocks.length, totalInNotes: notesBlocks.length, notesTotal: notesBlocks.length }
  }
  // NOTES.md unreadable or nothing new in it — fall back entirely to memory.
  const blocks = memory.map(m => m.block.trim())
  return { blocks, completeCount: blocks.length, totalInNotes: notesBlocks.length, notesTotal: notesBlocks.length }
}

function childIdOf(block: string): number | null {
  const m = /^### \[child-complete\] #(\d+)/.exec(block)
  return m ? Number(m[1]) : null
}

/** Mark this wake's payload as delivered — drains the pending set for the parent. */
function commitWakeDelivery(parentId: number, notesTotal: number): void {
  notesBlocksDelivered.set(parentId, notesTotal)
  pendingChildren.delete(parentId)
}

/** Test seam: reset all per-parent wake bookkeeping. */
export function __resetDelegationState(): void {
  for (const t of pendingWake.values()) clearTimeout(t)
  pendingWake.clear()
  pendingChildren.clear()
  notesBlocksDelivered.clear()
  lastNudgeAt.clear()
}

/**
 * Called when a child worker session has finished and been summarized. If the
 * child belongs to a delegator, records the result in the delegator's NOTES.md
 * and schedules a debounced wake.
 */
export function wakeDelegator(parentId: number, child: Objective): void {
  const db = getDb()
  const parent = db.prepare('SELECT * FROM objectives WHERE id = ?').get(parentId) as Objective | undefined
  if (!parent || !parent.delegate_mode) return

  // A worker entering independent review (`ai_review`) is NOT yet a result to act
  // on — its execution session ended but the reviewer's verdict is pending. The
  // review poll re-calls wakeDelegator with the terminal verdict, so skip now to
  // avoid waking the delegator mid-review.
  if (child.status === 'ai_review') return

  // 1. Durable truth first — survives a missed/coalesced nudge or a restart.
  appendChildResult(parentId, child)

  // 2. Debounced nudge.
  nudgeDelegator(parentId)
}

// When fireWake last actually revived each delegator — lets the reconcile pass
// throttle its safety-net nudges so it doesn't tight-loop a delegator that wakes
// but (by its own criteria) chooses not to accept a worker yet.
const lastNudgeAt = new Map<number, number>()

/** True if this delegator was revived within the last `withinMs`. */
export function recentlyNudged(parentId: number, withinMs: number): boolean {
  const t = lastNudgeAt.get(parentId)
  return t != null && Date.now() - t < withinMs
}

/**
 * Pure decision for the reconcile safety net (state-poller). Given a delegator's
 * children and the signature it was last nudged for, decide whether there is a
 * *new* actionable state worth waking it for.
 *
 * Why a signature: `allDone` and a stuck `review` worker are STABLE states, not
 * events. A delegator that finishes every worker but parks in `review` (e.g.
 * awaiting Operator's decision) stays all-done forever — so a per-cycle "all done →
 * nudge" check re-wakes it every poll, a wake storm that burns budget and floods
 * the thread with "stale duplicate wake" turns. By nudging only when the child
 * signature CHANGES, a genuinely new completion still wakes the delegator while a
 * settled state is left alone. Pure (no DB, no timers) so it is unit-tested.
 */
export function reconcileDecision(
  kids: { id: number; status: string }[],
  lastSig: string | undefined,
): { actionable: boolean; changed: boolean; sig: string; why: string } {
  const awaiting = kids.filter(k => k.status === 'review').length
  // Children sitting in `queue` need the delegator awake to spawn them. Without
  // this, a delegator that finished an all-done batch and then had new workers
  // queued (a follow-up wave) parked forever: no child was in `review` and the
  // set wasn't all-done, so the net never fired and the queued workers never
  // started. (obj 938/1017 stuck 10+h — 2026-06-22)
  const queued = kids.filter(k => k.status === 'queue').length
  const allDone = kids.length > 0 && kids.every(k => k.status === 'done')
  const actionable = awaiting > 0 || queued > 0 || allDone
  // Order-independent signature of every child's status (SQLite row order varies).
  const sig = kids.map(k => `${k.id}:${k.status}`).sort().join(',')
  const why = awaiting > 0
    ? `${awaiting} worker(s) awaiting processing`
    : queued > 0 ? `${queued} worker(s) queued to spawn`
    : allDone ? 'all workers done — synthesize' : ''
  return { actionable, changed: lastSig !== sig, sig, why }
}

/**
 * Schedule a debounced revive of a delegator. Used both by the event path
 * (wakeDelegator, on a real child completion) and the reconcile safety net
 * (poller, for any missed wake). Coalesces bursts within WAKE_DEBOUNCE_MS.
 */
export function nudgeDelegator(parentId: number): void {
  // If a nudge is already scheduled, let it fire — don't reset the timer (a
  // caller polling faster than the debounce would otherwise starve it forever).
  //
  // P0-1: this deliberately does NOT reset the armed timer (resetting is the
  // starvation bug the comment above warns about). Instead the drop is fixed at
  // the OTHER end: fireWake DRAINS the pending set / re-reads NOTES.md at fire
  // time, so every child that completed anywhere inside the window — before or
  // after the timer was armed — is carried by the single coalesced wake.
  if (pendingWake.has(parentId)) return
  const timer = setTimeout(() => {
    pendingWake.delete(parentId)
    void fireWake(parentId)
  }, WAKE_DEBOUNCE_MS)
  pendingWake.set(parentId, timer)
}

/**
 * Cancel a scheduled (debounced) wake for a delegator. Used when a human stops
 * the objective: without this, a `[child-complete]` ping that already armed the
 * debounce timer would fire a respawn right after the stop. The `review`-status
 * guard in fireWake is the durable backstop; this just avoids the noisy
 * immediately-after-stop respawn.
 */
export function cancelDelegatorWake(parentId: number): void {
  const timer = pendingWake.get(parentId)
  if (timer) {
    clearTimeout(timer)
    pendingWake.delete(parentId)
  }
}

export async function fireWake(parentId: number): Promise<void> {
  const db = getDb()
  const parent = db.prepare('SELECT * FROM objectives WHERE id = ?').get(parentId) as Objective | undefined
  if (!parent || !parent.delegate_mode) return
  // Don't re-wake a delegator that's already done with its whole objective.
  if (parent.status === 'done' || parent.status === 'cancelled') return
  // Don't auto-resurrect a delegator that's parked in `review` — that means a
  // human has it (either an explicit Stop, or a finished synthesis awaiting
  // sign-off). A normal orchestrating delegator sits in `working` (dormant
  // parking keeps it `working` with a null session), so this only blocks the
  // unwanted re-wake loop where late `[child-complete]` pings kept dragging a
  // stopped/parked delegator back into `working`. (2026-06-22 stop-button fix)
  if (parent.status === 'review') {
    console.log(`[delegation] skip wake for delegator #${parentId} — parked in review (human-owned)`)
    return
  }

  try {
    // Lazy import to avoid a module-load cycle:
    // session-manager -> session-intel -> delegation -> session-manager.
    const { sendFollowUp } = await import('./session-manager.js')
    const sessionId = parent.session_id || `cc-${parentId}-${Date.now()}`
    // P3: a depth-0 strategy node (flag on, children are delegators) gets the
    // PROJECT decision-loop message; everything else gets the original
    // worker-oriented [child-complete] text. Flag off ⇒ always the original.
    const isStrategy = isStrategyTierEnabled(db) && isStrategyNode(db, parentId)
    // READ HALF (P0-1): re-read the parent's NOTES.md and carry EVERY
    // [child-complete] block appended since the previous wake, so a burst that
    // coalesced into this one wake names all of its children.
    const pending = collectPendingForWake(parentId)
    const msg = buildWakeMessage(isStrategy, parent.trust_stage ?? 0, pending)
    const newSessionId = sendFollowUp(sessionId, msg, parent)
    runMachineStatusUpdate(
      db,
      "UPDATE objectives SET status = 'working', session_id = ?, updated_at = datetime('now') WHERE id = ?",
      newSessionId,
      parentId,
    )
    // Only drain AFTER the follow-up was actually accepted — a throw above leaves
    // the pending children armed for the next wake instead of losing them.
    commitWakeDelivery(parentId, pending.notesTotal)
    lastNudgeAt.set(parentId, Date.now())
    console.log(
      `[delegation] woke delegator #${parentId} (session ${newSessionId}) — ${pending.completeCount} child result(s) carried`,
    )
  } catch (err) {
    console.warn(`[delegation] wake failed for parent #${parentId}:`, (err as Error).message)
  }
}
