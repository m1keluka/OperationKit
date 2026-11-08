/**
 * obj 900309 — actionable completion routing + honest owner naming.
 *
 * Two defects are covered here, both observed on the live board on 2026-11-08:
 *
 *  1. A child card that finishes cleanly wakes NOBODY. #900303 went `done` at
 *     09:45 ET straight from its reviewer PASS (mustRouteToHumanReview() is false
 *     once parent_id is set, so it never entered `review`), and classifyNeed()
 *     only covers working/ai_review/review — leaving that set is not entering it.
 *  2. The wake summary named the agent KEY's label as the thing the card "needs"
 *     whenever owner_bot was null. The key is a shared connection, so that turned
 *     an authentication artefact into ownership metadata.
 *
 * The enqueue path is driven against the real DB and the real triggers; nothing
 * leaves the box (no transport is installed — these assertions are on the OUTBOX).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 23).toString('base64')
const TMP_DB = path.join(os.tmpdir(), `cc-wh-completion-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const wh = await import('./agent-webhooks.js')

const USER_ID = 1
const WORKSPACE = 'operationkit'
let keyId: number

function seedCard(opts: { title?: string; ownerBot?: string | null; parentId?: number | null } = {}): number {
  const r = getDb()
    .prepare(
      `INSERT INTO objectives (title, description, agent_context, workspace, created_by, status, agent_key_id, agent_key_label, owner_bot, parent_id)
       VALUES (?, '', 'cto', ?, ?, 'working', ?, ?, ?, ?)`,
    )
    .run(opts.title ?? 'Ship the thing', WORKSPACE, USER_ID, keyId, 'Grok: Shared Connection', opts.ownerBot ?? null, opts.parentId ?? null)
  return Number(r.lastInsertRowid)
}

const setStatus = (id: number, status: string) =>
  getDb().prepare('UPDATE objectives SET status = ? WHERE id = ?').run(status, id)

/** Enqueue only — the outbox is what this suite asserts on. */
function enqueue(): number {
  return wh.enqueueAgentWebhookEvents(getDb(), new Date())
}

interface Queued { event: string; event_id: string; payload: Record<string, unknown> }
function outbox(objectiveId?: number): Queued[] {
  const rows = getDb()
    .prepare('SELECT event, event_id, payload FROM agent_webhook_deliveries ORDER BY id ASC')
    .all() as Array<{ event: string; event_id: string; payload: string }>
  return rows
    .map(r => ({ event: r.event, event_id: r.event_id, payload: JSON.parse(r.payload) as Record<string, unknown> }))
    .filter(q => objectiveId === undefined || (q.payload.objective as { id: number }).id === objectiveId)
}

const needsOf = (objectiveId: number) =>
  outbox(objectiveId).filter(q => q.event === 'needs_agent')

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'mike', 'x', 'admin')`).run(USER_ID)
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace) VALUES (?, ?)`).run(USER_ID, WORKSPACE)
  const k = db
    .prepare(
      `INSERT INTO agent_api_keys (user_id, label, key_hash, last4, scopes, workspaces)
       VALUES (?, 'Grok: Shared Connection', 'hash-900309', '0309', '["board:write"]', NULL)`,
    )
    .run(USER_ID)
  keyId = Number(k.lastInsertRowid)
  db.prepare(
    `INSERT INTO agent_key_webhooks (key_id, user_id, url, events, enabled)
     VALUES (?, ?, 'https://hook.example.com/cc', '["needs_agent"]', 1)`,
  ).run(keyId, USER_ID)
})

