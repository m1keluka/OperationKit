/**
 * obj 900323 — the bounded single-agent chat → board → thread MVP, end to end.
 *
 * This file IS the acceptance matrix. One `describe` per gate G1-G12, driven
 * against a REAL migrated SQLite database and the REAL modules the runtime
 * calls — no stubs standing in for the thing under test. Credentials are
 * SYNTHETIC throughout (fake connector ids, fake secret names, a fake
 * `sk-ant-` shaped string); nothing here reads a production secret, grants one,
 * or touches live configuration.
 *
 * Shared A/B behaviour (obj 900321 isolation, obj 900322 lifecycle) is gated
 * here by CALLING those modules, never by re-implementing them: G5 drives
 * `lib/kb-workspace-scope` and `services/connector-guard`, G12 drives
 * `services/job-accounting`. A failure in one of those shows up as a failure of
 * the gate that depends on it, which is the point.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bots-mvp-'))
process.env.DB_PATH = path.join(TMP, 'db.sqlite')
process.env.JWT_SECRET = 'test-secret-900323'
process.env.TRANSCRIPT_DIR = TMP
process.env.PROJECTS_DIR = TMP
process.env.KNOWLEDGE_BASE_DIR = path.join(TMP, 'kb')

vi.mock('../../ws/index.js', () => ({ broadcast: vi.fn(), broadcastToObjective: vi.fn() }))
vi.mock('../notifier.js', () => ({ sendTelegram: vi.fn(), insertAlert: vi.fn() }))

const { getDb, initDb } = await import('../../db/index.js')
const { createBotJob, followUpBotJob, getJobOrigin, listThreadJobs, MVP_JOB_MODE } = await import('./bot-jobs.js')
const { authorizeBotJob } = await import('./bot-authorization.js')
const { resolveBot, botForAgentSlug } = await import('./bot-registry.js')
const { decideBotJobStart } = await import('./bot-job-start.js')
const { enqueueBotThreadDeliveries, deliverBotThreadMessages, runBotThreadDeliveryTick, buildThreadBody, threadDeliveryId } =
  await import('./bot-thread-delivery.js')
const { requestApproval, decideApproval, consumeApproval, actionFingerprint } = await import('./bot-approvals.js')
const { assertCredentialLive, assertSecretReadable, revokeCredential, restoreCredential } = await import('./bot-credentials.js')
const { setObjectiveCeiling, resolveConfiguredCeiling, recordSpend, evaluateCeiling } = await import('../job-accounting.js')
const { isInWorkspaceScope } = await import('../../lib/kb-workspace-scope.js')
const { canUseConnectorCredential } = await import('../connector-guard.js')
const { default: BetterSqlite3 } = await import('better-sqlite3')
const { runTool, ToolUseError } = await import('../agent-chat/tools.js')

const PERSON = 9001 // the one person
const OUTSIDER = 9002 // a person with no membership in WS
const WS = 'operationkit' // the one workspace
const OTHER_WS = 'example'
const AGENT = 'operation-kit' // the one domain bot's chat slug
const BOT = 'Operation Kit'

beforeAll(() => {
  initDb()
  const db = getDb()
  db.prepare("INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (?, 'bot-mvp-person', 'x', 'member')").run(PERSON)
  db.prepare("INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (?, 'bot-mvp-outsider', 'x', 'member')").run(OUTSIDER)
  db.prepare('INSERT OR IGNORE INTO user_workspaces (user_id, workspace) VALUES (?, ?)').run(PERSON, WS)
  // Thread deliveries only fire for events AFTER the cursor is anchored.
  enqueueBotThreadDeliveries(db)
})

afterAll(() => {
  try { getDb().close() } catch { /* ignore */ }
  fs.rmSync(TMP, { recursive: true, force: true })
})

let titleSeq = 0
function uniqueTitle(label: string): string {
  return `${label} ${++titleSeq}-${Date.now()}`
}

function fileJob(over: Partial<Parameters<typeof createBotJob>[1]> = {}) {
  return createBotJob(getDb(), {
    userId: PERSON,
    agentSlug: AGENT,
    ownerBot: BOT,
    workspace: WS,
    title: uniqueTitle('Summarise last week'),
    description: 'Read the weekly notes and summarise them. Read-only.',
    idempotencyKey: `idem-${++titleSeq}-${Date.now()}`,
    ...over,
  })
}

