/**
 * Preflight, preservation fingerprint and scoped cleanup planning for the
 * **live-install bounded Bots job smoke** (obj 900366).
 *
 * obj 900323 shipped the bounded chat → board → thread MVP and a synthetic
 * G1–G12 matrix. What it did NOT ship is the thing an operator needs on a REAL
 * install: a procedure that can be run once, against live data, without
 * damaging any of it. `docs/bots/live-install-job-smoke-runbook.md` is that
 * procedure; this module is the small amount of code the procedure cannot be
 * made safe without.
 *
 * Three jobs, and each one exists because the hand-rolled version of it is
 * wrong in a way that is invisible until it has already happened:
 *
 *  1. **Identity (`resolveSmokeIdentity` + `chooseThreadLane`).** The obvious
 *     way to get a temporary test bot is to write `settings.bot_registry`. That
 *     setting **REPLACES** the built-in list (`bot-registry.ts` `parseOverride`),
 *     so appending a test entry by hand deletes every bot the install knows
 *     about for as long as the smoke runs — the exact "preserve the shared
 *     registry" constraint, broken by the first step. The correct move is to
 *     write NOTHING: `Operation Kit` already owns two recognised agent slugs
 *     (`operation-kit`, `operationkit`), a chat thread is keyed on
 *     `(person, agent_slug)`, and chat agents are FILES on disk. So a temporary
 *     test identity is a temporary agent FOLDER named after an
 *     already-recognised-but-unoccupied slug. No registry row is written, the
 *     canonical `owner_bot` is unchanged, and cleanup is removing one folder.
 *     `chooseThreadLane` refuses rather than inventing a slug when no recognised
 *     alias is free.
 *
 *  2. **Ceiling (`assessCeilingReadiness`).** This module contains no numbers
 *     and will not let the runbook contain any either. It reports what
 *     `resolveConfiguredCeiling` found and what `resolveAutoStartPolicy` would
 *     do about it, and it is `ready` only when a finite ceiling is genuinely
 *     configured somewhere. The dangerous case is NOT "no ceiling" — the
 *     `bounded` path defaults to `enforce`, so that refuses loudly and
 *     correctly. It is "no ceiling AND the guard was relaxed to observe/off on
 *     this install", where the product will happily start the job UNBUDGETED.
 *     That is reported as its own refusal code, because a smoke that starts an
 *     unbudgeted job has not tested a bounded job.
 *
 *  3. **Preservation (`preservationFingerprint` / `diffFingerprints`) and
 *     cleanup (`planSmokeCleanup`).** "Did not touch preexisting data" is a
 *     claim, and a claim needs a before/after. The fingerprint digests exactly
 *     the surfaces the card forbids disturbing — shared registry, global
 *     defaults, providers, connectors, keys, permissions — by NAME and SHAPE
 *     only; it never reads a secret value, so the digest is safe to paste into
 *     a PR. `planSmokeCleanup` refuses to emit a plan for a card that is not
 *     demonstrably a smoke artifact: it must carry a `bot_job_origins` row, on
 *     the smoke's own thread lane, in the declared workspace. A card that fails
 *     that test is somebody's real work.
 *
 * Everything here is a PURE READ over an injected `Database`. Nothing in this
 * module writes to the database, kills a session, or deletes a file; the
 * cleanup step emits a plan a person executes through the product's own
 * surfaces. That is deliberate — a mutating helper aimed at a live install is
 * the thing this runbook exists to avoid needing.
 */
import crypto from 'crypto'
import type { Database } from 'better-sqlite3'
import { botForAgentSlug, listBots, registryKey, type BotDefinition } from './bot-registry.js'
import { resolveConfiguredCeiling, resolveAutoStartPolicy, type ConfiguredCeiling, type CeilingPolicy } from '../job-accounting.js'

// ── 1. identity ──────────────────────────────────────────────────────────────

export type SmokeIdentity =
  | { ok: true; bot: BotDefinition; recognisedSlugs: string[] }
  | { ok: false; code: 'unknown_bot'; error: string; known: string[] }

/**
 * The bot the smoke will run as, resolved through the SHARED registry.
 *
 * Takes a name an operator typed and answers with the registry's own canonical
 * definition, or refuses naming what is known. It never creates an entry: a
 * smoke that has to add a bot to the registry is testing a registry write, not
 * a bot job.
 */
