import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP_DB = path.join(os.tmpdir(), `cc-model-refresh-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const { listModels, setDefaultModel, getDefaultModelId } = await import('./model-registry.js')
const {
  refreshProviderModels, getLastRefreshReport, resolveCredentials, isUsableModel, prettifyModelId,
  autoRefreshIntervalHours,
} = await import('./model-refresh.js')

type Handler = (url: string, headers: Record<string, string>) => { status: number; body: unknown } | Error

function fakeFetch(handler: Handler) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const impl = async (url: string, init?: { headers?: Record<string, string> }) => {
    const headers = init?.headers ?? {}
    calls.push({ url, headers })
    const r = handler(url, headers)
    if (r instanceof Error) throw r
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    }
  }
  return { impl, calls }
}

const noSecrets = { readSecret: () => null, listSecretKeys: () => [] as string[] }

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
})
afterAll(() => {
  try { getDb().close() } catch {}
  for (const s of ['', '-wal', '-shm']) {
    const f = `${TMP_DB}${s}`
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
})
beforeEach(() => {
  getDb().exec("DELETE FROM models WHERE source = 'provider'")
  getDb().exec("DELETE FROM settings WHERE key LIKE 'model_refresh%'")
})

describe('schema', () => {
  it('adds source / discovered_at / last_seen_at, seeded rows are source=seed', () => {
    const cols = (getDb().prepare('PRAGMA table_info(models)').all() as { name: string }[]).map(c => c.name)
    expect(cols).toEqual(expect.arrayContaining(['source', 'discovered_at', 'last_seen_at']))
    expect(listModels().every(m => m.source === 'seed')).toBe(true)
  })
})

describe('filters + labels', () => {
  it('keeps runnable chat models and drops embeddings, audio, image and dated snapshots', () => {
    expect(isUsableModel('openai', 'gpt-5.6')).toBe(true)
    expect(isUsableModel('openai', 'o5-mini')).toBe(true)
    expect(isUsableModel('openai', 'text-embedding-3-large')).toBe(false)
    expect(isUsableModel('openai', 'gpt-4o-realtime-preview')).toBe(false)
    expect(isUsableModel('openai', 'gpt-image-1')).toBe(false)
    expect(isUsableModel('openai', 'gpt-4o-2024-08-06')).toBe(false)
    expect(isUsableModel('openai', 'whisper-1')).toBe(false)
    expect(isUsableModel('openai', 'gpt-3.5-turbo')).toBe(false)
    expect(isUsableModel('openai', 'gpt-4-turbo')).toBe(false)
    expect(isUsableModel('openai', 'gpt-4.1')).toBe(true)
    expect(isUsableModel('openai', 'chatgpt-4o-latest')).toBe(false)
    expect(isUsableModel('anthropic', 'claude-opus-6')).toBe(true)
    expect(isUsableModel('xai', 'grok-5')).toBe(true)
    expect(isUsableModel('xai', 'grok-2-image')).toBe(false)
  })
  it('prettifies ids without a display name', () => {
    expect(prettifyModelId('gpt-5.6-mini')).toBe('GPT-5.6 Mini')
    expect(prettifyModelId('grok-5')).toBe('Grok 5')
  })
})

describe('resolveCredentials', () => {
  it('prefers the BYOK secret, then env, then (anthropic) OAuth — names only, deduped', () => {
    const creds = resolveCredentials(
      'anthropic',
      k => (k === 'PROVIDER_API_KEY__ANTHROPIC' ? JSON.stringify({ apiKey: 'sk-a' }) : null),
      { ANTHROPIC_API_KEY: 'sk-a', SESSION_JAIL_ANTHROPIC_API_KEY: 'sk-b', CLAUDE_CODE_OAUTH_TOKEN: 'oat' },
    )
    expect(creds.map(c => [c.name, c.kind])).toEqual([
      ['PROVIDER_API_KEY__ANTHROPIC', 'api_key'],
      ['SESSION_JAIL_ANTHROPIC_API_KEY', 'api_key'],
      ['CLAUDE_CODE_OAUTH_TOKEN', 'oauth'],
    ])
  })
  it('returns nothing when the provider is not connected', () => {
    expect(resolveCredentials('xai', () => null, {})).toEqual([])
  })
})

describe('refreshProviderModels', () => {
  it('adds new models from every provider (disabled), marks seen ones, reports missing', async () => {
    const { impl, calls } = fakeFetch(url => {
      if (url.startsWith('https://api.anthropic.com/v1/models')) {
        return { status: 200, body: { data: [
          { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', type: 'model' },
          { id: 'claude-opus-6', display_name: 'Claude Opus 6', type: 'model' },
        ], has_more: false, last_id: 'claude-opus-6' } }
      }
      if (url === 'https://api.openai.com/v1/models') {
        return { status: 200, body: { data: [{ id: 'gpt-5.5' }, { id: 'gpt-5.6' }, { id: 'text-embedding-3-large' }] } }
      }
      if (url === 'https://api.x.ai/v1/models') return { status: 200, body: { data: [{ id: 'grok-5' }] } }
      return { status: 404, body: {} }
    })
    const report = await refreshProviderModels('manual', {
      fetchImpl: impl,
      env: { ANTHROPIC_API_KEY: 'sk-ant', OPENAI_API_KEY: 'sk-oai', XAI_API_KEY: 'xai' },
      ...noSecrets,
    })
    const byId = Object.fromEntries(report.providers.map(p => [p.provider, p]))
    expect(byId.anthropic).toMatchObject({ status: 'ok', fetched: 2, added: ['claude-opus-6'], credential: 'ANTHROPIC_API_KEY' })
    expect(byId.anthropic.missing).toContain('claude-sonnet-5')
    expect(byId.openai).toMatchObject({ status: 'ok', fetched: 2, added: ['gpt-5.6'] })
    expect(byId.xai).toMatchObject({ status: 'ok', added: ['grok-5'] })

    const rows = Object.fromEntries(listModels().map(m => [m.id, m]))
    expect(rows['claude-opus-6']).toMatchObject({ label: 'Claude Opus 6', engine: 'claude', enabled: false, source: 'provider' })
    expect(rows['gpt-5.6']).toMatchObject({ label: 'GPT-5.6', engine: 'codex', enabled: false })
    expect(rows['grok-5']).toMatchObject({ engine: 'grok', enabled: false })
    // curated label untouched, last_seen stamped
    expect(rows['claude-opus-5-5'].label).toBe('Opus 5.5')
    expect(rows['claude-opus-5-5'].last_seen_at).toBeTruthy()
    // key went only to its own provider, in the right header
    const ant = calls.find(c => c.url.includes('anthropic'))!
    expect(ant.headers['x-api-key']).toBe('sk-ant')
    expect(calls.find(c => c.url.includes('openai'))!.headers.Authorization).toBe('Bearer sk-oai')

    // persisted for the UI
    expect(getLastRefreshReport()?.providers).toHaveLength(3)

    // second run is idempotent: nothing new
    const again = await refreshProviderModels('manual', {
      fetchImpl: impl,
      env: { ANTHROPIC_API_KEY: 'sk-ant', OPENAI_API_KEY: 'sk-oai', XAI_API_KEY: 'xai' },
      ...noSecrets,
    })
    expect(again.providers.every(p => p.added.length === 0)).toBe(true)
  })

  it('a discovered model can become the default (auto-enabled)', async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: { data: [{ id: 'claude-opus-6', display_name: 'Claude Opus 6' }], has_more: false } }))
    await refreshProviderModels('manual', { fetchImpl: impl, env: { ANTHROPIC_API_KEY: 'k' }, ...noSecrets })
    const before = getDefaultModelId()
    setDefaultModel('claude-opus-6')
    expect(getDefaultModelId()).toBe('claude-opus-6')
    expect(listModels().find(m => m.id === 'claude-opus-6')!.enabled).toBe(true)
    setDefaultModel(before)
  })

  it('reports each failure clearly and keeps going with the other providers', async () => {
    const { impl } = fakeFetch(url => {
      if (url.includes('anthropic')) return { status: 401, body: { error: { message: 'invalid x-api-key' } } }
      if (url.includes('openai')) return new Error('getaddrinfo ENOTFOUND api.openai.com')
      return { status: 200, body: { data: [{ id: 'grok-5' }] } }
    })
    const report = await refreshProviderModels('scheduled', {
      fetchImpl: impl, env: { ANTHROPIC_API_KEY: 'bad', OPENAI_API_KEY: 'k', XAI_API_KEY: 'k' }, ...noSecrets,
    })
    const byId = Object.fromEntries(report.providers.map(p => [p.provider, p]))
    expect(byId.anthropic.status).toBe('error')
    expect(byId.anthropic.http_status).toBe(401)
    expect(byId.anthropic.error).toMatch(/401.*credential rejected.*invalid x-api-key/)
    expect(byId.anthropic.error).not.toContain('bad')
    expect(byId.openai.status).toBe('error')
    expect(byId.openai.error).toMatch(/Could not reach api\.openai\.com/)
    expect(byId.xai.status).toBe('ok')
    expect(report.trigger).toBe('scheduled')
  })

  it('falls through a rejected key to the next credential (OAuth for Anthropic)', async () => {
    const { impl, calls } = fakeFetch((url, h) => {
      if (h['x-api-key']) return { status: 401, body: { error: { message: 'bad key' } } }
      if (h.Authorization === 'Bearer oat' && h['anthropic-beta']) {
        return { status: 200, body: { data: [{ id: 'claude-sonnet-6', display_name: 'Claude Sonnet 6' }], has_more: false } }
      }
      return { status: 500, body: {} }
    })
    const report = await refreshProviderModels('manual', {
      fetchImpl: impl, env: { ANTHROPIC_API_KEY: 'old', CLAUDE_CODE_OAUTH_TOKEN: 'oat' }, ...noSecrets,
    })
    const ant = report.providers.find(p => p.provider === 'anthropic')!
    expect(ant).toMatchObject({ status: 'ok', credential: 'CLAUDE_CODE_OAUTH_TOKEN', added: ['claude-sonnet-6'] })
    expect(calls.filter(c => c.url.includes('anthropic'))).toHaveLength(2)
  })

  it('marks unconnected providers as skipped, not failed', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200, body: { data: [] } }))
    const report = await refreshProviderModels('manual', { fetchImpl: impl, env: {}, ...noSecrets })
    expect(report.providers.map(p => p.status)).toEqual(['skipped', 'skipped', 'skipped'])
    expect(report.providers[0].error).toMatch(/Not connected/)
    expect(calls).toHaveLength(0)
  })

  it('follows Anthropic pagination', async () => {
    const { impl } = fakeFetch(url => {
      const u = new URL(url)
      if (!u.searchParams.get('after_id')) {
        return { status: 200, body: { data: [{ id: 'claude-a-1', display_name: 'A1' }], has_more: true, last_id: 'claude-a-1' } }
      }
      return { status: 200, body: { data: [{ id: 'claude-a-2', display_name: 'A2' }], has_more: false, last_id: 'claude-a-2' } }
    })
    const report = await refreshProviderModels('manual', { fetchImpl: impl, env: { ANTHROPIC_API_KEY: 'k' }, ...noSecrets })
    expect(report.providers[0].added).toEqual(['claude-a-1', 'claude-a-2'])
  })

  it('lists custom OpenAI-compatible endpoints from the stored base URL without inserting rows', async () => {
    const { impl, calls } = fakeFetch(url => (url === 'https://llm.example.com/v1/models'
      ? { status: 200, body: { data: [{ id: 'llama-4' }] } }
      : { status: 404, body: {} }))
    const report = await refreshProviderModels('manual', {
      fetchImpl: impl,
      env: {},
      listSecretKeys: () => ['PROVIDER_API_KEY__CUSTOM__LITELLM', 'OTHER'],
      readSecret: k => (k === 'PROVIDER_API_KEY__CUSTOM__LITELLM' ? JSON.stringify({ apiKey: 'c', baseUrl: 'https://llm.example.com/v1/' }) : null),
    })
    const custom = report.providers.find(p => p.provider === 'custom:litellm')!
    expect(custom).toMatchObject({ status: 'ok', fetched: 1, listed: ['llama-4'], engine: null })
    expect(calls[0].headers.Authorization).toBe('Bearer c')
    expect(listModels().some(m => m.id === 'llama-4')).toBe(false)
  })

  it('shares one in-flight run between concurrent callers', async () => {
    let n = 0
    const { impl } = fakeFetch(() => { n++; return { status: 200, body: { data: [], has_more: false } } })
    const deps = { fetchImpl: impl, env: { ANTHROPIC_API_KEY: 'k' }, ...noSecrets }
    const [a, b] = await Promise.all([refreshProviderModels('manual', deps), refreshProviderModels('manual', deps)])
    expect(a).toBe(b)
    expect(n).toBe(1)
  })
})

describe('autoRefreshIntervalHours', () => {
  it('defaults to 24h, honours the interval setting and the off switch', () => {
    expect(autoRefreshIntervalHours()).toBe(24)
    getDb().prepare("INSERT INTO settings (key, value) VALUES ('model_refresh_interval_hours', '6')").run()
    expect(autoRefreshIntervalHours()).toBe(6)
    getDb().prepare("INSERT INTO settings (key, value) VALUES ('model_refresh_auto', '0')").run()
    expect(autoRefreshIntervalHours()).toBe(0)
  })
})
