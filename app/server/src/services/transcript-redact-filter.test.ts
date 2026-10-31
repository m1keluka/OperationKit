/**
 * Transcript scrubbing (obj 715532): the generated stream filter the session
 * wrapper pipes the CLI through, run as a real `node` child exactly as the
 * wrapper runs it, plus the /output read path (getSessionOutput).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-tfilter-'))
process.env.TRANSCRIPT_DIR = DIR
process.env.CC_REDACT_ENV_FILES = ''

const { installTranscriptFilter, redactEnvKeysFor, buildFilterSource } = await import('./transcript-redact-filter.js')
const { registerKnownSecret, clearRegisteredSecretsForTests } = await import('./secret-redaction.js')
const { getSessionOutput } = await import('./stream-parser.js')

const SECRET = 'sbp_echoed_by_worker_0123456789'
let filter: string

function runFilter(input: string, env: Record<string, string> = { SUPABASE_SERVICE_ROLE: SECRET, CC_REDACT_ENV_KEYS: 'SUPABASE_SERVICE_ROLE' }): string {
  const r = spawnSync(process.execPath, [filter], { input, env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf-8' })
  expect(r.status).toBe(0)
  return r.stdout
}

const line = (o: unknown) => JSON.stringify(o) + '\n'
const delta = (text: string, index = 0) => line({ type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text } } })

beforeAll(() => {
  filter = installTranscriptFilter(DIR)
})

afterAll(() => {
  clearRegisteredSecretsForTests()
  fs.rmSync(DIR, { recursive: true, force: true })
})

describe('write-time stream filter', () => {
  it('installs an executable, idempotent script', () => {
    expect(fs.statSync(filter).mode & 0o111).toBeTruthy()
    expect(fs.readFileSync(filter, 'utf-8')).toBe(buildFilterSource())
    expect(installTranscriptFilter(DIR)).toBe(filter)
  })

  it('a known secret echoed by a worker is stored as [REDACTED:NAME]', () => {
    const input = line({ type: 'assistant', message: { content: [{ type: 'text', text: `the key is ${SECRET}` }] } }) +
      line({ type: 'user', message: { content: [{ type: 'tool_result', content: `SUPABASE_SERVICE_ROLE=${SECRET}\n` }] } })
    const out = runFilter(input)
    expect(out).not.toContain(SECRET)
    const lines = out.trim().split('\n').map(l => JSON.parse(l))
    expect(lines[0].message.content[0].text).toBe('the key is [REDACTED:SUPABASE_SERVICE_ROLE]')
    expect(lines[1].message.content[0].content).toBe('SUPABASE_SERVICE_ROLE=[REDACTED:SUPABASE_SERVICE_ROLE]\n')
  })

  it('a value split across token deltas never lands in the file, and the text still reassembles', () => {
    const parts = ['Here: ', 'sbp_echo', 'ed_by_wor', 'ker_0123', '456789', ' done']
    const out = runFilter(parts.map(p => delta(p)).join('') + line({ type: 'result', result: 'ok' }))
    expect(out).not.toMatch(/sbp_echo|ed_by_wor|ker_0123/)
    const events = out.trim().split('\n').map(l => JSON.parse(l))
    const text = events.filter(e => e.type === 'stream_event').map(e => e.event.delta.text).join('')
    expect(text).toBe('Here: [REDACTED:SUPABASE_SERVICE_ROLE] done')
    expect(events[events.length - 1]).toEqual({ type: 'result', result: 'ok' })
  })

  it('deltas that cannot be a secret prefix pass through promptly and unchanged', () => {
    const out = runFilter(delta('hello ') + delta('world'))
    const texts = out.trim().split('\n').map(l => JSON.parse(l).event.delta.text)
    expect(texts.join('')).toBe('hello world')
  })

  it('high-confidence shapes are scrubbed even when the value was never configured', () => {
    const out = runFilter(line({ type: 'assistant', text: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 and postgres://u:pw12345678@h/db' }), { CC_REDACT_ENV_KEYS: '' })
    expect(JSON.parse(out).text).toBe('token [REDACTED:GITHUB_TOKEN] and postgres://u:[REDACTED:CONN_PASSWORD]@h/db')
  })

  it('JSON-escaped values (quotes/newlines) are matched too and output stays valid JSON', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----'
    const out = runFilter(line({ type: 'assistant', text: `k=${pem}` }), { MY_PRIVATE_KEY: pem, CC_REDACT_ENV_KEYS: 'MY_PRIVATE_KEY' })
    expect(JSON.parse(out).text).toBe('k=[REDACTED:MY_PRIVATE_KEY]')
  })

  it('non-JSON lines and a trailing partial line are preserved', () => {
    expect(runFilter(`plain ${SECRET} text\nno newline at end`)).toBe('plain [REDACTED:SUPABASE_SERVICE_ROLE] text\nno newline at end')
  })
})

describe('redactEnvKeysFor', () => {
  it('names only the credential-looking keys of the session env', () => {
    const keys = redactEnvKeysFor({ HOME: '/home/x', PATH: '/usr/bin', GH_TOKEN: 'ghs_abcdefghijklmnop', SUPABASE_ACCESS_TOKEN: 'sbp_1234567890abcdef', USER: 'ccuser', GOOGLE_WORKSPACE_CONNECTION: 'absent' })
    expect(keys).toEqual(['GH_TOKEN', 'SUPABASE_ACCESS_TOKEN'])
  })
})

describe('read-time redaction (/output thread view)', () => {
  it('older transcripts written before the filter are redacted when served', () => {
    registerKnownSecret('SUPABASE_SERVICE_ROLE', SECRET)
    const id = 'cc-715532-legacy'
    fs.writeFileSync(path.join(DIR, `${id}.jsonl`),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: `legacy leak ${SECRET}` }] } }) +
      line({ type: 'followup', text: `here is ${SECRET}`, timestamp: '2026-10-11T00:00:00Z' }))
    const msgs = getSessionOutput(id)
    expect(JSON.stringify(msgs)).not.toContain(SECRET)
    expect(msgs.some(m => m.text === 'legacy leak [REDACTED:SUPABASE_SERVICE_ROLE]')).toBe(true)
  })
})
