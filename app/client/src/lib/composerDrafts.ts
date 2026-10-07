/**
 * Composer draft persistence (obj 711501 — "Text Remain Feature").
 *
 * Text typed into a chat box must survive the user clicking away and coming
 * back. React state alone does not: the session drawer unmounts on close, and
 * the Mentor page swaps `composerValue` out when you switch threads. So every
 * draft is mirrored into localStorage under a per-conversation key and read
 * back when that conversation is opened again.
 *
 * This module is the pure half — it takes the Storage object as an argument so
 * it is unit-testable in a plain node environment (the client test setup has no
 * jsdom). `useComposerDraft` is the React half.
 */

export const DRAFT_PREFIX = 'cc.draft.'

/** Drafts older than this are swept on app load. */
export const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
/** Hard cap on retained drafts; the oldest beyond this are swept. */
export const MAX_DRAFTS = 50
/**
 * Refuse to persist anything larger than this. A pasted megabyte of log output
 * is not worth risking a QuotaExceededError that would take out the *other*
 * localStorage-backed preferences (board filters, drawer size).
 */
export const MAX_DRAFT_CHARS = 200_000

interface StoredDraft {
  text: string
  /** epoch ms of the last write — drives TTL sweeping. */
  at: number
}

/**
 * Build the storage key for one conversation. `scope` separates the surfaces
 * (a session objective #7 and a mentor thread #7 are different conversations).
 */
export function draftKey(scope: 'session' | 'mentor', id: string | number): string {
  return `${DRAFT_PREFIX}${scope}.${id}`
}

/** localStorage, or null when unavailable (SSR, disabled storage, private mode). */
export function draftStorage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage
  } catch {
    return null
  }
}

/** Read a draft back. Returns '' for missing/corrupt/expired entries. */
export function readDraft(storage: Storage | null, key: string, now = Date.now()): string {
  if (!storage) return ''
  try {
    const raw = storage.getItem(key)
    if (raw === null) return ''
    const parsed = JSON.parse(raw) as Partial<StoredDraft>
    if (typeof parsed?.text !== 'string') return ''
    if (typeof parsed.at === 'number' && now - parsed.at > DRAFT_TTL_MS) {
      storage.removeItem(key)
      return ''
    }
    return parsed.text
  } catch {
    return ''
  }
}

/**
 * Persist a draft. An empty (or whitespace-only) draft is a *deletion* — a sent
 * or cleared composer must not leave a ghost entry that resurrects later.
 */
export function writeDraft(storage: Storage | null, key: string, text: string, now = Date.now()): void {
  if (!storage) return
  try {
    if (text.trim().length === 0 || text.length > MAX_DRAFT_CHARS) {
      storage.removeItem(key)
      return
    }
    const payload: StoredDraft = { text, at: now }
    storage.setItem(key, JSON.stringify(payload))
  } catch {
    /* quota / disabled storage — a lost draft must never break the composer */
  }
}

/** Forget one draft (conversation deleted, or an explicit clear). */
export function dropDraft(storage: Storage | null, key: string): void {
  if (!storage) return
  try { storage.removeItem(key) } catch { /* ignore */ }
}

/** Every draft key currently in storage, oldest write first. */
function draftEntries(storage: Storage): Array<{ key: string; at: number }> {
  const out: Array<{ key: string; at: number }> = []
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)
    if (!key || !key.startsWith(DRAFT_PREFIX)) continue
    let at = 0
    try {
      const parsed = JSON.parse(storage.getItem(key) || '{}') as Partial<StoredDraft>
      at = typeof parsed?.at === 'number' ? parsed.at : 0
    } catch {
      at = 0 // unparseable ⇒ treat as ancient so the sweep reclaims it
    }
    out.push({ key, at })
  }
  return out.sort((a, b) => a.at - b.at)
}

/**
 * Sweep expired and surplus drafts. Called once per app load so abandoned
 * conversations cannot grow localStorage without bound. Returns how many keys
 * were removed (for tests).
 */
export function pruneDrafts(storage: Storage | null, now = Date.now()): number {
  if (!storage) return 0
  let removed = 0
  try {
    const entries = draftEntries(storage)
    const survivors: Array<{ key: string; at: number }> = []
    for (const entry of entries) {
      if (now - entry.at > DRAFT_TTL_MS) {
        storage.removeItem(entry.key)
        removed++
      } else {
        survivors.push(entry)
      }
    }
    // `survivors` is still oldest-first, so the surplus to drop is the head.
    const surplus = survivors.length - MAX_DRAFTS
    for (let i = 0; i < surplus; i++) {
      storage.removeItem(survivors[i].key)
      removed++
    }
  } catch {
    /* ignore */
  }
  return removed
}
