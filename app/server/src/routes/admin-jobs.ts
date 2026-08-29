/**
 * Admin jobs/assistant/strategy routes —
 * extracted from admin.ts (behavior frozen).
 *
 * Auth is applied by the admin.ts facade. Paths are unchanged.
 */
import { Router } from 'express'
import type { Response } from 'express'
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { getDb } from '../db/index.js'
import type { AuthRequest } from '../middleware/auth.js'
import { pickAccount } from '../services/account-router.js'
import { runDreamCycle, getKnowledgeHealth } from '../services/dream-cycle.js'
import {
  fireRoutine,
  nextRunAt,
  describeCron,
  validateCronExpr,
  routinesGloballyEnabled,
  computeRoutineHealth,
  routinesHealth,
  type RoutineRow,
} from '../services/routine-scheduler.js'
import { ASSISTANT_DIR } from '../config.js'
import { getSkillGraph } from '../services/skill-graph.js'

const router = Router()

// Assistant files
router.get('/assistant', (_req: AuthRequest, res) => {
  try {
    const files: Record<string, { content: string; modifiedAt: string; size: number }> = {}
    for (const filename of ['loops.md', 'conversation.md', 'context.md']) {
      const filePath = path.join(ASSISTANT_DIR, filename)
      try {
        const stat = fs.statSync(filePath)
        files[filename] = {
          content: fs.readFileSync(filePath, 'utf-8'),
          modifiedAt: stat.mtime.toISOString(),
          size: stat.size,
        }
      } catch {
        files[filename] = { content: '', modifiedAt: '', size: 0 }
      }
    }
    res.json(files)
  } catch (err) {
    res.status(500).json({ error: 'Failed to read assistant files' })
  }
})

// Assistant ingest
router.post('/assistant/ingest', async (req: AuthRequest, res) => {
  const { text } = req.body as { text?: string }
  if (!text?.trim()) {
    res.status(400).json({ error: 'text is required' })
    return
  }

  const account = pickAccount()
  if (!account) {
    res.status(503).json({ error: 'All Claude accounts are rate-limited. Try again later.' })
    return
  }

  const ingestPrompt = [
    "You are Operator's personal assistant. Read ~/ai-workspace/agents/assistant.md for your full instructions.",
    "Read ~/ai-workspace/skills/loop-tracker/SKILL.md for loop management rules.",
    "Read /home/operator/assistant/loops.md for current open loops.",
    "",
    "Operator is pasting content for ingestion from the Command Center UI.",
    "Process this content:",
    "1. Extract any knowledge, insights, or reference material and add it to the vault at ~/second-brain/ following the vault schema",
    "2. Identify any action items, ideas, decisions, or follow-ups and create loops in /home/operator/assistant/loops.md",
    "3. Do NOT create loops for items that already exist as open loops",
    "4. Do NOT create loops for Command Center board objectives",
    "",
    "Respond with a brief summary of what was captured: knowledge added and loops created.",
    "Keep it concise - this is displayed in a UI card.",
    "",
    "--- BEGIN CONTENT ---",
    text.trim(),
    "--- END CONTENT ---",
  ].join("\n")

  const tmpFile = `/tmp/ingest-${Date.now()}.txt`
  fs.writeFileSync(tmpFile, ingestPrompt)
  fs.chmodSync(tmpFile, '644')

  try {
    const proc = spawn('su', ['-s', '/bin/bash', 'ccuser', '-c',
      `export HOME=${account.homeDir} && cd /home/operator/ai-workspace && claude -p "$(cat ${tmpFile})" --dangerously-skip-permissions --output-format stream-json --verbose`
    ], {
      env: { ...process.env, HOME: account.homeDir, USER: 'ccuser', TERM: 'dumb' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let responseText = ''

    proc.stdout?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const event = JSON.parse(trimmed)
          if (event.type === 'assistant' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'text') responseText += block.text
            }
          }
        } catch {}
      }
    })

    const timeout = setTimeout(() => {
      try { proc.kill('SIGTERM') } catch {}
    }, 5 * 60 * 1000)

    proc.on('exit', () => {
      clearTimeout(timeout)
      try { fs.unlinkSync(tmpFile) } catch {}
      res.json({ response: responseText || 'Processing complete but no summary generated.' })
    })
  } catch (err) {
    try { fs.unlinkSync(tmpFile) } catch {}
    res.status(500).json({ error: 'Failed to start ingestion session' })
  }
})

