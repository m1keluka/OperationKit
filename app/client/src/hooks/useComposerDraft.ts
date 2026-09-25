/**
 * useComposerDraft — a chat composer value that survives navigating away
 * (obj 711501, "Text Remain Feature").
 *
 * Drop-in replacement for `useState('')` in a composer. The returned setter has
 * the same signature, so existing call sites (`setMessage('')` on send,
 * `setMessage(draft)` on send failure) keep working unchanged; the difference is
 * that the value is mirrored to localStorage under `key` and read back when the
 * component remounts or `key` changes.
 *
 * Passing `key: null` disables persistence (e.g. the Mentor page before a thread
 * is selected) and behaves exactly like plain `useState`.
 */
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { draftStorage, dropDraft, pruneDrafts, readDraft, writeDraft } from '../lib/composerDrafts'

/** Coalesce keystrokes into one write. */
const WRITE_DEBOUNCE_MS = 200

let pruned = false
function pruneOnce() {
  if (pruned) return
  pruned = true
  pruneDrafts(draftStorage())
}

export function useComposerDraft(
  key: string | null,
): [string, Dispatch<SetStateAction<string>>, () => void] {
  const [value, setValue] = useState(() => (key ? readDraft(draftStorage(), key) : ''))

  // Which key the current `value` belongs to. Until the load effect below has
  // run for a new key, `value` still holds the PREVIOUS conversation's text —
  // the persist effect must not write it under the new key.
  const loadedKey = useRef<string | null>(key)
  // Latest (key, value) pair, so unmount/pagehide can flush without re-subscribing.
  const latest = useRef<{ key: string | null; value: string }>({ key, value })
  useEffect(() => { latest.current = { key, value } })

  useEffect(pruneOnce, [])

  // Key changed → swap in that conversation's draft.
  useEffect(() => {
    if (loadedKey.current === key) return
    // Flush the outgoing conversation's draft before abandoning it.
    if (loadedKey.current) writeDraft(draftStorage(), loadedKey.current, value)
    loadedKey.current = key
    setValue(key ? readDraft(draftStorage(), key) : '')
    // `value` is deliberately not a dep: this runs on key change only, and reads
    // the outgoing value through the closure at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  // Persist (debounced) whenever the value settles.
  //
  // On the render where `key` changed, the load effect above has already moved
  // `loadedKey` forward while `value` is still the OUTGOING conversation's text.
  // That render's timer never fires: the load effect's setValue re-renders well
  // inside WRITE_DEBOUNCE_MS and the cleanup clears it. The one case where no
  // re-render happens is when the incoming draft is byte-identical to the
  // outgoing text — in which case the write is a no-op anyway.
  useEffect(() => {
    if (!key || loadedKey.current !== key) return
    const timer = setTimeout(() => writeDraft(draftStorage(), key, value), WRITE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [key, value])

  // A tab closed or backgrounded mid-keystroke must not lose the last 200ms.
  useEffect(() => {
    function flush() {
      const { key: k, value: v } = latest.current
      if (k) writeDraft(draftStorage(), k, v)
    }
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      flush() // unmount (drawer closed, route change) — flush synchronously
    }
  }, [])

  // Explicit discard: clears the box AND forgets the stored draft immediately,
  // without waiting for the debounce.
  const clear = useCallback(() => {
    if (key) dropDraft(draftStorage(), key)
    setValue('')
  }, [key])

  return [value, setValue, clear]
}
