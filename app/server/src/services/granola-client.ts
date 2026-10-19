// Granola public API client — https://public-api.granola.ai/v1
// Requires Business/Enterprise plan. Auth via GRANOLA_API_KEY (grn_* prefix).

const BASE_URL = 'https://public-api.granola.ai/v1'

export interface GranolaAttendee {
  name: string
  email: string
}

/**
 * One speaker-attributed line of the transcript. Kept alongside the flattened
 * `transcript_text` because voice-profile extraction needs to know WHICH lines
 * the owner said — flattening first and diarizing later is unrecoverable.
 */
export interface GranolaSegment {
  /** 'me' when Granola attributes the line to the note owner, else the label. */
  speaker: string
  /** True when this line is the note owner speaking (the voice-profile source). */
  is_owner: boolean
  text: string
}

export interface GranolaTranscript {
  id: string
  title: string
  created_at: string
  updated_at: string
  attendees: GranolaAttendee[]
  transcript_text: string
  /** Speaker-attributed lines, in order. Empty when Granola returned no transcript. */
  segments: GranolaSegment[]
  notes_text: string
}

// Raw shapes from the Granola API
interface RawTranscriptSegment {
  speaker?: { source?: string; diarization_label?: string }
  text: string
}

interface RawNote {
  id: string
  title: string
  owner?: { name?: string; email?: string }
  attendees?: Array<{ name?: string; email?: string }>
  summary?: string
  transcript?: RawTranscriptSegment[]
  created_at?: string
  updated_at?: string
}

interface NotesListResponse {
  notes: RawNote[]
  hasMore: boolean
  cursor?: string
}

/**
 * Resolve the key for a call. Callers that serve a specific content owner MUST
 * pass that owner's key explicitly — the process env is a single global and
 * falling back to it across owners would pull another person's meetings.
 */
function getApiKey(explicit?: string): string {
  const key = explicit || process.env.GRANOLA_API_KEY
  if (!key) {
    throw new Error('GRANOLA_API_KEY is not set — connect Granola on the Content page, or add it to Doppler')
  }
  return key
}

async function granolaGet<T>(path: string, apiKey?: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${getApiKey(apiKey)}`,
      'Content-Type': 'application/json',
    },
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Granola API error ${res.status} for ${path}: ${body}`)
  }

  return res.json() as Promise<T>
}

// Granola labels the note owner's own audio track 'me' (`speaker.source`); other
// participants carry a diarization label ('Speaker 1', a name, ...). Anything we
// cannot attribute is treated as NOT the owner, so a voice profile is never
// polluted with someone else's phrasing.
function toSegments(raw: RawTranscriptSegment[] | undefined): GranolaSegment[] {
  if (!raw || raw.length === 0) return []
  return raw
    .filter(s => typeof s.text === 'string' && s.text.trim())
    .map(s => {
      const source = (s.speaker?.source || '').toLowerCase()
      const label = s.speaker?.diarization_label || s.speaker?.source || ''
      return { speaker: label || 'unknown', is_owner: source === 'me', text: s.text.trim() }
    })
}

function joinTranscript(segments: GranolaSegment[]): string {
  if (segments.length === 0) return ''
  return segments.map(s => s.text).join(' ').trim()
}

function normalizeNote(raw: RawNote): GranolaTranscript {
  const attendees: GranolaAttendee[] = []

  // Include owner as first attendee if present
  if (raw.owner?.email) {
    attendees.push({ name: raw.owner.name ?? '', email: raw.owner.email })
  }

  // Merge additional attendees, deduplicating by email
  const seen = new Set(attendees.map(a => a.email))
  for (const a of raw.attendees ?? []) {
    if (a.email && !seen.has(a.email)) {
      seen.add(a.email)
      attendees.push({ name: a.name ?? '', email: a.email })
    }
  }

  const now = new Date().toISOString()
  const segments = toSegments(raw.transcript)
  return {
    id: raw.id,
    title: raw.title ?? '',
    created_at: raw.created_at ?? now,
    updated_at: raw.updated_at ?? raw.created_at ?? now,
    attendees,
    transcript_text: joinTranscript(segments),
    segments,
    notes_text: raw.summary ?? '',
  }
}

/**
 * Returns all meetings created or updated after the given date.
 * Handles cursor-based pagination automatically.
 */
export async function listRecentMeetings(since: Date, apiKey?: string): Promise<GranolaTranscript[]> {
  const results: GranolaTranscript[] = []
  const createdAfter = since.toISOString()
  let cursor: string | undefined

  do {
    const qs = new URLSearchParams({ created_after: createdAfter })
    if (cursor) qs.set('cursor', cursor)

    const page = await granolaGet<NotesListResponse>(`/notes?${qs}`, apiKey)

    for (const note of page.notes ?? []) {
      results.push(normalizeNote(note))
    }

    cursor = page.hasMore ? page.cursor : undefined
  } while (cursor)

  return results
}

/**
 * Fetches a single meeting with its full transcript.
 */
export async function getMeeting(id: string, apiKey?: string): Promise<GranolaTranscript> {
  const raw = await granolaGet<RawNote>(`/notes/${id}?include=transcript`, apiKey)
  return normalizeNote(raw)
}

/**
 * Cheapest authenticated call that proves a key works. Returns the owning
 * account's identity so the UI can confirm WHICH Granola account got connected
 * (a pasted key is easy to get wrong, and a silently-wrong account would quietly
 * ingest someone else's meetings).
 */
export async function verifyApiKey(
  apiKey: string
): Promise<{ ok: true; account: string } | { ok: false; error: string }> {
  try {
    const page = await granolaGet<NotesListResponse>('/notes?limit=1', apiKey)
    const owner = page.notes?.[0]?.owner
    return { ok: true, account: owner?.email || owner?.name || '' }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'verification failed' }
  }
}
