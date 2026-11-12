/**
 * Workflow builder (obj 900642, card B6 of docs/design/WORKFLOWS.md §5.1 / §7.6).
 *
 * "New workflow" — from the board, Jobs → Workflows or the agent API / MCP — is a
 * GOAL, not a definition. It creates:
 *
 *   1. a `flow_definitions` row with no version yet (status `draft`), and
 *   2. its HOME CARD as a BUILDER CARD: a normal objective (origin `workflow`)
 *      whose brief carries the goal, the end condition (or a request to propose
 *      one), the Tool registry the engine can run, the workspace's enabled MCP
 *      connectors, the exact REST loop to follow and the iteration budget.
 *
 * The builder agent (that card's session, or any outside agent over MCP) then
 * drafts versions with `POST /api/flows/:id/versions`, checks them with
 * `POST /api/flows/validate` (free) and self-tests them with
 * `POST /api/flows/:id/test`. It never publishes: publish stays cookie owner/admin.
 *
 * ── builder.max_iterations (§5.1 step 3) ─────────────────────────────────────
 * One iteration = one draft SUBMITTED by an agent principal (a card session token
 * or an agent API key), accepted or refused by the validator. Every submission is
 * a `flow_builder_attempts` row. Once `max_iterations` submissions have landed
 * since the flow's last GREEN self-test, the next agent draft is refused with
 * 409 `builder_iterations_exhausted` — the card then goes to the owner instead of
 * looping. A green self-test resets the count, so the owner can ask the builder
 * for a later change. Human drafts (cookie / JWT) are never counted or capped.
 *
 * Everything here is DB-injected so it is testable on a temp DB.
 */
import type Database from 'better-sqlite3'
import { initFlowSchema } from '../db/schema/flow.js'
import { FLOW_ID_RE, LLM_MAX_ITERATIONS_CAP, LOOP_MAX_CONCURRENCY } from '../../../shared/flow/types.js'
import { flowsEnabled, listRegisteredFlowTools } from './flow-engine.js'

/** §5.1: "up to builder.max_iterations (default 6)". */
export const DEFAULT_BUILDER_MAX_ITERATIONS = 6
/** Upper bound a caller may ask for; the card's cost ceiling still applies on top. */
export const BUILDER_MAX_ITERATIONS_CAP = 20
export const FLOW_GOAL_MAX_CHARS = 4000
export const FLOW_NAME_MAX_CHARS = 120

export const FLOWS_DISABLED_HOLD =
  'flows_disabled: settings.flows_enabled is off, so this builder cannot self-test yet. Start it after an operator turns workflows on.'

// ── settings ────────────────────────────────────────────────────────────────

function readSetting(db: Database.Database, key: string): string | null {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value ?? null
  } catch {
    return null
  }
}

/** Install default: `settings.flow_builder_max_iterations`, else 6. */
export function defaultBuilderMaxIterations(db: Database.Database): number {
  const n = Number(readSetting(db, 'flow_builder_max_iterations'))
  return Number.isInteger(n) && n >= 1 ? Math.min(n, BUILDER_MAX_ITERATIONS_CAP) : DEFAULT_BUILDER_MAX_ITERATIONS
}

/** The budget for one flow: its own `builder_max_iterations`, else the install default. */
export function builderMaxIterations(db: Database.Database, flowId: number): number {
  initFlowSchema(db)
  const row = db.prepare('SELECT builder_max_iterations FROM flow_definitions WHERE id = ?').get(flowId) as
    | { builder_max_iterations: number | null }
    | undefined
  const n = Number(row?.builder_max_iterations)
  return Number.isInteger(n) && n >= 1 ? Math.min(n, BUILDER_MAX_ITERATIONS_CAP) : defaultBuilderMaxIterations(db)
}

// ── iteration accounting ────────────────────────────────────────────────────

/** Authors whose drafts count as builder iterations: a card session or an agent key. Humans never do. */
export function isAgentAuthor(author: string): boolean {
  return author.startsWith('agent:') || author.startsWith('agent_key:')
}

