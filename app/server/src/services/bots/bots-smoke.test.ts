/**
 * obj 900366 — invariants of the live-install bounded Bots job smoke helpers.
 *
 * Driven against a REAL migrated SQLite database and the REAL registry /
 * accounting modules the runtime calls, in the same style as obj 900323's
 * matrix suite. Every credential-shaped value here is synthetic; nothing reads
 * a production secret, and nothing in the module under test writes to the db.
 *
 * The documented invariants, one describe each:
 *   I1  the smoke never adds to, or replaces, the shared bot registry
 *   I2  the thread lane is an already-recognised slug, or a refusal
 *   I3  no ceiling is ever invented — and a relaxed guard is its own refusal
 *   I4  the preservation fingerprint detects a change on every preserved surface
 *   I5  cleanup is card-scoped and refuses on anything the smoke did not create
 *   I6  the CLI exit code is the contract: 0 proceed, 1 refused, 2 usage
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bots-smoke-'))
process.env.DB_PATH = path.join(TMP, 'db.sqlite')
process.env.JWT_SECRET = 'test-secret-900366'
process.env.TRANSCRIPT_DIR = TMP
process.env.PROJECTS_DIR = TMP
process.env.KNOWLEDGE_BASE_DIR = path.join(TMP, 'kb')

vi.mock('../../ws/index.js', () => ({ broadcast: vi.fn(), broadcastToObjective: vi.fn() }))
vi.mock('../notifier.js', () => ({ sendTelegram: vi.fn(), insertAlert: vi.fn() }))

const { getDb, initDb } = await import('../../db/index.js')
const { BUILT_IN_BOTS, listBots, botForAgentSlug } = await import('./bot-registry.js')
const {
  assessCeilingReadiness,
  chooseThreadLane,
  diffFingerprints,
  occupiedLaneSlugs,
  planSmokeCleanup,
  preservationFingerprint,
  resolveSmokeIdentity,
  PRESERVED_SURFACES,
} = await import('./bots-smoke.js')
const { runSmokeCli, asFingerprint, SMOKE_CLI_USAGE } = await import('./bots-smoke-cli.js')

const WS = 'operationkit'
const OTHER_WS = 'example'
const PERSON = 9601
const BOT = 'Operation Kit'
const REAL_LANE = 'operation-kit'
const TEST_LANE = 'operationkit'

beforeAll(() => {
  initDb()
  const db = getDb()
  db.prepare("INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (?, 'smoke-person', 'x', 'member')").run(PERSON)
  db.prepare('INSERT OR IGNORE INTO user_workspaces (user_id, workspace) VALUES (?, ?)').run(PERSON, WS)
})

afterAll(() => {
  try { getDb().close() } catch { /* ignore */ }
  fs.rmSync(TMP, { recursive: true, force: true })
})

function clearSettings(): void {
  const db = getDb()
  db.prepare("DELETE FROM settings WHERE key = 'bot_registry' OR key LIKE 'job_cost_ceiling_usd%' OR key LIKE 'job_wallclock_ceiling_ms%' OR key LIKE 'job_ceiling_policy%' OR key = 'job_ceiling_guard_enabled'").run()
}

