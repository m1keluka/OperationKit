/**
 * PostHog Signals → Command Center objective bridge (W5 / obj 712024).
 *
 * WHY THIS EXISTS
 * ---------------
 * PostHog Self-Driving runs in two stages:
 *   1. DETECTION — scout agents running in PostHog's cloud watch session replays,
 *      error tracking and product analytics and emit *signal reports*.
 *   2. IMPLEMENTATION — PostHog dispatches its OWN coding agent to write the fix
 *      PR. That stage is what PostHog bills for (~$10-15 per PR; the report field
 *      `refund_ineligibility_reason: "no_billable_pr"` shows billing attaches to
 *      the PR, not to the report).
 *
 * We want stage 1 and we want to do stage 2 ourselves. This bridge polls the
 * detection API, claims the reports worth acting on (so they show as owned by
 * us rather than sitting unclaimed in PostHog's inbox), and opens ONE Command
 * Center objective per report carrying the full evidence pack, so one of OUR
 * agents writes the fix PR.
 *
 * VERIFIED CLAIM SEMANTICS (live against project 483354, 2026-09-23):
 *   POST /api/projects/<p>/signals/reports/<id>/claim/   body {}
 *       → 200, work_state "unclaimed" → "working", assignee.kind "user"
 *   POST .../claim/                                      body {"release": true}
 *       → 200, work_state → "unclaimed", assignee null   (claiming IS reversible)
 *   Re-POSTing {} while already claimed by the same principal is idempotent —
 *   the same claim_id is returned. There is no DELETE (405) and no /unclaim/ route (404).
 *
 * DOES CLAIMING SUPPRESS PostHog's OWN BILLABLE AGENT? Yes — proven from the
 * open-source backend (PostHog/posthog @ 5e4b199890ab00050f3a21e77173f1a59b3e8fd4),
 * not from any doc (the public docs never mention claiming at all):
 *   - products/signals/backend/auto_start.py:642 holds the ONLY call to
 *     tasks_facade.create_and_run_task(..., interaction_origin="signal_report"),
 *     i.e. the sole code path that dispatches PostHog's PR-writing agent.
 *   - The same function bails out first, at auto_start.py:614-615:
 *         elif claim is not None or pending_replacement(...) is not None:
 *             return False
 *     where `claim = get_active_claim(team_id=..., report_id=...)`.
 *   - serializers.py:1453-1454 derives the very `work_state` we read from that
 *     same get_active_claim() call, so work_state == 'working' is definitionally
 *     the predicate that blocks the dispatch.
 *   - billing.py:3-4 / :70 — "each signal report whose implementation task opens
 *     a pull request is charged"; SIGNALS_CREDITS_PER_REPORT_WITH_PR = 15 * ... .
 * CAVEATS (treat as real limits, not fine print): the gate is evaluated at
 * dispatch time, so it only helps while the claim is held — releasing re-arms
 * auto-start, and a claim placed after PostHog's task already started does
 * nothing. The behaviour is undocumented, so PostHog may change it silently.
 *
 * SAFETY — OFF BY DEFAULT
 * -----------------------
 * The sweep is a hard no-op unless POSTHOG_SIGNALS_BRIDGE_ENABLED === 'true'.
 * With the flag unset it performs no claim and creates no objective; it does not
 * even reach the PostHog API. Merging this file therefore cannot start spawning
 * objectives on the board.
 *
 * CONFIG
 *   POSTHOG_SIGNALS_BRIDGE_ENABLED  'true' to arm the sweep (default OFF)
 *   POSTHOG_SIGNALS_WORKSPACE       CC workspace whose PostHog integration to use (default 'example2')
 *   POSTHOG_SIGNALS_PROJECT_ID      PostHog project id (e.g. 483354)
 *   POSTHOG_SIGNALS_HOST            override host (default: integration host, else https://us.posthog.com)
 *   POSTHOG_SIGNALS_PERSONAL_API_KEY  env fallback when the workspace integration has no personal key
 *   POSTHOG_SIGNALS_MIN_WEIGHT      minimum total_weight to act on (default 0.4)
 *   POSTHOG_SIGNALS_MIN_SIGNALS     minimum signal_count to act on (default 1)
 *   POSTHOG_SIGNALS_STATUSES        comma-separated allowed report statuses (default 'potential,confirmed')
 *   POSTHOG_SIGNALS_MAX_PER_RUN     cap on objectives created per sweep (default 5)
 *   POSTHOG_SIGNALS_REPO            fallback target repo when the report carries no repo_slug
 *
 * Credentials are NEVER hardcoded — they come from the per-workspace PostHog
 * integration (workspace_integrations.config) or from env.
 *
 * IDEMPOTENCY
 * The objectives table carries `posthog_report_id` with a partial UNIQUE index
 * (idx_objectives_posthog_report_id, see db/index.ts). The sweep pre-checks that
 * column and the index is the hard backstop, so a re-run can never create a
 * second objective for the same report id.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'better-sqlite3'

// ── Types ────────────────────────────────────────────────────────────────────

export interface SignalReport {
  id: string
  title: string
  summary: string
  status: string
  total_weight: number
  signal_count: number
  source_products: string[]
  work_state: string
  repo_slug: string | null
  priority: string | null
  created_at: string
}

export interface ReportEvidence {
  artefacts: unknown[]
  signals: unknown[]
}

export interface SignalsConfig {
  enabled: boolean
  workspace: string
  host: string
  projectId: string
  apiKey: string
  minWeight: number
  minSignals: number
  allowedStatuses: string[]
  maxPerRun: number
  fallbackRepo: string
}

/** One acceptance criterion, in the shape POST /api/internal/objectives expects. */
export interface AcceptanceCriterion {
  id: string
  criterion: string
  type: string
  method: string
}

