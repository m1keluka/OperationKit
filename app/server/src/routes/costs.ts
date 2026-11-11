import { Router } from 'express'
import { getDb } from '../db/index.js'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import { easternDayKey, EASTERN_TZ } from '../lib/eastern-day.js'

const router = Router()
// Phase 5: costs expose LLM spend + account IDs across every workspace.
// Until we have per-workspace cost rollups (Phase 7+), restrict to admins
// rather than trying to filter the aggregations row-by-row.
router.use(requireAuth, requireAdmin)

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(n)) return fallback
  if (n < min) return min
  if (n > max) return max
  return n
}

function round4(n: number): number {
  return Number((n || 0).toFixed(4))
}

// Calendar-day arithmetic on an Eastern YYYY-MM-DD key. Parsing at UTC midnight
// and shifting whole days is DST-safe because the key is date-only.
function shiftDayKey(key: string, deltaDays: number): string {
  const d = new Date(`${key}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + deltaDays)
  return d.toISOString().slice(0, 10)
}

// GET /api/costs/summary
// Windowed cost rollup from session_usage_daily — the complete per-Eastern-day
// ledger (every transcript, not just the session_intel subset). `day` is already
// an Eastern calendar date, so windows are exact local days with no 'localtime'
// (= container UTC) skew.
router.get('/summary', (_req, res) => {
  const db = getDb()
  const today = easternDayKey()
  const yesterday = shiftDayKey(today, -1)
  const weekStart = shiftDayKey(today, -6)
  const prevWeekStart = shiftDayKey(today, -13)
  const monthStart = shiftDayKey(today, -29)

  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN day = @today THEN cost_usd ELSE 0 END), 0) AS today_usd,
      COALESCE(SUM(CASE WHEN day = @yesterday THEN cost_usd ELSE 0 END), 0) AS yesterday_usd,
      COALESCE(SUM(CASE WHEN day >= @weekStart THEN cost_usd ELSE 0 END), 0) AS week_usd,
      COALESCE(SUM(CASE WHEN day >= @prevWeekStart AND day < @weekStart
                        THEN cost_usd ELSE 0 END), 0) AS prev_week_usd,
      COALESCE(SUM(CASE WHEN day >= @monthStart THEN cost_usd ELSE 0 END), 0) AS month_usd,
      COALESCE(SUM(cost_usd), 0) AS all_time_usd,
      COUNT(DISTINCT CASE WHEN day = @today THEN session_id END) AS sessions_today,
      COUNT(DISTINCT CASE WHEN day >= @weekStart THEN session_id END) AS sessions_week
    FROM session_usage_daily
  `).get({ today, yesterday, weekStart, prevWeekStart, monthStart }) as {
    today_usd: number
    yesterday_usd: number
    week_usd: number
    prev_week_usd: number
    month_usd: number
    all_time_usd: number
    sessions_today: number
    sessions_week: number
  }

  const burnRate = row.week_usd / 7
  res.json({
    today_usd: round4(row.today_usd),
    yesterday_usd: round4(row.yesterday_usd),
    week_usd: round4(row.week_usd),
    prev_week_usd: round4(row.prev_week_usd),
    month_usd: round4(row.month_usd),
    all_time_usd: round4(row.all_time_usd),
    burn_rate_per_day_usd: round4(burnRate),
    projected_30d_usd: round4(burnRate * 30),
    sessions_today: row.sessions_today,
    sessions_week: row.sessions_week,
  })
})

