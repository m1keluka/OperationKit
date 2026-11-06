/**
 * Settings → You → Agent keys → Webhook (obj 719278).
 *
 * Mounted at /api/auth/agent-keys alongside the key routes. Human session (or the
 * legacy full key) only — an agent key can never point its own wake-up hook
 * somewhere else, and the agent-key guard already refuses /api/auth/* for it.
 * The sender key is write-only: no response here ever carries it.
 */
import { Router, type Response } from 'express'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import {
  deleteWebhookConfig,
  getWebhookConfig,
  listDeliveries,
  saveWebhookConfig,
  sendTestEvent,
  type Result,
} from '../services/agent-webhooks.js'

const router = Router()

function guard(req: AuthRequest, res: Response): number | null {
  if (req.agentKey) {
    res.status(403).json({ error: 'Agent keys cannot manage API keys', missing_scope: null })
    return null
  }
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) {
    res.status(404).json({ error: 'Agent key not found' })
    return null
  }
  return id
}

function send<T>(res: Response, r: Result<T>, wrap: (v: T) => unknown): void {
  if (!r.ok) {
    res.status(r.status).json({ error: r.error })
    return
  }
  res.json(wrap(r.value))
}

router.get('/:id/webhook', requireAuth, (req: AuthRequest, res) => {
  const id = guard(req, res)
  if (id == null) return
  send(res, getWebhookConfig(req.user!.id, id), webhook => ({ webhook }))
})

router.put('/:id/webhook', requireAuth, (req: AuthRequest, res) => {
  const id = guard(req, res)
  if (id == null) return
  send(res, saveWebhookConfig(req.user!.id, id, req.body ?? {}), webhook => ({ webhook }))
})

router.delete('/:id/webhook', requireAuth, (req: AuthRequest, res) => {
  const id = guard(req, res)
  if (id == null) return
  send(res, deleteWebhookConfig(req.user!.id, id), () => ({ ok: true }))
})

router.get('/:id/webhook/deliveries', requireAuth, (req: AuthRequest, res) => {
  const id = guard(req, res)
  if (id == null) return
  const limit = Number(req.query.limit ?? 50)
  send(res, listDeliveries(req.user!.id, id, Number.isFinite(limit) ? limit : 50), deliveries => ({ deliveries }))
})

router.post('/:id/webhook/test', requireAuth, async (req: AuthRequest, res) => {
  const id = guard(req, res)
  if (id == null) return
  send(res, await sendTestEvent(req.user!.id, id), result => result)
})

export default router