/** Payload handed to the objective creator. Mirrors POST /api/internal/objectives. */
export interface ObjectivePayload {
  title: string
  description: string
  workspace: string
  project: string
  type: string
  agent_context: string
  completion_goal: string
  /**
   * MUST be an array — internal-create.ts only honours `Array.isArray(...)` and
   * silently substitutes its own default rubric for anything else.
   */
  acceptance_criteria: AcceptanceCriterion[]
}

export type ObjectiveCreator = (payload: ObjectivePayload) => Promise<number>
export type FetchLike = typeof fetch

export interface SweepResult {
  enabled: boolean
  reports_fetched: number
  reports_actionable: number
  reports_claimed: number
  objectives_created: number
  skipped_duplicate: number
  skipped_threshold: number
  errors: Array<{ report_id: string; message: string }>
}

const LOG = '[posthog-signals]'

/**
 * Durable sink for the sweep's own log lines.
 *
 * The sweep is the only thing that proves the bridge is armed, and its output
 * previously existed ONLY on the container's stdout (docker json log). Anyone
 * without the docker socket — every Claude session on this box runs as an
 * unprivileged uid, and the socket is root:987 — could not observe it at all.
 * So every `${LOG}` line is mirrored to a file under the data volume as well as
 * to stdout. Best-effort: an unwritable path must never break a sweep.
 */
export const SIGNALS_LOG_FILE =
  process.env.POSTHOG_SIGNALS_LOG_FILE ||
  path.join(process.env.CC_DATA_DIR || '/app/data', 'logs', 'posthog-signals.log')

