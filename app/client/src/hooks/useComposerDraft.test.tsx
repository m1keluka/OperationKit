// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useComposerDraft } from './useComposerDraft'
import { draftKey } from '../lib/composerDrafts'

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true

/**
 * Drives the hook from a real (jsdom) mount so the persist/flush effects
 * actually run — that is the half of "text remains" that plain unit tests of
 * the storage module cannot cover.
 */
let container: HTMLDivElement
let root: Root
let api: { value: string; set: (v: string) => void; clear: () => void }

function Probe({ id }: { id: number | null }) {
  const [value, setValue, clear] = useComposerDraft(id === null ? null : draftKey('session', id))
  api = { value, set: setValue, clear }
  return <span>{value}</span>
}

function Host({ initialId }: { initialId: number | null }) {
  const [id, setId] = useState<number | null>(initialId)
  switchTo = setId
  return <Probe id={id} />
}

let switchTo: (id: number | null) => void

function mount(initialId: number | null = 1) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => { root.render(<Host initialId={initialId} />) })
}

function unmount() {
  act(() => { root.unmount() })
  container.remove()
}

/** Debounced writes settle on a macrotask; give them one. */
async function settle() {
  await act(async () => { await new Promise(r => setTimeout(r, 300)) })
}

beforeEach(() => { localStorage.clear() })
afterEach(() => { localStorage.clear() })

describe('useComposerDraft', () => {
  it('persists typed text and restores it after a remount', async () => {
    mount(1)
    act(() => { api.set('a half-typed follow-up') })
    await settle()
    unmount()

    mount(1)
    expect(api.value).toBe('a half-typed follow-up')
    unmount()
  })

  it('flushes the last keystrokes on unmount even inside the debounce window', async () => {
    mount(1)
    act(() => { api.set('typed then immediately closed') })
    unmount() // no settle() — the debounce timer has not fired yet

    mount(1)
    expect(api.value).toBe('typed then immediately closed')
    unmount()
  })

  it('keeps a separate draft per conversation and swaps on key change', async () => {
    mount(1)
    act(() => { api.set('draft for one') })
    await settle()
    act(() => { switchTo(2) })
    expect(api.value).toBe('')

    act(() => { api.set('draft for two') })
    await settle()
    act(() => { switchTo(1) })
    expect(api.value).toBe('draft for one')

    act(() => { switchTo(2) })
    expect(api.value).toBe('draft for two')
    unmount()
  })

  it('does not leak the outgoing draft into the incoming conversation', async () => {
    mount(1)
    act(() => { api.set('only belongs to one') })
    await settle()
    act(() => { switchTo(2) })
    await settle()
    expect(localStorage.getItem(draftKey('session', 2))).toBeNull()
    unmount()
  })

  it('drops the stored draft once the composer is emptied (successful send)', async () => {
    mount(1)
    act(() => { api.set('about to be sent') })
    await settle()
    act(() => { api.set('') }) // what handleSendMessage does on success
    await settle()
    expect(localStorage.getItem(draftKey('session', 1))).toBeNull()

    unmount()
    mount(1)
    expect(api.value).toBe('')
    unmount()
  })

  it('re-persists a restored draft when a send fails', async () => {
    mount(1)
    act(() => { api.set('will fail to send') })
    await settle()
    act(() => { api.set('') })          // optimistic clear
    act(() => { api.set('will fail to send') }) // restore on error
    await settle()
    unmount()

    mount(1)
    expect(api.value).toBe('will fail to send')
    unmount()
  })

  it('clear() discards the draft immediately', async () => {
    mount(1)
    act(() => { api.set('discard me') })
    await settle()
    act(() => { api.clear() })
    expect(localStorage.getItem(draftKey('session', 1))).toBeNull()
    expect(api.value).toBe('')
    unmount()
  })

  it('behaves like plain useState when there is no conversation key', async () => {
    mount(null)
    act(() => { api.set('nowhere to save this') })
    await settle()
    expect(localStorage.length).toBe(0)
    unmount()
  })
})
