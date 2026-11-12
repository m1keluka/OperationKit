// Self-test helpers shared by the engine, the publish gate and the UI
// (card B5, docs/design/WORKFLOWS.md §5.2 + §5.4). Pure, no dependencies.

import { declaredOrDefaultEffect, type RawNode } from './analyze.js'
import { validateFlow } from './validate.js'
import type { FlowDefinition, FlowFixture, FlowRegistry } from './types.js'

/** Modes a self-test may run in. `live` and `replay` are not self-tests. */
export const FLOW_SELF_TEST_MODES = ['dry', 'test'] as const
export type FlowSelfTestMode = (typeof FLOW_SELF_TEST_MODES)[number]

/**
 * The send/spend nodes the OWNER must approve to publish this definition
 * (§5.4 per-version approval): every send/spend node that no approval `wait`
 * dominates. Computed from the definition with any embedded `approvals` block
 * removed — that block is not authority (see FlowApprovals). Sorted, unique.
 */
export function nodesRequiringApproval(def: FlowDefinition, registry?: FlowRegistry): string[] {
  const rest: Partial<FlowDefinition> = { ...def }
  delete rest.approvals
  const v = validateFlow(rest, { requireApprovals: false, ...(registry ? { registry } : {}) })
  const ids = new Set<string>()
  for (const w of [...v.warnings, ...v.errors]) if (w.code === 'UNAPPROVED_EFFECT' && w.node_id) ids.add(w.node_id)
  return [...ids].sort()
}

/** Does the node carry a usable fixture (`mock.output` or `mock.error`)? */
export function hasMock(node: { mock?: unknown }): boolean {
  const m = node.mock
  return !!m && typeof m === 'object' && !Array.isArray(m) && ('output' in m || 'error' in m)
}

/**
 * §5.2: "the builder is required to write mocks for every write/send/spend node,
 * and the validator rejects a publish without them." Returns the offenders.
 */
export function nodesMissingMocks(def: FlowDefinition): string[] {
  const out: string[] = []
  for (const n of def.nodes ?? []) {
    const eff = declaredOrDefaultEffect(n as unknown as RawNode)
    if ((eff === 'write' || eff === 'send' || eff === 'spend') && !hasMock(n)) out.push(n.id)
  }
  return out
}

/** The fixtures a self-test runs: the request's, else the definition's, else one empty payload. */
export function effectiveFixtures(def: FlowDefinition, requested?: FlowFixture[] | null): FlowFixture[] {
  if (requested && requested.length) return requested
  if (Array.isArray(def.fixtures) && def.fixtures.length) return def.fixtures
  return [{ name: 'default', payload: {} }]
}

/**
 * A minimal value that satisfies a JSON Schema (the subset flow-json-schema
 * accepts): `const`, first `enum` member, required object properties, `minItems`
 * copies of `items`, the bound of a numeric range. Used as the dry-run stand-in
 * for an `llm` node that has no `mock`, so a dry run never calls a model.
 */
export function stubFromSchema(schema: unknown, depth = 0): unknown {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || depth > 8) return null
  const s = schema as Record<string, unknown>
  if ('const' in s) return s.const
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0]
  for (const k of ['anyOf', 'oneOf'] as const) {
    if (Array.isArray(s[k]) && (s[k] as unknown[]).length) return stubFromSchema((s[k] as unknown[])[0], depth + 1)
  }
  const type = Array.isArray(s.type) ? (s.type.find((t) => t !== 'null') ?? s.type[0]) : s.type
  switch (type) {
    case 'object': {
      const props = (s.properties && typeof s.properties === 'object' ? s.properties : {}) as Record<string, unknown>
      const out: Record<string, unknown> = {}
      for (const k of Array.isArray(s.required) ? (s.required as string[]) : []) out[k] = stubFromSchema(props[k], depth + 1)
      return out
    }
    case 'array': {
      const n = typeof s.minItems === 'number' && s.minItems > 0 ? Math.min(s.minItems, 10) : 0
      return Array.from({ length: n }, () => stubFromSchema(s.items, depth + 1))
    }
    case 'string': {
      const n = typeof s.minLength === 'number' && s.minLength > 0 ? Math.min(s.minLength, 1000) : 0
      return 'x'.repeat(n)
    }
    case 'integer':
    case 'number':
      return typeof s.minimum === 'number' ? s.minimum : typeof s.exclusiveMinimum === 'number' ? s.exclusiveMinimum + 1 : 0
    case 'boolean':
      return false
    case 'null':
      return null
    default:
      // A schema with properties but no `type` is still an object.
      if (s.properties) return stubFromSchema({ ...s, type: 'object' }, depth + 1)
      return null
  }
}