export function slog(line: string, level: 'log' | 'warn' | 'error' = 'log'): void {
  console[level](line)
  try {
    fs.mkdirSync(path.dirname(SIGNALS_LOG_FILE), { recursive: true })
    fs.appendFileSync(SIGNALS_LOG_FILE, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // Observability is not worth failing the sweep over.
  }
}

function emptyResult(enabled: boolean): SweepResult {
  return {
    enabled,
    reports_fetched: 0,
    reports_actionable: 0,
    reports_claimed: 0,
    objectives_created: 0,
    skipped_duplicate: 0,
    skipped_threshold: 0,
    errors: [],
  }
}

// ── Config ───────────────────────────────────────────────────────────────────

function num(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  return raw !== undefined && raw !== '' && Number.isFinite(n) ? n : fallback
}

/**
 * Build the sweep config from env + the per-workspace PostHog integration.
 *
 * `integration` is the raw workspace_integrations config row (host /
 * project_api_key / personal_api_key). It is passed in rather than read here so
 * the function stays pure and testable.
 */
export function loadSignalsConfig(
  env: NodeJS.ProcessEnv = process.env,
  integration: Record<string, unknown> | undefined = undefined,
): SignalsConfig {
  const intHost = typeof integration?.host === 'string' ? integration.host : ''
  const intKey = typeof integration?.personal_api_key === 'string' ? integration.personal_api_key : ''
  const statuses = (env.POSTHOG_SIGNALS_STATUSES || 'potential,confirmed')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
  return {
    // Default OFF. Only the exact string 'true' arms the sweep.
    enabled: env.POSTHOG_SIGNALS_BRIDGE_ENABLED === 'true',
    workspace: env.POSTHOG_SIGNALS_WORKSPACE || 'example2',
    host: (env.POSTHOG_SIGNALS_HOST || intHost || 'https://us.posthog.com').replace(/\/+$/, ''),
    projectId: env.POSTHOG_SIGNALS_PROJECT_ID || '',
    apiKey: env.POSTHOG_SIGNALS_PERSONAL_API_KEY || intKey || '',
    minWeight: num(env.POSTHOG_SIGNALS_MIN_WEIGHT, 0.4),
    minSignals: num(env.POSTHOG_SIGNALS_MIN_SIGNALS, 1),
    allowedStatuses: statuses,
    maxPerRun: num(env.POSTHOG_SIGNALS_MAX_PER_RUN, 5),
    fallbackRepo: env.POSTHOG_SIGNALS_REPO || 'example2/example3-platform',
  }
}

/** Returns a human-readable reason string when the config cannot drive a sweep, else null. */
export function configProblem(cfg: SignalsConfig): string | null {
  const missing: string[] = []
  if (!cfg.projectId) missing.push('POSTHOG_SIGNALS_PROJECT_ID')
  if (!cfg.apiKey) missing.push('PostHog personal API key (integration or POSTHOG_SIGNALS_PERSONAL_API_KEY)')
  return missing.length > 0 ? `missing ${missing.join(', ')}` : null
}

// ── Threshold filter ─────────────────────────────────────────────────────────

/**
 * Decide whether a report is worth claiming + turning into an objective.
 * Every bound is config-driven — no magic numbers live here.
 */
export function isActionable(
  report: SignalReport,
  cfg: SignalsConfig,
): { ok: boolean; reason: string } {
  if (report.work_state !== 'unclaimed') {
    return { ok: false, reason: `work_state=${report.work_state} (not unclaimed)` }
  }
  if (!cfg.allowedStatuses.includes(String(report.status).toLowerCase())) {
    return { ok: false, reason: `status=${report.status} not in [${cfg.allowedStatuses.join(',')}]` }
  }
  if (Number(report.total_weight) < cfg.minWeight) {
    return { ok: false, reason: `total_weight=${report.total_weight} < ${cfg.minWeight}` }
  }
  if (Number(report.signal_count) < cfg.minSignals) {
    return { ok: false, reason: `signal_count=${report.signal_count} < ${cfg.minSignals}` }
  }
  return { ok: true, reason: 'passes threshold' }
}

// ── PostHog API ──────────────────────────────────────────────────────────────

function reportsBase(cfg: SignalsConfig): string {
  return `${cfg.host}/api/projects/${cfg.projectId}/signals/reports`
}

/** Public PostHog URL a human can open for one report. */
export function reportUrl(cfg: SignalsConfig, reportId: string): string {
  return `${cfg.host}/project/${cfg.projectId}/signals/${reportId}`
}

async function phJson(
  f: FetchLike,
  cfg: SignalsConfig,
  url: string,
  init?: RequestInit,
): Promise<unknown> {
  const res = await f(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json',
      ...(init?.headers as Record<string, string> | undefined),
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${init?.method || 'GET'} ${url} → ${res.status}: ${body.slice(0, 300)}`)
  }
  return res.json()
}

function toReport(raw: Record<string, unknown>): SignalReport {
  return {
    id: String(raw.id ?? ''),
    title: typeof raw.title === 'string' ? raw.title : '(untitled signal report)',
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    status: typeof raw.status === 'string' ? raw.status : 'unknown',
    total_weight: Number(raw.total_weight ?? 0),
    signal_count: Number(raw.signal_count ?? 0),
    source_products: Array.isArray(raw.source_products) ? (raw.source_products as string[]) : [],
    work_state: typeof raw.work_state === 'string' ? raw.work_state : 'unknown',
    repo_slug: typeof raw.repo_slug === 'string' ? raw.repo_slug : null,
    priority: typeof raw.priority === 'string' ? raw.priority : null,
    created_at: typeof raw.created_at === 'string' ? raw.created_at : '',
  }
}

/** GET /signals/reports/ — the detection-stage inbox. */
export async function fetchSignalReports(f: FetchLike, cfg: SignalsConfig): Promise<SignalReport[]> {
  const body = (await phJson(f, cfg, `${reportsBase(cfg)}/`)) as { results?: unknown[] }
  const results = Array.isArray(body?.results) ? body.results : []
  return results.map(r => toReport((r || {}) as Record<string, unknown>))
}

/** GET the artefacts + signals sub-resources that carry the actual evidence. */
export async function fetchReportEvidence(
  f: FetchLike,
  cfg: SignalsConfig,
  reportId: string,
): Promise<ReportEvidence> {
  const [art, sig] = await Promise.all([
    phJson(f, cfg, `${reportsBase(cfg)}/${reportId}/artefacts/`).catch(() => ({})),
    phJson(f, cfg, `${reportsBase(cfg)}/${reportId}/signals/`).catch(() => ({})),
  ])
  const artefacts = Array.isArray((art as { results?: unknown[] })?.results)
    ? ((art as { results: unknown[] }).results)
    : []
  const signals = Array.isArray((sig as { signals?: unknown[] })?.signals)
    ? ((sig as { signals: unknown[] }).signals)
    : []
  return { artefacts, signals }
}

/**
 * POST /signals/reports/<id>/claim/ — take ownership.
 * Body {} claims; body {"release": true} releases (verified live). Returns the
 * post-claim work_state.
 */
export async function claimReport(
  f: FetchLike,
  cfg: SignalsConfig,
  reportId: string,
  release = false,
): Promise<string> {
  const body = (await phJson(f, cfg, `${reportsBase(cfg)}/${reportId}/claim/`, {
    method: 'POST',
    body: JSON.stringify(release ? { release: true } : {}),
  })) as { work_state?: string }
  return typeof body?.work_state === 'string' ? body.work_state : 'unknown'
}

// ── Objective payload ────────────────────────────────────────────────────────

function fence(label: string, value: unknown): string {
  return `### ${label}\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`
}

/** Turn a report + its evidence into a Command Center objective payload. */
export function buildObjectivePayload(
  report: SignalReport,
  evidence: ReportEvidence,
  cfg: SignalsConfig,
): ObjectivePayload {
  const repo = report.repo_slug || cfg.fallbackRepo
  const url = reportUrl(cfg, report.id)
  const description = [
    `Auto-filed from a **PostHog Self-Driving signal report** (detection stage). We implement the fix ourselves rather than letting PostHog's paid agent write the PR.`,
    ``,
    `| | |`,
    `|---|---|`,
    `| PostHog report id | \`${report.id}\` |`,
    `| PostHog report URL | ${url} |`,
    `| Target repository | \`${repo}\` |`,
    `| Status / weight / signals | ${report.status} / ${report.total_weight} / ${report.signal_count} |`,
    `| Source products | ${report.source_products.join(', ') || '(none)'} |`,
    `| Detected at | ${report.created_at} |`,
    ``,
    `## Summary (from PostHog)`,
    ``,
    report.summary || '(no summary)',
    ``,
    `## Evidence`,
    ``,
    fence(`Signals (${evidence.signals.length})`, evidence.signals),
    fence(`Artefacts (${evidence.artefacts.length})`, evidence.artefacts),
  ].join('\n')

  return {
    title: `[PostHog] ${report.title}`,
    description,
    workspace: cfg.workspace,
    project: repo.split('/').pop() || repo,
    type: 'task',
    agent_context: 'cto',
    completion_goal:
      `The bug described by PostHog signal report ${report.id} is fixed in ${repo} with a merged PR, ` +
      `and the fix is verified against the evidence in the report (session replay / signals listed above).`,
    acceptance_criteria: [
      {
        id: 'root-cause-identified',
        criterion:
          `The root cause of "${report.title}" is identified in ${repo}, cited as file:line on the PR branch ` +
          `(not just described), and the citation resolves at the PR head.`,
        type: 'data',
        method: 'doc',
      },
      {
        id: 'fix-shipped',
        criterion: `An open PR on ${repo} contains the fix, with every CI check FINISHED and conclusion success on the PR head SHA.`,
        type: 'functional',
        method: 'api',
      },
      {
        id: 'evidence-addressed',
        criterion:
          `The specific user-visible failure described in the PostHog signals above no longer reproduces — ` +
          `proven by a committed regression test that fails on the pre-fix code, or a pasted reproduction run.`,
        type: 'functional',
        method: 'static',
      },
      {
        id: 'posthog-report-linked',
        criterion: `The PR body links the PostHog report ${url} so the fix is traceable back to the detection that triggered it.`,
        type: 'data',
        method: 'doc',
      },
    ],
  }
}

// ── Sweep ────────────────────────────────────────────────────────────────────

export interface SweepDeps {
  fetch: FetchLike
  createObjective: ObjectiveCreator
  config: SignalsConfig
}

/** Existing objective id for this report id, or undefined. */
export function existingObjectiveFor(db: Database, reportId: string): number | undefined {
  try {
    const row = db
      .prepare('SELECT id FROM objectives WHERE posthog_report_id = ?')
      .get(reportId) as { id: number } | undefined
    return row?.id
  } catch {
    return undefined
  }
}

/**
 * One full sweep: fetch reports → threshold filter → claim → create one objective
 * each, idempotently. Never throws; per-report failures are collected.
 *
 * Hard no-op (zero network calls, zero claims, zero objectives) when the bridge
 * flag is not explicitly 'true'.
 */
export async function runPosthogSignalsSweep(
  db: Database,
  deps: SweepDeps,
): Promise<SweepResult> {
  const cfg = deps.config

  if (!cfg.enabled) {
    slog(`${LOG} disabled (POSTHOG_SIGNALS_BRIDGE_ENABLED is not 'true') — no claims, no objectives`)
    return emptyResult(false)
  }
  const problem = configProblem(cfg)
  if (problem) {
    slog(`${LOG} enabled but not configured: ${problem} — skipping sweep`, 'warn')
    return emptyResult(true)
  }

  const result = emptyResult(true)

  let reports: SignalReport[]
  try {
    reports = await fetchSignalReports(deps.fetch, cfg)
  } catch (err) {
    slog(`${LOG} fetch reports failed: ${(err as Error).message}`, 'error')
    result.errors.push({ report_id: '(list)', message: (err as Error).message })
    return result
  }
  result.reports_fetched = reports.length
  slog(
    `${LOG} project ${cfg.projectId}: fetched ${reports.length} report(s); ` +
      `threshold status=[${cfg.allowedStatuses.join(',')}] min_weight=${cfg.minWeight} min_signals=${cfg.minSignals}`,
  )

  for (const report of reports) {
    const verdict = isActionable(report, cfg)
    if (!verdict.ok) {
      result.skipped_threshold++
      slog(`${LOG} skip ${report.id}: ${verdict.reason}`)
      continue
    }
    result.reports_actionable++

    const existing = existingObjectiveFor(db, report.id)
    if (existing !== undefined) {
      result.skipped_duplicate++
      slog(`${LOG} skip ${report.id}: objective ${existing} already exists for this report`)
      continue
    }

    if (result.objectives_created >= cfg.maxPerRun) {
      slog(`${LOG} per-run cap ${cfg.maxPerRun} reached — deferring ${report.id} to the next sweep`)
      break
    }

    try {
      const evidence = await fetchReportEvidence(deps.fetch, cfg, report.id)
      const workState = await claimReport(deps.fetch, cfg, report.id)
      result.reports_claimed++
      slog(`${LOG} claimed ${report.id} → work_state=${workState}`)

      const payload = buildObjectivePayload(report, evidence, cfg)
      const objId = await deps.createObjective(payload)
      // Anchor the report id on the objective immediately. The partial UNIQUE
      // index idx_objectives_posthog_report_id makes a duplicate impossible.
      db.prepare('UPDATE objectives SET posthog_report_id = ? WHERE id = ?').run(report.id, objId)
      result.objectives_created++
      slog(`${LOG} created objective ${objId} for report ${report.id} ("${report.title}")`)
    } catch (err) {
      const message = (err as Error).message
      result.errors.push({ report_id: report.id, message })
      slog(`${LOG} report ${report.id} failed: ${message}`, 'error')
    }
  }

  slog(
    `${LOG} sweep done: fetched=${result.reports_fetched} actionable=${result.reports_actionable} ` +
      `claimed=${result.reports_claimed} created=${result.objectives_created} ` +
      `dup=${result.skipped_duplicate} below_threshold=${result.skipped_threshold} errors=${result.errors.length}`,
  )
  return result
}

// ── Real objective creator (used by the poller, not by tests) ────────────────

const PORT = parseInt(process.env.PORT || '3002', 10)

/** Creates the objective through CC's own internal objectives endpoint. */
export const httpObjectiveCreator: ObjectiveCreator = async payload => {
  const res = await fetch(`http://localhost:${PORT}/api/internal/objectives`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([payload]),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`create objective → ${res.status}: ${body.slice(0, 300)}`)
  }
  const body = (await res.json()) as { objectives?: Array<{ id: number }> }
  const id = body?.objectives?.[0]?.id
  if (typeof id !== 'number') throw new Error('create objective returned no id')
  return id
}
