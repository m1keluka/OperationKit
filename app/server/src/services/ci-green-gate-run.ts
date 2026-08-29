/**
 * CI-green gate durable state, runCompletionGate, handback, and digest —
 * extracted from ci-green-gate.ts (behavior frozen).
 *
 * Pure decision lives in ci-green-gate-decide.ts; GitHub IO in
 * ci-green-gate-github.ts.
 */
import type { Database } from 'better-sqlite3'
import { skipMachineStatusWrite, runMachineStatusUpdate } from '../lib/status-lock.js'
import {
  type CiGateDecision,
  type ExecFn,
  type GateMode,
  buildHandback,
  evaluateCiGate,
  loadConfig,
} from './ci-green-gate-decide.js'
import {
  defaultExec,
  fetchPrCheckState,
  fetchRequiredChecks,
} from './ci-green-gate-github.js'

// ── Durable state ───────────────────────────────────────────────────────────────

/**
 * One row per objective that has ever hit the gate. This table is simultaneously:
 *  - the bounded-wait clock (`first_seen_at`),
 *  - the hold-cycle counter (`hold_count`, monotonic — never reset by a new commit,
 *    or a worker could push in a loop and reset its own bound),
 *  - and the durable record of every objective that completed on a non-green PR
 *    (`resolution` + `resolution_reason`), which is what the digest renders.
 */
