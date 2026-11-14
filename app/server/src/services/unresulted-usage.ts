/**
 * Usage of CLI processes that died WITHOUT a `result` event (obj 900547).
 *
 * Every token/cost path (`sumResultEventsFromContent` for the per-seat ledger,
 * `parseTranscript` for session_intel → objectives.total_tokens) counts ONLY
 * `result` events. A process that is killed mid-turn — #900543 on 2026-11-11, its
 * tmux reaped by a scratch server, 44 and 86 tool calls of real work — writes none,
 * so the session was recorded as 0 tokens / $0, and the seat's "Tokens today" did
 * not move across two deaths.
 *
 * The CLI's `assistant` events carry the API's per-message `usage`. This tracker
 * collects them, de-duplicated by `message.id` (with --include-partial-messages
 * one message appears as several `assistant` events and `stream_event`s), and
 * DISCARDS everything a later `result` already covers. Whatever is left when a new
 * process starts (a `system/init`, or a server `prompt`/`followup` marker) or the
 * transcript ends is the usage of a process that never reported it.
 *
 * Cost is an ESTIMATE from the list prices below (the CLI's own `total_cost_usd`
 * never got written). It only ever applies to unreported usage, so a clean session
 * is accounted exactly as before.
 */
import { catalogEntryForUsage } from '../lib/claude-model-catalog.js'

export interface UnresultedUsage {
  tokens: number
  /** Estimated from list prices — see PRICES. */
  cost: number
  /** Per-model split of the above. */
  models: Record<string, { tokens: number; cost_usd: number }>
  /** Distinct API messages that contributed. 0 = nothing unreported. */
  messages: number
}

interface MsgUsage {
  model: string
  input: number
  output: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
}

/** $ per million tokens: [input, output, cache read]. Cache writes: 1.25x (5m) / 2x (1h) input.
 *  An id in the curated Claude catalog (lib/claude-model-catalog.ts) is priced from
 *  the catalog first; these family regexes are the fallback for everything else.
 *  Fable/Mythos 5.2 dropped to $8/$40 (obj 900796) — the old `fable|mythos` row
 *  charged it at the 5.1 price. */
const PRICES: Array<[RegExp, number, number, number]> = [
  [/(fable|mythos)-5-2/, 8, 40, 0.2],
  [/fable|mythos/, 10, 50, 0.25],
  [/opus-5-5/, 4, 20, 0.2],
  [/opus/, 5, 25, 0.5],
  [/sonnet-5/, 2, 10, 0.2],
  [/sonnet/, 3, 15, 0.3],
  [/haiku-5/, 0.1, 0.5, 0.01],
  [/haiku/, 1, 5, 0.1],
]
/** Unknown model: priced as the default worker model (Opus) rather than $0. */
const FALLBACK_PRICE: [number, number, number] = [4, 20, 0.2]