// Skill graph — agent -> skill -> tool, derived from the okit-validated
// frontmatter layer graph (obj 707012). This used to serve raw registry.json,
// whose hand-maintained `graph` block was a stale second description of the
// same edges (11 agents where the real number is 19, dangling targets, no
// validator). See services/skill-graph.ts for what is and is not served.
router.get('/skill-graph', async (_req: AuthRequest, res) => {
  try {
    res.json(await getSkillGraph())
  } catch (err) {
    res.status(503).json({ error: err instanceof Error ? err.message : 'Skill graph unavailable' })
  }
})

// Dream cycle — manual trigger
// Accepts optional { phase: "blockers" | "rollup" | ... | "health" | "all" }
router.post('/dream-cycle', async (req: AuthRequest, res) => {
  const phase = (req.body as { phase?: string }).phase || (req.query.phase as string) || 'all'
  try {
    const start = Date.now()
    const result = await runDreamCycle(phase)
    const elapsed = Date.now() - start
    console.log(`[dream-cycle] Manual run (${phase}) completed in ${elapsed}ms`)
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Dream cycle failed' })
  }
})

// Knowledge health scores — latest + 7-day trend
router.get('/knowledge-health', (_req: AuthRequest, res) => {
  try {
    res.json(getKnowledgeHealth())
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to read health scores' })
  }
})

// ── Scheduled routines (the "queued jobs + cadence" view for the Jobs tab) ───
// Browser-facing, admin-only mirror of the localhost-only /api/internal/routines.
// Enriches each routine definition with a derived workspace (lives in the
// objective_template, not a column), human cadence, next-run time, and a count
// of its still-open runs — everything the Jobs board needs to show "what's
// scheduled, on what cadence, in which workspace".

/** Safely pull a string field out of a routine's parsed objective_template. */
function tplStr(tpl: Record<string, unknown>, key: string, fallback = ''): string {
  const v = tpl[key]
  return typeof v === 'string' && v.length > 0 ? v : fallback
}

router.get('/routines', (_req: AuthRequest, res) => {
  try {
    const rows = getDb()
      .prepare('SELECT * FROM routines ORDER BY id')
      .all() as RoutineRow[]
    const pendingStmt = getDb().prepare(
      "SELECT COUNT(*) AS n FROM objectives WHERE routine_id = ? AND status != 'done'"
    )
    // obj 2384 — resolve the owning Strategy's title so the Jobs UI can show which
    // strategy steers each routine (null for standalone routines).
    const strategyStmt = getDb().prepare('SELECT title FROM objectives WHERE id = ?')
    const routines = rows.map((r) => {
      let tpl: Record<string, unknown> = {}
      try {
        tpl = JSON.parse(r.objective_template) as Record<string, unknown>
      } catch {
        // leave tpl empty — derived fields fall back below
      }
      const pending = (pendingStmt.get(r.id) as { n: number }).n
      const next = nextRunAt(r.cron_expr)
      const health = computeRoutineHealth(r)
      return {
        id: r.id,
        name: r.name,
        cron_expr: r.cron_expr,
        cadence: describeCron(r.cron_expr),
        enabled: r.enabled === 1,
        max_queue_depth: r.max_queue_depth,
        last_run_at: r.last_run_at,
        next_run_at: next ? next.toISOString() : null,
        created_at: r.created_at,
        title: tplStr(tpl, 'title', r.name),
        workspace: tplStr(tpl, 'workspace', 'example'),
        agent_context: tplStr(tpl, 'agent_context'),
        project: tplStr(tpl, 'project') || null,
        category: tplStr(tpl, 'category', 'general'),
        strategy_objective_id: r.strategy_objective_id ?? null,
        strategy_title:
          r.strategy_objective_id != null
            ? ((strategyStmt.get(r.strategy_objective_id) as { title: string } | undefined)?.title ?? null)
            : null,
        pending,
        // Health flags so the Jobs board can show a routine has stalled inline.
        overdue: health.overdue,
        minutes_overdue: health.minutes_overdue,
        expected_last_fire: health.expected_last_fire,
        last_skip_reason: health.last_skip_reason,
      }
    })
    const summary = routinesHealth()
    res.json({
      routines_enabled: routinesGloballyEnabled(),
      health: {
        ok: summary.ok,
        last_tick: summary.last_tick,
        tick_stale: summary.tick_stale,
        overdue_count: summary.overdue_count,
      },
      routines,
    })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to list routines' })
  }
})

