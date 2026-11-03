/**
 * Keep the PostHog person property `hot_owner` in sync with the "Hot owners (14d)"
 * cohort (obj 900091, continuing obj 719738). Moved off a Grok routine that did the
 * same thing every 30 min, and off the unmerged example-platform pg_cron attempt
 * (PR #1478) — this now runs as a Command Center schedule, gated weekdays 8:00-19:30
 * America/New_York, using POSTHOG_PERSONAL_API_KEY from Command Center's own secrets.
 *
 * Why the property exists: the #website Slack hot-visitor destination in example-website's
 * PostHog project (584614) fires on person property `hot_owner = true`, because PostHog
 * can't use a cohort as a live trigger. So the cohort is the source of truth and this job
 * mirrors it onto the property:
 *   - cohort member without hot_owner=true  -> $set hot_owner=true
 *   - person with hot_owner=true not in it  -> $set hot_owner=false
 *
 * Writes go through the capture API as `$set` events with `$geoip_disable: true`. Without
 * that, PostHog geolocates the request's IP (the server's) and overwrites the person's
 * location — an earlier pass reset everyone's city to Ashburn, VA. Nothing but `hot_owner`
 * is ever set. Nothing here touches Bird or any send path.
 *
 * Deterministic, no LLM per run — the scheduler (posthog-hot-owner-scheduler.ts) ticks
 * this directly; it never spawns a Claude session.
 */

export const HOT_OWNER_PROJECT_ID = '584614'
export const HOT_OWNER_COHORT_ID = 655347
export const HOT_OWNER_PROPERTY = 'hot_owner'

const API_HOST = process.env.WEBSITE_POSTHOG_API_HOST || 'https://us.posthog.com'
const CAPTURE_HOST = process.env.WEBSITE_POSTHOG_CAPTURE_HOST || 'https://us.i.posthog.com'

type EnvLike = Record<string, string | undefined>

/** Command Center's own configured secret. Only the NAME is ever reported, never the value. */
export const HOT_OWNER_KEY_ENV_VAR = 'POSTHOG_PERSONAL_API_KEY'

export function resolvePersonalApiKey(env: EnvLike = process.env): string | null {
  return env[HOT_OWNER_KEY_ENV_VAR] || null
}

export interface PostHogPerson {
  uuid: string
  distinctId: string
  hotOwner: unknown
}

export interface HotOwnerChange {
  uuid: string
  distinctId: string
  previous: unknown
  next: boolean
  reason: 'joined_cohort' | 'left_cohort'
}

export interface HotOwnerDiff {
  cohortMembers: number
  flaggedBefore: number
  changes: HotOwnerChange[]
}

/** PostHog stores the property as a boolean, but older writes may have left the string. */
export function isHotOwner(value: unknown): boolean {
  return value === true || value === 'true'
}

export function computeHotOwnerDiff(members: PostHogPerson[], propertyHolders: PostHogPerson[]): HotOwnerDiff {
  const memberIds = new Set(members.map((m) => m.uuid))
  const flagged = propertyHolders.filter((p) => isHotOwner(p.hotOwner))
  const changes: HotOwnerChange[] = []

  for (const m of members) {
    if (!isHotOwner(m.hotOwner)) {
      changes.push({ uuid: m.uuid, distinctId: m.distinctId, previous: m.hotOwner ?? null, next: true, reason: 'joined_cohort' })
    }
  }
  for (const p of flagged) {
    if (!memberIds.has(p.uuid)) {
      changes.push({ uuid: p.uuid, distinctId: p.distinctId, previous: p.hotOwner, next: false, reason: 'left_cohort' })
    }
  }
  return { cohortMembers: members.length, flaggedBefore: flagged.length, changes }
}

type FetchLike = typeof fetch

interface RawPerson {
  id?: string | number
  uuid?: string
  distinct_ids?: string[]
  properties?: Record<string, unknown>
}

function toPerson(raw: RawPerson): PostHogPerson | null {
  const uuid = raw.uuid ?? (typeof raw.id === 'string' ? raw.id : undefined)
  const distinctId = raw.distinct_ids?.[0]
  if (!uuid || !distinctId) return null
  return { uuid, distinctId, hotOwner: raw.properties?.[HOT_OWNER_PROPERTY] }
}

