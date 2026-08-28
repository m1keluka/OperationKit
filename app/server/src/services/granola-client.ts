// Granola public API client — https://public-api.granola.ai/v1
// Requires Business/Enterprise plan. Auth via GRANOLA_API_KEY (grn_* prefix).

const BASE_URL = 'https://public-api.granola.ai/v1'

export interface GranolaAttendee {
  name: string
  email: string
}

export interface GranolaTranscript {
  id: string
  title: string
  created_at: string
  updated_at: string
  attendees: GranolaAttendee[]
  transcript_text: string
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

function getApiKey(): string {
  const key = process.env.GRANOLA_API_KEY
  if (!key) {
    throw new Error('GRANOLA_API_KEY is not set — add it to Doppler under the command-center project')
  }
  return key
}

async function granolaGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      'Content-Type': 'application/json',
    },
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Granola API error ${res.status} for ${path}: ${body}`)
  }

  return res.json() as Promise<T>
}

function joinTranscript(segments: RawTranscriptSegment[] | undefined): string {
  if (!segments || segments.length === 0) return ''
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
  return {
    id: raw.id,
    title: raw.title ?? '',
    created_at: raw.created_at ?? now,
    updated_at: raw.updated_at ?? raw.created_at ?? now,
    attendees,
    transcript_text: joinTranscript(raw.transcript),
    notes_text: raw.summary ?? '',
  }
}

/**
 * Returns all meetings created or updated after the given date.
 * Handles cursor-based pagination automatically.
 */
export async function listRecentMeetings(since: Date): Promise<GranolaTranscript[]> {
  const results: GranolaTranscript[] = []
  const createdAfter = since.toISOString()
  let cursor: string | undefined

  do {
    const qs = new URLSearchParams({ created_after: createdAfter })
    if (cursor) qs.set('cursor', cursor)

    const page = await granolaGet<NotesListResponse>(`/notes?${qs}`)

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
export async function getMeeting(id: string): Promise<GranolaTranscript> {
  const raw = await granolaGet<RawNote>(`/notes/${id}?include=transcript`)
  return normalizeNote(raw)
}