export interface BuilderIterationState {
  /** Agent draft submissions since the last green self-test of this flow. */
  used: number
  max: number
  remaining: number
  exhausted: boolean
}

export function builderIterationState(db: Database.Database, flowId: number): BuilderIterationState {
  initFlowSchema(db)
  const lastGreen = (db.prepare(
    "SELECT MAX(COALESCE(ended_at, created_at)) AS at FROM flow_self_tests WHERE flow_id = ? AND status = 'passed'",
  ).get(flowId) as { at: string | null }).at
  const used = (db.prepare('SELECT COUNT(*) AS n FROM flow_builder_attempts WHERE flow_id = ? AND created_at > ?')
    .get(flowId, lastGreen ?? '') as { n: number }).n
  const max = builderMaxIterations(db, flowId)
  return { used, max, remaining: Math.max(0, max - used), exhausted: used >= max }
}

export function recordBuilderAttempt(
  db: Database.Database,
  args: { flowId: number; author: string; ok: boolean; version?: number | null; errors?: unknown },
): void {
  initFlowSchema(db)
  db.prepare('INSERT INTO flow_builder_attempts (flow_id, author, ok, version, errors_json) VALUES (?, ?, ?, ?, ?)').run(
    args.flowId,
    args.author,
    args.ok ? 1 : 0,
    args.version ?? null,
    args.errors === undefined ? null : JSON.stringify(args.errors).slice(0, 20_000),
  )
}

// ── naming ──────────────────────────────────────────────────────────────────

/** A slug matching FLOW_ID_RE from any name, or `workflow`. */
export function slugifyFlowName(name: string): string {
  const s = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
  return s && FLOW_ID_RE.test(s) ? s : 'workflow'
}

/** First free slug in the workspace: `base`, `base-2`, `base-3`, … */
export function uniqueFlowSlug(db: Database.Database, workspace: string, base: string): string {
  initFlowSchema(db)
  const taken = (slug: string) => !!db.prepare('SELECT 1 FROM flow_definitions WHERE workspace = ? AND slug = ?').get(workspace, slug)
  if (!taken(base)) return base
  for (let i = 2; i < 1000; i++) {
    const s = `${base.slice(0, 58)}-${i}`
    if (!taken(s)) return s
  }
  return `${base.slice(0, 50)}-${Date.now().toString(36)}`
}

/** A name from the goal's first sentence when the caller did not give one. */
export function nameFromGoal(goal: string): string {
  const first = goal.split(/(?<=[.!?])\s|\n/)[0]?.trim() || goal.trim()
  return first.length > 60 ? `${first.slice(0, 57).trimEnd()}…` : first
}

// ── registry + connectors for the brief ─────────────────────────────────────

export interface BriefTool {
  slug: string
  effect: string
  source: 'engine' | 'okit'
  description?: string
}

export interface BriefConnector {
  slug: string
  catalog_id: string | null
  name: string
  tools: string[]
}

/** Enabled + connected MCP connections of the workspace, with their enabled tools (what an `mcp` node may name). */
export async function workspaceConnectorsForBrief(workspace: string): Promise<BriefConnector[]> {
  try {
    const svc = await import('./workspace-mcp-servers.js')
    return svc.listServerRows(workspace)
      .filter((r) => Number(r.enabled) !== 0 && r.status === 'connected' && r.workspace === workspace)
      .map((r) => ({
        slug: r.slug,
        catalog_id: r.catalog_id ?? null,
        name: r.name,
        tools: svc.enabledToolsOf(r).map((t) => t.name),
      }))
  } catch {
    return []
  }
}

const OKIT_BRIEF_TIMEOUT_MS = 8000

/**
 * Tools a `tool` node can name: every Tool registered with the flow engine (these
 * run today), plus — best-effort, time-boxed — the okit Tools registry. The okit
 * runner is not wired into the engine yet (B2 notes), so those are listed as
 * "registry only" and a dry self-test must mock them.
 */
