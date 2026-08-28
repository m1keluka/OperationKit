import { Router } from 'express'
import { getDb } from '../db/index.js'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import type { User } from '@command-center/shared'
import { escapeLike } from '../lib/dev-api-envelope.js'

// ─────────────────────────────────────────────────────────────────────────────
// Server-side objective SEARCH (obj 702388). BACKEND-ONLY.
//
// The board's Done column is a ~2000-row lazily-paginated backlog that is never
// fully loaded client-side, so search cannot run in the browser — it MUST be a
// server-side SQL query over the FULL objectives table across ALL statuses
// (planning|queue|working|ai_review|review|done|cancelled). Two endpoints:
//   GET  /api/objectives/search       — keyword + fuzzy (typo-tolerant) match
//   POST /api/objectives/search/ai    — natural-language via Anthropic Haiku
//
// RBAC: both endpoints replicate the EXACT visibility scoping used by
// objectives.ts GET '/' (obj 700512 / view-leak fixes 1001 / 700082). The shared
// clause is factored into buildScope() below so both handlers stay in lockstep
// and objectives.ts is never mutated.
// ─────────────────────────────────────────────────────────────────────────────

const router = Router()
router.use(requireAuth)

// ── Text columns ─────────────────────────────────────────────────────────────
// Base searchable text columns always present on the objectives table. `project`
// / `notes` / `context` are added ONLY if the column actually exists (checked via
// PRAGMA table_info at first use) — schema drifts across DBs, so probe defensively.
const BASE_TEXT_COLUMNS = ['title', 'description', 'completion_goal', 'last_session_summary'] as const
const OPTIONAL_TEXT_COLUMNS = ['project', 'notes', 'context'] as const

let cachedTextColumns: string[] | null = null
function getTextColumns(): string[] {
  if (cachedTextColumns) return cachedTextColumns
  const db = getDb()
  const cols = new Set(
    (db.prepare('PRAGMA table_info(objectives)').all() as Array<{ name: string }>).map(c => c.name)
  )
  const optional = OPTIONAL_TEXT_COLUMNS.filter(c => cols.has(c))
  cachedTextColumns = [...BASE_TEXT_COLUMNS.filter(c => cols.has(c)), ...optional]
  return cachedTextColumns
}

// Per-field weight for the fuzzy scorer (title matters most; summaries least).
const FIELD_WEIGHT: Record<string, number> = {
  title: 3,
  completion_goal: 1.6,
  project: 1.4,
  description: 1,
  last_session_summary: 0.9,
  notes: 1,
  context: 1,
}

// ── Visibility scope ─────────────────────────────────────────────────────────
// Membership row including objective_visibility. NOTE: middleware/getUserWorkspaces
// deliberately projects only (workspace, role) and DROPS objective_visibility, so
// we query it directly here — objectives.ts GET '/' references m.objective_visibility
// and we must honor the 'all' vs 'own' distinction to replicate its scoping.
interface Membership {
  workspace: string
  objective_visibility: string
}

function getMemberships(userId: number): Membership[] {
  return getDb()
    .prepare(
      'SELECT workspace, objective_visibility FROM user_workspaces WHERE user_id = ? ORDER BY workspace'
    )
    .all(userId) as Membership[]
}

// Result: a WHERE fragment (already parenthesized) + its bound params, or null
// when the caller can see NOTHING in the requested scope (→ handler returns []).
// The fragment does NOT include the `deleted_at IS NULL` guard — callers append it.
type Scope = { clause: string; params: unknown[] } | null

// The ownership sub-predicate shared by every 'own'-visibility branch.
const OWN_PREDICATE =
  '(assigned_user_id = ? OR created_by = ? OR id IN (SELECT objective_id FROM objective_assignees WHERE user_id = ?))'

