import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const broadcastSpy = vi.fn()

// In-memory better-sqlite3 stand-in: a tiny shim that backs the only methods
// notifier.ts uses (prepare → run/get) against an array.
type AlertRow = {
  id: number
  severity: string
  source: string
  title: string
  message: string
  dedup_key: string | null
  url: string | null
  email_sent_at: string | null
  acked_at: string | null
  acked_by: string | null
  created_at: string
}
const rows: AlertRow[] = []
let nextId = 1

const fakeDb = {
  prepare: (sql: string) => {
    if (sql.startsWith('INSERT INTO alerts')) {
      return {
        run: (severity: string, source: string, title: string, message: string, dedup_key: string | null, url: string | null) => {
          const row: AlertRow = {
            id: nextId++,
            severity,
            source,
            title,
            message,
            dedup_key: dedup_key ?? null,
            url: url ?? null,
            email_sent_at: null,
            acked_at: null,
            acked_by: null,
            created_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
          }
          rows.push(row)
          return { lastInsertRowid: row.id, changes: 1 }
        },
      }
    }
    if (sql.startsWith('SELECT * FROM alerts WHERE id =')) {
      return { get: (id: number) => rows.find(r => r.id === id) }
    }
    if (sql.startsWith('UPDATE alerts SET email_sent_at')) {
      return {
        run: (id: number) => {
          const r = rows.find(x => x.id === id)
          if (r) r.email_sent_at = new Date().toISOString()
          return { changes: r ? 1 : 0 }
        },
      }
    }
    throw new Error(`Unhandled SQL in test fakeDb: ${sql}`)
  },
}

vi.mock('../db/index.js', () => ({
  getDb: () => fakeDb,
}))

vi.mock('../ws/index.js', () => ({
  broadcast: (msg: unknown) => broadcastSpy(msg),
}))

const { notify, _resetDedupForTests } = await import('./notifier.js')

const mockFetch = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch)
  mockFetch.mockReset()
  mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' })
  broadcastSpy.mockReset()
  rows.length = 0
  nextId = 1
  _resetDedupForTests()
  process.env.RESEND_API_KEY = 'test-resend-key'
  process.env.ALERTS_TO_EMAIL = 'dev@example.com'
  process.env.ALERTS_FROM_EMAIL = 'alerts@example.com'
  delete process.env.ALERTS_ENABLED
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('notifier', () => {
  it('writes the alert to the DB and broadcasts a WS event', async () => {
    await notify({ severity: 'normal', source: 'test', title: 'T', message: 'M' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ severity: 'normal', source: 'test', title: 'T', message: 'M' })
    expect(broadcastSpy).toHaveBeenCalledTimes(1)
    expect(broadcastSpy.mock.calls[0][0]).toMatchObject({ type: 'alert', payload: { id: 1 } })
  })

  it('does NOT email for severity=normal', async () => {
    await notify({ severity: 'normal', source: 'test', title: 'T', message: 'M' })
    expect(mockFetch).not.toHaveBeenCalled()
    expect(rows[0].email_sent_at).toBeNull()
  })

  it('emails via Resend for severity=high and marks email_sent_at', async () => {
    await notify({ severity: 'high', source: 'test', title: 'T', message: 'M' })
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, opts] = mockFetch.mock.calls[0]
    expect(url).toBe('https://api.resend.com/emails')
    expect(opts.headers.Authorization).toBe('Bearer test-resend-key')
    const body = JSON.parse(opts.body)
    expect(body.from).toBe('alerts@example.com')
    expect(body.to).toBe('dev@example.com')
    expect(body.subject).toContain('[HIGH]')
    expect(body.subject).toContain('T')
    expect(body.text).toContain('M')
    expect(rows[0].email_sent_at).not.toBeNull()
  })

  it('uses [EMERGENCY] subject prefix for severity=emergency', async () => {
    await notify({ severity: 'emergency', source: 'test', title: 'T', message: 'M' })
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.subject).toContain('[EMERGENCY]')
  })

  it('suppresses duplicates within the dedup window — no DB write, no broadcast, no email', async () => {
    await notify({ severity: 'high', source: 's', title: 'T', message: 'M', dedup_key: 'k1' })
    await notify({ severity: 'high', source: 's', title: 'T', message: 'M', dedup_key: 'k1' })
    await notify({ severity: 'high', source: 's', title: 'T', message: 'M', dedup_key: 'k1' })
    expect(rows).toHaveLength(1)
    expect(broadcastSpy).toHaveBeenCalledTimes(1)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('does not suppress different dedup_keys', async () => {
    await notify({ severity: 'high', source: 's', title: 'T', message: 'M', dedup_key: 'k1' })
    await notify({ severity: 'high', source: 's', title: 'T', message: 'M', dedup_key: 'k2' })
    expect(rows).toHaveLength(2)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('always emits when no dedup_key provided', async () => {
    await notify({ severity: 'normal', source: 's', title: 'T', message: 'M' })
    await notify({ severity: 'normal', source: 's', title: 'T', message: 'M' })
    expect(rows).toHaveLength(2)
    expect(broadcastSpy).toHaveBeenCalledTimes(2)
  })

  it('ALERTS_ENABLED=false suppresses email but still writes feed + broadcasts', async () => {
    process.env.ALERTS_ENABLED = 'false'
    await notify({ severity: 'high', source: 's', title: 'T', message: 'M' })
    expect(rows).toHaveLength(1)
    expect(broadcastSpy).toHaveBeenCalledTimes(1)
    expect(mockFetch).not.toHaveBeenCalled()
    expect(rows[0].email_sent_at).toBeNull()
  })

  it('skips email when RESEND_API_KEY missing — feed still works', async () => {
    delete process.env.RESEND_API_KEY
    await notify({ severity: 'high', source: 's', title: 'T', message: 'M' })
    expect(rows).toHaveLength(1)
    expect(broadcastSpy).toHaveBeenCalledTimes(1)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('skips email when ALERTS_TO_EMAIL missing — feed still works', async () => {
    delete process.env.ALERTS_TO_EMAIL
    await notify({ severity: 'high', source: 's', title: 'T', message: 'M' })
    expect(rows).toHaveLength(1)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('truncates messages to 4000 chars before insert', async () => {
    const long = 'x'.repeat(8000)
    await notify({ severity: 'normal', source: 's', title: 'T', message: long })
    expect(rows[0].message.length).toBe(4000)
  })

  it('does not throw when Resend rejects', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network down'))
    await expect(
      notify({ severity: 'high', source: 's', title: 'T', message: 'M' })
    ).resolves.toBeUndefined()
    // Feed write still succeeded; just no email_sent_at
    expect(rows).toHaveLength(1)
    expect(rows[0].email_sent_at).toBeNull()
  })

  it('does not throw when Resend returns non-ok and does NOT mark email_sent_at', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' })
    await expect(
      notify({ severity: 'high', source: 's', title: 'T', message: 'M' })
    ).resolves.toBeUndefined()
    expect(rows[0].email_sent_at).toBeNull()
  })
})