export function resolveSmokeIdentity(db: Database, botName: string): SmokeIdentity {
  const bots = listBots(db)
  const key = registryKey(String(botName ?? ''))
  const bot = bots.find(
    b => registryKey(b.id) === key || registryKey(b.name) === key || b.aliases.some(a => registryKey(a) === key),
  )
  if (!bot) {
    return {
      ok: false,
      code: 'unknown_bot',
      error:
        `"${botName}" is not in this install's bot registry, and the smoke will not add it. ` +
        'Run the smoke as a bot that already exists.',
      known: bots.map(b => b.id),
    }
  }
  return { ok: true, bot, recognisedSlugs: [...bot.agent_slugs] }
}

export type ThreadLane =
  | { ok: true; slug: string; bot: string; rationale: string }
  | { ok: false; code: 'no_free_recognised_slug'; error: string; occupied: string[] }

/**
 * Pick the temporary test thread lane: a slug this bot ALREADY owns in the
 * shared registry which no agent file currently occupies.
 *
 * `occupiedSlugs` is the caller's list of agent slugs that exist on this
 * install (one per agent folder). The chosen slug must satisfy both halves:
 *
 *  - recognised — `botForAgentSlug` maps it back to this exact bot, so the card
 *    it files is owned by the canonical `owner_bot` and the completion lands in
 *    the thread it came from; and
 *  - unoccupied — it is not the operator's real conversation, so the test
 *    thread cannot interleave with live chat history and removing the temporary
 *    agent folder cannot delete a real agent.
 *
 * If no recognised slug is free this REFUSES. Inventing one would create a bot
 * the registry does not know (`bot_agent_mismatch` at the first filing attempt)
 * or, worse, invite a `settings.bot_registry` write that wipes the shared list.
 */
export function chooseThreadLane(db: Database, bot: BotDefinition, occupiedSlugs: string[]): ThreadLane {
  const occupied = new Set(occupiedSlugs.map(s => registryKey(s)))
  for (const slug of bot.agent_slugs) {
    if (occupied.has(registryKey(slug))) continue
    const back = botForAgentSlug(slug, db)
    if (!back || back.id !== bot.id) continue
    return {
      ok: true,
      slug,
      bot: bot.id,
      rationale:
        `"${slug}" is already a recognised agent slug for ${bot.id} in the shared registry and no agent file ` +
        'occupies it, so the smoke gets an isolated thread without a single registry write.',
    }
  }
  return {
    ok: false,
    code: 'no_free_recognised_slug',
    error:
      `Every agent slug ${bot.id} owns (${bot.agent_slugs.join(', ')}) is already in use on this install. ` +
      'The smoke will NOT invent a slug and will NOT overwrite settings.bot_registry (that setting replaces the ' +
      'built-in list, so writing it would remove every other bot). Retire or rename one of those agent folders, ' +
      'or run the smoke as a different registered bot.',
    occupied: [...occupied],
  }
}

/**
 * Every agent slug that is already SPOKEN FOR on this install, from durable
 * state rather than from the filesystem alone.
 *
 * The filesystem is not sufficient on its own: `loadChatAgents` swallows a
 * missing agents dir and returns an empty list, so a misconfigured
 * `AGENT_FILES_DIR` would make every slug look free and hand the smoke a lane
 * that is somebody's live conversation. So the slugs on disk are UNIONED with
 * every slug that has chat history, a card link or a filed bot job behind it.
 * A slug is free only when nothing anywhere claims it.
 */
export function occupiedLaneSlugs(db: Database, fileSlugs: string[] = []): string[] {
  const seen = new Set(fileSlugs.map(s => s.trim()).filter(Boolean))
  const queries = [
    'SELECT DISTINCT agent_slug AS slug FROM agent_chat_messages',
    'SELECT DISTINCT agent_slug AS slug FROM agent_chat_cards',
    'SELECT DISTINCT thread_agent_slug AS slug FROM bot_job_origins',
  ]
  for (const sql of queries) {
    try {
      for (const row of db.prepare(sql).all() as { slug: string | null }[]) {
        if (row.slug) seen.add(row.slug)
      }
    } catch { /* table absent in this schema → contributes nothing */ }
  }
  return [...seen].sort()
}

// ── 2. ceiling ───────────────────────────────────────────────────────────────

export type CeilingRefusal = 'no_ceiling_configured' | 'no_ceiling_guard_permissive'

export interface CeilingReadiness {
  ready: boolean
  code: CeilingRefusal | 'ok'
  ceiling: ConfiguredCeiling
  policy: CeilingPolicy
  policySource: string
  /** Honest split inherited verbatim from obj 900322. Never conflated. */
  enforcement: { wallclock: 'enforced' | 'unset'; cost: 'advisory' | 'unset' }
  /** What a person should read. Carries no invented number, ever. */
  report: string
}