function buildScope(user: User, workspace: string | undefined): Scope {
  const specific = workspace && workspace !== 'all' ? workspace : undefined

  // Admins see everything (optionally narrowed to one workspace).
  if (user.role === 'admin') {
    return specific ? { clause: 'workspace = ?', params: [specific] } : { clause: '1 = 1', params: [] }
  }

  const memberships = getMemberships(user.id)
  if (memberships.length === 0) return null

  if (specific) {
    const m = memberships.find(x => x.workspace === specific)
    if (!m) return null
    if (m.objective_visibility === 'all') {
      return { clause: 'workspace = ?', params: [specific] }
    }
    return {
      clause: `(workspace = ? AND ${OWN_PREDICATE})`,
      params: [specific, user.id, user.id, user.id],
    }
  }

  // Cross-workspace union: all-visibility workspaces (full set) OR own-visibility
  // workspaces (filtered to ownership). Mirrors objectives.ts GET '/' exactly.
  const allWs = memberships.filter(m => m.objective_visibility === 'all').map(m => m.workspace)
  const ownWs = memberships.filter(m => m.objective_visibility !== 'all').map(m => m.workspace)

  const clauses: string[] = []
  const params: unknown[] = []
  if (allWs.length > 0) {
    clauses.push(`workspace IN (${allWs.map(() => '?').join(',')})`)
    params.push(...allWs)
  }
  if (ownWs.length > 0) {
    clauses.push(`(workspace IN (${ownWs.map(() => '?').join(',')}) AND ${OWN_PREDICATE})`)
    params.push(...ownWs, user.id, user.id, user.id)
  }
  if (clauses.length === 0) return null
  return { clause: `(${clauses.join(' OR ')})`, params }
}

// ── Fuzzy scoring ────────────────────────────────────────────────────────────
function tokenize(q: string): string[] {
  return q
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map(t => t.trim())
    .filter(Boolean)
}

// Bounded Levenshtein distance (early-exit once it exceeds `max`).
function levenshtein(a: string, b: string, max: number): number {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > max) return max + 1
  const prev = new Array(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    let rowMin = i
    let diag = prev[0]
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + cost)
      diag = tmp
      if (prev[j] < rowMin) rowMin = prev[j]
    }
    if (rowMin > max) return max + 1
  }
  return prev[b.length]
}

// Is `t` a subsequence of `s` (chars in order, not necessarily contiguous)?
function isSubsequence(t: string, s: string): boolean {
  let i = 0
  for (let j = 0; j < s.length && i < t.length; j++) {
    if (s[j] === t[i]) i++
  }
  return i === t.length
}

// Score a single query token against a lowercased field value (0..1).
function tokenScore(token: string, fieldLower: string, fieldWords: string[]): number {
  if (!fieldLower) return 0
  if (fieldLower.includes(token)) return 1 // exact substring
  // Near-miss typo: best Levenshtein over the field's words.
  const maxDist = token.length <= 4 ? 1 : token.length <= 7 ? 2 : 3
  let best = 0
  for (const w of fieldWords) {
    if (Math.abs(w.length - token.length) > maxDist) continue
    const d = levenshtein(token, w, maxDist)
    if (d <= maxDist) {
      const s = 0.85 * (1 - d / (token.length + 1))
      if (s > best) best = s
    }
  }
  if (best > 0) return best
  // Subsequence (e.g. abbreviations / dropped letters) — weakest signal.
  if (token.length >= 3 && isSubsequence(token, fieldLower)) return 0.45
  return 0
}

interface CandidateRow {
  id: number
  title: string | null
  status: string
  workspace: string
  agent_context: string | null
  updated_at: string
  description?: string | null
  completion_goal?: string | null
  last_session_summary?: string | null
  project?: string | null
  notes?: string | null
  context?: string | null
}

// Sum of per-token best weighted field contributions. Higher = better match.
function scoreRow(tokens: string[], row: CandidateRow, textColumns: string[]): number {
  const fields = textColumns
    .map(col => {
      const raw = (row as unknown as Record<string, unknown>)[col]
      const val = typeof raw === 'string' ? raw.toLowerCase() : ''
      return { col, val, words: val.split(/[^a-z0-9]+/i).filter(Boolean) }
    })
    .filter(f => f.val)

  let total = 0
  for (const token of tokens) {
    let tokenBest = 0
    for (const f of fields) {
      const contribution = (FIELD_WEIGHT[f.col] ?? 1) * tokenScore(token, f.val, f.words)
      if (contribution > tokenBest) tokenBest = contribution
    }
    total += tokenBest
  }
  return total
}

