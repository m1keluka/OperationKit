/**
 * Speaker attribution in the Granola client (obj 710856).
 *
 * The client used to flatten `transcript[]` straight to a single string, which
 * discards WHO said each line. Voice-profile extraction ("write in Ava's tone")
 * depends on isolating the owner's own lines, and once flattened that is
 * unrecoverable — so these tests pin the attribution, not just the text.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

process.env.JWT_SECRET ||= 'test-secret-granola-segments-xx'

const { getMeeting, verifyApiKey } = await import('./granola-client.js')

function stubFetch(payload: unknown, ok = true, status = 200) {
  const spy = vi.fn(async () => ({
    ok,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }))
  vi.stubGlobal('fetch', spy)
  return spy
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.GRANOLA_API_KEY
})

const NOTE = {
  id: 'not_x',
  title: 'Ava <> Mike',
  owner: { name: 'Ava Kelly', email: 'ava@example.com' },
  transcript: [
    { speaker: { source: 'me', diarization_label: 'Me' }, text: 'I kind of wanted to talk about how I should edit them.' },
    { speaker: { source: 'them', diarization_label: 'Michael Rivera' }, text: 'So what I do now is take reference content.' },
    { speaker: { source: 'me' }, text: 'Right, okay.' },
    { text: '   ' },
  ],
}

describe('speaker-attributed segments', () => {
  it('flags only the note owner lines as is_owner', async () => {
    stubFetch(NOTE)
    const m = await getMeeting('not_x', 'grn_test')
    expect(m.segments.map(s => s.is_owner)).toEqual([true, false, true])
    expect(m.segments.filter(s => s.is_owner).map(s => s.text)).toEqual([
      'I kind of wanted to talk about how I should edit them.',
      'Right, okay.',
    ])
  })

  it('drops empty lines but preserves the flattened text contract', async () => {
    stubFetch(NOTE)
    const m = await getMeeting('not_x', 'grn_test')
    expect(m.segments).toHaveLength(3)
    expect(m.transcript_text).toBe(
      'I kind of wanted to talk about how I should edit them. So what I do now is take reference content. Right, okay.'
    )
  })

  it('tolerates a note with no transcript', async () => {
    stubFetch({ id: 'not_y', title: 'n', transcript: undefined })
    const m = await getMeeting('not_y', 'grn_test')
    expect(m.segments).toEqual([])
    expect(m.transcript_text).toBe('')
  })
})

describe('per-owner credential', () => {
  it('sends the EXPLICIT key, not the process global', async () => {
    process.env.GRANOLA_API_KEY = 'grn_global_wrong_owner'
    const spy = stubFetch(NOTE)
    await getMeeting('not_x', 'grn_this_owner')
    const headers = (spy.mock.calls[0] as unknown as [string, { headers: Record<string, string> }])[1].headers
    expect(headers.Authorization).toBe('Bearer grn_this_owner')
  })

  it('verifyApiKey returns the owning account on success', async () => {
    stubFetch({ notes: [NOTE], hasMore: false })
    await expect(verifyApiKey('grn_ok')).resolves.toEqual({ ok: true, account: 'ava@example.com' })
  })

  it('verifyApiKey reports failure instead of throwing', async () => {
    stubFetch({ error: 'unauthorized' }, false, 401)
    const res = await verifyApiKey('grn_bad')
    expect(res.ok).toBe(false)
  })
})