// Fire a routine immediately (operator action). Mirrors the internal run-now:
// 201 on success, 409 if a per-routine guard blocked it, 500 on error.
router.post('/routines/:id/run-now', async (req: AuthRequest, res) => {
  const id = Number(req.params.id)
  const routine = getDb()
    .prepare('SELECT * FROM routines WHERE id = ?')
    .get(id) as RoutineRow | undefined
  if (!routine) {
    res.status(404).json({ error: 'Routine not found' })
    return
  }
  try {
    const result = await fireRoutine(routine, 'run-now')
    res.status(result.ok ? 201 : 409).json(result)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'run-now failed' })
  }
})

// ── Strategy nodes + Strategy-owned Jobs authoring (obj 2384) ────────────────
// A Strategy is a delegate_mode objective (the top orchestrator tier). These two
// routes let Operator (a) pick an existing strategy and (b) author a recurring
// research Job under a strategy from the UI — translating a friendly cadence into
// a cron and a prompt into the routine's objective_template, so nobody hand-writes
// cron/JSON. The routine is linked via routines.strategy_objective_id, so its runs
// spawn as children of the strategy and feed their summaries back into its context.

/** GET /api/admin/strategies — delegator objectives available to own a Job. */
router.get('/strategies', (_req: AuthRequest, res) => {
  try {
    const rows = getDb()
      .prepare(
        `SELECT id, title, workspace, status, depth
           FROM objectives
          WHERE delegate_mode = 1 AND status != 'done'
          ORDER BY id DESC`
      )
      .all() as { id: number; title: string; workspace: string; status: string; depth: number | null }[]
    res.json({ strategies: rows })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to list strategies' })
  }
})

/**
 * Translate a friendly cadence selection into a 5-field cron expression.
 * Off-peak default minute (7) avoids stampeding the top-of-hour. day-of-week
 * uses 0-6 (Sun-Sat). Returns null on an unrecognized cadence.
 */
function cadenceToCron(cadence: string, hour: number, minute: number, dow: number, dom: number): string | null {
  const h = Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 9
  const m = Number.isInteger(minute) && minute >= 0 && minute <= 59 ? minute : 7
  switch (cadence) {
    case 'daily':    return `${m} ${h} * * *`
    case 'weekdays': return `${m} ${h} * * 1-5`
    case 'weekly':   return `${m} ${h} * * ${Number.isInteger(dow) && dow >= 0 && dow <= 6 ? dow : 1}`
    case 'monthly':  return `${m} ${h} ${Number.isInteger(dom) && dom >= 1 && dom <= 28 ? dom : 1} * *`
    case 'hourly':   return `${m} * * * *`
    default:         return null
  }
}

/**
 * POST /api/admin/strategy-jobs — author a strategy-owned recurring Job.
 * Body: {
 *   strategy_objective_id?: number,   // attach to an existing strategy, OR…
 *   strategy_title?: string,          // …create a new strategy with this title
 *   strategy_description?: string,
 *   workspace: string,
 *   job_title: string,                // the recurring run's objective title
 *   job_prompt: string,               // becomes the run's description/completion_goal
 *   agent_context?: string,
 *   cadence: 'daily'|'weekdays'|'weekly'|'monthly'|'hourly',
 *   hour?, minute?, day_of_week?, day_of_month?: number,
 *   enabled?: boolean,
 * }
 * Creates the strategy (delegate_mode=1) if a title is given, then the linked
 * routine. Returns { strategy, routine }.
 */