// Build a ~120-char excerpt around the first place any token hits, preferring
// higher-weight fields. Falls back to the title's head when nothing matches cleanly.
function buildSnippet(tokens: string[], row: CandidateRow, textColumns: string[]): string {
  const ordered = [...textColumns].sort((a, b) => (FIELD_WEIGHT[b] ?? 1) - (FIELD_WEIGHT[a] ?? 1))
  for (const col of ordered) {
    const raw = (row as unknown as Record<string, unknown>)[col]
    if (typeof raw !== 'string' || !raw) continue
    const lower = raw.toLowerCase()
    let hit = -1
    for (const token of tokens) {
      const idx = lower.indexOf(token)
      if (idx >= 0 && (hit === -1 || idx < hit)) hit = idx
    }
    if (hit >= 0) {
      const start = Math.max(0, hit - 40)
      const excerpt = raw.slice(start, start + 120).replace(/\s+/g, ' ').trim()
      return (start > 0 ? '…' : '') + excerpt + (start + 120 < raw.length ? '…' : '')
    }
  }
  const title = row.title || ''
  return title.length > 120 ? title.slice(0, 117) + '…' : title
}

// SQL LIKE prefilter fragments for a token: the whole token plus its 4-char
// head/tail so common typos (a wrong letter mid/leading/trailing) still land the
// intended row in the candidate set, which the JS fuzzy scorer then ranks.
function likeFragmentsForToken(token: string): string[] {
  const frags = new Set<string>([token])
  if (token.length >= 4) {
    frags.add(token.slice(0, 4))
    frags.add(token.slice(-4))
  }
  return [...frags]
}

// GET /api/objectives/search?q=&workspace=&limit=
// Keyword + fuzzy search across ALL statuses (incl. done/cancelled). RBAC-scoped.
router.get('/', (req: AuthRequest, res) => {
  const user = req.user!
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
  const workspace = typeof req.query.workspace === 'string' ? req.query.workspace : undefined
  const rawLimit = parseInt(req.query.limit as string, 10)
  const limit = !isNaN(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 30

  if (!q) return res.json({ results: [] })

  const tokens = tokenize(q)
  if (tokens.length === 0) return res.json({ results: [] })

  const scope = buildScope(user, workspace)
  if (!scope) return res.json({ results: [] })

  const textColumns = getTextColumns()
  const db = getDb()

  // LIKE prefilter — case-insensitive by default for ASCII in SQLite. OR every
  // (fragment × column) so recall is broad; JS re-ranking does the precision.
  const likeClauses: string[] = []
  const likeParams: unknown[] = []
  for (const token of tokens) {
    for (const frag of likeFragmentsForToken(token)) {
      for (const col of textColumns) {
        likeClauses.push(`${col} LIKE ? ESCAPE '\\'`)
        likeParams.push(`%${escapeLike(frag)}%`)
      }
    }
  }

  const selectCols = ['id', 'title', 'status', 'workspace', 'agent_context', 'updated_at', ...textColumns]
  // Dedup the select list (title lives in both fixed + text columns).
  const uniqueSelect = [...new Set(selectCols)].join(', ')

  const sql = `SELECT ${uniqueSelect} FROM objectives
     WHERE ${scope.clause}
       AND deleted_at IS NULL
       AND (${likeClauses.join(' OR ')})
     ORDER BY updated_at DESC
     LIMIT 800`
  const candidates = db.prepare(sql).all(...scope.params, ...likeParams) as CandidateRow[]

  const scored = candidates
    .map(row => ({ row, score: scoreRow(tokens, row, textColumns) }))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)

  const results = scored.map(({ row, score }) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    workspace: row.workspace,
    agent_context: row.agent_context,
    updated_at: row.updated_at,
    score: Math.round(score * 1000) / 1000,
    snippet: buildSnippet(tokens, row, textColumns),
  }))

  res.json({ results })
})

