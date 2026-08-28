/* Contract-faithful mock for obj 702389 frontend verification.
   Serves the built client SPA + only the /api routes the board/search/modal hit,
   returning the exact shapes from app/server/src/routes/objectives-search.ts and
   the shared Objective/WorkspaceRecord types. NOT a backend test — it exists
   solely to drive the FRONTEND in a browser since the real search backend
   (obj 702388) is not yet on origin/main. AI 502 path is triggered by a query
   containing the word "unconfigured". */
const path = require('path')
const express = require(path.join('/home/operator/projects/command-center-infra/app/node_modules/express'))

const DIST = '/home/operator/projects/cc-wt-702389/app/client/dist'
const app = express()
app.use(express.json())

const USER = {
  id: 1, username: 'mike', role: 'admin', created_at: '2026-05-10 17:01:33',
  workspaces: [
    { workspace: 'example', role: 'admin' },
    { workspace: 'example2', role: 'admin' },
    { workspace: 'example-project', role: 'admin' },
  ],
}
const WORKSPACES = [
  { slug: 'example', name: 'Example', short_label: 'AX', badge_color: null, vault_path: null, doc_read_roots: [], doc_write_roots: [], default_agent_pool: [], archived: false, sort_order: 0, created_at: '', updated_at: '' },
  { slug: 'example2', name: 'Grass-Fed', short_label: 'GF', badge_color: null, vault_path: null, doc_read_roots: [], doc_write_roots: [], default_agent_pool: [], archived: false, sort_order: 1, created_at: '', updated_at: '' },
  { slug: 'example-project', name: 'Example Project', short_label: 'WS', badge_color: null, vault_path: null, doc_read_roots: [], doc_write_roots: [], default_agent_pool: [], archived: false, sort_order: 2, created_at: '', updated_at: '' },
]

// Search corpus — mixed statuses, incl. DONE, so keyword search proves it finds
// completed objectives. Shape = GET /objectives/search result rows.
const CORPUS = [
  { id: 501, title: 'Board objective search UI (keyword+fuzzy + AI mode)', status: 'working', workspace: 'example', agent_context: 'cto', updated_at: '2026-07-16T10:00:00Z', description: 'Build the frontend objective search panel wired to the search endpoints.' },
  { id: 402, title: 'Client portal lockout + dispute flow', status: 'done', workspace: 'example2', agent_context: 'cto', updated_at: '2026-07-02T09:00:00Z', description: 'Shipped the portal lockout and dispute UI to the redesign branch. Completed and verified.' },
  { id: 377, title: 'Deploy pipeline hardening for board', status: 'done', workspace: 'example', agent_context: 'coo', updated_at: '2026-06-20T09:00:00Z', description: 'Hardened the self-deploy path and drift guard. Done, merged to main.' },
  { id: 288, title: 'Approve & Bill Stripe charge for example3', status: 'done', workspace: 'example2', agent_context: 'cfo', updated_at: '2026-06-11T09:00:00Z', description: 'In-process Stripe charge for the Approve & Bill flow. Completed.' },
  { id: 233, title: 'Manufacturer order change-detection', status: 'cancelled', workspace: 'example-project', agent_context: 'cto', updated_at: '2026-05-30T09:00:00Z', description: 'Superseded — retired in favour of the snapshot approach.' },
  { id: 199, title: 'Assignee filter chips on the board', status: 'review', workspace: 'example', agent_context: 'designer', updated_at: '2026-07-10T09:00:00Z', description: 'Multi-select assignee filter chips above the board grid.' },
]

function buildRow(o, q) {
  const hay = (o.title + ' ' + o.description).toLowerCase()
  const idx = hay.indexOf(q.toLowerCase())
  const snippet = idx >= 0
    ? (idx > 20 ? '…' : '') + o.description.slice(Math.max(0, idx - 20), idx + 80).trim() + '…'
    : o.description.slice(0, 90) + '…'
  return { id: o.id, title: o.title, status: o.status, workspace: o.workspace, agent_context: o.agent_context, updated_at: o.updated_at, score: 2.5, snippet }
}

app.get('/api/auth/me', (_req, res) => res.json(USER))
app.get('/api/workspaces', (_req, res) => res.json(WORKSPACES))
app.get('/api/workspaces-config', (_req, res) => res.json({ workspaces: WORKSPACES }))
app.get('/api/models', (_req, res) => res.json({ models: [] }))
app.get('/api/test-credentials', (_req, res) => res.json([]))
app.get('/api/objectives/strategies', (_req, res) => res.json([]))

// GET /api/objectives/search — keyword/fuzzy
app.get('/api/objectives/search', (req, res) => {
  const q = String(req.query.q || '').trim()
  if (!q) return res.json({ results: [] })
  const tokens = q.toLowerCase().split(/\s+/)
  const results = CORPUS
    .filter(o => tokens.some(t => (o.title + ' ' + o.description).toLowerCase().includes(t)))
    .map(o => buildRow(o, tokens[0]))
  res.json({ results })
})

// POST /api/objectives/search/ai — Haiku-ranked; 502 when "unconfigured" in query
app.post('/api/objectives/search/ai', (req, res) => {
  const q = String((req.body && req.body.q) || '').trim()
  if (/unconfigured/i.test(q)) return res.status(502).json({ error: 'ai search unavailable' })
  if (!q) return res.json({ results: [] })
  const tokens = q.toLowerCase().split(/\s+/)
  const results = CORPUS
    .filter(o => tokens.some(t => (o.title + ' ' + o.description).toLowerCase().includes(t)) || /done|complete|ship/.test(q.toLowerCase()) && o.status === 'done')
    .slice(0, 20)
    .map(o => ({ id: o.id, title: o.title, status: o.status, workspace: o.workspace, reason: `Matches “${q}” — ${o.status === 'done' ? 'a completed' : 'an active'} objective about ${o.title.split(' ').slice(0, 3).join(' ').toLowerCase()}.` }))
  res.json({ results })
})

// GET /api/objectives/:id — full Objective for the modal (defaults for all fields)
app.get('/api/objectives/:id', (req, res) => {
  const id = Number(req.params.id)
  const src = CORPUS.find(o => o.id === id)
  if (!src) return res.status(404).json({ error: 'Objective not found' })
  res.json({
    id: src.id, title: src.title, description: src.description, status: src.status,
    agent_context: src.agent_context, workspace: src.workspace, project: null,
    category: 'general', parent_id: null, depth: 0, assigned_user_id: null,
    assigned_user_ids: [], assigned_usernames: [], routine_id: null,
    created_by: 1, session_id: null, transcript_path: null, last_session_summary: null,
    session_count: 3, total_cost_usd: 0, total_tokens: 0, has_blockers: false,
    delegate_mode: false, is_strategy: false, type: 'task', effort: 'normal',
    model: '', workflow_hint: '', completion_goal: '', create_pr: false,
    skip_ai_review: false, test_cred_slug: null, strategy_id: null,
    created_at: '2026-06-01 00:00:00', updated_at: src.updated_at,
  })
})

// Board list — empty is fine (columns render empty); covers all query variants.
app.get('/api/objectives', (_req, res) => res.json([]))

// Static SPA (assets + index.html fallback for client routes)
app.use(express.static(DIST))
app.get('*', (_req, res) => res.sendFile(path.join(DIST, 'index.html')))

const PORT = 4599
app.listen(PORT, () => console.log('mock listening on ' + PORT))
