import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { extractDeterministic } from './session-intel-parse.js'
import { isAuthFailureMessage } from './account-router.js'

// Regression guard for obj 716791 (distill 2026-10-17): the CLI's dead-refresh-
// token exit ("Failed to authenticate: OAuth session expired and could not be
// refreshed") arrives as an `is_error:true` TERMINAL `result` event with
// `api_error_status: null` — never a `type:'error'` event. extractDeterministic
// previously only pushed `type:'error'` events into `errors`, so this text was
// dropped on the floor and the poller's noop_respawn guard had no way to tell
// an auth-failure no-op apart from a generic one, and kept re-picking the same
// dead account. These pin that the text now reaches `intel.errors` and that
// isAuthFailureMessage (the poller's actual check) matches it there.

let tmpDir: string
let n = 0

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'si-oauth-'))
})
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeJsonl(events: Record<string, unknown>[]): string {
  const p = path.join(tmpDir, `session-${n++}.jsonl`)
  fs.writeFileSync(p, events.map(e => JSON.stringify(e)).join('\n'))
  return p
}

describe('extractDeterministic — OAuth-refresh-expired no-op capture (obj 716791)', () => {
  it('captures the OAuth-refresh-expired text into errors (the real cc-716607 shape)', async () => {
    const p = writeJsonl([
      { type: 'system', subtype: 'init', timestamp: '2026-10-16T11:25:22Z' },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Failed to authenticate: OAuth session expired and could not be refreshed' }] },
      },
      {
        type: 'result', subtype: 'success', is_error: true, api_error_status: null,
        result: 'Failed to authenticate: OAuth session expired and could not be refreshed',
        duration_ms: 88, num_turns: 1, total_cost_usd: 0,
      },
    ])
    const intel = await extractDeterministic(p)
    expect(intel.toolCalls).toBe(0)
    expect(intel.errors).toHaveLength(1)
    expect(intel.errors[0]).toContain('OAuth session expired')
    expect(intel.errors.some(e => isAuthFailureMessage(e))).toBe(true)
  })

  it('does not misclassify a successful terminal result as an error', async () => {
    const p = writeJsonl([
      { type: 'system', subtype: 'init', timestamp: '2026-10-16T11:25:22Z' },
      {
        type: 'result', subtype: 'success', is_error: false,
        result: 'Done — shipped the fix.',
        duration_ms: 5000, num_turns: 1,
      },
    ])
    const intel = await extractDeterministic(p)
    expect(intel.errors).toHaveLength(0)
  })
})