// POST /api/objectives/search/ai  body { q, workspace? }
// Natural-language search: pull a bounded RBAC-scoped candidate set, hand a
// token-bounded (id+title+status+snippet) list to Anthropic Haiku, and let it
// select + rank. Model-invented ids are dropped (never trusted). Mirrors the
// Haiku call shape from objectives.ts POST /goal/draft.
router.post('/ai', async (req: AuthRequest, res) => {
  const user = req.user!
  const body = (req.body || {}) as { q?: string; workspace?: string }
  const q = typeof body.q === 'string' ? body.q.trim() : ''
  const workspace = typeof body.workspace === 'string' ? body.workspace : undefined

  if (!q) return res.json({ results: [] })

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(502).json({ error: 'ai search unavailable' })

  const scope = buildScope(user, workspace)
  if (!scope) return res.json({ results: [] })

  const textColumns = getTextColumns()
  const db = getDb()
  const tokens = tokenize(q)

  // Candidate pool = keyword-prefilter hits UNION most-recent rows in scope,
  // capped to bound the token budget. Both halves share the SAME scope clause so
  // RBAC can't leak. id+title+status+short snippet only.
  const selectCols = ['id', 'title', 'status', 'workspace', 'agent_context', 'updated_at', ...textColumns]
  const uniqueSelect = [...new Set(selectCols)].join(', ')

  const byId = new Map<number, CandidateRow>()

  if (tokens.length > 0) {
    const likeClauses: string[] = []
    const likeParams: unknown[] = []
    for (const token of tokens) {
      for (const frag of likeFragmentsForToken(token)) {
        for (const col of textColumns) {
          likeClauses.push(`${col} LIKE ?`)
          likeParams.push(`%${frag}%`)
        }
      }
    }
    const likeSql = `SELECT ${uniqueSelect} FROM objectives
       WHERE ${scope.clause} AND deleted_at IS NULL AND (${likeClauses.join(' OR ')})
       ORDER BY updated_at DESC LIMIT 100`
    for (const row of db.prepare(likeSql).all(...scope.params, ...likeParams) as CandidateRow[]) {
      byId.set(row.id, row)
    }
  }

  // Top up with most-recent-in-scope rows so the model can still find matches a
  // literal keyword prefilter misses.
  const recentSql = `SELECT ${uniqueSelect} FROM objectives
     WHERE ${scope.clause} AND deleted_at IS NULL
     ORDER BY updated_at DESC LIMIT 100`
  for (const row of db.prepare(recentSql).all(...scope.params) as CandidateRow[]) {
    if (byId.size >= 150) break
    if (!byId.has(row.id)) byId.set(row.id, row)
  }

  const candidates = [...byId.values()].slice(0, 150)
  if (candidates.length === 0) return res.json({ results: [] })

  const candidateBlock = candidates
    .map(c => {
      const snippet = buildSnippet(tokens, c, textColumns).slice(0, 160)
      return `id=${c.id} status=${c.status} title=${JSON.stringify(c.title || '')} snippet=${JSON.stringify(snippet)}`
    })
    .join('\n')

  const prompt = `You are a search assistant. From the CANDIDATE objectives below, select the ones that best match the user's natural-language query and rank them best-first.

User query: ${JSON.stringify(q)}

CANDIDATES (only these ids exist — never invent ids):
${candidateBlock}

Respond with ONLY a JSON object, no prose, no markdown fences:
{"results":[{"id":123,"reason":"one short line on why it matches"}]}
Include at most 20 results. If nothing matches, return {"results":[]}.`

  let raw: string | null = null
  try {
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    if (!apiRes.ok) return res.status(502).json({ error: 'ai search unavailable' })
    const data = (await apiRes.json()) as { content?: Array<{ type: string; text?: string }> }
    raw = data.content?.find(b => b.type === 'text')?.text?.trim() || null
  } catch {
    return res.status(502).json({ error: 'ai search unavailable' })
  }

  if (!raw) return res.status(502).json({ error: 'ai search unavailable' })

  let parsed: { results?: Array<{ id?: number; reason?: string }> } | null = null
  try {
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    const json = start >= 0 && end > start ? raw.slice(start, end + 1) : raw
    parsed = JSON.parse(json)
  } catch {
    return res.status(502).json({ error: 'ai search unavailable' })
  }

  const picks = Array.isArray(parsed?.results) ? parsed!.results! : []
  const seen = new Set<number>()
  const results: Array<{
    id: number
    title: string | null
    status: string
    workspace: string
    reason: string
  }> = []
  for (const pick of picks) {
    const id = typeof pick?.id === 'number' ? pick.id : Number(pick?.id)
    if (!Number.isFinite(id)) continue
    const row = byId.get(id) // hydrate ONLY from the candidate set — drop invented ids
    if (!row || seen.has(id)) continue
    seen.add(id)
    results.push({
      id: row.id,
      title: row.title,
      status: row.status,
      workspace: row.workspace,
      reason: typeof pick?.reason === 'string' ? pick.reason : '',
    })
  }

  res.json({ results })
})

export default router