export async function toolRegistryForBrief(): Promise<{ tools: BriefTool[]; okit: 'ok' | 'unavailable' }> {
  const tools: BriefTool[] = listRegisteredFlowTools().map((t) => ({ slug: t.slug, effect: t.effect ?? 'send', source: 'engine' as const }))
  const seen = new Set(tools.map((t) => t.slug))
  try {
    const { runOkit } = await import('../routes/internal-operationkit.js')
    const r = await Promise.race([
      runOkit(['inventory', '--json']),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('okit timeout')), OKIT_BRIEF_TIMEOUT_MS).unref?.()),
    ])
    if (r.code !== 0) return { tools, okit: 'unavailable' }
    for (const t of okitTools(JSON.parse(r.stdout))) {
      if (seen.has(t.slug)) continue
      seen.add(t.slug)
      tools.push(t)
    }
    return { tools, okit: 'ok' }
  } catch {
    return { tools, okit: 'unavailable' }
  }
}

/** Pull `{slug, description, effect}` out of an okit inventory payload, whatever its exact shape. */
export function okitTools(inv: unknown): BriefTool[] {
  const raw = (inv as { tools?: unknown } | null)?.tools
  const entries: [string, unknown][] = Array.isArray(raw)
    ? raw.map((t) => [String((t as Record<string, unknown>)?.name ?? (t as Record<string, unknown>)?.slug ?? ''), t])
    : raw && typeof raw === 'object'
      ? Object.entries(raw as Record<string, unknown>)
      : []
  const out: BriefTool[] = []
  for (const [slug, t] of entries) {
    if (!slug || !FLOW_ID_RE.test(slug)) continue
    const o = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>
    const fm = (o.frontmatter && typeof o.frontmatter === 'object' ? o.frontmatter : o) as Record<string, unknown>
    const effect = typeof fm.effect === 'string' ? fm.effect : 'send'
    const description = typeof fm.description === 'string' ? fm.description.slice(0, 160) : undefined
    out.push({ slug, effect, source: 'okit', ...(description ? { description } : {}) })
  }
  return out.slice(0, 200)
}

// ── the brief ───────────────────────────────────────────────────────────────

export interface BuilderBriefInput {
  flowId: number
  slug: string
  name: string
  workspace: string
  goal: string
  endCondition: unknown | null
  maxIterations: number
  tools: BriefTool[]
  okit: 'ok' | 'unavailable'
  connectors: BriefConnector[]
  flowsEnabled: boolean
}

// Backslash first, so a `\` already in the text cannot un-escape the `\|` we add.
export const mdCell = (s: string) => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')

