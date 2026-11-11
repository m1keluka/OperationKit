import { describe, it, expect } from 'vitest'
import { withRetry } from './state-poller.js'

// Objective 1234 follow-up: postHarnessStatus posts the gating `harness/test-agent`
// status exactly once when the reviewer verdict resolves; it is never re-driven.
// A single transient `gh`/network error therefore stranded the PR with no check
// forever (observed live on obj 1303/PR #98 even after auth was fixed — the same
// call succeeded on immediate retry). withRetry wraps the get-sha + post sequence
// in a bounded exponential backoff so transient failures self-heal while a hard
// failure still surfaces (it rejects after the final attempt).

// Injected synchronous sleep so tests incur no real delay; records the backoff schedule.
const makeSleep = () => {
  const delays: number[] = []
  return { delays, sleep: async (ms: number) => { delays.push(ms) } }
}

describe('withRetry (harness status post resilience)', () => {
  it('returns the value on first success without sleeping', async () => {
    const { delays, sleep } = makeSleep()
    let calls = 0
    const out = await withRetry(async () => { calls++; return 'ok' }, { attempts: 3, baseDelayMs: 1000, sleep })
    expect(out).toBe('ok')
    expect(calls).toBe(1)
    expect(delays).toEqual([]) // no retry ⇒ no backoff
  })

  it('recovers from transient failures: fails twice then succeeds', async () => {
    const { delays, sleep } = makeSleep()
    let calls = 0
    const out = await withRetry(
      async () => {
        calls++
        if (calls < 3) throw new Error(`transient ${calls}`)
        return 'recovered'
      },
      { attempts: 3, baseDelayMs: 1000, sleep },
    )
    expect(out).toBe('recovered')
    expect(calls).toBe(3)
    // exponential backoff between attempts: baseDelayMs * 2^(n-1) for the 2 retries.
    expect(delays).toEqual([1000, 2000])
  })

  it('throws the last error after exhausting all attempts', async () => {
    const { delays, sleep } = makeSleep()
    let calls = 0
    await expect(
      withRetry(async () => { calls++; throw new Error(`fail ${calls}`) }, { attempts: 3, baseDelayMs: 500, sleep }),
    ).rejects.toThrow('fail 3') // the LAST error is propagated
    expect(calls).toBe(3)
    // sleeps only BETWEEN attempts (not after the final one).
    expect(delays).toEqual([500, 1000])
  })

  it('does not sleep after the final attempt and respects attempts=1 (no retry)', async () => {
    const { delays, sleep } = makeSleep()
    let calls = 0
    await expect(
      withRetry(async () => { calls++; throw new Error('boom') }, { attempts: 1, baseDelayMs: 1000, sleep }),
    ).rejects.toThrow('boom')
    expect(calls).toBe(1)
    expect(delays).toEqual([])
  })
})