// GET /api/costs/daily?days=30
// Dense (no-gap) daily series ASC. Pads zero-rows in JS so the response always
// has length === days, even when the table has nothing for some calendar days.
router.get('/daily', (req, res) => {
  const days = clampInt(req.query.days, 30, 1, 90)
  const db = getDb()

  const today = easternDayKey()
  const start = shiftDayKey(today, -(days - 1))

  const rows = db.prepare(`
    SELECT day AS date,
           SUM(cost_usd) AS cost_usd,
           COUNT(DISTINCT session_id) AS sessions,
           SUM(tokens) AS tokens
    FROM session_usage_daily
    WHERE day >= ? AND day <= ?
    GROUP BY day
  `).all(start, today) as Array<{ date: string; cost_usd: number; sessions: number; tokens: number }>

  const byDate = new Map(rows.map(r => [r.date, r]))

  const out: Array<{ date: string; cost_usd: number; sessions: number; tokens: number }> = []
  const cursor = new Date(`${start}T00:00:00Z`)
  for (let i = 0; i < days; i++) {
    const key = cursor.toISOString().slice(0, 10)
    const r = byDate.get(key)
    out.push({
      date: key,
      cost_usd: round4(r?.cost_usd ?? 0),
      sessions: r?.sessions ?? 0,
      tokens: r?.tokens ?? 0,
    })
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }

  res.json(out)
})

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MAX_RANGE_DAYS = 366

// GET /api/costs/range?start=YYYY-MM-DD&end=YYYY-MM-DD
// Range-scoped rollup from session_usage_daily — each session's cost/tokens are
// pre-attributed to the Eastern day they actually ran on (see session-intel),
// so multi-day sessions are split correctly instead of dumped on one day. The
// `tz` query param is accepted for back-compat but the table is Eastern.
router.get('/range', (req, res) => {
  const todayKey = easternDayKey()

  let end = DATE_RE.test(String(req.query.end ?? '')) ? String(req.query.end) : todayKey
  let start = DATE_RE.test(String(req.query.start ?? '')) ? String(req.query.start) : ''
  if (!start) {
    const d = new Date(`${end}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() - 29)
    start = d.toISOString().slice(0, 10)
  }
  if (start > end) [start, end] = [end, start]

  const spanDays = Math.round(
    (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000
  ) + 1
  if (spanDays > MAX_RANGE_DAYS) {
    const d = new Date(`${end}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() - (MAX_RANGE_DAYS - 1))
    start = d.toISOString().slice(0, 10)
  }

  const db = getDb()
  const W = 'WHERE day >= ? AND day <= ?'

  const totalsRow = db.prepare(
    `SELECT COALESCE(SUM(cost_usd),0) cost, COALESCE(SUM(tokens),0) tok, COUNT(DISTINCT session_id) sess
     FROM session_usage_daily ${W}`
  ).get(start, end) as { cost: number; tok: number; sess: number }

  const dailyRows = db.prepare(
    `SELECT day, SUM(cost_usd) cost, SUM(tokens) tok, COUNT(DISTINCT session_id) sess
     FROM session_usage_daily ${W} GROUP BY day`
  ).all(start, end) as Array<{ day: string; cost: number; tok: number; sess: number }>

  const accountRows = db.prepare(
    `SELECT COALESCE(account_id,'unknown') account_id, SUM(cost_usd) cost, SUM(tokens) tok, COUNT(DISTINCT session_id) sess
     FROM session_usage_daily ${W} GROUP BY COALESCE(account_id,'unknown')`
  ).all(start, end) as Array<{ account_id: string; cost: number; tok: number; sess: number }>

  const modelRows = db.prepare(
    `SELECT model, SUM(cost_usd) cost, SUM(tokens) tok, COUNT(DISTINCT session_id) sess
     FROM session_usage_daily ${W} GROUP BY model`
  ).all(start, end) as Array<{ model: string; cost: number; tok: number; sess: number }>

  const objRows = db.prepare(
    `SELECT d.objective_id, o.title, o.status, o.project, o.workspace,
            SUM(d.cost_usd) cost, COUNT(DISTINCT d.session_id) sess, MAX(d.day) last_day
     FROM session_usage_daily d LEFT JOIN objectives o ON o.id = d.objective_id
     ${W.replace(/day/g, 'd.day')} AND d.objective_id IS NOT NULL
     GROUP BY d.objective_id ORDER BY cost DESC LIMIT 50`
  ).all(start, end) as Array<{
    objective_id: number; title: string | null; status: string | null
    project: string | null; workspace: string | null; cost: number; sess: number; last_day: string
  }>

  const allTime = db.prepare(
    `SELECT COALESCE(SUM(cost_usd),0) AS cost_usd, COALESCE(SUM(tokens),0) AS tokens FROM session_usage_daily`
  ).get() as { cost_usd: number; tokens: number }

  // Dense daily fill (zero-rows for gap days) so the series length === span.
  const dailyMap = new Map(dailyRows.map(r => [r.day, r]))
  const dailyOut: Array<{ date: string; cost_usd: number; tokens: number; sessions: number }> = []
  const cursor = new Date(`${start}T00:00:00Z`)
  while (true) {
    const key = cursor.toISOString().slice(0, 10)
    if (key > end) break
    const r = dailyMap.get(key)
    dailyOut.push({ date: key, cost_usd: round4(r?.cost ?? 0), tokens: r?.tok ?? 0, sessions: r?.sess ?? 0 })
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }

  res.json({
    start,
    end,
    tz: EASTERN_TZ,
    today: todayKey,
    totals: { cost_usd: round4(totalsRow.cost), tokens: totalsRow.tok, sessions: totalsRow.sess },
    all_time_usd: round4(allTime.cost_usd),
    all_time_tokens: allTime.tokens,
    daily: dailyOut,
    by_account: accountRows
      .map(r => ({ account_id: r.account_id, cost_usd: round4(r.cost), tokens: r.tok, sessions: r.sess }))
      .sort((a, b) => b.cost_usd - a.cost_usd),
    by_model: modelRows
      .map(r => ({ model: r.model, cost_usd: round4(r.cost), tokens: r.tok, sessions: r.sess }))
      .sort((a, b) => b.cost_usd - a.cost_usd),
    by_objective: objRows.map(r => ({
      objective_id: r.objective_id,
      title: r.title ?? `Objective #${r.objective_id}`,
      status: r.status ?? 'unknown',
      project: r.project,
      workspace: r.workspace,
      cost_usd: round4(r.cost),
      sessions: r.sess,
      last_session_at: r.last_day,
    })),
  })
})

