import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

/*
 * Regression for obj 900157 — "the chat says it can't open screenshots".
 *
 * The bug was not an upload that errored; it was that an image never became
 * image CONTENT on the way to the model. These tests assert the whole path:
 * an attached screenshot ends up in the provider's HTTP body as a real image
 * block (Anthropic) / image_url part (OpenAI-shape), survives into the next
 * turn's history, and — when the provider cannot see images at all — the person
 * is told so instead of the image being dropped in silence.
 */
process.env.JWT_SECRET = 'test-secret-chat-images-xxxx'
const TMP_DB = path.join(os.tmpdir(), `cc-chat-images-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
const TMP_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-chat-images-agents-'))
const TMP_KB = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-chat-images-kb-'))
process.env.AGENT_FILES_DIR = TMP_AGENTS
process.env.KNOWLEDGE_BASE_DIR = TMP_KB

const { initDb, getDb } = await import('../../db/index.js')
const { findAgent, listMessages, runTurn } = await import('./engine.js')
const { parseIncomingImages } = await import('./attachments.js')

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const USER = 2

type Seen = { url: string; body: Record<string, unknown> }

/** A provider endpoint that records what it was sent and answers plain text. */
function captureFetch(seen: Seen[], reply: unknown) {
  return (async (url: string, init: RequestInit) => {
    seen.push({ url: String(url), body: JSON.parse(String(init.body)) })
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as unknown as typeof fetch
}

const screenshot = () => parseIncomingImages([{ name: 'bug.png', media_type: 'image/png', data: PNG_B64 }])

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'ava', 'x', 'member')`).run(USER)
  fs.mkdirSync(path.join(TMP_AGENTS, 'helper'))
  fs.writeFileSync(
    path.join(TMP_AGENTS, 'helper', 'agent.yaml'),
    'name: Helper\nsystem_prompt: You help.\nknowledge_folders: []\ntools: []\ncolour: blue\nversion: 1.0.0\nauthor: Test\n',
  )
})

afterAll(() => {
  try { getDb().close() } catch { /* already closed */ }
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
  fs.rmSync(TMP_AGENTS, { recursive: true, force: true })
  fs.rmSync(TMP_KB, { recursive: true, force: true })
})

const agent = () => findAgent('helper')!