router.post('/strategy-jobs', (req: AuthRequest, res) => {
  const b = req.body as {
    strategy_objective_id?: number
    strategy_title?: string
    strategy_description?: string
    workspace?: string
    job_title?: string
    job_prompt?: string
    agent_context?: string
    cadence?: string
    hour?: number
    minute?: number
    day_of_week?: number
    day_of_month?: number
    enabled?: boolean
  }

  const workspace = (b.workspace || '').trim()
  if (!workspace) { res.status(400).json({ error: 'workspace required' }); return }
  if (!b.job_title?.trim()) { res.status(400).json({ error: 'job_title required' }); return }
  if (!b.job_prompt?.trim()) { res.status(400).json({ error: 'job_prompt required' }); return }

  const cron = cadenceToCron(
    (b.cadence || '').trim(),
    b.hour ?? 9, b.minute ?? 7, b.day_of_week ?? 1, b.day_of_month ?? 1,
  )
  if (!cron) { res.status(400).json({ error: 'cadence must be one of: daily, weekdays, weekly, monthly, hourly' }); return }
  const cronErr = validateCronExpr(cron)
  if (cronErr) { res.status(400).json({ error: `derived cron invalid: ${cronErr}` }); return }

  const db = getDb()
  const agentContext = (b.agent_context || 'cto').trim()

  try {
    const tx = db.transaction(() => {
      // Resolve or create the owning strategy (a delegate_mode objective).
      let strategyId: number
      if (b.strategy_objective_id != null) {
        const existing = db
          .prepare('SELECT id, delegate_mode FROM objectives WHERE id = ?')
          .get(b.strategy_objective_id) as { id: number; delegate_mode: number } | undefined
        if (!existing) throw new Error(`strategy_objective_id ${b.strategy_objective_id} not found`)
        if (!existing.delegate_mode) {
          // Promote the target to a delegator so it can own/steer Jobs.
          db.prepare("UPDATE objectives SET delegate_mode = 1, updated_at = datetime('now') WHERE id = ?").run(existing.id)
        }
        strategyId = existing.id
      } else if (b.strategy_title?.trim()) {
        // Created in 'review' (human-owned), NOT 'queue': a brand-new strategy is
        // a holder/steerer that Operator activates when ready. fireWake skips delegators
        // parked in 'review', so the existing (non-flag-gated) reconcile wake fabric
        // will NOT auto-spawn a session for it just because a routine run completed
        // under it while CC_STRATEGY_TIER is off. The run-summary still feeds back
        // into its NOTES.md (append path bypasses fireWake). Operator starts it to engage
        // autonomy.
        const r = db.prepare(
          `INSERT INTO objectives
             (title, description, agent_context, workspace, category, type,
              delegate_mode, depth, status)
           VALUES (?, ?, ?, ?, 'strategy', 'project', 1, 0, 'review')`
        ).run(
          b.strategy_title.trim(),
          (b.strategy_description || '').trim(),
          agentContext,
          workspace,
        )
        strategyId = r.lastInsertRowid as number
      } else {
        throw new Error('either strategy_objective_id or strategy_title is required')
      }

      // Build the routine's objective_template (no hand-written JSON for the user).
      const template = {
        title: b.job_title!.trim(),
        description: b.job_prompt!.trim(),
        completion_goal: b.job_prompt!.trim(),
        agent_context: agentContext,
        workspace,
        category: 'research',
        type: 'task',
      }
      // Routine name must be unique; namespace it under the strategy.
      const baseName = `strategy-${strategyId}-${b.job_title!.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'job'}`
      let name = baseName
      let suffix = 1
      while (db.prepare('SELECT 1 FROM routines WHERE name = ?').get(name)) {
        name = `${baseName}-${++suffix}`
      }

      const rr = db.prepare(
        `INSERT INTO routines (name, cron_expr, objective_template, enabled, max_queue_depth, strategy_objective_id)
         VALUES (?, ?, ?, ?, 1, ?)`
      ).run(name, cron, JSON.stringify(template), b.enabled ? 1 : 0, strategyId)
      const routineId = rr.lastInsertRowid as number

      const strategy = db.prepare('SELECT id, title, workspace, delegate_mode, depth, status FROM objectives WHERE id = ?').get(strategyId)
      const routine = db.prepare('SELECT * FROM routines WHERE id = ?').get(routineId)
      return { strategy, routine }
    })
    const result = tx()
    res.status(201).json(result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'failed to author strategy job'
    res.status(msg.includes('UNIQUE') ? 409 : 400).json({ error: msg })
  }
})


export default router
