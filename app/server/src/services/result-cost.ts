/**
 * Per-result share of the cumulative Claude `total_cost_usd` / `modelUsage`
 * (obj 712954). No I/O and no imports, so both the transcript parser and the
 * usage math can use it. See session-usage.ts for the CLI semantics.
 */

export interface ResultCostShare {
  /** This result's own share of `total_cost_usd`. */
  cost: number
  /** This result's own share of each `modelUsage` entry. */
  models: Record<string, { cost_usd: number; tokens: number }>
}

function modelTotals(event: Record<string, unknown>): Record<string, { cost_usd: number; tokens: number }> {
  const out: Record<string, { cost_usd: number; tokens: number }> = {}
  const mu = event.modelUsage as Record<string, Record<string, unknown>> | undefined
  if (!mu || typeof mu !== 'object') return out
  for (const [model, u] of Object.entries(mu)) {
    if (!u || typeof u !== 'object') continue
    out[model] = {
      cost_usd: (u.costUSD as number) || 0,
      tokens:
        ((u.inputTokens as number) || 0) +
        ((u.outputTokens as number) || 0) +
        ((u.cacheReadInputTokens as number) || 0) +
        ((u.cacheCreationInputTokens as number) || 0),
    }
  }
  return out
}

/**
 * Turns the cumulative per-session `total_cost_usd` / `modelUsage` on successive
 * `result` events into each result's own share (obj 712954).
 *
 * - Grouped by the event's `session_id` (the Claude session). A total that is
 *   lower than the previous one for the same session means a fresh process that
 *   did not restore the running total (older CLIs, June-era transcripts), so the
 *   whole value counts.
 * - A repeated result `uuid` counts zero (the same event appended twice).
 * - A result WITHOUT a session_id is taken at face value (no key to group by).
 * Pure apart from its own running state; one instance per transcript scan.
 */
export class ResultCostTracker {
  private seen = new Set<string>()
  private lastCost = new Map<string, number>()
  private lastModels = new Map<string, Record<string, { cost_usd: number; tokens: number }>>()

  take(event: Record<string, unknown>): ResultCostShare | null {
    const uuid = typeof event.uuid === 'string' ? event.uuid : null
    if (uuid) {
      if (this.seen.has(uuid)) return null
      this.seen.add(uuid)
    }
    const total = (event.total_cost_usd as number) || 0
    const models = modelTotals(event)
    const sid = typeof event.session_id === 'string' && event.session_id ? event.session_id : null
    if (!sid) return { cost: total, models }

    const prev = this.lastCost.get(sid)
    const prevModels = this.lastModels.get(sid) ?? {}
    this.lastCost.set(sid, total)
    this.lastModels.set(sid, models)
    if (prev === undefined || total < prev - 1e-9) return { cost: total, models }

    const share: Record<string, { cost_usd: number; tokens: number }> = {}
    for (const [model, m] of Object.entries(models)) {
      const p = prevModels[model]
      share[model] = p && m.cost_usd >= p.cost_usd && m.tokens >= p.tokens
        ? { cost_usd: m.cost_usd - p.cost_usd, tokens: m.tokens - p.tokens }
        : m
    }
    return { cost: Math.max(0, total - prev), models: share }
  }
}