export function estimateCostUsd(u: Omit<MsgUsage, 'model'>, model: string): number {
  const cat = catalogEntryForUsage(model)
  const hit = cat ? null : PRICES.find(([re]) => re.test(model))
  const [inP, outP, readP] = cat
    ? [cat.price.input, cat.price.output, cat.price.cache_read]
    : hit ? [hit[1], hit[2], hit[3]] : FALLBACK_PRICE
  return (
    u.input * inP +
    u.output * outP +
    u.cacheRead * readP +
    u.cacheWrite5m * inP * 1.25 +
    u.cacheWrite1h * inP * 2
  ) / 1_000_000
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

function readUsage(usage: Record<string, unknown> | undefined, model: string): MsgUsage {
  const u = usage ?? {}
  const cacheWrite = num(u.cache_creation_input_tokens)
  const split = (u.cache_creation as Record<string, unknown> | undefined) ?? {}
  const w1h = Math.min(num(split.ephemeral_1h_input_tokens), cacheWrite)
  return {
    model,
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheWrite1h: w1h,
    cacheWrite5m: cacheWrite - w1h,
  }
}

function maxMerge(a: MsgUsage | undefined, b: MsgUsage): MsgUsage {
  if (!a) return b
  return {
    model: a.model || b.model,
    input: Math.max(a.input, b.input),
    output: Math.max(a.output, b.output),
    cacheRead: Math.max(a.cacheRead, b.cacheRead),
    cacheWrite5m: Math.max(a.cacheWrite5m, b.cacheWrite5m),
    cacheWrite1h: Math.max(a.cacheWrite1h, b.cacheWrite1h),
  }
}

const NEW_PROCESS_MARKERS = new Set(['prompt', 'followup', 'chain_reset'])

export class UnresultedUsageTracker {
  /** Messages since the last `result` of the current process. */
  private pending = new Map<string, MsgUsage>()
  /** Message ids already settled (covered by a result, or flushed). */
  private settled = new Set<string>()
  private currentStreamMsg: { id: string; model: string } | null = null
  private out: UnresultedUsage = { tokens: 0, cost: 0, models: {}, messages: 0 }

  feed(event: Record<string, unknown>): void {
    const type = event.type
    if (type === 'result') {
      // The result's own usage/cost covers this process's messages so far.
      for (const id of this.pending.keys()) this.settled.add(id)
      this.pending.clear()
      return
    }
    if ((type === 'system' && event.subtype === 'init') || (typeof type === 'string' && NEW_PROCESS_MARKERS.has(type))) {
      this.flush()
      return
    }
    if (type === 'assistant') {
      const msg = event.message as Record<string, unknown> | undefined
      const id = typeof msg?.id === 'string' ? msg.id : null
      if (!msg || !id || this.settled.has(id)) return
      const model = typeof msg.model === 'string' ? msg.model : ''
      this.pending.set(id, maxMerge(this.pending.get(id), readUsage(msg.usage as Record<string, unknown> | undefined, model)))
      return
    }
    if (type === 'stream_event') {
      const ev = event.event as Record<string, unknown> | undefined
      if (!ev) return
      if (ev.type === 'message_start') {
        const msg = ev.message as Record<string, unknown> | undefined
        const id = typeof msg?.id === 'string' ? msg.id : null
        if (!msg || !id) { this.currentStreamMsg = null; return }
        const model = typeof msg.model === 'string' ? msg.model : ''
        this.currentStreamMsg = { id, model }
        if (this.settled.has(id)) return
        this.pending.set(id, maxMerge(this.pending.get(id), readUsage(msg.usage as Record<string, unknown> | undefined, model)))
      } else if (ev.type === 'message_delta' && this.currentStreamMsg) {
        const { id, model } = this.currentStreamMsg
        if (this.settled.has(id)) return
        this.pending.set(id, maxMerge(this.pending.get(id), readUsage(ev.usage as Record<string, unknown> | undefined, model)))
      }
    }
  }

  private flush(): void {
    for (const [id, u] of this.pending) {
      this.settled.add(id)
      const tokens = u.input + u.output + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h
      if (tokens === 0) continue
      const cost = estimateCostUsd(u, u.model)
      const key = u.model || 'unknown'
      const agg = this.out.models[key] ?? { tokens: 0, cost_usd: 0 }
      agg.tokens += tokens
      agg.cost_usd += cost
      this.out.models[key] = agg
      this.out.tokens += tokens
      this.out.cost += cost
      this.out.messages++
    }
    this.pending.clear()
    this.currentStreamMsg = null
  }

  /** Finalise: whatever is still pending belongs to a process that never reported. */
  finish(): UnresultedUsage {
    this.flush()
    return this.out
  }
}

/** Convenience: unreported usage of a whole transcript's content. */
export function unresultedUsageFromContent(content: string): UnresultedUsage {
  const t = new UnresultedUsageTracker()
  for (const line of content.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try { t.feed(JSON.parse(s)) } catch { /* torn line */ }
  }
  return t.finish()
}
