// Pure main-loop model attribution over a Claude Code stream-json / transcript
// JSONL (obj 701053). No I/O, no DB — session-manager's scanStreamTelemetry,
// the fable-attribution backfill script, and the tests all share this core.
//
// Why "main loop only": a Fable objective legitimately spends Opus/Haiku tokens
// via sub-agents (Agent-tool sidechains), helper calls (titles, quotas), and the
// rolled-up `result.modelUsage` map (which includes ALL of the above — verified
// 2026-06-12: `usage` is main-thread-only, `modelUsage` is everything). None of
// those mean the objective's own agentic loop fell back. The only trustworthy
// fallback signals are:
//   1. an explicit `{type:'fallback', from, to}` content block the CLI emits on
//      a mid-run model switch (verified on cc-700913-1783349048324), and
//   2. a MAIN-LOOP assistant event whose `message.model` is the fallback model
//      (main loop = `parent_tool_use_id` null AND not `isSidechain`), and
//   3. only when there are no main-loop assistant events at all: the final
//      `result` event's top-level `model` (NOT its modelUsage keys).

export const FALLBACK_MODEL_ID = 'claude-sonnet-4-6'

export interface StreamAttribution {
  /** Assistant-turn count per model, MAIN LOOP only (sub-agent/sidechain events excluded). */
  mainLoopTurns: Record<string, number>
  /** Models the CLI explicitly switched to via a `{type:'fallback'}` content block. */
  fallbackSwitchTo: string[]
  /** Top-level `model` reported by the final `result` event, if any. */
  resultModel: string | null
  /** A refusal stop_reason was seen on an assistant or result event. */
  sawRefusal: boolean
}

/** Main loop = a top-level turn of the session's own agentic loop: not a
 *  sub-agent stream (`parent_tool_use_id` set) and not a transcript sidechain. */
export function isMainLoopEvent(event: Record<string, unknown>): boolean {
  return event.parent_tool_use_id == null && event.isSidechain !== true
}

export function analyzeStreamAttribution(content: string): StreamAttribution {
  const attr: StreamAttribution = { mainLoopTurns: {}, fallbackSwitchTo: [], resultModel: null, sawRefusal: false }
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let event: Record<string, unknown>
    try {
      event = JSON.parse(trimmed)
    } catch {
      continue
    }
    const type = event.type
    if (type !== 'assistant' && type !== 'result') continue
    const message = event.message as Record<string, unknown> | undefined
    const stopReason = (type === 'assistant' ? message?.stop_reason : event.stop_reason) as string | undefined
    if (stopReason === 'refusal') attr.sawRefusal = true

    if (type === 'result') {
      const model = (event.model as string | undefined) || (message?.model as string | undefined)
      if (model) attr.resultModel = model
      continue
    }
    // assistant event
    if (!isMainLoopEvent(event)) continue
    const model = message?.model as string | undefined
    // '<synthetic>' marks harness-injected placeholder events (errors/notices),
    // not a real model turn — never attribute to it.
    if (model && !model.startsWith('<')) attr.mainLoopTurns[model] = (attr.mainLoopTurns[model] ?? 0) + 1
    const blocks = message?.content
    if (Array.isArray(blocks)) {
      for (const b of blocks as Record<string, unknown>[]) {
        if (b && b.type === 'fallback') {
          const to = (b.to as Record<string, unknown> | undefined)?.model
          if (typeof to === 'string') attr.fallbackSwitchTo.push(to)
        }
      }
    }
  }
  return attr
}

/** True only when the session's OWN main loop actually ran on the fallback
 *  model. Opus keys in `modelUsage`, sub-agent turns, and helper models never
 *  trigger this. */
export function detectMainLoopFallback(attr: StreamAttribution, requestedModel: string | null | undefined): boolean {
  if (!requestedModel || requestedModel === FALLBACK_MODEL_ID) return false
  if ((attr.mainLoopTurns[FALLBACK_MODEL_ID] ?? 0) > 0) return true
  if (attr.fallbackSwitchTo.includes(FALLBACK_MODEL_ID)) return true
  // Degenerate stream with no main-loop assistant events: trust the result
  // event's own top-level model (still NOT the modelUsage rollup).
  if (Object.keys(attr.mainLoopTurns).length === 0 && attr.resultModel === FALLBACK_MODEL_ID) return true
  return false
}

/** The main-loop models that actually ran, most turns first; falls back to the
 *  result event's model when the stream had no main-loop assistant events. */
export function mainLoopModelsRan(attr: StreamAttribution): string[] {
  const models = Object.entries(attr.mainLoopTurns)
    .sort((a, b) => b[1] - a[1])
    .map(([m]) => m)
  if (models.length === 0 && attr.resultModel) return [attr.resultModel]
  return models
}

/** Merge a session's observed main-loop models into a persisted comma-joined
 *  `ran_model` value (order preserved: existing first, new appended). */
export function mergeRanModel(existing: string | null | undefined, observed: string[]): string | null {
  const merged: string[] = []
  for (const m of (existing ? existing.split(',') : []).concat(observed)) {
    const t = m.trim()
    if (t && !merged.includes(t)) merged.push(t)
  }
  return merged.length ? merged.join(',') : null
}
