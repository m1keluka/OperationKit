/**
 * obj 900368 — what the notification path ACTUALLY routes on.
 *
 * obj 900309 made completion wakes exist and made the summary stop calling the
 * shared agent key's label the card's owner. It did NOT change recipient
 * selection, and the design probe on #900332 flagged that as an open question.
 * This suite answers it with executable assertions instead of prose, because the
 * answer is load-bearing for the live verification runbook
 * (`docs/notifications/live-delivery-runbook.md`) and for anyone who later reads
 * `owner_bot` on a payload and assumes the server used it to choose a receiver.
 *
 * The three facts pinned here, all of them CURRENT behaviour on `main`:
 *
 *  1. For a card an agent key filed, the recipient is that **creating agent key**
 *     — the enqueue JOIN is `agent_key_webhooks w ON w.key_id = o.agent_key_id`.
 *  2. For such a card `owner_bot` is **payload-only**. It names the owner in
 *     `summary` and rides raw on the body so a DOWNSTREAM router can fan out on
 *     it. Two cards owned by two different bots, filed through one key, produce
 *     two deliveries to that ONE key.
 *  3. obj 900553 (rewritten deliberately, as this header asked): a card with
 *     `agent_key_id IS NULL` — every browser/UI-created and chat-created card —
 *     used to get NO webhook at all. It now gets the needs_agent family
 *     (needs, `completed`, `pr_merged`) routed by `owner_bot` to that bot's own
 *     in-scope webhook, else to the General's, else to the shared
 *     connection (`selectKeylessRecipient`). Same event ids, same dedupe.
 *
 * Nothing leaves the box: no transport is installed, every assertion is on the
 * OUTBOX rows, and no production endpoint is contacted.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 29).toString('base64')
const TMP_DB = path.join(os.tmpdir(), `cc-wh-routing-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const wh = await import('./agent-webhooks.js')

const USER_ID = 1
const WORKSPACE = 'operationkit'
let keyId: number

/** A card as the agent API files it: attributed to the key that created it. */
function seedAgentCard(opts: { ownerBot?: string | null; parentId?: number | null } = {}): number {
  const r = getDb()
    .prepare(
      `INSERT INTO objectives (title, description, agent_context, workspace, created_by, status, agent_key_id, agent_key_label, owner_bot, parent_id)
       VALUES ('Agent-filed card', '', 'cto', ?, ?, 'working', ?, 'Grok: Shared Connection', ?, ?)`,
    )
    .run(WORKSPACE, USER_ID, keyId, opts.ownerBot ?? null, opts.parentId ?? null)
  return Number(r.lastInsertRowid)
}

/**
 * A card as the BROWSER files it: `POST /api/objectives` with a cookie has no
 * `req.agentKey`, so `objectives-crud.ts` writes `agent_key_id = NULL` and
 * `origin = 'manual'`. owner_bot is accepted on this route, which is exactly why
 * the combination below is the dangerous one — the card LOOKS owned.
 */
function seedBrowserCard(opts: { ownerBot?: string | null } = {}): number {
  const r = getDb()
    .prepare(
      `INSERT INTO objectives (title, description, agent_context, workspace, created_by, status, agent_key_id, agent_key_label, owner_bot, origin)
       VALUES ('Browser-filed card', '', 'cto', ?, ?, 'working', NULL, NULL, ?, 'manual')`,
    )
    .run(WORKSPACE, USER_ID, opts.ownerBot ?? null)
  return Number(r.lastInsertRowid)
}

const setStatus = (id: number, status: string) =>
  getDb().prepare('UPDATE objectives SET status = ? WHERE id = ?').run(status, id)

const enqueue = () => wh.enqueueAgentWebhookEvents(getDb(), new Date())

