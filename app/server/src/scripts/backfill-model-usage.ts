// One-off backfill: populate session_intel.model_usage from transcript JSONLs.
// Run inside the container AFTER deploying the schema change:
//   docker exec command-center npx tsx /app/server/src/scripts/backfill-model-usage.ts
import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'

const DB_PATH = process.env.DB_PATH || '/app/data/command-center.db'
const TRANSCRIPT_DIR = process.env.TRANSCRIPT_DIR || '/home/operator/transcripts'

function parseModelUsage(jsonlPath: string): Record<string, { tokens: number; cost_usd: number }> {
  const out: Record<string, { tokens: number; cost_usd: number }> = {}
  const content = fs.readFileSync(jsonlPath, 'utf-8')
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let event: Record<string, unknown>
    try {
      event = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (event.type !== 'result') continue
    const mu = event.modelUsage as Record<string, Record<string, unknown>> | undefined
    if (!mu) continue
    for (const [model, u] of Object.entries(mu)) {
      const agg = out[model] ?? { tokens: 0, cost_usd: 0 }
      agg.tokens +=
        ((u.inputTokens as number) || 0) +
        ((u.outputTokens as number) || 0) +
        ((u.cacheReadInputTokens as number) || 0) +
        ((u.cacheCreationInputTokens as number) || 0)
      agg.cost_usd += (u.costUSD as number) || 0
      out[model] = agg
    }
  }
  return out
}

const db = new Database(DB_PATH)
const rows = db.prepare(
  "SELECT session_id FROM session_intel WHERE model_usage IS NULL"
).all() as Array<{ session_id: string }>

let updated = 0
let missing = 0
let empty = 0
const update = db.prepare('UPDATE session_intel SET model_usage = ? WHERE session_id = ?')

for (const { session_id } of rows) {
  const jsonlPath = path.join(TRANSCRIPT_DIR, `${session_id}.jsonl`)
  if (!fs.existsSync(jsonlPath)) {
    missing++
    continue
  }
  const usage = parseModelUsage(jsonlPath)
  if (Object.keys(usage).length === 0) {
    empty++
    continue
  }
  update.run(JSON.stringify(usage), session_id)
  updated++
}

console.log(`Backfill complete: ${rows.length} candidates, ${updated} updated, ${missing} transcript missing, ${empty} no modelUsage in transcript`)

// Phase 2: sync total_tokens to the modelUsage sum (result.usage only covers
// the main thread — subagent usage is excluded, undercounting by ~2.4x).
const withUsage = db.prepare(
  "SELECT session_id, total_tokens, model_usage FROM session_intel WHERE model_usage IS NOT NULL AND model_usage != '{}'"
).all() as Array<{ session_id: string; total_tokens: number; model_usage: string }>

let tokensSynced = 0
for (const row of withUsage) {
  let usage: Record<string, { tokens?: number }> = {}
  try {
    usage = JSON.parse(row.model_usage)
  } catch {
    continue
  }
  const modelTokens = Object.values(usage).reduce((s, m) => s + (m.tokens || 0), 0)
  if (modelTokens > 0 && modelTokens !== row.total_tokens) {
    db.prepare('UPDATE session_intel SET total_tokens = ? WHERE session_id = ?').run(modelTokens, row.session_id)
    tokensSynced++
  }
}
console.log(`Token sync: ${tokensSynced} of ${withUsage.length} sessions updated to modelUsage totals`)

// Phase 3: recompute objectives.total_tokens from session_intel so objective
// aggregates match the corrected per-session numbers.
const objResult = db.prepare(`
  UPDATE objectives SET total_tokens = COALESCE(
    (SELECT SUM(si.total_tokens) FROM session_intel si WHERE si.objective_id = objectives.id), total_tokens)
  WHERE id IN (SELECT DISTINCT objective_id FROM session_intel)
`).run()
console.log(`Objective aggregates recomputed: ${objResult.changes} objectives`)