async function getJson(url: string, key: string, fetchImpl: FetchLike): Promise<unknown> {
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${key}` } })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`PostHog ${res.status} on ${new URL(url).pathname}: ${body.slice(0, 200)}`)
  }
  return res.json()
}

/** Follows PostHog's `next` links. Caps pages so a bad cursor can't loop forever. */
async function listPersons(firstUrl: string, key: string, fetchImpl: FetchLike): Promise<PostHogPerson[]> {
  const out: PostHogPerson[] = []
  let url: string | null = firstUrl
  for (let page = 0; url && page < 200; page++) {
    const body = (await getJson(url, key, fetchImpl)) as { results?: RawPerson[]; next?: string | null }
    for (const raw of body.results ?? []) {
      const p = toPerson(raw)
      if (p) out.push(p)
    }
    url = body.next ?? null
  }
  return out
}

export function fetchCohortMembers(key: string, fetchImpl: FetchLike = fetch): Promise<PostHogPerson[]> {
  return listPersons(
    `${API_HOST}/api/projects/${HOT_OWNER_PROJECT_ID}/cohorts/${HOT_OWNER_COHORT_ID}/persons/?limit=500`,
    key,
    fetchImpl,
  )
}

/** Everyone who has the property at all; the caller keeps the ones where it is true. */
export function fetchPropertyHolders(key: string, fetchImpl: FetchLike = fetch): Promise<PostHogPerson[]> {
  const filter = JSON.stringify([{ key: HOT_OWNER_PROPERTY, operator: 'is_set', type: 'person' }])
  return listPersons(
    `${API_HOST}/api/projects/${HOT_OWNER_PROJECT_ID}/persons/?limit=500&properties=${encodeURIComponent(filter)}`,
    key,
    fetchImpl,
  )
}

async function fetchProjectToken(key: string, fetchImpl: FetchLike): Promise<string> {
  const body = (await getJson(`${API_HOST}/api/projects/${HOT_OWNER_PROJECT_ID}/`, key, fetchImpl)) as { api_token?: string }
  if (!body.api_token) throw new Error('PostHog project has no api_token')
  return body.api_token
}

/** The exact event sent per change. Only hot_owner is set; GeoIP is disabled. */
export function buildSetEvent(change: HotOwnerChange) {
  return {
    event: '$set',
    distinct_id: change.distinctId,
    properties: {
      $set: { [HOT_OWNER_PROPERTY]: change.next },
      $geoip_disable: true,
      $lib: 'cc-hot-owner-sync',
    },
  }
}

export async function applyHotOwnerChanges(key: string, changes: HotOwnerChange[], fetchImpl: FetchLike = fetch): Promise<void> {
  if (changes.length === 0) return
  const apiToken = await fetchProjectToken(key, fetchImpl)
  for (let i = 0; i < changes.length; i += 100) {
    const batch = changes.slice(i, i + 100).map(buildSetEvent)
    const res = await fetchImpl(`${CAPTURE_HOST}/batch/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiToken, batch }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`PostHog capture ${res.status}: ${body.slice(0, 200)}`)
    }
  }
}

export interface HotOwnerSyncResult extends HotOwnerDiff {
  dryRun: boolean
  setTrue: number
  setFalse: number
}

/**
 * One pass. Reads the cohort and the current property holders, diffs, and (unless dryRun)
 * writes the changes. `onChanges` runs BEFORE the writes so the undo log never misses a
 * change that landed. Throws on any read/write failure, including a missing key; the
 * caller records the failure and counts it toward the consecutive-failure alert.
 */
export async function runHotOwnerSync(opts: {
  dryRun: boolean
  env?: EnvLike
  fetchImpl?: FetchLike
  onChanges?: (changes: HotOwnerChange[]) => Promise<void>
}): Promise<HotOwnerSyncResult> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const key = resolvePersonalApiKey(opts.env)
  if (!key) throw new Error(`${HOT_OWNER_KEY_ENV_VAR} is not configured in Command Center's secrets`)

  const [members, holders] = await Promise.all([
    fetchCohortMembers(key, fetchImpl),
    fetchPropertyHolders(key, fetchImpl),
  ])
  const diff = computeHotOwnerDiff(members, holders)

  // An empty cohort read while people are flagged is far likelier to be a PostHog hiccup
  // (cohort mid-recalculation) than everyone going cold at once. Don't clear the channel on it.
  if (diff.cohortMembers === 0 && diff.flaggedBefore > 0) {
    throw new Error(`Cohort ${HOT_OWNER_COHORT_ID} returned 0 members while ${diff.flaggedBefore} are flagged; refusing to clear`)
  }

  if (!opts.dryRun && diff.changes.length > 0) {
    await opts.onChanges?.(diff.changes)
    await applyHotOwnerChanges(key, diff.changes, fetchImpl)
  }

  return {
    ...diff,
    dryRun: opts.dryRun,
    setTrue: diff.changes.filter((c) => c.next).length,
    setFalse: diff.changes.filter((c) => !c.next).length,
  }
}

/** Consecutive failed runs, newest first, from status strings. */
export function failureStreak(statusesNewestFirst: string[]): number {
  let n = 0
  for (const s of statusesNewestFirst) {
    if (s !== 'error') break
    n++
  }
  return n
}

export const ALERT_AFTER_FAILURES = 3

/** Alert exactly once per outage: when the streak first reaches the threshold. */
export function shouldAlert(streak: number): boolean {
  return streak === ALERT_AFTER_FAILURES
}