function setSetting(key: string, value: string): void {
  getDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

let cardSeq = 0
/** A card + bot_job_origins row, exactly as createBotJob would leave them. */
function fileCard(opts: { lane: string; workspace: string }): number {
  const db = getDb()
  const info = db
    .prepare(
      `INSERT INTO objectives (title, description, agent_context, workspace, category, depth, assigned_user_id, created_by, type, status, origin, owner_bot)
       VALUES (?, '', ?, ?, 'general', 0, ?, ?, 'task', 'queue', 'agent_chat', ?)`,
    )
    .run(`smoke card ${++cardSeq}`, opts.lane, opts.workspace, PERSON, PERSON, BOT)
  const id = Number(info.lastInsertRowid)
  db.prepare(
    `INSERT INTO bot_job_origins (objective_id, thread_user_id, thread_agent_slug, owner_bot, owner_user_id, workspace, job_mode, idempotency_key, start_mode)
     VALUES (?, ?, ?, ?, ?, ?, 'read_only', ?, 'manual')`,
  ).run(id, PERSON, opts.lane, BOT, PERSON, opts.workspace, `idem-${id}`)
  return id
}

beforeEach(() => {
  clearSettings()
})

// ── I1: the shared registry is never written ────────────────────────────────

describe('I1 shared registry is read, never written', () => {
  it('resolves the smoke bot out of the SHARED registry and adds nothing', () => {
    const before = getDb().prepare("SELECT value FROM settings WHERE key = 'bot_registry'").get()
    const r = resolveSmokeIdentity(getDb(), BOT)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.bot.id).toBe('Operation Kit')
    expect(r.recognisedSlugs).toEqual(['operation-kit', 'operationkit'])
    // Nothing was created to make that resolution work.
    expect(getDb().prepare("SELECT value FROM settings WHERE key = 'bot_registry'").get()).toEqual(before)
    expect(listBots(getDb())).toEqual(BUILT_IN_BOTS)
  })

  it('accepts any recognised alias, so an operator typing "okit" is routed not refused', () => {
    for (const alias of ['okit', 'operationkit', 'OPERATION KIT', 'Grok: Operation Kit']) {
      const r = resolveSmokeIdentity(getDb(), alias)
      expect(r.ok, alias).toBe(true)
      if (r.ok) expect(r.bot.id).toBe('Operation Kit')
    }
  })

  it('REFUSES an unregistered bot and names what is known, instead of registering it', () => {
    const r = resolveSmokeIdentity(getDb(), 'Smoke Test Bot 900366')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('unknown_bot')
    expect(r.error).toMatch(/will not add it/i)
    expect(r.known).toContain('Operation Kit')
    expect(listBots(getDb())).toEqual(BUILT_IN_BOTS)
  })
})

// ── I2: the thread lane is recognised, or there is no lane ──────────────────

describe('I2 temporary thread lane reuses a recognised identity shape', () => {
  const bot = BUILT_IN_BOTS[0]

  it('picks a slug the registry ALREADY maps back to this bot', () => {
    const lane = chooseThreadLane(getDb(), bot, [REAL_LANE])
    expect(lane.ok).toBe(true)
    if (!lane.ok) return
    expect(lane.slug).toBe(TEST_LANE)
    expect(bot.agent_slugs).toContain(lane.slug)
    // The round trip is the whole safety property: the card this lane files is
    // owned by the canonical owner_bot, so delivery comes back to this thread.
    expect(botForAgentSlug(lane.slug, getDb())?.id).toBe(bot.id)
  })

  it('never returns a slug that is occupied, so the real conversation is untouched', () => {
    const lane = chooseThreadLane(getDb(), bot, [REAL_LANE])
    expect(lane.ok && lane.slug).not.toBe(REAL_LANE)
  })

  it('REFUSES rather than inventing a slug when every recognised one is taken', () => {
    const lane = chooseThreadLane(getDb(), bot, bot.agent_slugs)
    expect(lane.ok).toBe(false)
    if (lane.ok) return
    expect(lane.code).toBe('no_free_recognised_slug')
    // And it says WHY the obvious workaround is forbidden.
    expect(lane.error).toMatch(/settings\.bot_registry/)
    expect(lane.error).toMatch(/replaces the built-in list/i)
  })

  it('counts a slug with chat history as occupied even when no agent file exists', () => {
    getDb()
      .prepare("INSERT INTO agent_chat_messages (user_id, agent_slug, role, content) VALUES (?, ?, 'user', 'hi')")
      .run(PERSON, 'ghost-lane')
    expect(occupiedLaneSlugs(getDb(), [])).toContain('ghost-lane')
    // …and a file slug is unioned in, not replaced by, the durable ones.
    expect(occupiedLaneSlugs(getDb(), ['from-disk'])).toContain('from-disk')
  })
})

// ── I3: no invented ceiling ─────────────────────────────────────────────────

