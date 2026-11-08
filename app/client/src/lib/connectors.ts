/**
 * The connector-catalogue read, in one place (obj 900303).
 *
 * `GET /api/connectors` answers with a BARE ARRAY of ConnectorSummary — see
 * `app/server/src/routes/connectors.ts`. One consumer (the agent-key connector
 * picker in Settings → You) assumed an envelope, `{ connectors: [...] }`, read
 * `res.connectors` off an array, got `undefined`, and rendered "No connectors
 * available." forever — on an install with connectors connected. Its unit test
 * mocked the same wrong envelope, so the suite agreed with the bug.
 *
 * Two lessons are baked in here:
 *
 *  1. The shape is parsed ONCE, at the client's data boundary, by a function
 *     every consumer shares. A second consumer cannot invent a third reading.
 *  2. Loading is a three-state (loading / ready / failed), never a two-state.
 *     An empty catalogue and a failed fetch are DIFFERENT, and collapsing them
 *     into `[]` is what turned a 401 into a confident, wrong sentence.
 *
 * The envelope is accepted on read as well, purely so a future server change
 * cannot reintroduce the same blank picker; `fromEnvelope` records which shape
 * actually arrived so a test can assert the real contract.
 */
import type { ConnectorSummary } from '@operationkit/shared'

/** A catalogue entry as the picker needs it: an id and something to call it. */
export interface ConnectorOption {
  id: string
  name: string
}

export interface ConnectorListParse {
  options: ConnectorOption[]
  /** True when the payload arrived wrapped as `{ connectors: [...] }`. */
  fromEnvelope: boolean
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function toOption(raw: unknown): ConnectorOption | null {
  if (!isRecord(raw)) return null
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (!id) return null
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : id
  return { id, name }
}

/**
 * Parse whatever `GET /api/connectors` returned.
 *
 * THROWS on a payload that is neither the array nor the envelope. That is
 * deliberate: an unreadable response is a failure, and a caller that turned it
 * into `[]` would tell the person their catalogue is empty when the truth is
 * that nobody could read the answer.
 */
export function parseConnectorList(raw: unknown): ConnectorListParse {
  const envelope = isRecord(raw) && Array.isArray((raw as { connectors?: unknown }).connectors)
  const list = envelope ? ((raw as { connectors: unknown[] }).connectors) : raw
  if (!Array.isArray(list)) {
    throw new Error('The connector list came back in a shape this page does not understand.')
  }
  const options: ConnectorOption[] = []
  for (const entry of list) {
    const opt = toOption(entry)
    if (opt) options.push(opt)
  }
  return { options, fromEnvelope: envelope }
}

/** Convenience for callers that only want the options. */
export function connectorOptionsOf(raw: unknown): ConnectorOption[] {
  return parseConnectorList(raw).options
}

/** Narrow a ConnectorSummary[] to picker options without re-parsing. */
export function optionsFromSummaries(list: ConnectorSummary[]): ConnectorOption[] {
  return list.map(c => ({ id: c.id, name: c.name || c.id }))
}