interface Queued { event: string; event_id: string; key_id: number; payload: Record<string, unknown> }
function outbox(objectiveId?: number): Queued[] {
  const rows = getDb()
    .prepare('SELECT event, event_id, key_id, objective_id, payload FROM agent_webhook_deliveries ORDER BY id ASC')
    .all() as Array<{ event: string; event_id: string; key_id: number; objective_id: number; payload: string }>
  return rows
    .filter(r => objectiveId === undefined || r.objective_id === objectiveId)
    .map(r => ({ event: r.event, event_id: r.event_id, key_id: r.key_id, payload: JSON.parse(r.payload) as Record<string, unknown> }))
}

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'operator', 'x', 'admin')`).run(USER_ID)
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace) VALUES (?, ?)`).run(USER_ID, WORKSPACE)
  const k = db
    .prepare(
      `INSERT INTO agent_api_keys (user_id, label, key_hash, last4, scopes, workspaces)
       VALUES (?, 'Grok: Shared Connection', 'hash-900368', '0368', '["board:write"]', NULL)`,
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
  enqueue() // anchor the cursor at head
})

describe('the recipient is the card’s creating agent key — owner_bot does not select one', () => {
  it('two cards owned by two different bots both land on the one key that filed them', () => {
    const a = seedAgentCard({ ownerBot: 'Operation Kit' })
    const b = seedAgentCard({ ownerBot: 'General' })
    setStatus(a, 'done')
    setStatus(b, 'done')
    enqueue()

    const qa = outbox(a)
    const qb = outbox(b)
    expect(qa).toHaveLength(1)
    expect(qb).toHaveLength(1)
    // Same receiver. The owner is metadata ON the body, not a routing decision.
    expect(qa[0].key_id).toBe(keyId)
    expect(qb[0].key_id).toBe(keyId)
    expect(qa[0].payload.owner_bot).toBe('Operation Kit')
    expect(qb[0].payload.owner_bot).toBe('General')
    expect(String(qa[0].payload.summary)).toContain('Operation Kit')
    expect(String(qb[0].payload.summary)).toContain('General')
  })

  it('an unowned card is delivered to the same key and asks the RECEIVER to route to the CoS', () => {
    const c = seedAgentCard({ ownerBot: null })
    setStatus(c, 'done')
    enqueue()

    const q = outbox(c)
    expect(q).toHaveLength(1)
    expect(q[0].key_id).toBe(keyId)
    expect(q[0].payload.owner_bot).toBeNull()
    // The fallback is a sentence in the body, not a second delivery to a CoS endpoint.
    // Asserted on the brand-neutral half ("unowned") plus the thing that must NOT be
    // there: the OSS public-mirror assembly renames the General, so pinning the
    // fallback's NAME would make this test a hostage of scripts/oss-genericize.sh. The
    // contract is "says unowned, never speaks the shared key's label as the owner".
    expect(String(q[0].payload.summary).toLowerCase()).toContain('unowned')
    expect(String(q[0].payload.summary)).not.toContain('Shared Connection')
    expect(outbox()).toHaveLength(1)
  })
})

/**
 * obj 900553 — the residual dark path is CLOSED. These three cases used to pin
 * ZERO rows for a card with `agent_key_id IS NULL`. With only the one shared
 * `needs_agent` webhook installed (the documented setup, cos-card-wake.md), a
 * keyless card now reaches that shared webhook — the CoS wake routine — exactly
 * like an unowned API card does. Bot-specific routing is covered at the bottom.
 */
