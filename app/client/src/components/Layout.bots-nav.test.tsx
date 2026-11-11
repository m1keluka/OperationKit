import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'

/* obj 900327 — the nav entry for the bot chat page.

   The rename is only coherent if the chrome agrees with the page, so this
   asserts the pair that must stay in lockstep: the LABEL is "Bots" and the
   HREF is still "/chat". The URL is deliberately NOT renamed — it is in
   people's bookmarks and in in-product deeplinks — so a future "tidy-up" that
   renames the route has to fail a test rather than break a bookmark. */

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, username: 'operator', role: 'admin', workspaces: [] }, logout: () => {} }),
}))
vi.mock('../context/nav', () => ({ useNavigate: () => () => {} }))
vi.mock('../preview/BoardShell', () => ({ useBoardTheme: () => ({ theme: 'dark', toggleTheme: () => {} }) }))
vi.mock('../hooks/useWorkspaces', () => ({
  useWorkspaces: () => ({ slugs: [], labelOf: (s: string) => s, shortOf: (s: string) => s }),
}))
vi.mock('./CommandPalette', () => ({ CommandPalette: () => null }))
vi.mock('./AlertBell', () => ({ AlertBell: () => null }))
// The page is present in this build, so the gated nav item renders.
vi.mock('../lib/optional-pages', () => ({ HAS_CHAT_PAGE: true }))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false

let root: Root
let host: HTMLDivElement

async function settle(n = 6) {
  for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0))
}

beforeEach(async () => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const { Layout } = await import('./Layout')
  root.render(
    <Layout selectedWorkspaces={[]} onWorkspacesChange={() => {}}>
      <div />
    </Layout>,
  )
  await settle()
})

afterEach(() => {
  root.unmount()
  host.remove()
})

describe('nav entry for the bots page (obj 900327)', () => {
  it('labels the /chat entry "Bots"', () => {
    const links = [...host.querySelectorAll('a[href="/chat"]')]
    expect(links.length).toBeGreaterThan(0)
    for (const a of links) expect((a.textContent ?? '').trim()).toContain('Bots')
  })

  it('does not label any nav entry "Chat" any more', () => {
    const labels = [...host.querySelectorAll('a')].map(a => (a.textContent ?? '').trim())
    expect(labels).not.toContain('Chat')
  })

  it('keeps the URL at /chat — the label was renamed, the bookmark was not', () => {
    expect(host.querySelector('a[href="/chat"]')).not.toBeNull()
    expect(host.querySelector('a[href="/bots"]')).toBeNull()
  })
})
