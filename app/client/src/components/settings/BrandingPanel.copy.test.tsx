import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { BrandingPanel, brandingAgentPrompt } from './BrandingPanel'
import { DEFAULT_BRANDING } from '../../hooks/useBranding'
import { COPY_FEEDBACK_MS } from '../ui/CopyButton'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, username: 'operator', role: 'admin', workspaces: [] } }),
}))

// obj 900673: the "Set this up with your coding agent" Copy button used to
// write to the clipboard silently — no Copied feedback at all.
describe('BrandingPanel agent-prompt Copy button', () => {
  let container: HTMLElement
  let root: Root
  const writeText = vi.fn()

  beforeEach(() => {
    vi.useFakeTimers()
    writeText.mockReset().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => DEFAULT_BRANDING }))
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('shows Copied after click, restores to Copy, and copies the prompt', async () => {
    await act(async () => { root.render(<BrandingPanel />) })
    const copyBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Copy')
    expect(copyBtn).toBeTruthy()

    await act(async () => { copyBtn!.click() })
    expect(writeText).toHaveBeenCalledWith(brandingAgentPrompt(''))
    expect(copyBtn!.textContent).toContain('Copied')

    act(() => { vi.advanceTimersByTime(COPY_FEEDBACK_MS) })
    expect(copyBtn!.textContent).toBe('Copy')
  })
})
