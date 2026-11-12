import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { CopyButton, COPY_FEEDBACK_MS } from './CopyButton'

// React 19 act() environment flag for jsdom.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('CopyButton', () => {
  let container: HTMLElement
  let root: Root
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')

  function setClipboard(value: unknown) {
    Object.defineProperty(navigator, 'clipboard', { value, configurable: true })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
    if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard)
    else delete (navigator as unknown as { clipboard?: unknown }).clipboard
  })

  const button = () => container.querySelector('button') as HTMLButtonElement

  async function click() {
    await act(async () => { button().click() })
  }

  it('copies the value, shows Copied, then restores the label', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    setClipboard({ writeText })
    act(() => root.render(<CopyButton value="hello world" />))
    expect(button().textContent).toBe('Copy')

    await click()
    expect(writeText).toHaveBeenCalledWith('hello world')
    expect(button().textContent).toContain('Copied')
    expect(button().dataset.copyState).toBe('copied')
    expect(button().querySelector('[aria-live="polite"]')?.textContent).toBe('Copied')

    act(() => { vi.advanceTimersByTime(COPY_FEEDBACK_MS) })
    expect(button().textContent).toBe('Copy')
    expect(button().dataset.copyState).toBe('idle')
  })

  it('a second click restarts the feedback window instead of cutting it short', async () => {
    setClipboard({ writeText: vi.fn().mockResolvedValue(undefined) })
    act(() => root.render(<CopyButton value="x" />))
    await click()
    act(() => { vi.advanceTimersByTime(COPY_FEEDBACK_MS - 500) })
    await click()
    act(() => { vi.advanceTimersByTime(COPY_FEEDBACK_MS - 500) })
    expect(button().textContent).toContain('Copied')
    act(() => { vi.advanceTimersByTime(500) })
    expect(button().textContent).toBe('Copy')
  })

  it('falls back to execCommand when the Clipboard API is unavailable', async () => {
    setClipboard(undefined)
    const exec = vi.fn().mockReturnValue(true)
    ;(document as unknown as { execCommand: unknown }).execCommand = exec
    act(() => root.render(<CopyButton value="fallback" />))
    await click()
    expect(exec).toHaveBeenCalledWith('copy')
    expect(button().textContent).toContain('Copied')
  })

  it('shows Copy failed (then restores) when nothing could be copied', async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) })
    ;(document as unknown as { execCommand: unknown }).execCommand = vi.fn().mockReturnValue(false)
    act(() => root.render(<CopyButton value="x" />))
    await click()
    expect(button().textContent).toBe('Copy failed')
    act(() => { vi.advanceTimersByTime(COPY_FEEDBACK_MS) })
    expect(button().textContent).toBe('Copy')
  })
})