afterAll(() => {
  try { getDb().close() } catch { /* noop */ }
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${TMP_DB}${suffix}`
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
})

beforeEach(() => {
  getDb().exec(
    `DELETE FROM agent_webhook_deliveries;
     DELETE FROM agent_webhook_card_need_state;
     DELETE FROM settings WHERE key = '${wh.CURSOR_SETTING}';`,
  )
  // Anchor the cursor at head so each test reads as "the moves made after this".
  enqueue()
})

// ── pure classification ──────────────────────────────────────────────────────

describe('classifyCompletion', () => {
  it('a move to done that did NOT come from review is an actionable completion', () => {
    const need = wh.classifyCompletion({ kind: 'status', from_value: 'ai_review', to_value: 'done' })
    expect(need?.kind).toBe('completed')
    expect(need?.category).toBe('completed')
  })

  it('a move to done FROM review is not — Mike already saw it, and review already woke the owner', () => {
    expect(wh.classifyCompletion({ kind: 'status', from_value: 'review', to_value: 'done' })).toBeNull()
  })

  it('a PR reaching merged is an actionable completion', () => {
    expect(wh.classifyCompletion({ kind: 'pr', from_value: 'open', to_value: 'merged' })?.kind).toBe('pr_merged')
  })

  it('is silent on everything else — cancelled, pr closed, ordinary moves, deleted cards', () => {
    expect(wh.classifyCompletion({ kind: 'status', from_value: 'working', to_value: 'cancelled' })).toBeNull()
    expect(wh.classifyCompletion({ kind: 'pr', from_value: 'open', to_value: 'closed' })).toBeNull()
    expect(wh.classifyCompletion({ kind: 'status', from_value: 'queue', to_value: 'working' })).toBeNull()
    expect(wh.classifyCompletion({ kind: 'status', from_value: 'ai_review', to_value: 'done', deleted_at: '2026-11-08' })).toBeNull()
  })
})

// ── owner naming ─────────────────────────────────────────────────────────────

describe('needRecipientLabel — the key label is never spoken as the owner', () => {
  it('names the owner bot when the card is owned', () => {
    expect(wh.needRecipientLabel('Operation Kit')).toBe('Operation Kit')
    expect(wh.needRecipientLabel('Grok: General')).toBe('General')
  })

  it('says UNOWNED (and names the fallback) when it is not', () => {
    for (const v of [null, undefined, '', '   ']) {
      const label = wh.needRecipientLabel(v as string | null)
      expect(label).toContain('unowned')
      expect(label).toContain('General')
    }
  })
})

// ── end to end through the outbox ────────────────────────────────────────────

describe('a child card that completes without passing through review', () => {
  it('wakes its owner exactly once, with the owner named and carried raw', () => {
    const parent = seedCard({ title: 'Parent', ownerBot: 'Operation Kit' })
    const child = seedCard({ title: 'Connector picker fix', ownerBot: 'Operation Kit', parentId: parent })

    setStatus(child, 'ai_review')
    setStatus(child, 'done') // the reviewer-PASS auto-route: review is skipped
    enqueue()

    const completions = needsOf(child).filter(q => (q.payload.need as { kind: string }).kind === 'completed')
    expect(completions).toHaveLength(1)
    const p = completions[0].payload
    expect(p.owner_bot).toBe('Operation Kit')
    expect(p.summary).toContain('Operation Kit')
    expect(p.summary).toContain('completed')
    expect(completions[0].event).toBe('needs_agent') // shape the CoS routine already parses
  })

  it('does not wake twice, however many done events the card produces', () => {
    const child = seedCard({ ownerBot: 'Operation Kit', parentId: seedCard({ title: 'P2' }) })
    setStatus(child, 'done')
    enqueue()
    // reopened, finished again — a replay from the router's point of view
    setStatus(child, 'working')
    setStatus(child, 'done')
    enqueue()

    expect(needsOf(child).filter(q => (q.payload.need as { kind: string }).kind === 'completed')).toHaveLength(1)
  })

  it('an unowned card still wakes, and says unowned rather than naming the shared key', () => {
    const card = seedCard({ title: 'Unowned child', ownerBot: null, parentId: seedCard({ title: 'P3' }) })
    setStatus(card, 'done')
    enqueue()

    const [c] = needsOf(card).filter(q => (q.payload.need as { kind: string }).kind === 'completed')
    expect(c).toBeDefined()
    expect(c.payload.owner_bot).toBeNull()
    expect(String(c.payload.summary)).toContain('unowned')
    expect(String(c.payload.summary)).not.toContain('Shared Connection')
  })
})

describe('a top-level card Mike signs off in review', () => {
  it('gets its review wake and NO completion wake — human-done semantics unchanged', () => {
    const card = seedCard({ title: 'Top level', ownerBot: 'Operation Kit' })
    setStatus(card, 'review')
    enqueue()
    setStatus(card, 'done') // Mike accepts
    enqueue()

    const kinds = needsOf(card).map(q => (q.payload.need as { kind: string }).kind)
    expect(kinds).toContain('review')
    expect(kinds).not.toContain('completed')
  })
})

describe('a merged PR', () => {
  it('wakes the owner once when objective_prs reaches merged', () => {
    const card = seedCard({ title: 'PR card', ownerBot: 'Operation Kit' })
    const db = getDb()
    db.prepare(
      `INSERT INTO objective_prs (objective_id, repo, pr_number, pr_url, state)
       VALUES (?, 'your-org/operationkit', 9001, 'https://github.com/your-org/operationkit/pull/9001', 'open')`,
    ).run(card)
    enqueue()
    db.prepare("UPDATE objective_prs SET state = 'merged' WHERE objective_id = ? AND pr_number = 9001").run(card)
    enqueue()
    // a replayed transition must not produce a second wake
    db.prepare("UPDATE objective_prs SET state = 'open' WHERE objective_id = ? AND pr_number = 9001").run(card)
    db.prepare("UPDATE objective_prs SET state = 'merged' WHERE objective_id = ? AND pr_number = 9001").run(card)
    enqueue()

    const merged = needsOf(card).filter(q => (q.payload.need as { kind: string }).kind === 'pr_merged')
    expect(merged).toHaveLength(1)
    expect(merged[0].payload.owner_bot).toBe('Operation Kit')
  })
})

describe('opt-in and scope are preserved', () => {
  it('a webhook not subscribed to needs_agent gets no completion wake', () => {
    const db = getDb()
    db.prepare("UPDATE agent_key_webhooks SET events = '[\"done\"]' WHERE key_id = ?").run(keyId)
    const card = seedCard({ title: 'Not subscribed', ownerBot: 'Operation Kit', parentId: seedCard({ title: 'P4' }) })
    setStatus(card, 'done')
    enqueue()
    try {
      expect(needsOf(card)).toHaveLength(0)
    } finally {
      db.prepare("UPDATE agent_key_webhooks SET events = '[\"needs_agent\"]' WHERE key_id = ?").run(keyId)
    }
  })

  it('a card outside the key workspace scope gets no completion wake', () => {
    const db = getDb()
    db.prepare("UPDATE agent_api_keys SET workspaces = '[\"some-other-workspace\"]' WHERE id = ?").run(keyId)
    const card = seedCard({ title: 'Out of scope', ownerBot: 'Operation Kit', parentId: seedCard({ title: 'P5' }) })
    setStatus(card, 'done')
    enqueue()
    try {
      expect(needsOf(card)).toHaveLength(0)
    } finally {
      db.prepare('UPDATE agent_api_keys SET workspaces = NULL WHERE id = ?').run(keyId)
    }
  })

  it('a revoked key gets nothing', () => {
    const db = getDb()
    db.prepare("UPDATE agent_api_keys SET revoked_at = datetime('now') WHERE id = ?").run(keyId)
    const card = seedCard({ title: 'Revoked', ownerBot: 'Operation Kit', parentId: seedCard({ title: 'P6' }) })
    setStatus(card, 'done')
    enqueue()
    try {
      expect(needsOf(card)).toHaveLength(0)
    } finally {
      db.prepare('UPDATE agent_api_keys SET revoked_at = NULL WHERE id = ?').run(keyId)
    }
  })
})

describe('completionEventId', () => {
  it('is stable per (kind, card, key) — that is the whole dedupe mechanism', () => {
    expect(wh.completionEventId('completed', 42, 7)).toBe('cc_completed_42_k7')
    expect(wh.completionEventId('pr_merged', 42, 7)).toBe('cc_pr_merged_42_k7')
  })
})