// GET /api/costs/by-objective?days=30&limit=50
router.get('/by-objective', (req, res) => {
  const days = clampInt(req.query.days, 30, 1, 365)
  const limit = clampInt(req.query.limit, 50, 1, 200)
  const db = getDb()

  const today = easternDayKey()
  const start = shiftDayKey(today, -(days - 1))
  const rows = db.prepare(`
    SELECT
      d.objective_id AS objective_id,
      COALESCE(o.title, 'Objective #' || d.objective_id) AS title,
      COALESCE(o.status, 'unknown') AS status,
      o.project AS project,
      o.workspace AS workspace,
      SUM(d.cost_usd) AS cost_usd,
      COUNT(DISTINCT d.session_id) AS sessions,
      MAX(d.day) AS last_session_at
    FROM session_usage_daily d
    LEFT JOIN objectives o ON o.id = d.objective_id
    WHERE d.day >= ? AND d.day <= ? AND d.objective_id IS NOT NULL
    GROUP BY d.objective_id
    ORDER BY cost_usd DESC
    LIMIT ?
  `).all(start, today, limit) as Array<{
    objective_id: number
    title: string
    status: string
    project: string | null
    workspace: string | null
    cost_usd: number
    sessions: number
    last_session_at: string | null
  }>

  res.json(rows.map(r => ({ ...r, cost_usd: round4(r.cost_usd) })))
})

// GET /api/costs/by-account?days=30
router.get('/by-account', (req, res) => {
  const days = clampInt(req.query.days, 30, 1, 90)
  const db = getDb()

  const today = easternDayKey()
  const start = shiftDayKey(today, -(days - 1))
  const rows = db.prepare(`
    SELECT
      COALESCE(account_id, 'unknown') AS account_id,
      SUM(cost_usd) AS cost_usd,
      COUNT(DISTINCT session_id) AS sessions,
      SUM(tokens) AS tokens
    FROM session_usage_daily
    WHERE day >= ? AND day <= ?
    GROUP BY COALESCE(account_id, 'unknown')
    ORDER BY cost_usd DESC
  `).all(start, today) as Array<{
    account_id: string
    cost_usd: number
    sessions: number
    tokens: number
  }>

  res.json(rows.map(r => ({ ...r, cost_usd: round4(r.cost_usd) })))
})

export default router
