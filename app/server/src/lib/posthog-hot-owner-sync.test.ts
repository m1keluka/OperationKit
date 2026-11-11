import { describe, it, expect, vi } from 'vitest'
import {
  computeHotOwnerDiff, buildSetEvent, runHotOwnerSync, failureStreak, shouldAlert,
  resolvePersonalApiKey, type PostHogPerson,
} from './posthog-hot-owner-sync.js'

const p = (uuid: string, hotOwner?: unknown): PostHogPerson => ({ uuid, distinctId: `d-${uuid}`, hotOwner })

describe('computeHotOwnerDiff', () => {
  it('is a no-op when every member is flagged and nobody else is', () => {
    const members = [p('a', true), p('b', 'true')]
    const diff = computeHotOwnerDiff(members, [p('a', true), p('b', 'true')])
    expect(diff).toEqual({ cohortMembers: 2, flaggedBefore: 2, changes: [] })
  })

  it('flags members missing the property and unflags people who left', () => {
    const members = [p('a', true), p('b'), p('c', false)]
    const holders = [p('a', true), p('c', false), p('gone', true), p('cold', false)]
    const diff = computeHotOwnerDiff(members, holders)
    expect(diff.flaggedBefore).toBe(2)
    expect(diff.changes).toEqual([
      { uuid: 'b', distinctId: 'd-b', previous: null, next: true, reason: 'joined_cohort' },
      { uuid: 'c', distinctId: 'd-c', previous: false, next: true, reason: 'joined_cohort' },
      { uuid: 'gone', distinctId: 'd-gone', previous: true, next: false, reason: 'left_cohort' },
    ])
  })
})

describe('buildSetEvent', () => {
  it('sets only hot_owner and disables GeoIP', () => {
    const ev = buildSetEvent({ uuid: 'a', distinctId: 'd-a', previous: null, next: true, reason: 'joined_cohort' })
    expect(ev).toEqual({
      event: '$set',
      distinct_id: 'd-a',
      properties: { $set: { hot_owner: true }, $geoip_disable: true, $lib: 'cc-hot-owner-sync' },
    })
  })
})

describe('resolvePersonalApiKey', () => {
  it('reads POSTHOG_PERSONAL_API_KEY and nothing else', () => {
    expect(resolvePersonalApiKey({ POSTHOG_PERSONAL_API_KEY: 'p' })).toBe('p')
    expect(resolvePersonalApiKey({})).toBeNull()
  })
})

function fakePostHog(cohort: unknown[], holders: unknown[]) {
  const calls: { url: string; init?: RequestInit }[] = []
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    calls.push({ url: u, init })
    if (u.includes('/cohorts/655347/persons/')) return json({ results: cohort, next: null })
    if (u.includes('/persons/?')) return json({ results: holders, next: null })
    if (u.endsWith('/api/projects/584614/')) return json({ api_token: 'phc_test' })
    if (u.endsWith('/batch/')) return json({ status: 1 })
    return new Response('nope', { status: 404 })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const raw = (uuid: string, hot_owner?: unknown) => ({ uuid, distinct_ids: [`d-${uuid}`], properties: hot_owner === undefined ? {} : { hot_owner } })
const env = { POSTHOG_PERSONAL_API_KEY: 'phx_secret' }

describe('runHotOwnerSync', () => {
  it('dry run reads and diffs but sends nothing', async () => {
    const { fetchImpl, calls } = fakePostHog([raw('a', true), raw('b')], [raw('a', true), raw('x', true)])
    const onChanges = vi.fn()
    const r = await runHotOwnerSync({ dryRun: true, env, fetchImpl, onChanges })
    expect(r).toMatchObject({ cohortMembers: 2, flaggedBefore: 2, setTrue: 1, setFalse: 1 })
    expect(onChanges).not.toHaveBeenCalled()
    expect(calls.some((c) => c.url.endsWith('/batch/'))).toBe(false)
  })

  it('logs changes before sending them, and sends only hot_owner with GeoIP disabled', async () => {
    const { fetchImpl, calls } = fakePostHog([raw('a', true), raw('b')], [raw('a', true), raw('x', true)])
    const order: string[] = []
    const onChanges = vi.fn(async () => { order.push('log') })
    const wrapped = (async (u: string | URL | Request, i?: RequestInit) => {
      if (String(u).endsWith('/batch/')) order.push('send')
      return fetchImpl(u, i)
    }) as typeof fetch
    await runHotOwnerSync({ dryRun: false, env, fetchImpl: wrapped, onChanges })
    expect(order).toEqual(['log', 'send'])
    const batch = JSON.parse(String(calls.find((c) => c.url.endsWith('/batch/'))!.init!.body))
    expect(batch.api_key).toBe('phc_test')
    expect(batch.batch.map((e: { distinct_id: string; properties: { $set: unknown } }) => [e.distinct_id, e.properties.$set]))
      .toEqual([['d-b', { hot_owner: true }], ['d-x', { hot_owner: false }]])
    expect(batch.batch.every((e: { properties: { $geoip_disable: boolean } }) => e.properties.$geoip_disable === true)).toBe(true)
  })

  it('does not touch PostHog writes when nothing changed', async () => {
    const { fetchImpl, calls } = fakePostHog([raw('a', true)], [raw('a', true)])
    const r = await runHotOwnerSync({ dryRun: false, env, fetchImpl })
    expect(r.changes).toHaveLength(0)
    expect(calls.map((c) => c.url).some((u) => u.endsWith('/batch/') || u.endsWith('/584614/'))).toBe(false)
  })

  it('refuses to clear everyone when the cohort reads back empty', async () => {
    const { fetchImpl } = fakePostHog([], [raw('a', true)])
    await expect(runHotOwnerSync({ dryRun: false, env, fetchImpl })).rejects.toThrow(/refusing to clear/)
  })

  it('never puts the key in an error message', async () => {
    const fetchImpl = (async () => new Response('forbidden', { status: 403 })) as unknown as typeof fetch
    const err = await runHotOwnerSync({ dryRun: true, env, fetchImpl }).catch((e: Error) => e)
    expect(String(err)).toMatch(/PostHog 403/)
    expect(String(err)).not.toContain('phx_secret')
  })

  it('fails clearly when no key is configured', async () => {
    await expect(runHotOwnerSync({ dryRun: true, env: {} })).rejects.toThrow(/POSTHOG_PERSONAL_API_KEY is not configured/)
  })
})

describe('failure alerting', () => {
  it('counts the leading run of errors', () => {
    expect(failureStreak(['error', 'error', 'ok', 'error'])).toBe(2)
    expect(failureStreak(['ok', 'error'])).toBe(0)
  })
  it('alerts only when the streak first hits 3', () => {
    expect([1, 2, 3, 4, 5].map(shouldAlert)).toEqual([false, false, true, false, false])
  })
})
