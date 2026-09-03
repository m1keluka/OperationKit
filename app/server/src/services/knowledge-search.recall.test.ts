import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync } from 'node:fs'
import { searchKnowledge, searchKnowledgeGrep } from './knowledge-search.js'
import { searchVaultIndex, resetVaultIndexCache } from './vault-index.js'

/**
 * ST6 recall test — the ROADMAP verifier signal:
 *   "a paraphrased query retrieves a known-relevant decision that grep misses."
 *
 * Known doc: workspaces/operator/decisions/2026-04-27-uptimerobot-status-page-architecture.md
 *   — it talks about "uptime" (×17), "incident" (×4), "monitor" (×11) but NEVER
 *     the words "outage", "availability", "service", or "detection".
 *
 * Paraphrase query: "service outage availability detection"
 *   — shares ZERO surface tokens with the doc, so the lexical grep path misses
 *     it. The semantic path bridges via Porter stemming + synonym expansion
 *     (outage→incident, availability→uptime) and retrieves it.
 *
 * Requires the live vault to be mounted (it is, in-container at
 * /home/operator/second-brain). If absent, the assertions are skipped with a clear
 * message rather than producing a misleading green.
 */

const VAULT_ROOT = process.env.SECOND_BRAIN_ROOT || '/home/operator/second-brain'
const TARGET = '2026-04-27-uptimerobot-status-page-architecture.md'
const PARAPHRASE = 'service outage availability detection'
const vaultPresent = existsSync(VAULT_ROOT)

const hasTarget = (hits: { path: string }[]) => hits.some((h) => h.path.endsWith(TARGET))

// Real-data integration test: it recalls against the live second-brain vault,
// which is mounted in-container but NOT present on a CI runner (it is Mike's
// knowledge base, not a checkable fixture). Skip the whole block when the vault
// is absent rather than failing CI — the suite still runs in full locally /
// in-container. (SECOND_BRAIN_ROOT can point it elsewhere.)
describe.skipIf(!vaultPresent)('ST6 semantic vault retrieval', () => {
  beforeAll(() => {
    resetVaultIndexCache()
  })

  it('vault is mounted (otherwise this recall test is meaningless)', () => {
    expect(vaultPresent, `vault not found at ${VAULT_ROOT}`).toBe(true)
  })

  it('GREP path MISSES the doc for a no-shared-keyword paraphrase', () => {
    if (!vaultPresent) return
    const grepHits = searchKnowledgeGrep(PARAPHRASE, 'operator')
    expect(hasTarget(grepHits)).toBe(false)
  })

  it('SEMANTIC path RETRIEVES the doc grep missed', () => {
    if (!vaultPresent) return
    const semanticHits = searchVaultIndex(PARAPHRASE, 'operator')
    expect(hasTarget(semanticHits)).toBe(true)
  })

  it('searchKnowledge() (the wired entry point) surfaces the doc', () => {
    if (!vaultPresent) return
    // This is exactly what context-builder calls; proves the wiring + that the
    // semantic path runs ahead of the grep fallback.
    const hits = searchKnowledge(PARAPHRASE, 'operator')
    expect(hasTarget(hits)).toBe(true)
  })

  it('the contrast IS the verifier signal: grep=miss, semantic=hit', () => {
    if (!vaultPresent) return
    const grepHas = hasTarget(searchKnowledgeGrep(PARAPHRASE, 'operator'))
    const semHas = hasTarget(searchVaultIndex(PARAPHRASE, 'operator'))
    expect({ grepHas, semHas }).toEqual({ grepHas: false, semHas: true })
  })

  it('falls back gracefully to grep on a plain keyword query (no regression)', () => {
    if (!vaultPresent) return
    // A direct keyword query should still return results via one path or the other.
    const hits = searchKnowledge('uptimerobot status page monitoring', 'operator')
    expect(hits.length).toBeGreaterThan(0)
  })
})