describe('I3 ceiling readiness never invents a number', () => {
  it('is NOT ready with no ceiling configured, and carries no digits in the report', () => {
    const r = assessCeilingReadiness(getDb(), { workspace: WS })
    expect(r.ready).toBe(false)
    expect(r.code).toBe('no_ceiling_configured')
    expect(r.ceiling).toEqual({ costUsd: null, wallclockMs: null, source: 'none' })
    expect(r.enforcement).toEqual({ wallclock: 'unset', cost: 'unset' })
    // The only digits allowed to appear are the ones in setting KEY names.
    expect(r.report.replace(/job_cost_ceiling_usd|job_wallclock_ceiling_ms/g, '')).not.toMatch(/\d/)
    expect(r.report).toMatch(/does NOT invent/i)
  })

  it('flags the DANGEROUS variant separately: no ceiling AND a relaxed guard', () => {
    setSetting('job_ceiling_policy:bounded', 'observe')
    const r = assessCeilingReadiness(getDb(), { workspace: WS })
    expect(r.ready).toBe(false)
    expect(r.code).toBe('no_ceiling_guard_permissive')
    expect(r.policy).toBe('observe')
    expect(r.report).toMatch(/UNBUDGETED/)
  })

  it('treats the global kill switch the same way — off is still not bounded', () => {
    setSetting('job_ceiling_guard_enabled', '0')
    const r = assessCeilingReadiness(getDb(), { workspace: WS })
    expect(r.ready).toBe(false)
    expect(r.code).toBe('no_ceiling_guard_permissive')
    expect(r.policy).toBe('off')
  })

  it('is ready on an EXISTING workspace ceiling and reports it as found', () => {
    setSetting(`job_wallclock_ceiling_ms:${WS}`, '900000')
    const r = assessCeilingReadiness(getDb(), { workspace: WS })
    expect(r.ready).toBe(true)
    expect(r.ceiling.wallclockMs).toBe(900_000)
    expect(r.ceiling.source).toBe(`workspace:${WS}`)
    expect(r.enforcement).toEqual({ wallclock: 'enforced', cost: 'unset' })
    expect(r.report).toMatch(/uses it as found and sets nothing/)
  })

  it('is ready on an inherited GLOBAL ceiling, and keeps the advisory/enforced split honest', () => {
    setSetting('job_cost_ceiling_usd', '5')
    const r = assessCeilingReadiness(getDb(), { workspace: WS })
    expect(r.ready).toBe(true)
    expect(r.ceiling.source).toBe('global')
    expect(r.enforcement).toEqual({ wallclock: 'unset', cost: 'advisory' })
    expect(r.report).toMatch(/ADVISORY/)
    expect(r.report).toMatch(/not a billing cap/)
  })

  it('does not read another workspace\'s ceiling as its own', () => {
    setSetting(`job_cost_ceiling_usd:${OTHER_WS}`, '5')
    expect(assessCeilingReadiness(getDb(), { workspace: WS }).ready).toBe(false)
    expect(assessCeilingReadiness(getDb(), { workspace: OTHER_WS }).ready).toBe(true)
  })
})

// ── I4: preservation is provable ────────────────────────────────────────────

describe('I4 preservation fingerprint', () => {
  it('is stable across repeated reads of an unchanged install', () => {
    const a = preservationFingerprint(getDb())
    const b = preservationFingerprint(getDb())
    expect(b.overall).toBe(a.overall)
    expect(diffFingerprints(a, b).clean).toBe(true)
    expect(diffFingerprints(a, b).report).toMatch(/PRESERVATION OK/)
  })

  it('covers every surface the card forbids disturbing', () => {
    const names = PRESERVED_SURFACES.map(s => s.surface)
    expect(names).toEqual([
      'shared_bot_registry',
      'global_job_defaults',
      'providers',
      'connectors',
      'keys',
      'secret_names',
      'permissions_members',
      'permissions_roles',
      'workspaces',
    ])
  })

  it('reports a surface whose table this schema lacks as absent, not as unchanged', () => {
    const fp = preservationFingerprint(getDb())
    for (const s of fp.surfaces) {
      expect(s.digest === 'absent' ? s.rows : 0).toBe(s.digest === 'absent' ? null : 0)
    }
    // connector_access is created lazily by connectors/access.ts, so on a fresh
    // db this is the real absent case rather than a hypothetical one.
    expect(fp.surfaces.some(s => s.digest === 'absent')).toBe(true)
  })

  it('DETECTS a change on each preserved surface it can be made to see', () => {
    const cases: { surface: string; mutate: () => void }[] = [
      { surface: 'shared_bot_registry', mutate: () => setSetting('bot_registry', '[]') },
      { surface: 'global_job_defaults', mutate: () => setSetting('job_cost_ceiling_usd', '7') },
      {
        surface: 'keys',
        mutate: () =>
          getDb()
            .prepare("INSERT INTO agent_api_keys (user_id, label, key_hash, last4, scopes) VALUES (?, 'smoke-synthetic', ?, '0000', '[]')")
            .run(PERSON, `hash-${Math.random()}`),
      },
      {
        surface: 'permissions_members',
        mutate: () => getDb().prepare('INSERT OR IGNORE INTO user_workspaces (user_id, workspace) VALUES (?, ?)').run(PERSON, OTHER_WS),
      },
    ]
    for (const c of cases) {
      const before = preservationFingerprint(getDb())
      c.mutate()
      const after = preservationFingerprint(getDb())
      const d = diffFingerprints(before, after)
      expect(d.clean, c.surface).toBe(false)
      expect(d.changed.map(x => x.surface), c.surface).toContain(c.surface)
      expect(d.report).toMatch(/PRESERVATION FAIL/)
    }
  })
})

