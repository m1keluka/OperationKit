/**
 * Gmail triage cron endpoint — extracted from internal.ts (behavior frozen).
 * Localhost gate unchanged.
 */
import { Router } from 'express'
import { runGmailTriage } from '../services/gmail-triage.js'
import { isLocalhost } from '../lib/is-localhost.js'

export function registerInternalGmailRoutes(router: Router): void {
// POST /api/internal/gmail-triage/run — cron-callable inbox classifier.
// Mirrors the existing run-gmail-triage.sh expectation. Classifies INBOX
// envelopes into Live / Junk / Example Leads / Notifications via Ollama with
// Anthropic fallback, applies Gmail labels, records results in gmail_triage.
router.post('/gmail-triage/run', async (req, res) => {
  if (!isLocalhost(req)) {
    res.status(403).json({ error: 'Internal API: localhost only' })
    return
  }
  try {
    const result = await runGmailTriage()
    res.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'gmail-triage failed'
    console.error('[internal] gmail-triage/run failed:', err)
    res.status(500).json({ error: message })
  }
})

}