/**
 * Is a BOUNDED job startable on this install, using only what is already
 * configured?
 *
 * `objectiveId` is optional because preflight runs before any card exists; with
 * no card the resolution starts one rung down, at
 * `settings.job_*_ceiling_*:<workspace>` then the global rows — the same chain
 * `resolveConfiguredCeiling` walks, not a second copy of it.
 *
 * Not ready is a first-class, honest outcome. The runbook's instruction in that
 * case is to STOP and report the product gap, exactly as obj 900323 did: there
 * is no number this function could supply that would not be a guess.
 */
export function assessCeilingReadiness(
  db: Database,
  opts: { workspace: string; objectiveId?: number },
): CeilingReadiness {
  // -1 can never be a real rowid, so with no card the objective rung is a
  // guaranteed miss and the chain continues at workspace → global.
  const ceiling = resolveConfiguredCeiling(db, opts.objectiveId ?? -1, opts.workspace)
  const { policy, source } = resolveAutoStartPolicy(db, 'bounded', opts.workspace)
  const enforcement = {
    wallclock: ceiling.wallclockMs === null ? ('unset' as const) : ('enforced' as const),
    cost: ceiling.costUsd === null ? ('unset' as const) : ('advisory' as const),
  }

  if (ceiling.costUsd === null && ceiling.wallclockMs === null) {
    const where =
      `Checked the card, settings.job_cost_ceiling_usd:${opts.workspace}, settings.job_cost_ceiling_usd ` +
      'and the job_wallclock_ceiling_ms equivalents.'
    if (policy === 'enforce') {
      return {
        ready: false,
        code: 'no_ceiling_configured',
        ceiling,
        policy,
        policySource: source,
        enforcement,
        report:
          `NOT READY — no finite job ceiling is configured for workspace "${opts.workspace}". ${where} ` +
          `The bounded auto-start guard is '${policy}' (${source}), so the product will refuse the start by itself ` +
          'and the card will sit in queue. This runbook does the same: it does NOT invent a dollar or time default. ' +
          'Report the gap and stop.',
      }
    }
    return {
      ready: false,
      code: 'no_ceiling_guard_permissive',
      ceiling,
      policy,
      policySource: source,
      enforcement,
      report:
        `NOT READY, and this is the dangerous variant — no finite job ceiling is configured for workspace ` +
        `"${opts.workspace}" (${where}) AND the bounded guard has been relaxed to '${policy}' (${source}). ` +
        'The product would therefore START this job UNBUDGETED. A job with no ceiling is not a bounded job, so the ' +
        'smoke must not run here. Configure a finite ceiling, or restore the bounded guard to enforce, then re-run ' +
        'preflight. No default is assumed by this runbook.',
    }
  }

  return {
    ready: true,
    code: 'ok',
    ceiling,
    policy,
    policySource: source,
    enforcement,
    report:
      `READY — a finite ceiling is already configured (source: ${ceiling.source}); the smoke uses it as found and ` +
      `sets nothing. Wall-clock ceiling ${enforcement.wallclock} (ENFORCED by the runner when set); cost ceiling ` +
      `${enforcement.cost} (ADVISORY — no measured provider spend is collected, so it is not a billing cap). ` +
      `Bounded auto-start policy '${policy}' (${source}).`,
  }
}

// ── 3. preservation ──────────────────────────────────────────────────────────

/**
 * The surfaces the card forbids the smoke from disturbing, and the read that
 * proves each one is unchanged.
 *
 * Two rules hold for every entry:
 *  - **names and shapes only.** No secret VALUE, no token, no connector
 *    credential is read, so a fingerprint is safe to paste into a PR.
 *  - **deterministic order.** Each query carries its own ORDER BY, because an
 *    unordered digest changes on a VACUUM and a false "you changed the keys"
 *    alarm is worse than no alarm.
 */