// ── I5: cleanup is scoped, and refuses ──────────────────────────────────────

describe('I5 cleanup plan is card-scoped and refuses foreign cards', () => {
  it('emits a plan keyed on the one objective id and the temporary lane only', () => {
    const id = fileCard({ lane: TEST_LANE, workspace: WS })
    const plan = planSmokeCleanup(getDb(), { objectiveId: id, laneSlug: TEST_LANE, workspace: WS })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    const commands = plan.steps.map(s => s.command).join('\n')
    // Every destructive statement names THIS card or THIS lane.
    for (const line of commands.split('\n').filter(l => /^(DELETE|rm -rf)/.test(l.trim()))) {
      expect(line, line).toMatch(new RegExp(`(= ?${id}\\b|${TEST_LANE})`))
    }
    // The two shapes that have taken a neighbour's row before are absent.
    expect(commands).not.toMatch(/LIKE 'cc-/)
    expect(commands).not.toMatch(/created_at >/)
    expect(plan.note).toMatch(/Nothing here touches the shared/)
  })

  it('REFUSES a card that is not a bot job at all', () => {
    const db = getDb()
    const info = db
      .prepare("INSERT INTO objectives (title, description, workspace, category, depth, created_by, type, status) VALUES ('real work', '', ?, 'general', 0, ?, 'task', 'queue')")
      .run(WS, PERSON)
    const plan = planSmokeCleanup(db, { objectiveId: Number(info.lastInsertRowid), laneSlug: TEST_LANE, workspace: WS })
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.code).toBe('not_a_bot_job')
  })

  it('REFUSES a bot job filed by the REAL conversation', () => {
    const id = fileCard({ lane: REAL_LANE, workspace: WS })
    const plan = planSmokeCleanup(getDb(), { objectiveId: id, laneSlug: TEST_LANE, workspace: WS })
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.code).toBe('not_the_smoke_thread')
    expect(plan.error).toMatch(/somebody's real work/)
  })

  it('REFUSES a card in a different workspace even on the right lane', () => {
    const id = fileCard({ lane: TEST_LANE, workspace: OTHER_WS })
    const plan = planSmokeCleanup(getDb(), { objectiveId: id, laneSlug: TEST_LANE, workspace: WS })
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.code).toBe('wrong_workspace')
  })

  it('REFUSES a card id that does not exist', () => {
    const plan = planSmokeCleanup(getDb(), { objectiveId: 99_999_999, laneSlug: TEST_LANE, workspace: WS })
    expect(plan.ok).toBe(false)
  })
})

// ── I6: the CLI contract ────────────────────────────────────────────────────