describe('obj 900553: a card with no agent_key_id now wakes the shared CoS webhook', () => {
  it('a browser-created card that completes produces exactly ONE webhook row', () => {
    const b = seedBrowserCard({ ownerBot: 'Operation Kit' })
    setStatus(b, 'done')
    enqueue()
    const q = outbox(b)
    expect(q).toHaveLength(1)
    expect(q[0].key_id).toBe(keyId)
    expect(q[0].event_id).toBe(wh.completionEventId('completed', b, keyId))
    expect(q[0].payload.owner_bot).toBe('Operation Kit')
  })

  it('the need ladder works for it too — a blocker wakes once', () => {
    const b = seedBrowserCard({ ownerBot: 'Operation Kit' })
    getDb().prepare('UPDATE objectives SET has_blockers = 1 WHERE id = ?').run(b)
    setStatus(b, 'working')
    enqueue()
    const q = outbox(b)
    expect(q).toHaveLength(1)
    expect((q[0].payload.need as { kind: string }).kind).toBe('blocked')
  })

  it('an agent-filed card in the same tick delivers exactly as before', () => {
    const ui = seedBrowserCard({ ownerBot: 'Operation Kit' })
    const api = seedAgentCard({ ownerBot: 'Operation Kit' })
    setStatus(ui, 'done')
    setStatus(api, 'done')
    enqueue()
    expect(outbox(ui)).toHaveLength(1)
    expect(outbox(api)).toHaveLength(1)
    expect(outbox(api)[0].event_id).toBe(wh.completionEventId('completed', api, keyId))
  })
})

describe('dedupe survives a replay, which is what makes the runbook’s replay check meaningful', () => {
  it('a reopen → done cycle still yields exactly one completion wake', () => {
    const c = seedAgentCard({ ownerBot: 'Operation Kit' })
    setStatus(c, 'done')
    enqueue()
    expect(outbox(c)).toHaveLength(1)

    setStatus(c, 'working')
    enqueue()
    setStatus(c, 'done')
    enqueue()

    const q = outbox(c)
    expect(q).toHaveLength(1)
    expect(q[0].event_id).toBe(wh.completionEventId('completed', c, keyId))
  })
})

/**
 * obj 900553 — recipient selection for keyless cards when bots have their OWN
 * needs_agent webhooks. Tiers: owner_bot's webhook → General (then
 * General) → the shared connection. Only webhooks that already exist and already
 * cover the card's workspace are candidates; nothing is widened.
 */
