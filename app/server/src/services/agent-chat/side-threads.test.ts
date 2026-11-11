import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

/*
 * Bot side threads / concurrent task lanes — obj 900370.
 *
 * Three properties are load-bearing and all three are asserted here against the
 * real engine and the real database, not a mock of them:
 *
 *   1. CONCURRENCY. Two lanes of the SAME bot are in flight at the same moment.
 *      The provider stub is a BARRIER: it does not answer any turn until N turns
 *      have reached it simultaneously. If lanes were serialised behind one chat
 *      (the pre-900370 behaviour, one in-flight slot per (person, bot)) the
 *      second turn would be refused or would never arrive and the barrier would
 *      reject — so this test cannot pass by accident.
 *
 *   2. ISOLATION, FAIL-CLOSED. A message posted in thread A is absent from
 *      thread B's stored history AND from the conversation the model is handed
 *      for thread B. The model context is read out of the captured HTTP body, so
 *      the assertion is about what actually left the process, not about an
 *      internal helper's return value.
 *
 *   3. CLOSING A SIDE THREAD LEAVES THE MAIN CONVERSATION UNCHANGED. Archive,
 *      clear and outright delete of a lane are each compared against a snapshot
 *      of the main conversation taken before the operation.
 *
 * Reimplemented from this install's own prior art (mentor_threads) and its own
 * agent_chat tables. No third-party source was read, copied or adapted.
 */