export function builderBrief(b: BuilderBriefInput): string {
  const api = 'http://localhost:3002/api/flows'
  const auth = '-H "X-CC-Session-Token: $CC_SESSION_TOKEN" -H "Content-Type: application/json"'
  const lines: string[] = []
  lines.push(
    `You are the **builder** of the workflow **${b.name}** (\`${b.slug}\`, flow #${b.flowId}, workspace \`${b.workspace}\`).`,
    'Turn the goal below into an `okflow/1` definition that validates and passes its self-test. You draft and test; you never publish.',
    '',
    '## Goal',
    '',
    b.goal,
    '',
    '## End condition',
    '',
  )
  if (b.endCondition) {
    lines.push(
      'Given by the owner. Put it in `goal.end_condition` exactly as written — it is the contract, you may not weaken or edit it:',
      '',
      '```json',
      JSON.stringify(b.endCondition, null, 2),
      '```',
    )
  } else {
    lines.push(
      'None given. **Propose one**: at least one deterministic `assert` (an expression over `steps.<id>.output…`), optional `judge`.',
      'Put it in the draft\'s `goal.end_condition` and state it in your summary so the owner can confirm it before publishing.',
      'Once the owner confirms it, you may not change it without them.',
    )
  }
  lines.push(
    '',
    `## The loop (budget: ${b.maxIterations} draft submissions)`,
    '',
    `Every draft you submit counts as one iteration, valid or not. After ${b.maxIterations} submissions without a green`,
    'self-test the server refuses the next one with `builder_iterations_exhausted`: stop, summarise what still fails, and route the card to review.',
    '',
    '1. Optional and free (does not count): check a definition without saving it:',
    `   \`curl -s -X POST ${api}/validate ${auth} -d '{"definition": {…}}'\` → \`{ok, errors[], warnings[]}\`.`,
    '2. Draft a version (counts): ',
    `   \`curl -s -X POST ${api}/${b.flowId}/versions ${auth} -d '{"definition": {…}}'\``,
    '   A 400 lists **every** validation error at once (`code`, `path`, `message`, `node_id`) — fix them all, then resubmit.',
    '   `version` may be omitted (the next number is used). The answer carries `builder.remaining`.',
    '3. Self-test the version you drafted:',
    `   \`curl -s -X POST ${api}/${b.flowId}/test ${auth} -d '{"version": N, "mode": "dry"}'\``,
    '   `self_test.status` is `passed` or `failed`; `self_test.result.failures[]` says which assert or node failed. `dry` calls nothing outside.',
    '4. Iterate on failures (back to 2). Stop at the first `passed`.',
    '5. Do **not** publish (the server refuses anyone but the signed-in owner). Write a short summary: the version, the self-test id,',
    '   the end condition, and the send/spend nodes the owner will be asked to approve. Then route the card to review.',
    '',
    '## Definition rules (the validator enforces them)',
    '',
    `- \`apiVersion: "okflow/1"\`, \`id: "${b.slug}"\`, \`workspace: "${b.workspace}"\`, an integer \`version\`, \`name\`, \`goal\`, \`nodes[]\`.`,
    '- Node kinds: `trigger` (exactly one, first; `on: schedule|webhook|manual|board|event`), `tool`, `mcp`, `llm`, `branch`, `loop`, `check`, `agent`, `wait`, `end`. A `wait` takes exactly one of `for` / `until` / `event` / `approval: {from, prompt}`; an `agent` files a child card and parks until it finishes. In a dry/test self-test both are simulated, so give an `agent` node a `mock` too. Loops cannot nest.',
    `- Node ids match \`^[a-z][a-z0-9_]{0,40}$\`; wire them with \`next\`. \`loop\` needs \`max_items\` (concurrency ≤ ${LOOP_MAX_CONCURRENCY}); \`llm.max_iterations\` ≤ ${LLM_MAX_ITERATIONS_CAP} and an \`output_schema\`.`,
    '- References are paths only: `{{ trigger.payload.x }}`, `{{ steps.<id>.output.y }}`, `{{ item.z }}`. Functions: `len`, `now`, `date_add`, `lower`, `join`, `default`. No code.',
    '- **Never** `{{ secrets.* }}` — Tools and connectors resolve their own credentials.',
    '- Every node gets an `effect` (`read|write|send|spend`; unknown = `send`). Every `write`/`send`/`spend` node needs a `mock: {output: …}` so the dry self-test can stub it; give `read` nodes a `mock` too unless you want a live `test` run.',
    '- Give the flow a `budget: {run_usd}` when it has an `llm` node: a spending node with no finite budget is refused at run time.',
    '- Do not write an `approvals` block: approval is recorded by the owner at publish time, never typed into the definition.',
    '- Full reference: `docs/design/WORKFLOWS.md` §3 (and the `daily-booking-triage` example in §3.5).',
    '',
    `## Tool registry (\`tool\` nodes, workspace \`${b.workspace}\`)`,
    '',
  )
  if (b.tools.length === 0) {
    lines.push('No Tool is registered with the flow engine on this install yet. Use `mcp` nodes, or a `tool` node with a `mock` (dry self-test only).')
  } else {
    lines.push('| slug | effect | runs in the engine today |', '|---|---|---|')
    for (const t of b.tools) {
      lines.push(`| \`${t.slug}\` | ${t.effect} | ${t.source === 'engine' ? 'yes' : 'registry only — mock it'}${t.description ? ` — ${mdCell(t.description)}` : ''} |`)
    }
  }
  if (b.okit === 'unavailable') {
    lines.push('', '_The okit Tools registry was not reachable when this brief was written; the full list is `GET /api/internal/operationkit/registry`._')
  }
  lines.push('', `## Connectors (\`mcp\` nodes, workspace \`${b.workspace}\`)`, '')
  if (b.connectors.length === 0) {
    lines.push('No MCP connection is connected and enabled in this workspace. Add one in Settings → Integrations, or build without `mcp` nodes.')
  } else {
    lines.push('`connector` is the slug (or its catalog id); `tool` must be one of the enabled tools.', '', '| connector | name | enabled tools |', '|---|---|---|')
    for (const c of b.connectors) {
      lines.push(`| \`${c.slug}\`${c.catalog_id ? ` (\`${c.catalog_id}\`)` : ''} | ${mdCell(c.name)} | ${c.tools.length ? c.tools.map((t) => `\`${t}\``).join(', ') : '—'} |`)
    }
  }
  lines.push('', `Diagram, versions and runs: [Jobs → Workflows](/jobs?view=workflows&flow=${b.flowId}).`)
  if (!b.flowsEnabled) {
    lines.push('', '> Workflows are switched off on this install (`settings.flows_enabled = 0`): drafts and validation work, self-tests answer `flows_disabled`.')
  }
  return lines.join('\n')
}

export const BUILDER_COMPLETION_GOAL =
  'A draft version of this workflow validates and its latest self-test is `passed`; the summary names the version, the self-test id, the end condition and the send/spend nodes the owner must approve at publish. The builder never publishes.'

// ── create ──────────────────────────────────────────────────────────────────

export interface CreateFromGoalInput {
  workspace: string
  goal: string
  name?: string
  endCondition?: unknown
  maxIterations?: number
  createdBy: string
  createdByUserId: number | null
}

export interface CreateFromGoalResult {
  flowId: number
  slug: string
  name: string
  objectiveId: number
  maxIterations: number
  queueHold: string | null
}

/**
 * Create the flow row and its builder (home) card in one transaction. The card
 * lands in `queue` (it is a real agent session once started). While the kill
 * switch is off it carries a queue hold, so the queue auto-starter does not spend
 * a session on a builder that cannot self-test yet; an explicit start still works.
 */
export async function createWorkflowFromGoal(db: Database.Database, input: CreateFromGoalInput): Promise<CreateFromGoalResult> {
  initFlowSchema(db)
  const name = (input.name?.trim() || nameFromGoal(input.goal)).slice(0, FLOW_NAME_MAX_CHARS)
  const [{ tools, okit }, connectors] = await Promise.all([toolRegistryForBrief(), workspaceConnectorsForBrief(input.workspace)])
  const enabled = flowsEnabled(db)
  const queueHold = enabled ? null : FLOWS_DISABLED_HOLD
  return db.transaction((): CreateFromGoalResult => {
    const slug = uniqueFlowSlug(db, input.workspace, slugifyFlowName(name))
    const maxIter = input.maxIterations ?? null
    const r = db.prepare(
      'INSERT INTO flow_definitions (slug, workspace, name, created_by, goal_statement, builder_max_iterations) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(slug, input.workspace, name, input.createdBy, input.goal, maxIter)
    const flowId = Number(r.lastInsertRowid)
    const maxIterations = builderMaxIterations(db, flowId)
    const description = builderBrief({
      flowId, slug, name, workspace: input.workspace, goal: input.goal, endCondition: input.endCondition ?? null,
      maxIterations, tools, okit, connectors, flowsEnabled: enabled,
    })
    const o = db.prepare(
      `INSERT INTO objectives (title, description, completion_goal, agent_context, workspace, category, type, status, origin, created_by, queue_hold)
       VALUES (?, ?, ?, 'general', ?, 'general', 'task', 'queue', 'workflow', ?, ?)`,
    ).run(
      `Build workflow: ${name}`, description, BUILDER_COMPLETION_GOAL, input.workspace,
      input.createdByUserId && input.createdByUserId > 0 ? input.createdByUserId : null, queueHold,
    )
    const objectiveId = Number(o.lastInsertRowid)
    db.prepare("UPDATE flow_definitions SET objective_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
      .run(objectiveId, flowId)
    return { flowId, slug, name, objectiveId, maxIterations, queueHold }
  })()
}
