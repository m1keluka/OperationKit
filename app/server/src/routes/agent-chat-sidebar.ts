import { Router, type Response } from 'express'
import type { AuthRequest } from '../middleware/auth.js'
import { findAgent, listAgents } from '../services/agent-chat/engine.js'
import {
  createSection,
  deleteSection,
  markRead,
  markUnread,
  reorderPins,
  reorderSections,
  sidebarState,
  SidebarRejected,
  updateBotPrefs,
  updateSection,
} from '../services/agent-chat/sidebar.js'

/**
 * The Bots sidebar (obj 900798) — mounted at /api/agent-chat/sidebar, behind
 * the agent-chat router's requireAuth.
 *
 *   GET    /                         sections + per-bot pin / section / hidden / unread / last-message preview
 *   PATCH  /bots/:slug               { pinned?, section_id?, hidden? }
 *   POST   /bots/:slug/read          opening a bot: everything so far is read
 *   POST   /bots/:slug/unread        "Mark as unread"
 *   PUT    /pins/order               { slugs: [...] } — the pinned rail's order
 *   POST   /sections                 { name }
 *   PUT    /sections/order           { ids: [...] }
 *   PATCH  /sections/:id             { name?, collapsed? }
 *   DELETE /sections/:id             its bots go back to "Other bots"
 *
 * All of it is the CALLER'S OWN arrangement: no route here reads or writes
 * another person's sidebar or changes a bot. An agent API key is refused, the
 * same as the conversation routes: this is a person's private view of their
 * chats (previews quote their messages).
 */
const router: Router = Router()

router.use((req: AuthRequest, res, next) => {
  if (req.authVia === 'agent_api_key') {
    res.status(403).json({ error: 'The bots sidebar is private to the person' })
    return
  }
  next()
})

function fail(res: Response, err: unknown): void {
  if (err instanceof SidebarRejected) {
    res.status(err.status).json({ error: err.message })
    return
  }
  console.error('[agent-chat] sidebar failed:', err instanceof Error ? err.message : err)
  res.status(500).json({ error: 'That did not work. Try again.' })
}

function state(req: AuthRequest) {
  return sidebarState(req.user!.id, listAgents().agents.map(a => a.slug))
}

/** A bot that is not on this install is a 404 — no row is written for a slug nobody can open. */
function botOr404(req: AuthRequest, res: Response): string | null {
  const a = findAgent(String(req.params.slug))
  if (!a) {
    res.status(404).json({ error: `No bot "${req.params.slug}" on this install` })
    return null
  }
  return a.slug
}

const idParam = (req: AuthRequest) => Number(req.params.id)

router.get('/', (req: AuthRequest, res) => {
  try {
    res.json(state(req))
  } catch (err) {
    fail(res, err)
  }
})

router.patch('/bots/:slug', (req: AuthRequest, res) => {
  const slug = botOr404(req, res)
  if (!slug) return
  const b = (req.body ?? {}) as Record<string, unknown>
  try {
    updateBotPrefs(req.user!.id, slug, { pinned: b.pinned, section_id: b.section_id, hidden: b.hidden })
    res.json(state(req))
  } catch (err) {
    fail(res, err)
  }
})

router.post('/bots/:slug/read', (req: AuthRequest, res) => {
  const slug = botOr404(req, res)
  if (!slug) return
  try {
    markRead(req.user!.id, slug)
    res.json(state(req))
  } catch (err) {
    fail(res, err)
  }
})

router.post('/bots/:slug/unread', (req: AuthRequest, res) => {
  const slug = botOr404(req, res)
  if (!slug) return
  try {
    markUnread(req.user!.id, slug)
    res.json(state(req))
  } catch (err) {
    fail(res, err)
  }
})

router.put('/pins/order', (req: AuthRequest, res) => {
  try {
    reorderPins(req.user!.id, (req.body ?? {}).slugs)
    res.json(state(req))
  } catch (err) {
    fail(res, err)
  }
})

router.post('/sections', (req: AuthRequest, res) => {
  try {
    const section = createSection(req.user!.id, (req.body ?? {}).name)
    res.status(201).json({ section, ...state(req) })
  } catch (err) {
    fail(res, err)
  }
})

// Declared before /sections/:id so "order" is never read as an id.
router.put('/sections/order', (req: AuthRequest, res) => {
  try {
    reorderSections(req.user!.id, (req.body ?? {}).ids)
    res.json(state(req))
  } catch (err) {
    fail(res, err)
  }
})

router.patch('/sections/:id', (req: AuthRequest, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>
  try {
    const section = updateSection(req.user!.id, idParam(req), { name: b.name, collapsed: b.collapsed })
    res.json({ section, ...state(req) })
  } catch (err) {
    fail(res, err)
  }
})

router.delete('/sections/:id', (req: AuthRequest, res) => {
  try {
    const { moved } = deleteSection(req.user!.id, idParam(req))
    res.json({ ok: true, moved, ...state(req) })
  } catch (err) {
    fail(res, err)
  }
})

export default router