describe('obj 900553: keyless cards route by owner_bot, unowned fall back to the CoS', () => {
  let opkitKey: number
  let cosKey: number
  let cfoOtherWsKey: number

  function addKeyWithWebhook(label: string, events: string[], workspaces: string[] | null = null): number {
    const db = getDb()
    const k = db
      .prepare(
        `INSERT INTO agent_api_keys (user_id, label, key_hash, last4, scopes, workspaces)
         VALUES (?, ?, ?, 'xxxx', '["board:write"]', ?)`,
      )
      .run(USER_ID, label, `hash-${label}`, workspaces ? JSON.stringify(workspaces) : null)
    const id = Number(k.lastInsertRowid)
    db.prepare(
      `INSERT INTO agent_key_webhooks (key_id, user_id, url, events, enabled) VALUES (?, ?, ?, ?, 1)`,
    ).run(id, USER_ID, `https://hook-${id}.example.com/cc`, JSON.stringify(events))
    return id
  }

  beforeAll(() => {
    // OpKit also subscribes to a raw status event, to prove a keyless card never
    // leaks the "cards YOU filed" feed to a key that did not file it.
    opkitKey = addKeyWithWebhook('Grok: Operation Kit', ['done', 'needs_agent'])
    cosKey = addKeyWithWebhook('Grok: General', ['needs_agent'])
    // A CFO webhook limited to ANOTHER workspace: never a candidate here.
    cfoOtherWsKey = addKeyWithWebhook('Grok: CFO', ['needs_agent'], ['some-other-workspace'])
  })

  it('a UI-created card with owner_bot set gets exactly ONE delivery, to the owner’s webhook', () => {
    const b = seedBrowserCard({ ownerBot: 'Operation Kit' })
    setStatus(b, 'done')
    enqueue()
    const q = outbox(b)
    expect(q).toHaveLength(1)
    expect(q[0].event).toBe('needs_agent') // no raw `done` row, though OpKit subscribes to it
    expect(q[0].key_id).toBe(opkitKey)
    expect(q[0].event_id).toBe(wh.completionEventId('completed', b, opkitKey))
    expect(q[0].payload.owner_bot).toBe('Operation Kit')
    expect(String(q[0].payload.summary)).toContain('Operation Kit')
    expect((q[0].payload.agent_key as { id: number }).id).toBe(opkitKey)
  })

  it('owner_bot resolves through the registry (alias spelling routes to the same bot)', () => {
    const b = seedBrowserCard({ ownerBot: 'okit' })
    getDb().prepare('UPDATE objectives SET has_blockers = 1 WHERE id = ?').run(b)
    setStatus(b, 'working')
    enqueue()
    const q = outbox(b)
    expect(q).toHaveLength(1)
    expect(q[0].key_id).toBe(opkitKey)
  })

  it('a UI-created UNOWNED card falls back to the General', () => {
    const b = seedBrowserCard({ ownerBot: null })
    setStatus(b, 'review')
    enqueue()
    const q = outbox(b)
    expect(q).toHaveLength(1)
    expect(q[0].key_id).toBe(cosKey)
    expect(q[0].payload.owner_bot).toBeNull()
    expect(String(q[0].payload.summary).toLowerCase()).toContain('unowned')
    expect((q[0].payload.need as { kind: string }).kind).toBe('review')
  })

  it('an owner with no in-scope webhook of its own (CFO, scoped elsewhere) falls back to the CoS', () => {
    const b = seedBrowserCard({ ownerBot: 'CFO' })
    setStatus(b, 'done')
    enqueue()
    const q = outbox(b)
    expect(q).toHaveLength(1)
    expect(q[0].key_id).toBe(cosKey)
    expect(q[0].payload.owner_bot).toBe('CFO')
    expect(outbox().some(r => r.key_id === cfoOtherWsKey)).toBe(false)
  })

  it('replaying the same events does not double deliver (needs and completions)', () => {
    const owned = seedBrowserCard({ ownerBot: 'Operation Kit' })
    const unowned = seedBrowserCard({ ownerBot: null })
    const db = getDb()
    db.prepare(
      `INSERT INTO objective_prs (objective_id, repo, pr_number, pr_url, state)
       VALUES (?, 'x/y', 553, 'https://github.com/x/y/pull/553', 'open')`,
    ).run(owned)
    setStatus(unowned, 'review')
    enqueue()
    db.prepare("UPDATE objective_prs SET state = 'merged' WHERE objective_id = ? AND pr_number = 553").run(owned)
    enqueue()
    expect(outbox(owned)).toHaveLength(1)
    expect(outbox(unowned)).toHaveLength(1)
    const before = outbox().map(r => r.event_id).sort()

    // Replay 1: rewind the cursor so the SAME objective_events rows are re-read.
    const first = (db.prepare('SELECT MIN(id) AS id FROM objective_events WHERE objective_id IN (?, ?)').get(owned, unowned) as { id: number }).id
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(String(first - 1), wh.CURSOR_SETTING)
    enqueue()
    // Replay 2: a replayed PR transition (open → merged again).
    db.prepare("UPDATE objective_prs SET state = 'open' WHERE objective_id = ? AND pr_number = 553").run(owned)
    db.prepare("UPDATE objective_prs SET state = 'merged' WHERE objective_id = ? AND pr_number = 553").run(owned)
    enqueue()

    expect(outbox().map(r => r.event_id).sort()).toEqual(before)
    const merged = outbox(owned)
    expect(merged).toHaveLength(1)
    expect(merged[0].event_id).toBe(wh.completionEventId('pr_merged', owned, opkitKey))
    expect(merged[0].key_id).toBe(opkitKey)
  })

  it('API-created cards are unchanged: still the filing key, even when the owner has its own webhook', () => {
    const a = seedAgentCard({ ownerBot: 'Operation Kit' })
    const u = seedAgentCard({ ownerBot: null })
    setStatus(a, 'done')
    setStatus(u, 'done')
    enqueue()
    expect(outbox(a)).toHaveLength(1)
    expect(outbox(a)[0].key_id).toBe(keyId)
    expect(outbox(u)).toHaveLength(1)
    expect(outbox(u)[0].key_id).toBe(keyId)
    // The OpKit key never sees the shared key's card, even its subscribed `done`.
    expect(outbox().filter(r => r.key_id === opkitKey)).toHaveLength(0)
  })

  it('a keyless card in another workspace: the only key scoped to it (a different bot) is never the fallback', () => {
    const r = getDb()
      .prepare(
        `INSERT INTO objectives (title, description, agent_context, workspace, created_by, status, agent_key_id, owner_bot, origin)
         VALUES ('Out of scope', '', 'cto', 'some-other-workspace', ?, 'working', NULL, 'Operation Kit', 'manual')`,
      )
      .run(USER_ID)
    const id = Number(r.lastInsertRowid)
    setStatus(id, 'done')
    enqueue()
    const q = outbox(id)
    // CFO's webhook is the only one that covers some-other-workspace, but it is a
    // DIFFERENT bot's key: never used as a fallback for an OpKit-owned card. The
    // unscoped keys (shared, OpKit, CoS) belong to an admin, so they DO cover it.
    expect(q.every(x => x.key_id !== cfoOtherWsKey)).toBe(true)
    expect(q).toHaveLength(1)
    expect(q[0].key_id).toBe(opkitKey)
  })

  it('selectKeylessRecipient: scope is enforced and a different bot’s key is never a fallback', () => {
    const cand = (key_id: number, key_label: string, key_workspaces: string | null = null, owner_role: string | null = 'member') => ({
      key_id, key_label, key_workspaces, key_user_id: 99, owner_role, events: '["needs_agent"]',
    })
    const member = () => true
    const nonMember = () => false
    // Not a member, not admin → out of scope → no delivery.
    expect(wh.selectKeylessRecipient({ owner_bot: null, workspace: 'w' }, [cand(1, 'Grok: General')], nonMember)).toBeNull()
    // Only a different bot's key in scope → no fallback onto it.
    expect(wh.selectKeylessRecipient({ owner_bot: null, workspace: 'w' }, [cand(1, 'Grok: CFO')], member)).toBeNull()
    // Key allowlist excludes the workspace → no delivery.
    expect(wh.selectKeylessRecipient({ owner_bot: 'CFO', workspace: 'w' }, [cand(1, 'Grok: CFO', '["x"]')], member)).toBeNull()
    // Shared connection (label names no bot) is the last tier.
    expect(wh.selectKeylessRecipient({ owner_bot: 'CFO', workspace: 'w' }, [cand(4, 'Shared'), cand(2, 'Grok: CTO')], member))
      .toMatchObject({ candidate: { key_id: 4 }, route: 'shared_fallback' })
    // CoS beats shared; General is the CoS-tier backup.
    expect(wh.selectKeylessRecipient({ owner_bot: null, workspace: 'w' }, [cand(4, 'Shared'), cand(5, 'General')], member))
      .toMatchObject({ candidate: { key_id: 5 }, route: 'cos_fallback' })
    // Owner match wins; lowest key id breaks ties.
    expect(wh.selectKeylessRecipient({ owner_bot: 'Grok: CTO', workspace: 'w' }, [cand(9, 'CTO'), cand(3, 'Grok: CTO'), cand(1, 'General')], member))
      .toMatchObject({ candidate: { key_id: 3 }, route: 'owner_bot' })
    // Not subscribed to needs_agent → not a candidate.
    expect(wh.selectKeylessRecipient({ owner_bot: null, workspace: 'w' }, [{ ...cand(1, 'General'), events: '["done"]' }], member)).toBeNull()
  })
})
