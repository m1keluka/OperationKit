// @vitest-environment jsdom
/* obj 900621 — browser QA round after #900543. Guards for the defects that a
   contrast audit cannot see: phone-width composer placeholders, sortable table
   headers losing their small caps, and the media-query hook in environments
   with no matchMedia. */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRef } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { Composer } from './session-viewer/Composer'
import { DataTable } from './ui/DataTable'
import { useMediaQuery } from '../hooks/useMediaQuery'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false

let root: Root | null = null
let host: HTMLDivElement | null = null
function render(node: React.ReactNode) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  flushSync(() => root!.render(node))
  return host
}
afterEach(() => {
  root?.unmount()
  host?.remove()
  root = null
  host = null
  vi.unstubAllGlobals()
  // jsdom has no matchMedia by default; drop any stub a test installed.
  delete (window as unknown as { matchMedia?: unknown }).matchMedia
})

function stubMatchMedia(matches: boolean) {
  ;(window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
    matches,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })
}

function composer() {
  return (
    <Composer
      attachedFiles={[]}
      removeFile={() => {}}
      sendError={null}
      setSendError={() => {}}
      fileInputRef={createRef<HTMLInputElement>()}
      handleUpload={() => {}}
      uploading={false}
      message=""
      setMessage={() => {}}
      messageRef={createRef<HTMLTextAreaElement>()}
      handleSendMessage={() => {}}
      inputDisabled={false}
      isActive
      handleStop={() => {}}
      interrupting={false}
      sending={false}
    />
  )
}

describe('card composer (obj 900621)', () => {
  it('uses a one-line placeholder at phone width', () => {
    stubMatchMedia(true)
    const el = render(composer())
    const ta = el.querySelector('textarea')!
    expect(ta.placeholder).toBe('Message…')
    // the long mono placeholder wrapped onto three lines at 390px
    expect(ta.className).toContain('font-sans')
    expect(ta.className).toContain('min-w-0')
  })

  it('keeps the descriptive placeholder on wider screens', () => {
    stubMatchMedia(false)
    const el = render(composer())
    expect(el.querySelector('textarea')!.placeholder).toBe('Send follow-up message…')
  })
})

describe('useMediaQuery without matchMedia', () => {
  it('reports false instead of throwing', () => {
    let seen: boolean | null = null
    function Probe() {
      seen = useMediaQuery('(max-width: 639px)')
      return null
    }
    render(<Probe />)
    expect(seen).toBe(false)
  })
})

describe('DataTable sortable headers', () => {
  it('keep the uppercase small caps the plain headers use', () => {
    const el = render(
      <DataTable
        columns={[
          { key: 'name', header: 'Routine', cell: (r: { id: number; n: number }) => r.id },
          { key: 'next', header: 'Next in', sortable: true, sortValue: r => r.n, cell: r => r.n },
        ]}
        rows={[{ id: 1, n: 2 }]}
        rowKey={r => r.id}
      />,
    )
    const sortBtn = [...el.querySelectorAll('th button')].find(b => b.textContent?.includes('Next in'))
    expect(sortBtn).toBeTruthy()
    // Tailwind preflight resets text-transform on <button>, so the class must be on the button itself.
    expect(sortBtn!.className).toContain('uppercase')
  })
})