describe('I6 CLI exit codes are the operator contract', () => {
  /** Drive the CLI with an in-memory stdout and a controllable slug source. */
  function run(argv: string[], over: { occupiedSlugs?: () => string[]; files?: Record<string, unknown> } = {}) {
    const printed: unknown[] = []
    const errors: string[] = []
    const code = runSmokeCli(argv, {
      db: getDb(),
      occupiedSlugs: over.occupiedSlugs ?? (() => [REAL_LANE]),
      readJson: path => {
        if (!over.files || !(path in over.files)) throw new Error(`no such file ${path}`)
        return over.files[path]
      },
      out: v => printed.push(v),
      err: l => errors.push(l),
    })
    return { code, payload: printed[0] as Record<string, unknown>, errors }
  }

  it('exits 2 with usage on an unknown or missing subcommand', () => {
    expect(run([]).code).toBe(2)
    expect(run(['wat']).code).toBe(2)
    expect(run(['wat']).errors[0]).toBe(SMOKE_CLI_USAGE)
    // The workspace has no default, and the refusal says so.
    const r = run(['preflight'])
    expect(r.code).toBe(2)
    expect(r.errors[0]).toMatch(/no default/)
  })

  it('exits 1 at stage "ceiling" when nothing is configured, with the lane already resolved', () => {
    const r = run(['preflight', WS])
    expect(r.code).toBe(1)
    expect(r.payload.ready).toBe(false)
    expect(r.payload.stage).toBe('ceiling')
    expect((r.payload.thread_lane as { slug: string }).slug).toBe(TEST_LANE)
    expect(r.payload.next).toMatch(/STOP/)
    expect(r.payload.next).toMatch(/do not configure a ceiling in order to get past this/i)
  })

  it('exits 0 and carries the baseline fingerprint once a ceiling exists', () => {
    setSetting(`job_wallclock_ceiling_ms:${WS}`, '600000')
    const r = run(['preflight', WS])
    expect(r.code).toBe(0)
    expect(r.payload.ready).toBe(true)
    expect(r.payload.stage).toBe('ready')
    expect(r.payload.bot).toBe('Operation Kit')
    expect((r.payload.fingerprint as { overall: string }).overall).toMatch(/^[0-9a-f]{16}$/)
    expect(r.payload.next).toMatch(/before\.json/)
  })

  it('exits 1 at stage "identity" for an unregistered bot, before touching anything else', () => {
    setSetting(`job_wallclock_ceiling_ms:${WS}`, '600000')
    const r = run(['preflight', WS, 'Smoke Bot 900366'])
    expect(r.code).toBe(1)
    expect(r.payload.stage).toBe('identity')
    expect(r.payload.fingerprint).toBeUndefined()
  })

  it('treats "cannot list slugs" as a refusal, never as "all slugs are free"', () => {
    setSetting(`job_wallclock_ceiling_ms:${WS}`, '600000')
    const r = run(['preflight', WS], {
      occupiedSlugs: () => {
        throw new Error('No chat-agents directory at /nope')
      },
    })
    expect(r.code).toBe(1)
    expect(r.payload.stage).toBe('thread_lane')
    expect(r.payload.code).toBe('slugs_unknown')
    expect(r.payload.thread_lane).toBeUndefined()
  })

  it('diff exits 0 when clean and 1 when a preserved surface moved', () => {
    const before = preservationFingerprint(getDb())
    const clean = run(['diff', 'a', 'b'], { files: { a: before, b: preservationFingerprint(getDb()) } })
    expect(clean.code).toBe(0)
    setSetting('bot_registry', '[]')
    const dirty = run(['diff', 'a', 'b'], { files: { a: before, b: preservationFingerprint(getDb()) } })
    expect(dirty.code).toBe(1)
    expect((dirty.payload.changed as { surface: string }[]).map(c => c.surface)).toContain('shared_bot_registry')
  })

  it('diff accepts a whole preflight payload, not just a bare fingerprint', () => {
    const fp = preservationFingerprint(getDb())
    expect(asFingerprint({ ready: true, fingerprint: fp }).overall).toBe(fp.overall)
    expect(asFingerprint(fp).overall).toBe(fp.overall)
    setSetting(`job_wallclock_ceiling_ms:${WS}`, '600000')
    const pre = run(['preflight', WS])
    const r = run(['diff', 'a', 'b'], { files: { a: pre.payload, b: preservationFingerprint(getDb()) } })
    expect(r.code).toBe(0)
  })

  it('cleanup-plan exits 1 and refuses a foreign card, 0 on a smoke card', () => {
    const foreign = fileCard({ lane: REAL_LANE, workspace: WS })
    expect(run(['cleanup-plan', String(foreign), TEST_LANE, WS]).code).toBe(1)
    const mine = fileCard({ lane: TEST_LANE, workspace: WS })
    const ok = run(['cleanup-plan', String(mine), TEST_LANE, WS])
    expect(ok.code).toBe(0)
    expect(ok.payload.objectiveId).toBe(mine)
    expect(run(['cleanup-plan', 'not-a-number', TEST_LANE, WS]).code).toBe(2)
  })
})