export const PRESERVED_SURFACES: { surface: string; sql: string }[] = [
  {
    surface: 'shared_bot_registry',
    sql: "SELECT key, value FROM settings WHERE key = 'bot_registry'",
  },
  {
    surface: 'global_job_defaults',
    sql:
      "SELECT key, value FROM settings WHERE key LIKE 'job_cost_ceiling_usd%' OR key LIKE 'job_wallclock_ceiling_ms%' " +
      "OR key LIKE 'job_ceiling_policy%' OR key = 'job_ceiling_guard_enabled' ORDER BY key",
  },
  { surface: 'providers', sql: 'SELECT id, engine, enabled, is_default, is_planner FROM models ORDER BY id' },
  { surface: 'connectors', sql: 'SELECT connector_id, user_id, agents, workspaces FROM connector_access ORDER BY connector_id, user_id' },
  { surface: 'keys', sql: 'SELECT id, label, revoked_at FROM agent_api_keys ORDER BY id' },
  { surface: 'secret_names', sql: 'SELECT key, scope_type FROM secrets ORDER BY scope_type, key' },
  { surface: 'permissions_members', sql: 'SELECT user_id, workspace FROM user_workspaces ORDER BY user_id, workspace' },
  { surface: 'permissions_roles', sql: 'SELECT id, username, role FROM users ORDER BY id' },
  { surface: 'workspaces', sql: 'SELECT slug, archived, doc_read_roots, doc_write_roots FROM workspaces ORDER BY slug' },
]

export interface SurfaceDigest {
  surface: string
  /** `rows:<n>` worth of content, hashed. `absent` when the table is not in this schema. */
  digest: string
  rows: number | null
}

export interface PreservationFingerprint {
  takenAt: string
  surfaces: SurfaceDigest[]
  /** Digest over the per-surface digests — one line to paste and compare. */
  overall: string
}

function digestRows(rows: unknown[]): string {
  const h = crypto.createHash('sha256')
  for (const row of rows) h.update(JSON.stringify(row ?? null)).update('\u0000')
  return h.digest('hex').slice(0, 16)
}

/**
 * Digest every preserved surface.
 *
 * A table this install's schema does not have is reported as `absent`, not
 * skipped and not an error: "that surface does not exist here" and "that
 * surface is unchanged" are different facts, and collapsing them would let a
 * dropped table read as a clean run.
 */
export function preservationFingerprint(db: Database, now = new Date()): PreservationFingerprint {
  const surfaces: SurfaceDigest[] = PRESERVED_SURFACES.map(({ surface, sql }) => {
    try {
      const rows = db.prepare(sql).all() as unknown[]
      return { surface, digest: digestRows(rows), rows: rows.length }
    } catch {
      return { surface, digest: 'absent', rows: null }
    }
  })
  const h = crypto.createHash('sha256')
  for (const s of surfaces) h.update(`${s.surface}=${s.digest}\u0000`)
  return { takenAt: now.toISOString(), surfaces, overall: h.digest('hex').slice(0, 16) }
}

export interface FingerprintDiff {
  clean: boolean
  changed: { surface: string; before: string; after: string }[]
  report: string
}

/** Compare two fingerprints. Any difference on any preserved surface is a FAIL. */
export function diffFingerprints(before: PreservationFingerprint, after: PreservationFingerprint): FingerprintDiff {
  const beforeBy = new Map(before.surfaces.map(s => [s.surface, s.digest]))
  const afterBy = new Map(after.surfaces.map(s => [s.surface, s.digest]))
  const changed: { surface: string; before: string; after: string }[] = []
  for (const surface of new Set([...beforeBy.keys(), ...afterBy.keys()])) {
    const b = beforeBy.get(surface) ?? 'missing'
    const a = afterBy.get(surface) ?? 'missing'
    if (b !== a) changed.push({ surface, before: b, after: a })
  }
  changed.sort((x, y) => x.surface.localeCompare(y.surface))
  return {
    clean: changed.length === 0,
    changed,
    report: changed.length
      ? `PRESERVATION FAIL — ${changed.length} surface(s) changed across the smoke: ` +
        changed.map(c => `${c.surface} (${c.before} → ${c.after})`).join(', ') +
        '. Investigate before reporting the smoke as clean.'
      : `PRESERVATION OK — all ${after.surfaces.length} preserved surfaces are byte-identical (overall ${after.overall}).`,
  }
}

// ── 4. scoped cleanup ────────────────────────────────────────────────────────

export interface CleanupStep {
  /** `product` — do it through the UI/API. `sql` — a scoped statement, shown for review. `fs` — remove a file the smoke created. */
  via: 'product' | 'sql' | 'fs'
  what: string
  command: string
}

export type CleanupPlan =
  | { ok: true; objectiveId: number; steps: CleanupStep[]; note: string }
  | { ok: false; code: 'not_a_bot_job' | 'not_the_smoke_thread' | 'wrong_workspace'; error: string }