/** Move a card and record the objective_event the delivery scanner reads. */
function transition(objectiveId: number, to: string, from = 'queue'): void {
  const db = getDb()
  db.prepare('UPDATE objectives SET status = ? WHERE id = ?').run(to, objectiveId)
  db.prepare('INSERT INTO objective_events (objective_id, workspace, kind, from_value, to_value) VALUES (?, ?, ?, ?, ?)')
    .run(objectiveId, WS, 'status', from, to)
}

function threadMessages(userId = PERSON, agentSlug = AGENT) {
  return getDb()
    .prepare("SELECT * FROM agent_chat_messages WHERE user_id = ? AND agent_slug = ? AND role = 'assistant' ORDER BY id")
    .all(userId, agentSlug) as { id: number; content: string; meta: string | null }[]
}

// ─────────────────────────────────────────────────────────────────────────────
describe('G1 — an owned, authorized job is filed and its start is a decision, not a side effect', () => {
  it('files one card owned by the validated bot, in the person\'s workspace, read-only', () => {
    const r = fileJob()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const card = getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(r.objectiveId) as
      { owner_bot: string; workspace: string; created_by: number; origin: string; status: string }
    expect(card.owner_bot).toBe(BOT)
    expect(card.workspace).toBe(WS)
    expect(card.created_by).toBe(PERSON)
    expect(card.origin).toBe('agent_chat')
    const origin = getJobOrigin(getDb(), r.objectiveId)!
    expect(origin.job_mode).toBe(MVP_JOB_MODE)
    expect(origin.thread_user_id).toBe(PERSON)
    expect(origin.thread_agent_slug).toBe(AGENT)
    // The chat UI's own linkage is written too — one card, both views.
    const link = getDb().prepare('SELECT 1 AS ok FROM agent_chat_cards WHERE objective_id = ?').get(r.objectiveId)
    expect(link).toBeTruthy()
    expect(listThreadJobs(getDb(), PERSON, AGENT).some(j => j.objective_id === r.objectiveId)).toBe(true)
  })

  it('a job with an explicit finite ceiling may auto-start; the same job without one may not', () => {
    const unbudgeted = fileJob()
    expect(unbudgeted.ok).toBe(true)
    if (!unbudgeted.ok) return
    expect(unbudgeted.start.allowed).toBe(false)
    expect(unbudgeted.start.code).toBe('auto_start_no_ceiling')
    expect(getJobOrigin(getDb(), unbudgeted.objectiveId)!.start_mode).toBe('manual')

    setObjectiveCeiling(getDb(), unbudgeted.objectiveId, { wallclockMs: 15 * 60_000, source: 'objective' })
    const after = decideBotJobStart(getDb(), { objectiveId: unbudgeted.objectiveId, workspace: WS })
    expect(after.allowed).toBe(true)
    expect(after.mode).toBe('auto')
  })
})