export function ensureGateTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS objective_completion_gate (
      objective_id      INTEGER PRIMARY KEY,
      repo              TEXT,
      pr_number         INTEGER,
      pr_url            TEXT,
      head_sha          TEXT,
      first_seen_at     TEXT NOT NULL DEFAULT (datetime('now')),
      last_evaluated_at TEXT,
      hold_count        INTEGER NOT NULL DEFAULT 0,
      last_action       TEXT,
      last_reason       TEXT,
      required_checks   TEXT,
      required_source   TEXT,
      failing_checks    TEXT,
      missing_checks    TEXT,
      advisory_red      TEXT,
      pathway           TEXT,
      resolution        TEXT,
      resolution_reason TEXT,
      resolved_at       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_completion_gate_resolution
      ON objective_completion_gate(resolution);
  `)
}

export interface GateRow {
  objective_id: number
  repo: string | null
  pr_number: number | null
  pr_url: string | null
  head_sha: string | null
  first_seen_at: string
  last_evaluated_at: string | null
  hold_count: number
  last_action: string | null
  last_reason: string | null
  required_checks: string | null
  required_source: string | null
  failing_checks: string | null
  missing_checks: string | null
  advisory_red: string | null
  pathway: string | null
  resolution: string | null
  resolution_reason: string | null
  resolved_at: string | null
}

export function getGateRow(db: Database, objectiveId: number): GateRow | undefined {
  ensureGateTable(db)
  return db
    .prepare('SELECT * FROM objective_completion_gate WHERE objective_id = ?')
    .get(objectiveId) as GateRow | undefined
}

// ── Objective → PR resolution ───────────────────────────────────────────────────

/** `https://github.com/OWNER/REPO/pull/123` → `OWNER/REPO`. */
export function repoFromPrUrl(prUrl: string | null | undefined): string | null {
  if (!prUrl) return null
  const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/\d+/.exec(prUrl)
  return m ? `${m[1]}/${m[2]}` : null
}

export interface GateObjective {
  id: number
  title?: string | null
  pr_number?: number | null
  pr_url?: string | null
  session_id?: string | null
  status?: string | null
  workspace?: string | null
  project?: string | null
}

// ── The gate, end to end ────────────────────────────────────────────────────────

export interface RunGateOptions {
  mode?: GateMode
  /** Which done-path called us. Recorded, and rendered in the digest. */
  pathway: string
  exec?: ExecFn
  env?: NodeJS.ProcessEnv
  now?: () => Date
  /** Injected so this module never imports the notifier in tests. */
  alert?: (args: { severity: 'normal' | 'high' | 'emergency'; title: string; message: string; source: string; dedup_key: string; url?: string }) => unknown
}

export interface GateResult {
  decision: CiGateDecision
  /** True ⇒ the caller must NOT complete the objective. */
  blocked: boolean
  /** Present when blocked — the concrete instruction to hand the owner. */
  handback: string | null
  repo: string | null
  prNumber: number | null
  prUrl: string | null
}

const ALLOW_NOOP = (reason: string): GateResult => ({
  decision: {
    action: 'allow', reason, failingRequired: [], missingRequired: [], advisoryRed: [],
    requiredChecks: [], requiredSource: 'none', holdCount: 0, waitedMinutes: 0,
  },
  blocked: false, handback: null, repo: null, prNumber: null, prUrl: null,
})

/**
 * Evaluate the CI-green gate for one objective about to complete, and persist the
 * outcome. Call this from EVERY path that moves an objective to `done`.
 *
 * Never throws. Any failure resolves to `allow` (fail-open) — see the module header.
 */
export async function runCompletionGate(
  db: Database,
  obj: GateObjective,
  opts: RunGateOptions,
): Promise<GateResult> {
  const mode = opts.mode ?? 'enforce'
  const exec = opts.exec ?? defaultExec
  const nowFn = opts.now ?? (() => new Date())
  const config = loadConfig(db, opts.env ?? process.env)

  if (!config.enabled) return ALLOW_NOOP('CI-green gate disabled (ci_green_gate_enabled=0).')

  const prNumber = obj.pr_number ?? null
  const repo = repoFromPrUrl(obj.pr_url)
  if (!prNumber || !repo) return ALLOW_NOOP('Objective has no associated PR — nothing to gate on.')

  try {
    ensureGateTable(db)
    const now = nowFn()
    db.prepare(
      `INSERT INTO objective_completion_gate (objective_id, repo, pr_number, first_seen_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(objective_id) DO UPDATE SET repo = excluded.repo, pr_number = excluded.pr_number`,
    ).run(obj.id, repo, prNumber, now.toISOString())
    const row = getGateRow(db, obj.id)!

    const pr = await fetchPrCheckState(repo, prNumber, exec)
    const required = await fetchRequiredChecks(repo, pr.baseRef, exec, () => now.getTime())

    const waitedMinutes = Math.max(0, (now.getTime() - new Date(row.first_seen_at).getTime()) / 60000)
    const decision = evaluateCiGate({
      requiredChecks: required,
      rollup: pr.rollup,
      holdCount: row.hold_count,
      waitedMinutes,
      mode,
      config,
    })

    const blocked = decision.action === 'hold' || decision.action === 'escalate'
    const resolution =
      decision.action === 'allow' ? 'green'
        : decision.action === 'complete-with-red' ? 'completed-with-red'
          : decision.action === 'escalate' ? 'escalated'
            : null // 'hold' is not a resolution — the objective is still open

    db.prepare(
      `UPDATE objective_completion_gate SET
         pr_url = ?, head_sha = ?, last_evaluated_at = ?,
         hold_count = hold_count + ?, last_action = ?, last_reason = ?,
         required_checks = ?, required_source = ?, failing_checks = ?, missing_checks = ?,
         advisory_red = ?, pathway = ?,
         resolution = ?, resolution_reason = ?, resolved_at = ?
       WHERE objective_id = ?`,
    ).run(
      pr.url, pr.headSha, now.toISOString(),
      decision.action === 'hold' ? 1 : 0,
      decision.action, decision.reason,
      JSON.stringify(decision.requiredChecks), decision.requiredSource,
      JSON.stringify(decision.failingRequired), JSON.stringify(decision.missingRequired),
      JSON.stringify(decision.advisoryRed), opts.pathway,
      resolution, resolution ? decision.reason : null, resolution ? now.toISOString() : null,
      obj.id,
    )

    if (decision.action === 'escalate' && opts.alert) {
      try {
        opts.alert({
          severity: 'high',
          source: 'ci-green-gate',
          title: `Objective ${obj.id} hit the CI-gate hold cap on a failing PR`,
          message:
            `${obj.title ?? '(untitled)'}\n\n${pr.url}\n\n${decision.reason}\n\n` +
            `It has been handed back ${decision.holdCount} time(s) and the required check(s) are still failing. ` +
            `It will not be bounced again — this needs you.`,
          dedup_key: `ci-green-gate:${repo}#${prNumber}`,
          url: pr.url,
        })
      } catch { /* an alert failure must never wedge completion */ }
    }

    if (decision.action !== 'allow') {
      console.warn(
        `[ci-green-gate] obj ${obj.id} ${repo}#${prNumber} pathway=${opts.pathway} ` +
        `action=${decision.action} — ${decision.reason}`,
      )
    }

    return {
      decision,
      blocked,
      handback: blocked ? buildHandback(decision, repo, prNumber) : null,
      repo,
      prNumber,
      prUrl: pr.url,
    }
  } catch (err) {
    // FAIL-OPEN. A gate that can wedge the board on its own bug is worse than no gate.
    const msg = (err as Error).message
    console.error(`[ci-green-gate] obj ${obj.id} evaluation failed (fail-open):`, msg)
    try {
      ensureGateTable(db)
      db.prepare(
        `UPDATE objective_completion_gate
           SET last_action = 'error', last_reason = ?, resolution = 'completed-unverified',
               resolution_reason = ?, resolved_at = datetime('now'), pathway = ?
         WHERE objective_id = ?`,
      ).run(`gate error: ${msg}`, `CI-green gate could not evaluate this PR (${msg}); completed unverified.`, opts.pathway, obj.id)
    } catch { /* recording is best-effort */ }
    return ALLOW_NOOP(`CI-green gate errored (${msg}) — failing open.`)
  }
}

// ── Handback ────────────────────────────────────────────────────────────────────

export interface HandbackDeps {
  // `any` (not `unknown`) is deliberate: these are the CONCRETE
  // session-manager.sendFollowUp / ws.broadcast functions, whose parameters are
  // narrower types (Objective, ServerMessage). An `unknown` parameter would reject
  // them contravariantly. Injected rather than imported to keep this module free of
  // an import cycle with session-manager.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  sendFollowUp?: (sessionId: string, message: string, obj: any) => string
  broadcast?: (msg: any) => void
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/**
 * Apply a blocked decision to the objective. Mirrors the deterministic-floor bounce so
 * every gate in this codebase feels the same from a worker's seat:
 *   - `hold` with a live session  → back to `working` with the failing check names.
 *   - `hold` with no session      → parked in `review` with the findings.
 *   - `escalate`                  → ALWAYS parked in `review`. The cap exists precisely
 *                                   to stop the worker→review bounce, so never respawn.
 * Returns the status the objective was left in.
 */
export function applyGateHandback(
  db: Database,
  obj: GateObjective,
  result: GateResult,
  deps: HandbackDeps = {},
): 'working' | 'review' {
  const findings = result.handback ?? result.decision.reason
  if (skipMachineStatusWrite(db, obj.id)) return 'review'
  db.prepare(
    "UPDATE objectives SET ai_review_verdict = 'fail', ai_review_findings = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(findings, obj.id)

  let landed: 'working' | 'review' = 'review'
  if (result.decision.action === 'hold' && obj.session_id && deps.sendFollowUp) {
    try {
      const newSessionId = deps.sendFollowUp(obj.session_id, findings, obj)
      runMachineStatusUpdate(
        db,
        "UPDATE objectives SET status = 'working', session_id = ?, updated_at = datetime('now') WHERE id = ?",
        newSessionId,
        obj.id,
      )
      landed = 'working'
    } catch {
      runMachineStatusUpdate(
        db,
        "UPDATE objectives SET status = 'review', updated_at = datetime('now') WHERE id = ?",
        obj.id,
      )
    }
  } else {
    runMachineStatusUpdate(
      db,
      "UPDATE objectives SET status = 'review', updated_at = datetime('now') WHERE id = ?",
      obj.id,
    )
  }

  if (deps.broadcast) {
    try {
      const updated = db.prepare('SELECT * FROM objectives WHERE id = ?').get(obj.id)
      deps.broadcast({ type: 'objective_updated', payload: updated })
    } catch { /* best effort */ }
  }
  return landed
}

// ── Operator-facing surface ─────────────────────────────────────────────────────────

export interface CompletedWithRedEntry {
  objectiveId: number
  title: string | null
  status: string | null
  repo: string | null
  prNumber: number | null
  prUrl: string | null
  resolution: string
  reason: string | null
  pathway: string | null
  holdCount: number
  failingChecks: string[]
  missingChecks: string[]
  resolvedAt: string | null
}

function parseList(raw: string | null): string[] {
  if (!raw) return []
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v as string[] : [] } catch { return [] }
}

/**
 * Every objective that reached a terminal state on a PR that was NOT green, newest
 * first. `escalated` rows are included: they are the ones that need Operator personally.
 */
export function listNonGreenCompletions(db: Database, limit = 30): CompletedWithRedEntry[] {
  ensureGateTable(db)
  const rows = db.prepare(
    `SELECT g.*, o.title AS obj_title, o.status AS obj_status
       FROM objective_completion_gate g
       LEFT JOIN objectives o ON o.id = g.objective_id
      WHERE g.resolution IN ('completed-with-red', 'escalated', 'completed-unverified')
      ORDER BY COALESCE(g.resolved_at, g.last_evaluated_at) DESC
      LIMIT ?`,
  ).all(limit) as (GateRow & { obj_title: string | null; obj_status: string | null })[]
  return rows.map(r => ({
    objectiveId: r.objective_id,
    title: r.obj_title,
    status: r.obj_status,
    repo: r.repo,
    prNumber: r.pr_number,
    prUrl: r.pr_url,
    resolution: r.resolution!,
    reason: r.resolution_reason ?? r.last_reason,
    pathway: r.pathway,
    holdCount: r.hold_count,
    failingChecks: parseList(r.failing_checks),
    missingChecks: parseList(r.missing_checks),
    resolvedAt: r.resolved_at,
  }))
}

const RESOLUTION_LABEL: Record<string, string> = {
  'escalated': '🚨 ESCALATED — hold cap hit, required check still failing',
  'completed-with-red': '⚠️  Completed with a non-green PR',
  'completed-unverified': '❓ Completed unverified — the gate could not read the PR',
}

/**
 * Markdown section appended to the pr-health digest. It answers, without Operator asking:
 * which finished objectives closed on a red PR, and why the gate let them.
 */
export function renderNonGreenCompletions(entries: CompletedWithRedEntry[]): string {
  const lines: string[] = ['', '---', '', '## Objectives completed with a non-green PR']
  if (entries.length === 0) {
    lines.push('', '_None. Every completed objective closed on a green (or advisory-only-red) PR._', '')
    return lines.join('\n')
  }
  lines.push(
    '',
    'These closed WITHOUT their required checks green. None of them is orphaned — each is',
    'listed here with the reason the CI-green gate released it, and the PR stays in the',
    'watchdog sweep above until it is merged or closed.',
    '',
  )
  // Escalations first: those are the ones that need a person.
  const ordered = [...entries].sort((a, b) => (a.resolution === 'escalated' ? -1 : 0) - (b.resolution === 'escalated' ? -1 : 0))
  for (const e of ordered) {
    lines.push(`### ${RESOLUTION_LABEL[e.resolution] ?? e.resolution}`)
    lines.push(`- **obj ${e.objectiveId}** (${e.status ?? 'unknown'}) — ${e.title ?? '(untitled)'}`)
    lines.push(`- PR: ${e.prUrl ?? `${e.repo}#${e.prNumber}`}`)
    if (e.failingChecks.length) lines.push(`- Failing required: ${e.failingChecks.map(c => `\`${c}\``).join(', ')}`)
    if (e.missingChecks.length) lines.push(`- Never reported: ${e.missingChecks.map(c => `\`${c}\``).join(', ')}`)
    lines.push(`- Holds spent: ${e.holdCount} · closed via \`${e.pathway ?? 'unknown'}\` at ${e.resolvedAt ?? 'unknown'}`)
    lines.push(`- Why released: ${e.reason ?? 'no reason recorded'}`)
    lines.push('')
  }
  return lines.join('\n')
}