process.env.JWT_SECRET = 'test-secret-side-threads-xxxx'
const TMP_DB = path.join(os.tmpdir(), `cc-side-threads-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
const TMP_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-side-threads-agents-'))
const TMP_KB = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-side-threads-kb-'))
process.env.AGENT_FILES_DIR = TMP_AGENTS
process.env.KNOWLEDGE_BASE_DIR = TMP_KB

const { initDb, getDb } = await import('../../db/index.js')
const { findAgent, listMessages, clearChat, runTurn, ChatBusyError } = await import('./engine.js')
const {
  createThread,
  listThreads,
  getThread,
  updateThread,
  resolveLane,
  lanePredicate,
  laneKey,
  maxThreadsPerBot,
  countOpenThreads,
  ThreadRejected,
  MAIN_LANE,
} = await import('./threads.js')

const OWNER = 2
const OTHER = 3
const ENV = { ANTHROPIC_API_KEY: 'k', AGENT_CHAT_PROVIDER: 'anthropic' } as NodeJS.ProcessEnv

type Seen = { body: Record<string, unknown> }

const textReply = (t: string) => ({ content: [{ type: 'text', text: t }] })

/** Records the request body and answers immediately. */
function captureFetch(seen: Seen[], reply: unknown) {
  return (async (_url: string, init: RequestInit) => {
    seen.push({ body: JSON.parse(String(init.body)) })
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as unknown as typeof fetch
}

/**
 * Answers NOTHING until `n` turns are inside the provider at the same time.
 * That is the whole proof of concurrency: with one in-flight slot per bot the
 * nth turn can never arrive, and the barrier rejects with a readable message
 * instead of hanging the suite.
 */
function barrierFetch(n: number, seen: Seen[], timeoutMs = 4000) {
  let arrived = 0
  let release!: () => void
  let fail!: (e: Error) => void
  const gate = new Promise<void>((resolve, reject) => {
    release = resolve
    fail = reject
  })
  const timer = setTimeout(() => fail(new Error(`lanes did not run concurrently: only ${arrived} of ${n} turns reached the provider`)), timeoutMs)
  if (typeof timer.unref === 'function') timer.unref()
  return (async (_url: string, init: RequestInit) => {
    seen.push({ body: JSON.parse(String(init.body)) })
    arrived += 1
    if (arrived >= n) {
      clearTimeout(timer)
      release()
    }
    await gate
    return new Response(JSON.stringify(textReply(`answer ${arrived}`)), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as unknown as typeof fetch
}

const agent = () => ({ ...findAgent('helper')!, provider: 'anthropic' as const })

/** Everything the model was told, flattened to plain text. */
function modelText(s: Seen): string {
  const msgs = (s.body.messages ?? []) as { role: string; content: unknown }[]
  return JSON.stringify(msgs)
}

function say(lane: Parameters<typeof runTurn>[0]['lane'], text: string, seen: Seen[], userId = OWNER) {
  return runTurn({
    userId,
    username: `user${userId}`,
    agent: agent(),
    text,
    lane,
    env: ENV,
    deps: { fetch: captureFetch(seen, textReply(`ack: ${text}`)) },
  })
}

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'user2', 'x', 'member')`).run(OWNER)
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'user3', 'x', 'member')`).run(OTHER)
  for (const slug of ['helper', 'second-bot']) {
    fs.mkdirSync(path.join(TMP_AGENTS, slug))
    fs.writeFileSync(
      path.join(TMP_AGENTS, slug, 'agent.yaml'),
      'name: Helper\nsystem_prompt: You help.\nknowledge_folders: []\ntools: []\ncolour: blue\nversion: 1.0.0\nauthor: Test\n',
    )
  }
})

beforeEach(() => {
  const db = getDb()
  db.prepare('DELETE FROM agent_chat_messages').run()
  db.prepare('DELETE FROM agent_chat_threads').run()
  db.prepare("DELETE FROM settings WHERE key = 'agent_chat_max_threads_per_bot'").run()
})

afterAll(() => {
  try { getDb().close() } catch { /* already closed */ }
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
  fs.rmSync(TMP_AGENTS, { recursive: true, force: true })
  fs.rmSync(TMP_KB, { recursive: true, force: true })
})

// ── 1. concurrency ──

describe('a bot holds more than one conversation at the same time', () => {
  it('two SIDE THREADS of one bot are inside the provider simultaneously', async () => {
    const a = createThread(OWNER, 'helper', 'Lane A')
    const b = createThread(OWNER, 'helper', 'Lane B')
    const seen: Seen[] = []
    const f = barrierFetch(2, seen)
    const [ra, rb] = await Promise.all([
      runTurn({ userId: OWNER, username: 'user2', agent: agent(), text: 'work on A', lane: { kind: 'thread', id: a.id }, env: ENV, deps: { fetch: f } }),
      runTurn({ userId: OWNER, username: 'user2', agent: agent(), text: 'work on B', lane: { kind: 'thread', id: b.id }, env: ENV, deps: { fetch: f } }),
    ])
    expect(ra.messages.at(-1)?.role).toBe('assistant')
    expect(rb.messages.at(-1)?.role).toBe('assistant')
    expect(seen).toHaveLength(2)
    // And each lane kept only its own turn.
    expect(listMessages(OWNER, 'helper', { lane: { kind: 'thread', id: a.id } }).map(m => m.content)).toContain('work on A')
    expect(listMessages(OWNER, 'helper', { lane: { kind: 'thread', id: b.id } }).map(m => m.content)).not.toContain('work on A')
  })

  it('a side thread runs while the MAIN conversation is still answering', async () => {
    const a = createThread(OWNER, 'helper', 'Lane A')
    const seen: Seen[] = []
    const f = barrierFetch(2, seen)
    await Promise.all([
      runTurn({ userId: OWNER, username: 'user2', agent: agent(), text: 'main question', lane: MAIN_LANE, env: ENV, deps: { fetch: f } }),
      runTurn({ userId: OWNER, username: 'user2', agent: agent(), text: 'side question', lane: { kind: 'thread', id: a.id }, env: ENV, deps: { fetch: f } }),
    ])
    expect(seen).toHaveLength(2)
    expect(listMessages(OWNER, 'helper').map(m => m.content)).toContain('main question')
    expect(listMessages(OWNER, 'helper').map(m => m.content)).not.toContain('side question')
  })

  it('three lanes at once still works — the ceiling is on lanes, not on concurrency', async () => {
    const ids = [createThread(OWNER, 'helper', 'A'), createThread(OWNER, 'helper', 'B'), createThread(OWNER, 'helper', 'C')]
    const seen: Seen[] = []
    const f = barrierFetch(3, seen)
    await Promise.all(
      ids.map(t =>
        runTurn({ userId: OWNER, username: 'user2', agent: agent(), text: `in ${t.title}`, lane: { kind: 'thread', id: t.id }, env: ENV, deps: { fetch: f } }),
      ),
    )
    expect(seen).toHaveLength(3)
  })

  it('but a second turn in the SAME lane is still refused', async () => {
    const a = createThread(OWNER, 'helper', 'Lane A')
    const lane = { kind: 'thread' as const, id: a.id }
    const seen: Seen[] = []
    // A 2-turn barrier that one lane can never satisfy on its own.
    const f = barrierFetch(2, seen, 300)
    const first = runTurn({ userId: OWNER, username: 'user2', agent: agent(), text: 'first', lane, env: ENV, deps: { fetch: f } })
    await expect(
      runTurn({ userId: OWNER, username: 'user2', agent: agent(), text: 'second', lane, env: ENV, deps: { fetch: f } }),
    ).rejects.toBeInstanceOf(ChatBusyError)
    // The refusal is why only ONE turn of this lane ever reached the provider.
    const done = await first
    expect(done.messages.at(-1)?.role).toBe('error')
    expect(seen).toHaveLength(1)
    // And the refused turn stored nothing at all.
    expect(listMessages(OWNER, 'helper', { lane }).map(m => m.content)).not.toContain('second')
  })

  it('the in-flight slot is keyed per lane, so no two lanes share one', () => {
    expect(laneKey(MAIN_LANE)).toBe('main')
    expect(laneKey({ kind: 'thread', id: 7 })).toBe('t7')
    expect(laneKey({ kind: 'thread', id: 7 })).not.toBe(laneKey({ kind: 'thread', id: 8 }))
  })
})

// ── 2. isolation, fail closed ──

describe('a message in one thread never enters another thread', () => {
  it('is absent from the other lane’s stored history', async () => {
    const a = createThread(OWNER, 'helper', 'Lane A')
    const b = createThread(OWNER, 'helper', 'Lane B')
    await say({ kind: 'thread', id: a.id }, 'the door code is on the fridge', [])
    await say({ kind: 'thread', id: b.id }, 'what did I just tell you?', [])

    const inB = listMessages(OWNER, 'helper', { lane: { kind: 'thread', id: b.id } })
    expect(inB.map(m => m.content).join('\n')).not.toContain('door code')
    expect(inB.some(m => m.content === 'what did I just tell you?')).toBe(true)
  })

  it('is absent from the other lane’s MODEL CONTEXT (what actually left the process)', async () => {
    const a = createThread(OWNER, 'helper', 'Lane A')
    const b = createThread(OWNER, 'helper', 'Lane B')
    await say({ kind: 'thread', id: a.id }, 'secret-in-lane-a', [])

    const seen: Seen[] = []
    await say({ kind: 'thread', id: b.id }, 'hello from lane b', seen)
    expect(seen).toHaveLength(1)
    expect(modelText(seen[0])).toContain('hello from lane b')
    expect(modelText(seen[0])).not.toContain('secret-in-lane-a')
  })

  it('the main conversation is not visible from a side thread, and vice versa', async () => {
    const a = createThread(OWNER, 'helper', 'Lane A')
    await say(MAIN_LANE, 'only-in-main', [])
    const intoLane: Seen[] = []
    await say({ kind: 'thread', id: a.id }, 'only-in-lane', intoLane)
    expect(modelText(intoLane[0])).not.toContain('only-in-main')

    const intoMain: Seen[] = []
    await say(MAIN_LANE, 'second main turn', intoMain)
    expect(modelText(intoMain[0])).toContain('only-in-main')
    expect(modelText(intoMain[0])).not.toContain('only-in-lane')
  })

  it('the lane predicate is exactly one lane — never a span, never an OR', () => {
    expect(lanePredicate(MAIN_LANE)).toEqual({ sql: 'thread_id IS NULL', params: [] })
    expect(lanePredicate({ kind: 'thread', id: 9 })).toEqual({ sql: 'thread_id = ?', params: [9] })
    for (const lane of [MAIN_LANE, { kind: 'thread' as const, id: 9 }]) {
      expect(lanePredicate(lane).sql.toUpperCase()).not.toContain(' OR ')
    }
  })

  it('another person cannot name my side thread — it 404s instead of falling back to main', async () => {
    const mine = createThread(OWNER, 'helper', 'Mine')
    expect(() => resolveLane(OTHER, 'helper', mine.id)).toThrow(ThreadRejected)
    try {
      resolveLane(OTHER, 'helper', mine.id)
    } catch (err) {
      expect((err as InstanceType<typeof ThreadRejected>).status).toBe(404)
    }
    expect(getThread(OTHER, 'helper', mine.id)).toBeNull()
  })

  it('a lane of a DIFFERENT bot is not resolvable from this bot', () => {
    const other = createThread(OWNER, 'second-bot', 'Other bot lane')
    expect(() => resolveLane(OWNER, 'helper', other.id)).toThrow(ThreadRejected)
    expect(resolveLane(OWNER, 'second-bot', other.id)).toEqual({ kind: 'thread', id: other.id })
  })

  it('a missing or junk thread_id is refused, never treated as the main conversation', () => {
    expect(resolveLane(OWNER, 'helper', undefined)).toEqual(MAIN_LANE)
    expect(resolveLane(OWNER, 'helper', 'main')).toEqual(MAIN_LANE)
    for (const bad of [0, -1, 1.5, 'abc', 999999]) {
      expect(() => resolveLane(OWNER, 'helper', bad)).toThrow(ThreadRejected)
    }
  })
})

// ── 3. closing a side thread leaves the main conversation unchanged ──

describe('closing or clearing a side thread leaves the main conversation unchanged', () => {
  async function seedBoth() {
    const a = createThread(OWNER, 'helper', 'Lane A')
    await say(MAIN_LANE, 'main message one', [])
    await say(MAIN_LANE, 'main message two', [])
    await say({ kind: 'thread', id: a.id }, 'lane message', [])
    return a
  }
  const snapshotMain = () => listMessages(OWNER, 'helper').map(m => ({ id: m.id, role: m.role, content: m.content }))

  it('archiving (= closing) keeps the main history identical and keeps the lane’s own messages', async () => {
    const a = await seedBoth()
    const before = snapshotMain()
    expect(before.length).toBeGreaterThan(0)

    const closed = updateThread(OWNER, 'helper', a.id, { archived: true })
    expect(closed.archived).toBe(true)

    expect(snapshotMain()).toEqual(before)
    // The lane is gone from the open list but its history is still there.
    expect(listThreads(OWNER, 'helper').map(t => t.id)).not.toContain(a.id)
    expect(listThreads(OWNER, 'helper', { includeArchived: true }).map(t => t.id)).toContain(a.id)
    expect(listMessages(OWNER, 'helper', { lane: { kind: 'thread', id: a.id } }).map(m => m.content)).toContain('lane message')
  })

  it('clearing a side thread deletes that lane only', async () => {
    const a = await seedBoth()
    const before = snapshotMain()

    const removed = clearChat(OWNER, 'helper', { kind: 'thread', id: a.id })
    expect(removed).toBeGreaterThan(0)

    expect(snapshotMain()).toEqual(before)
    expect(listMessages(OWNER, 'helper', { lane: { kind: 'thread', id: a.id } })).toHaveLength(0)
  })

  it('deleting the thread row takes its messages and nothing else', async () => {
    const a = await seedBoth()
    const before = snapshotMain()

    getDb().prepare('DELETE FROM agent_chat_threads WHERE id = ?').run(a.id)

    expect(snapshotMain()).toEqual(before)
    const orphans = getDb().prepare('SELECT COUNT(*) AS n FROM agent_chat_messages WHERE thread_id = ?').get(a.id) as { n: number }
    expect(Number(orphans.n)).toBe(0)
  })

  it('clearing the MAIN conversation leaves the side threads alone', async () => {
    const a = await seedBoth()
    clearChat(OWNER, 'helper', MAIN_LANE)
    expect(listMessages(OWNER, 'helper')).toHaveLength(0)
    expect(listMessages(OWNER, 'helper', { lane: { kind: 'thread', id: a.id } }).map(m => m.content)).toContain('lane message')
    expect(listThreads(OWNER, 'helper').map(t => t.id)).toContain(a.id)
  })

  it('every pre-existing message row is in the main conversation (NULL means main)', async () => {
    // Written the way every row was written before this feature existed.
    getDb()
      .prepare("INSERT INTO agent_chat_messages (user_id, agent_slug, role, content) VALUES (?, 'helper', 'user', 'legacy row')")
      .run(OWNER)
    expect(listMessages(OWNER, 'helper').map(m => m.content)).toContain('legacy row')
  })
})

// ── the per-bot lane ceiling ──

describe('per-bot lane ceiling', () => {
  const setCap = (n: number) =>
    getDb()
      .prepare("INSERT INTO settings (key, value) VALUES ('agent_chat_max_threads_per_bot', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(String(n))

  it('refuses the next OPEN thread past the ceiling, and frees a slot on archive', () => {
    setCap(2)
    expect(maxThreadsPerBot()).toBe(2)
    const a = createThread(OWNER, 'helper', 'A')
    createThread(OWNER, 'helper', 'B')
    expect(() => createThread(OWNER, 'helper', 'C')).toThrow(ThreadRejected)
    try {
      createThread(OWNER, 'helper', 'C')
    } catch (err) {
      expect((err as InstanceType<typeof ThreadRejected>).status).toBe(409)
    }
    updateThread(OWNER, 'helper', a.id, { archived: true })
    expect(countOpenThreads(OWNER, 'helper')).toBe(1)
    expect(createThread(OWNER, 'helper', 'C').title).toBe('C')
  })

  it('is per bot, not per person', () => {
    setCap(1)
    createThread(OWNER, 'helper', 'A')
    expect(() => createThread(OWNER, 'helper', 'B')).toThrow(ThreadRejected)
    expect(createThread(OWNER, 'second-bot', 'A').title).toBe('A')
  })

  it('re-opening an archived thread is capped the same way opening one is', () => {
    setCap(1)
    const a = createThread(OWNER, 'helper', 'A')
    updateThread(OWNER, 'helper', a.id, { archived: true })
    createThread(OWNER, 'helper', 'B')
    expect(() => updateThread(OWNER, 'helper', a.id, { archived: false })).toThrow(ThreadRejected)
  })

  it('0 means no ceiling', () => {
    setCap(0)
    for (let i = 0; i < 12; i++) createThread(OWNER, 'helper', `lane ${i}`)
    expect(countOpenThreads(OWNER, 'helper')).toBe(12)
  })

  it('an unset setting falls back to the built-in default', () => {
    expect(maxThreadsPerBot()).toBe(10)
  })
})