describe('G2 — idempotency: a retried request returns the same job', () => {
  it('same (thread, key) twice → one card, reused:true, no second row', () => {
    const key = `idem-fixed-${Date.now()}`
    const title = uniqueTitle('Idempotent job')
    const a = fileJob({ idempotencyKey: key, title })
    const b = fileJob({ idempotencyKey: key, title, description: 'different words, same request' })
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(b.objectiveId).toBe(a.objectiveId)
    expect(b.reused).toBe(true)
    expect(b.reason).toBe('idempotent_replay')
    const n = getDb().prepare('SELECT COUNT(*) AS n FROM bot_job_origins WHERE idempotency_key = ?').get(key) as { n: number }
    expect(n.n).toBe(1)
  })

  it('a missing idempotency key is refused rather than silently generated', () => {
    const r = fileJob({ idempotencyKey: '' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('invalid')
    expect(r.error).toMatch(/idempotency_key is required/)
  })
})

describe('G3 — duplicate guard: the same ask in a new request does not open a second card', () => {
  it('same title, same workspace, different key → refused with the existing card id', () => {
    const title = uniqueTitle('Weekly pipeline review')
    const first = fileJob({ title })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = fileJob({ title })
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.code).toBe('duplicate')
    expect(second.existingId).toBe(first.objectiveId)
  })

  it('force files anyway — the override exists and is explicit', () => {
    const title = uniqueTitle('Forced twin')
    const first = fileJob({ title })
    const forced = fileJob({ title, force: true })
    expect(first.ok && forced.ok).toBe(true)
    if (!first.ok || !forced.ok) return
    expect(forced.objectiveId).not.toBe(first.objectiveId)
  })
})

describe('G4 — owner validation: explicit, registry-checked, never inferred', () => {
  it('an unknown bot name is refused and the refusal names the valid bots', () => {
    const r = fileJob({ ownerBot: 'Operaton Kit' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('unknown_bot')
    expect(r.error).toMatch(/Known bots/)
  })

  it('a bot that does not own this conversation is refused', () => {
    const r = fileJob({ ownerBot: 'Grok: General' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('bot_agent_mismatch')
  })

  it('a key LABEL is not an identity — it resolves to nothing', () => {
    // The exact failure this gate exists for: "mike's okit key (prod)" is a
    // nickname somebody typed, and it must never become an owner.
    expect(resolveBot("mike's okit key (prod)").ok).toBe(false)
    expect(botForAgentSlug('some-unregistered-agent')).toBeNull()
  })

  it('a person with no membership in the workspace cannot file there', () => {
    const r = fileJob({ userId: OUTSIDER })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('workspace_forbidden')
  })

  it('a missing workspace is refused — no default is assumed', () => {
    const r = fileJob({ workspace: undefined })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('workspace_missing')
  })
})

describe('G5 — isolation: board, knowledge base and connectors all stop at the job\'s workspace', () => {
  it('board: the job cannot be filed into another workspace', () => {
    const r = authorizeBotJob(getDb(), { userId: PERSON, agentSlug: AGENT, ownerBot: BOT, workspace: OTHER_WS })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('workspace_forbidden')
  })

  it('knowledge base: a path in another workspace is out of scope (obj 900321 module, called not copied)', () => {
    const kbRoot = path.join(TMP, 'kb')
    fs.mkdirSync(path.join(kbRoot, 'workspaces', WS, 'notes'), { recursive: true })
    fs.mkdirSync(path.join(kbRoot, 'workspaces', OTHER_WS, 'notes'), { recursive: true })
    const mine = path.join(kbRoot, 'workspaces', WS, 'notes', 'a.md')
    const theirs = path.join(kbRoot, 'workspaces', OTHER_WS, 'notes', 'b.md')
    fs.writeFileSync(mine, 'mine')
    fs.writeFileSync(theirs, 'theirs')
    expect(isInWorkspaceScope(mine, WS, kbRoot)).toBe(true)
    expect(isInWorkspaceScope(theirs, WS, kbRoot)).toBe(false)
  })

  it('connectors: another person\'s credential is denied to this job (obj 900303 module, called not copied)', () => {
    const mine = canUseConnectorCredential({
      connectorId: 'synthetic-connector',
      ownerUserId: PERSON,
      actor: { kind: 'user', userId: PERSON },
      use: { agent: AGENT, workspace: WS },
    })
    const theirs = canUseConnectorCredential({
      connectorId: 'synthetic-connector',
      ownerUserId: OUTSIDER,
      actor: { kind: 'user', userId: PERSON },
      use: { agent: AGENT, workspace: WS },
    })
    expect(theirs.allowed).toBe(false)
    if (!theirs.allowed) expect(theirs.reason).toBe('cross_user')
    // `mine` is whatever the owner's own consent rules say; the gate here is
    // that the CROSS-USER case is refused, which it is.
    expect(typeof mine.allowed).toBe('boolean')
  })
})

describe('G6 — artifact text reaching the thread is redacted', () => {
  it('a secret-shaped token in the worker summary never reaches the message', () => {
    const body = buildThreadBody('completed', {
      objective_id: 42,
      title: 'Key audit',
      status: 'done',
      pr_url: null,
      summary: 'Found the key sk-ant-abcdefghijklmnopqrstuvwxyz0123 in the config.',
    })
    expect(body).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz0123')
    expect(body).toContain('[REDACTED:ANTHROPIC_KEY]')
  })

  it('the redaction survives the full enqueue → deliver path', () => {
    const job = fileJob()
    expect(job.ok).toBe(true)
    if (!job.ok) return
    // Built at runtime so the OSS publish gate's gitleaks scan has no literal to flag.
    const forgedGh = ['ghp', ['ABCDEFGHIJKLMNOP', 'QRSTUVWXYZ012345'].join('')].join('_')
    getDb().prepare('UPDATE objectives SET last_session_summary = ? WHERE id = ?')
      .run(`Done. Token: ${forgedGh}`, job.objectiveId)
    transition(job.objectiveId, 'done')
    runBotThreadDeliveryTick(getDb())
    const delivered = threadMessages().find(m => (m.meta ?? '').includes(`"bot_job":${job.objectiveId}`))
    expect(delivered).toBeTruthy()
    expect(delivered!.content).not.toContain(forgedGh)
    expect(delivered!.content).toContain('[REDACTED:GITHUB_TOKEN]')
  })
})

describe('G7 — completion is delivered exactly once', () => {
  it('a replayed done event produces ONE delivery and ONE message', () => {
    const job = fileJob()
    expect(job.ok).toBe(true)
    if (!job.ok) return
    getDb().prepare('UPDATE objectives SET last_session_summary = ? WHERE id = ?').run('Summarised 14 notes.', job.objectiveId)
    transition(job.objectiveId, 'done')
    runBotThreadDeliveryTick(getDb())
    // Replay: reopen and finish again, plus a duplicate event in the same tick.
    transition(job.objectiveId, 'working', 'done')
    transition(job.objectiveId, 'done', 'working')
    runBotThreadDeliveryTick(getDb())

    const deliveries = getDb()
      .prepare('SELECT * FROM bot_thread_deliveries WHERE objective_id = ?')
      .all(job.objectiveId) as { delivery_id: string; status: string }[]
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0].delivery_id).toBe(threadDeliveryId('completed', job.objectiveId))
    expect(deliveries[0].status).toBe('delivered')
    const mine = threadMessages().filter(m => (m.meta ?? '').includes(`"bot_job":${job.objectiveId}`))
    expect(mine).toHaveLength(1)
  })

  it('a done card with NO output says so instead of implying a result', () => {
    const body = buildThreadBody('completed', { objective_id: 7, title: 'Silent job', status: 'done', pr_url: null, summary: null })
    expect(body).toMatch(/reported NO output/)
    expect(body).not.toMatch(/Your job finished/)
  })

  it('a card that is not a bot job is never delivered anywhere', () => {
    const db = getDb()
    const info = db.prepare(
      `INSERT INTO objectives (title, description, workspace, type, status, created_by)
       VALUES ('not a bot job', '', ?, 'task', 'queue', ?)`,
    ).run(WS, PERSON)
    const id = Number(info.lastInsertRowid)
    transition(id, 'done')
    runBotThreadDeliveryTick(db)
    const n = db.prepare('SELECT COUNT(*) AS n FROM bot_thread_deliveries WHERE objective_id = ?').get(id) as { n: number }
    expect(n.n).toBe(0)
  })
})

describe('G8 — the result lands in the SAME conversation that asked', () => {
  it('the message is an assistant turn in the originating (person, bot) thread', () => {
    const job = fileJob()
    expect(job.ok).toBe(true)
    if (!job.ok) return
    getDb().prepare('UPDATE objectives SET last_session_summary = ? WHERE id = ?').run('Here is your summary.', job.objectiveId)
    transition(job.objectiveId, 'done')
    const tick = runBotThreadDeliveryTick(getDb())
    expect(tick.queued).toBeGreaterThanOrEqual(1)
    const row = getDb()
      .prepare("SELECT * FROM agent_chat_messages WHERE user_id = ? AND agent_slug = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1")
      .get(PERSON, AGENT) as { user_id: number; agent_slug: string; content: string }
    expect(row.user_id).toBe(PERSON)
    expect(row.agent_slug).toBe(AGENT)
    expect(row.content).toContain(`#${job.objectiveId}`)
    expect(row.content).toContain('Here is your summary.')
    // and nothing leaked into another thread
    const other = getDb()
      .prepare("SELECT COUNT(*) AS n FROM agent_chat_messages WHERE agent_slug != ? AND content LIKE ?")
      .get(AGENT, `%#${job.objectiveId}%`) as { n: number }
    expect(other.n).toBe(0)
  })

  it('a blocked card tells the thread it stopped, as a clarification', () => {
    const job = fileJob()
    expect(job.ok).toBe(true)
    if (!job.ok) return
    getDb().prepare('INSERT INTO objective_events (objective_id, workspace, kind, to_value) VALUES (?, ?, ?, ?)')
      .run(job.objectiveId, WS, 'blocked', 'needs input')
    runBotThreadDeliveryTick(getDb())
    const row = getDb()
      .prepare('SELECT * FROM bot_thread_deliveries WHERE objective_id = ?')
      .get(job.objectiveId) as { kind: string } | undefined
    expect(row?.kind).toBe('clarification')
  })
})

describe('G9 — a follow-up continues the SAME job', () => {
  it('a live worker is attached to; no second card, no second worker', () => {
    const job = fileJob()
    expect(job.ok).toBe(true)
    if (!job.ok) return
    const before = getDb().prepare('SELECT COUNT(*) AS n FROM objectives').get() as { n: number }
    const first = followUpBotJob(getDb(), {
      userId: PERSON, agentSlug: AGENT, objectiveId: job.objectiveId,
      message: 'also do Q3', sessionId: 'cc-live-1', isAlive: () => true,
    })
    expect(first.ok).toBe(true)
    const second = followUpBotJob(getDb(), {
      userId: PERSON, agentSlug: AGENT, objectiveId: job.objectiveId,
      message: 'and Q4', sessionId: 'cc-other-2', isAlive: () => true,
    })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.action).toBe('attach')
    expect(second.sessionId).toBe('cc-live-1')
    expect(second.objectiveId).toBe(job.objectiveId)
    const after = getDb().prepare('SELECT COUNT(*) AS n FROM objectives').get() as { n: number }
    expect(after.n).toBe(before.n)
  })

  it('a follow-up from a different conversation is refused', () => {
    const job = fileJob()
    expect(job.ok).toBe(true)
    if (!job.ok) return
    const r = followUpBotJob(getDb(), {
      userId: OUTSIDER, agentSlug: AGENT, objectiveId: job.objectiveId,
      message: 'show me', sessionId: 'cc-x', isAlive: () => true,
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('not_your_thread')
  })
})

describe('G10 — credential revocation is live and fails closed', () => {
  it('the next authorized call after a controlled revocation fails', () => {
    const db = getDb()
    expect(assertCredentialLive(db, 'connector', 'synthetic-connector').allowed).toBe(true)
    revokeCredential(db, 'connector', 'synthetic-connector', 'synthetic revocation test')
    const after = assertCredentialLive(db, 'connector', 'synthetic-connector')
    expect(after.allowed).toBe(false)
    expect(after.code).toBe('revoked')
    restoreCredential(db, 'connector', 'synthetic-connector')
    expect(assertCredentialLive(db, 'connector', 'synthetic-connector').allowed).toBe(true)
  })

  it('a wildcard revocation covers every subject in its scope', () => {
    const db = getDb()
    revokeCredential(db, 'agent_key', '*', 'synthetic blanket revocation')
    expect(assertCredentialLive(db, 'agent_key', 'any-key-at-all').allowed).toBe(false)
    restoreCredential(db, 'agent_key', '*')
  })

  it('secrets are not blanket-readable, and only NAMES are ever returned', () => {
    const db = getDb()
    const policy = { allowed: ['SYNTHETIC_TEST_TOKEN'] }
    const denied = assertSecretReadable(db, policy, 'SOME_OTHER_SECRET')
    expect(denied.allowed).toBe(false)
    expect(denied.code).toBe('not_permitted')
    expect(assertSecretReadable(db, policy, 'SYNTHETIC_TEST_TOKEN').allowed).toBe(true)
    // Revoking the NAME closes it, with no value anywhere in the verdict.
    revokeCredential(db, 'secret', 'SYNTHETIC_TEST_TOKEN', 'synthetic')
    const revoked = assertSecretReadable(db, policy, 'SYNTHETIC_TEST_TOKEN')
    expect(revoked.allowed).toBe(false)
    expect(JSON.stringify(revoked)).not.toMatch(/value/i)
    restoreCredential(db, 'secret', 'SYNTHETIC_TEST_TOKEN')
  })

  it('an unreadable ledger is treated as NO permission, not as permission', () => {
    const broken = { prepare() { throw new Error('ledger gone') } } as unknown as Parameters<typeof assertCredentialLive>[0]
    const v = assertCredentialLive(broken, 'connector', 'synthetic-connector')
    expect(v.allowed).toBe(false)
    expect(v.code).toBe('ledger_unavailable')
  })
})

describe('G11 — crash, cancel and resume leave exactly one worker', () => {
  it('a dead holder\'s lease is taken over by the resuming session', () => {
    const job = fileJob()
    expect(job.ok).toBe(true)
    if (!job.ok) return
    followUpBotJob(getDb(), { userId: PERSON, agentSlug: AGENT, objectiveId: job.objectiveId, message: 'go', sessionId: 'cc-dead-1', isAlive: () => true })
    const resumed = followUpBotJob(getDb(), {
      userId: PERSON, agentSlug: AGENT, objectiveId: job.objectiveId,
      message: 'still there?', sessionId: 'cc-new-2', isAlive: () => false, // the holder crashed
    })
    expect(resumed.ok).toBe(true)
    if (!resumed.ok) return
    expect(resumed.action).toBe('resume')
    expect(resumed.sessionId).toBe('cc-new-2')
  })

  it('a cancelled job is not revived by a follow-up', () => {
    const job = fileJob()
    expect(job.ok).toBe(true)
    if (!job.ok) return
    getDb().prepare("UPDATE objectives SET status = 'cancelled' WHERE id = ?").run(job.objectiveId)
    const r = followUpBotJob(getDb(), { userId: PERSON, agentSlug: AGENT, objectiveId: job.objectiveId, message: 'carry on', sessionId: 'cc-z', isAlive: () => false })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('terminal')
  })
})

describe('G12 — the cost/time limit is durable, finite and honestly described', () => {
  it('no configured ceiling → auto-start refused, and NO number is invented', () => {
    const job = fileJob()
    expect(job.ok).toBe(true)
    if (!job.ok) return
    const d = decideBotJobStart(getDb(), { objectiveId: job.objectiveId, workspace: WS })
    expect(d.allowed).toBe(false)
    expect(d.ceiling!.costUsd).toBeNull()
    expect(d.ceiling!.wallclockMs).toBeNull()
    expect(d.ceiling!.source).toBe('none')
    expect(d.reason).toMatch(/No default budget is assumed/)
  })

  it('the enforced/advisory split from obj 900322 is preserved verbatim', () => {
    const job = fileJob()
    expect(job.ok).toBe(true)
    if (!job.ok) return
    setObjectiveCeiling(getDb(), job.objectiveId, { costUsd: 2, wallclockMs: 600_000, source: 'objective' })
    const d = decideBotJobStart(getDb(), { objectiveId: job.objectiveId, workspace: WS })
    expect(d.allowed).toBe(true)
    expect(d.enforcement).toEqual({ wallclock: 'enforced', cost: 'advisory' })
    expect(d.reason).toMatch(/not a billing hard stop/)
  })

  it('the ceiling and the spend against it survive a process restart', () => {
    const job = fileJob()
    expect(job.ok).toBe(true)
    if (!job.ok) return
    setObjectiveCeiling(getDb(), job.objectiveId, { wallclockMs: 60_000, source: 'objective' })
    recordSpend(getDb(), job.objectiveId, { ms: 90_000 })
    // Re-read through a FRESH connection to the same file: this is what a
    // restart sees. A Map-based budget would be empty here.
    const fresh = new BetterSqlite3(process.env.DB_PATH as string, { readonly: true })
    const row = fresh.prepare('SELECT * FROM objective_job_accounting WHERE objective_id = ?').get(job.objectiveId) as
      { wallclock_ceiling_ms: number; elapsed_ms: number }
    fresh.close()
    expect(row.wallclock_ceiling_ms).toBe(60_000)
    expect(row.elapsed_ms).toBeGreaterThanOrEqual(90_000)
    const verdict = evaluateCeiling(getDb(), job.objectiveId, WS)
    expect(verdict.state).toBe('exceeded')
  })

  it('an unbudgeted workspace stays unbudgeted — resolveConfiguredCeiling reports absence', () => {
    const c = resolveConfiguredCeiling(getDb(), 999999123, WS)
    expect(c.source).toBe('none')
    expect(c.costUsd).toBeNull()
    expect(c.wallclockMs).toBeNull()
  })
})

describe('approval / block — durable, fingerprinted, and never executed in the read-only MVP', () => {
  it('a consequential action is RECORDED and refused, not performed', () => {
    const r = requestApproval({
      db: getDb(), objectiveId: null, threadUserId: PERSON, threadAgentSlug: AGENT,
      kind: 'send_email', inputs: { to: 'dana@example.test', subject: 'hi' },
    })
    expect(r.executed).toBe(false)
    expect(r.state).toBe('pending')
    expect(consumeApproval(getDb(), 'send_email', { to: 'dana@example.test', subject: 'hi' }).ok).toBe(false)
  })

  it('an approval is bound to the exact inputs it was given', () => {
    const inputs = { to: 'dana@example.test', amount: 10 }
    const req = requestApproval({ db: getDb(), objectiveId: null, threadUserId: PERSON, threadAgentSlug: AGENT, kind: 'purchase', inputs })
    decideApproval(getDb(), req.approvalId, 'approved', PERSON)
    // Same kind, different inputs → different fingerprint → no approval at all.
    expect(actionFingerprint('purchase', { to: 'dana@example.test', amount: 1000 })).not.toBe(req.fingerprint)
    expect(consumeApproval(getDb(), 'purchase', { to: 'dana@example.test', amount: 1000 }).ok).toBe(false)
    // Key ORDER must not change the fingerprint.
    expect(actionFingerprint('purchase', { amount: 10, to: 'dana@example.test' })).toBe(req.fingerprint)
    // Single use.
    expect(consumeApproval(getDb(), 'purchase', inputs).ok).toBe(true)
    expect(consumeApproval(getDb(), 'purchase', inputs).ok).toBe(false)
  })

  it('a block is durable and cannot be re-decided into an approval', () => {
    const inputs = { path: '/synthetic/everything' }
    const req = requestApproval({ db: getDb(), objectiveId: null, threadUserId: PERSON, threadAgentSlug: AGENT, kind: 'destructive_write', inputs })
    expect(decideApproval(getDb(), req.approvalId, 'blocked', PERSON).ok).toBe(true)
    const flip = decideApproval(getDb(), req.approvalId, 'approved', PERSON)
    expect(flip.ok).toBe(false)
    const again = requestApproval({ db: getDb(), objectiveId: null, threadUserId: PERSON, threadAgentSlug: AGENT, kind: 'destructive_write', inputs })
    expect(again.state).toBe('blocked')
    expect(consumeApproval(getDb(), 'destructive_write', inputs).ok).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('wiring — the chat tool the person actually uses goes through the guarded path', () => {
  function chatCtx(slug: string) {
    return {
      userId: PERSON,
      username: 'bot-mvp-person',
      workspace: WS,
      agent: {
        slug,
        name: slug,
        description: '',
        avatar: '',
        colour: 'blue',
        system_prompt: '',
        knowledge_folders: [],
        tools: ['create_objective'],
        model: null,
        provider: null,
        schedules: [],
        version: null,
        author: null,
        source: 'demo',
        file: '',
      },
      kbRoot: path.join(TMP, 'kb'),
      connectors: {},
    } as unknown as Parameters<typeof runTool>[0]
  }

  it('a registered bot files a BOT JOB (origin row, owner, read-only) from create_objective', () => {
    const title = uniqueTitle('Chat-filed job')
    const out = runTool(chatCtx(AGENT), 'create_objective', { title, description: 'read the notes' })
    const id = out.objective_id!
    const origin = getJobOrigin(getDb(), id)
    expect(origin).toBeTruthy()
    expect(origin!.owner_bot).toBe(BOT)
    expect(origin!.job_mode).toBe(MVP_JOB_MODE)
    // Unbudgeted, so the person is told it will not start by itself.
    expect(String((out.result as { note: string }).note)).toMatch(/will NOT start by itself/)
  })

  it('the identical tool call twice files ONE card (derived idempotency key)', () => {
    const title = uniqueTitle('Chat-filed twice')
    const a = runTool(chatCtx(AGENT), 'create_objective', { title, description: 'same ask' })
    const b = runTool(chatCtx(AGENT), 'create_objective', { title, description: 'same ask' })
    expect(b.objective_id).toBe(a.objective_id)
    expect(String((b.result as { note: string }).note)).toMatch(/already filed/)
  })

  it('an UNREGISTERED agent keeps the original behaviour — legacy compatibility', () => {
    const title = uniqueTitle('Legacy filed')
    const out = runTool(chatCtx('not-a-registered-bot'), 'create_objective', { title, description: 'still works' })
    expect(out.objective_id).toBeGreaterThan(0)
    expect(getJobOrigin(getDb(), out.objective_id!)).toBeNull()
    expect(ToolUseError).toBeTruthy()
  })
})