/**
 * The exact, card-scoped cleanup for ONE smoke artifact — and the refusal that
 * matters more than the plan.
 *
 * Before emitting anything this re-reads `bot_job_origins` and requires the
 * card to be (a) a bot job at all, (b) on the smoke's own temporary thread lane
 * and (c) in the workspace the operator declared. A card that fails any of
 * those is live work filed by a real conversation, and the honest answer is a
 * refusal rather than a plan that would delete it. Every step that follows is
 * keyed on this one `objective_id` — there is no prefix glob and no
 * `DELETE … WHERE created_at > …`, which are the two shapes that have taken a
 * neighbour's row with them before.
 */
export function planSmokeCleanup(
  db: Database,
  opts: { objectiveId: number; laneSlug: string; workspace: string; agentDir?: string },
): CleanupPlan {
  const origin = db
    .prepare('SELECT objective_id, thread_agent_slug, workspace FROM bot_job_origins WHERE objective_id = ?')
    .get(opts.objectiveId) as { objective_id: number; thread_agent_slug: string; workspace: string } | undefined

  if (!origin) {
    return {
      ok: false,
      code: 'not_a_bot_job',
      error:
        `Card #${opts.objectiveId} has no bot_job_origins row, so it was not filed by this smoke (or by any bot ` +
        'thread). Refusing to emit a cleanup plan for a card the smoke did not create.',
    }
  }
  if (registryKey(origin.thread_agent_slug) !== registryKey(opts.laneSlug)) {
    return {
      ok: false,
      code: 'not_the_smoke_thread',
      error:
        `Card #${opts.objectiveId} belongs to the "${origin.thread_agent_slug}" conversation, not the smoke's ` +
        `temporary lane "${opts.laneSlug}". That is somebody's real work. Refusing.`,
    }
  }
  if (origin.workspace !== opts.workspace) {
    return {
      ok: false,
      code: 'wrong_workspace',
      error:
        `Card #${opts.objectiveId} is in workspace "${origin.workspace}", not the declared "${opts.workspace}". Refusing.`,
    }
  }

  const id = opts.objectiveId
  const steps: CleanupStep[] = [
    {
      via: 'product',
      what: 'Cancel the job through the board so the owned teardown runs (kills only this card\'s tmux session, releases only this card\'s leases, records the teardown once).',
      command: `PATCH /api/objectives/${id}/status {"status":"cancelled"}  — or the Cancel button on card #${id}`,
    },
    {
      via: 'product',
      what: 'Confirm the card owns nothing any more before deleting any row.',
      command: `SELECT id, status, session_id FROM objectives WHERE id = ${id};  -- expect status 'cancelled', session_id NULL`,
    },
    {
      via: 'sql',
      what: 'Remove the thread delivery outbox rows for this card (delivery_id is bot_<kind>_<id>, so this is exact).',
      command: `DELETE FROM bot_thread_deliveries WHERE objective_id = ${id};`,
    },
    {
      via: 'sql',
      what: 'Remove the chat messages the smoke posted into the temporary lane. Scoped to the lane slug, which no real conversation uses.',
      command: `DELETE FROM agent_chat_messages WHERE agent_slug = '${opts.laneSlug}';`,
    },
    {
      via: 'sql',
      what: 'Remove the thread↔card link and the job origin record.',
      command:
        `DELETE FROM agent_chat_cards WHERE objective_id = ${id};\n` +
        `DELETE FROM bot_job_origins WHERE objective_id = ${id};`,
    },
    {
      via: 'sql',
      what: 'Remove the temporary card itself.',
      command: `DELETE FROM objectives WHERE id = ${id};`,
    },
    {
      via: 'fs',
      what: 'Remove the temporary agent folder that created the lane. This is the whole of the "deregistration" — no registry row was ever written.',
      command: `rm -rf ${opts.agentDir ?? `<agents dir>/${opts.laneSlug}`}`,
    },
    {
      via: 'product',
      what: 'Re-take the preservation fingerprint and diff it against the preflight one.',
      command: 'npx tsx src/scripts/bots-smoke.ts fingerprint > after.json  # then: bots-smoke.ts diff before.json after.json',
    },
  ]

  return {
    ok: true,
    objectiveId: id,
    steps,
    note:
      'Every step is keyed on this one objective id or on the temporary lane slug. Nothing here touches the shared ' +
      'bot registry, a global default, a provider, a connector, a key or a permission — those are the surfaces the ' +
      'fingerprint diff then proves unchanged.',
  }
}
