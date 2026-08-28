/**
 * Unauthenticated discovery for third-party agents.
 * Spec + how-to-auth; no board data.
 */
import { Router } from 'express'
import { AGENT_DISCOVERY, AGENT_OPENAPI } from '../api/agent-openapi.js'

const router = Router()

router.get('/agent', (_req, res) => {
  res.json(AGENT_DISCOVERY)
})

router.get('/openapi.json', (_req, res) => {
  res.json(AGENT_OPENAPI)
})

export default router