describe('an attached screenshot reaches the model as image content', () => {
  it('Anthropic gets a base64 image block, and the question after it', async () => {
    const seen: Seen[] = []
    const out = await runTurn({
      userId: USER,
      username: 'ava',
      agent: { ...agent(), provider: 'anthropic' },
      text: 'what is wrong here?',
      images: screenshot(),
      env: { ANTHROPIC_API_KEY: 'k', AGENT_CHAT_PROVIDER: 'anthropic' },
      deps: { fetch: captureFetch(seen, { content: [{ type: 'text', text: 'A null pointer on line 12.' }] }) },
    })
    expect(out.messages.at(-1)?.role).toBe('assistant')

    expect(seen).toHaveLength(1)
    const content = (seen[0].body.messages as { role: string; content: Record<string, never>[] }[])[0].content
    // The image is a real block, carrying the actual bytes — not JSON.stringify'd text.
    expect(content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } })
    expect(content[1]).toEqual({ type: 'text', text: 'what is wrong here?' })
    expect(JSON.stringify(seen[0].body)).not.toContain('image_url')
  })

  it('OpenAI-shape providers get an image_url data: URL part', async () => {
    const seen: Seen[] = []
    await runTurn({
      userId: USER + 1,
      username: 'ava2',
      agent: { ...agent(), provider: 'openai-compatible', model: 'local-vision' },
      text: 'read this',
      images: screenshot(),
      env: { AGENT_CHAT_OPENAI_COMPAT_BASE_URL: 'http://litellm:4000/v1' },
      deps: { fetch: captureFetch(seen, { choices: [{ message: { content: 'ok' } }] }) },
    })
    const parts = (seen[0].body.messages as { role: string; content: { type: string; image_url?: { url: string } }[] }[])[1].content
    expect(parts[0].type).toBe('image_url')
    expect(parts[0].image_url?.url).toBe(`data:image/png;base64,${PNG_B64}`)
    expect(parts[1]).toEqual({ type: 'text', text: 'read this' })
  })

  it('a screenshot with no words is still a message, and the model is told so', async () => {
    const seen: Seen[] = []
    await runTurn({
      userId: USER + 2,
      username: 'ava3',
      agent: { ...agent(), provider: 'anthropic' },
      text: '',
      images: screenshot(),
      env: { ANTHROPIC_API_KEY: 'k' },
      deps: { fetch: captureFetch(seen, { content: [{ type: 'text', text: 'I see a 500 page.' }] }) },
    })
    const content = (seen[0].body.messages as { content: { type: string; text?: string }[] }[])[0].content
    expect(content[0].type).toBe('image')
    expect(content[1].text).toMatch(/screenshot/i)
  })

  it('the screenshot is still there on the NEXT turn, so follow-up questions work', async () => {
    const user = USER + 3
    const first: Seen[] = []
    await runTurn({
      userId: user, username: 'ava4', agent: { ...agent(), provider: 'anthropic' },
      text: 'look at this', images: screenshot(),
      env: { ANTHROPIC_API_KEY: 'k' },
      deps: { fetch: captureFetch(first, { content: [{ type: 'text', text: 'Seen.' }] }) },
    })
    const second: Seen[] = []
    await runTurn({
      userId: user, username: 'ava4', agent: { ...agent(), provider: 'anthropic' },
      text: 'what does the red box say?',
      env: { ANTHROPIC_API_KEY: 'k' },
      deps: { fetch: captureFetch(second, { content: [{ type: 'text', text: 'It says 500.' }] }) },
    })
    const blocks = (second[0].body.messages as { content: { type: string }[] }[]).flatMap(m => m.content)
    expect(blocks.filter(b => b.type === 'image')).toHaveLength(1)
  })

  it('stores the image against the message and hands the UI metadata, never bytes', async () => {
    const user = USER + 4
    await runTurn({
      userId: user, username: 'ava5', agent: { ...agent(), provider: 'anthropic' },
      text: 'hi', images: screenshot(),
      env: { ANTHROPIC_API_KEY: 'k' },
      deps: { fetch: captureFetch([], { content: [{ type: 'text', text: 'hello' }] }) },
    })
    const rows = listMessages(user, 'helper')
    const userRow = rows.find(r => r.role === 'user')!
    expect(userRow.images).toHaveLength(1)
    expect(userRow.images[0].name).toBe('bug.png')
    expect(userRow.images[0].url).toMatch(/^\/api\/agent-chat\/attachments\/\d+$/)
    expect(JSON.stringify(userRow)).not.toContain(PNG_B64)
    // The assistant's own reply carries no attachments.
    expect(rows.find(r => r.role === 'assistant')!.images).toEqual([])
  })

  it('a provider that cannot see images says so, instead of dropping the screenshot', async () => {
    const user = USER + 5
    const out = await runTurn({
      userId: user, username: 'ava6', agent: { ...agent(), provider: 'claude' },
      text: 'look', images: screenshot(),
      // The Claude CLI image path turned off: the provider reports no image support.
      env: { SESSION_JAIL_CLAUDE_OAUTH_TOKEN: 't', AGENT_CHAT_CLAUDE_IMAGES: '0' },
    })
    const last = out.messages.at(-1)!
    expect(last.role).toBe('error')
    expect(last.content).toMatch(/cannot look at images/)
    // The image is kept, not thrown away — the person can switch provider and retry.
    expect(listMessages(user, 'helper').find(r => r.role === 'user')!.images).toHaveLength(1)
  })
})
