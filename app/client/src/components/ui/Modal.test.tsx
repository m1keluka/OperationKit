// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { Modal } from './Modal'

// We render outside @testing-library and drive React ourselves; flushSync
// commits the render AND flushes passive effects (useEffect) before returning,
// so the focus/scroll-lock effect has run by the time we assert. Tell React we
// are deliberately not in an act() environment to silence the act warning.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false

/* obj 700071 regression — Modal focus stability.

   The board re-renders every ~3s for any live session (the state-poller emits
   objective_updated broadcasts), and its consumers pass an INLINE onClose
   closure, so onClose's identity changes on every one of those re-renders. The
   old focus/scroll-lock effect depended on [open, onClose], so an
   identity-only change tore the effect down — the cleanup ran
   restoreRef.current?.focus?.() and yanked focus to the trigger behind the
   modal, breaking the field/dropdown the user was in. The fix uses a latest-ref
   for onClose and depends on [open] only, so an onClose-identity-only re-render
   is a no-op for the effect and focus stays put.

   This test re-renders the Modal with a DIFFERENT onClose reference while open
   is unchanged and asserts the effect did NOT tear down/re-run (focus-restore
   never fires; focus stays inside the panel). It FAILS against the old
   [open, onClose] deps and PASSES with [open]. */

describe('Modal — focus is stable across onClose identity changes', () => {
  let container: HTMLDivElement | null = null
  let root: Root | null = null
  let trigger: HTMLButtonElement | null = null

  afterEach(() => {
    if (root) flushSync(() => root!.unmount())
    container?.remove()
    trigger?.remove()
    root = null
    container = null
    trigger = null
    vi.useRealTimers()
  })

  it('does not re-run the focus effect when only onClose identity changes', () => {
    vi.useFakeTimers()

    // A trigger button standing in for the "New" button behind the modal — this
    // is what the old cleanup would restore focus to.
    trigger = document.createElement('button')
    trigger.textContent = 'New'
    document.body.appendChild(trigger)
    trigger.focus()
    expect(document.activeElement).toBe(trigger)

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    const onClose1 = () => {}
    flushSync(() => {
      root!.render(
        <Modal open onClose={onClose1}>
          <input data-autofocus placeholder="field" />
          <button>Save</button>
        </Modal>,
      )
    })
    // Flush the initial-focus setTimeout(…, 0) so focus lands inside the panel.
    vi.runAllTimers()

    const panel = document.querySelector<HTMLElement>('[role="dialog"] [tabindex="-1"]')
    expect(panel).toBeTruthy()
    expect(panel!.contains(document.activeElement)).toBe(true)

    // Now spy on the trigger's focus: the old cleanup would call it on teardown.
    const restoreSpy = vi.spyOn(trigger, 'focus')

    // Re-render with a DIFFERENT onClose reference, same open=true. Do NOT flush
    // timers afterward: with the old deps the cleanup fires synchronously during
    // teardown (focus → trigger), so the difference is observable immediately,
    // before any re-scheduled initial-focus timer could mask it.
    const onClose2 = () => {}
    flushSync(() => {
      root!.render(
        <Modal open onClose={onClose2}>
          <input data-autofocus placeholder="field" />
          <button>Save</button>
        </Modal>,
      )
    })

    // With [open] deps: effect untouched → focus-restore never ran, focus stays
    // inside the panel. With the old [open, onClose] deps: teardown restored
    // focus to the trigger (both assertions fail).
    expect(restoreSpy).not.toHaveBeenCalled()
    expect(panel!.contains(document.activeElement)).toBe(true)
  })
})
