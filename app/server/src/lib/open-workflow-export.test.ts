// B10 — okflow/1 → Open Workflow export (docs/design/WORKFLOWS.md §8).
// The exported YAML is parsed back and validated against the upstream Open
// Workflow JSON Schema pinned at tag v1.0.3 (vendored under __fixtures__ with
// its Apache-2.0 LICENSE). ajv / ajv-formats / yaml are devDependencies used
// here only; the exporter itself imports nothing.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { parse as parseYaml } from 'yaml'
import {
  okflowToOpenWorkflow,
  okflowExprToJq,
  toYaml,
  OkflowExportError,
  OPEN_WORKFLOW_NON_EXPORTABLE,
  OPEN_WORKFLOW_DSL_VERSION,
  type OkflowExportInput,
} from '../../../shared/flow/open-workflow-export'

const here = path.dirname(fileURLToPath(import.meta.url))
const SCHEMA_DIR = path.join(here, '../__fixtures__/open-workflow/v1.0.3')
const EXPORTER_SRC = path.join(here, '../../../shared/flow/open-workflow-export.ts')

const schema = parseYaml(fs.readFileSync(path.join(SCHEMA_DIR, 'workflow.yaml'), 'utf8'))
const ajv = new Ajv2020({ allErrors: true, strict: false })
addFormats(ajv)
const validateOw = ajv.compile(schema)

/** Validate a YAML string; returns ajv errors (empty = valid). */
function schemaErrors(yamlText: string) {
  const doc = parseYaml(yamlText)
  return validateOw(doc) ? [] : (validateOw.errors ?? []).map((e) => `${e.instancePath} ${e.message}`)
}

/** WORKFLOWS.md §3.5 verbatim (comments removed; goal from §3.3). */
function section35(): OkflowExportInput {
  return {
    apiVersion: 'okflow/1',
    id: 'daily-booking-triage',
    name: 'Daily booking triage',
    workspace: 'acme',
    version: 3,
    goal: {
      statement: 'Every booking created yesterday is in the CRM with a category, and the team got one summary message.',
      end_condition: {
        assert: [
          { expr: 'len(steps.fetch.output.bookings) == steps.upsert.output.count', why: 'nothing dropped' },
          { expr: 'steps.notify.output.ok == true', why: 'summary posted' },
        ],
        judge: { rubric: 'The message states how many bookings were triaged and nothing else.', on: 'steps.notify.input.text', budget_usd: 0.05 },
      },
    },
    budget: { run_usd: 0.5, repair_usd: 2.0, repairs_per_day: 3 },
    approvals: { version: 3, nodes: ['notify'], by: 'user:1', at: '2026-11-20T14:02:00Z' },
    nodes: [
      { id: 'start', kind: 'trigger', on: 'schedule', schedule: { cron: '0 8 * * 1-5' }, next: 'fetch' },
      {
        id: 'fetch', kind: 'tool', tool: 'calendar-bookings-list', effect: 'read',
        input: { since: "{{ date_add(now(), -1, 'day') }}" }, retry: { max: 3, backoff: 'exponential', delay_ms: 2000 },
        mock: { output: { bookings: [{ id: 'b1', notes: 'pricing question' }] } }, next: 'each',
      },
      { id: 'each', kind: 'loop', over: '{{ steps.fetch.output.bookings }}', as: 'b', max_items: 200, body: ['classify', 'upsert_one'], next: 'upsert' },
      {
        id: 'classify', kind: 'llm', model: 'default', max_iterations: 1, budget_usd: 0.01,
        prompt: 'Classify this booking note into one of: sales, support, other. Note: {{ item.b.notes }}',
        output_schema: { type: 'object', properties: { category: { enum: ['sales', 'support', 'other'] } }, required: ['category'] },
      } as OkflowExportInput['nodes'][number],
      {
        id: 'upsert_one', kind: 'mcp', connector: 'crm', tool: 'upsert_contact', effect: 'write',
        arguments: { external_id: '{{ item.b.id }}', tag: '{{ steps.classify.output.category }}' },
      },
      { id: 'upsert', kind: 'check', assert: [{ expr: 'len(steps.each.output) == len(steps.fetch.output.bookings)' }], on_fail: 'repair', next: 'notify' },
      {
        id: 'notify', kind: 'mcp', connector: 'slack', tool: 'post_message', effect: 'send',
        arguments: { channel: '#bookings', text: 'Triaged {{ len(steps.fetch.output.bookings) }} bookings.' }, next: 'done',
      },
      { id: 'done', kind: 'end', output: '{{ steps.each.output }}' },
    ],
  }
}

/** §3.5 minus `llm`: drop `classify` and the one argument that read its output. */
function section35MinusLlm(): OkflowExportInput {
  const def = section35()
  def.nodes = def.nodes.filter((n) => n.kind !== 'llm')
  const each = def.nodes.find((n) => n.id === 'each')!
  each.body = ['upsert_one']
  const upsertOne = def.nodes.find((n) => n.id === 'upsert_one')!
  upsertOne.arguments = { external_id: '{{ item.b.id }}', tag: 'triaged' }
  return def
}

describe('okflowToOpenWorkflow — §3.5 example (minus llm)', () => {
  const result = okflowToOpenWorkflow(section35MinusLlm())

  it('emits YAML that validates against the Open Workflow JSON Schema at tag v1.0.3', () => {
    expect(OPEN_WORKFLOW_DSL_VERSION).toBe('1.0.3')
    expect(schema.$id).toBe('https://serverlessworkflow.io/schemas/1.0.3/workflow.yaml')
    expect(schemaErrors(result.yaml)).toEqual([])
  })

  it('the YAML round-trips to exactly the returned document', () => {
    expect(parseYaml(result.yaml)).toEqual(result.workflow)
  })

  it('maps every node kind to the expected Open Workflow construct', () => {
    const wf = result.workflow as any
    expect(wf.document).toMatchObject({ dsl: '1.0.3', namespace: 'acme', name: 'daily-booking-triage', version: '3.0.0', title: 'Daily booking triage' })
    expect(wf.schedule).toEqual({ cron: '0 8 * * 1-5' })
    expect(wf.do.map((t: object) => Object.keys(t)[0])).toEqual(['fetch', 'each', 'upsert', 'notify', 'done'])

    // tool with retry → try/catch.retry around a custom function call
    const fetch = wf.do[0].fetch
    expect(fetch.catch.retry).toEqual({ backoff: { exponential: {} }, limit: { attempt: { count: 3 } }, delay: { milliseconds: 2000 } })
    expect(fetch.try[0].fetch.call).toBe('calendar-bookings-list')
    expect(fetch.try[0].fetch.with.since).toBe('${ (((now | todate) | fromdate) + ((0 - 1)) * 86400 | todate) }')

    // loop → for, body nested, item.b → $b
    const each = wf.do[1].each
    expect(each.for).toEqual({ each: 'b', in: '${ $context.steps.fetch.output.bookings }' })
    expect(each.do[0].upsert_one.call).toBe('mcp')
    expect(each.do[0].upsert_one.with.parameters).toEqual({ name: 'upsert_contact', arguments: { external_id: '${ $b.id }', tag: 'triaged' } })
    expect(each.metadata.okflow).toMatchObject({ kind: 'loop', max_items: 200 })

    // check → conditional raise
    expect(wf.do[2].upsert.if).toBe('${ (((($context.steps.each.output | length) == ($context.steps.fetch.output.bookings | length)))) | not }')
    expect(wf.do[2].upsert.raise.error.type).toBe('https://serverlessworkflow.io/spec/1.0.0/errors/validation')

    // mixed text template → jq string interpolation; effect kept as metadata
    expect(wf.do[3].notify.with.parameters.arguments.text).toBe('${ "Triaged \\(($context.steps.fetch.output.bookings | length)) bookings." }')
    expect(wf.do[3].notify.with.transport).toEqual({ http: { endpoint: 'okflow://connectors/slack' } })
    expect(wf.do[3].notify.metadata.okflow.effect).toBe('send')

    // end → set + then: end
    expect(wf.do[4].done).toEqual({ set: '${ $context.steps.each.output }', then: 'end', metadata: { okflow: { kind: 'end' } } })
  })

  it('drops goal (and the other OperationKit-only blocks) and says so', () => {
    expect(result.yaml).not.toMatch(/end_condition|statement|rubric|run_usd|approvals:/)
    const features = new Set(result.dropped.map((d) => d.feature))
    for (const f of ['goal', 'budget', 'approvals', 'workspace', 'mock', 'effect', 'loop.max_items', 'loop.output', 'check.on_fail=repair']) {
      expect(features.has(f), f).toBe(true)
    }
    expect((result.workflow as any).document.metadata.okflow.dropped).toEqual(expect.arrayContaining(['goal', 'budget', 'approvals']))
  })
})

describe('non-exportable features', () => {
  it('lists llm, agent and goal explicitly', () => {
    const byFeature = Object.fromEntries(OPEN_WORKFLOW_NON_EXPORTABLE.map((f) => [f.feature, f.handling]))
    expect(byFeature).toMatchObject({ llm: 'refuse', agent: 'refuse', goal: 'drop' })
  })

  it('the full §3.5 example (with its llm node) is refused, naming the node', () => {
    try {
      okflowToOpenWorkflow(section35())
      throw new Error('expected a refusal')
    } catch (e) {
      expect(e).toBeInstanceOf(OkflowExportError)
      const issues = (e as OkflowExportError).issues
      expect(issues).toContainEqual(expect.objectContaining({ code: 'NON_EXPORTABLE_NODE', nodeId: 'classify' }))
    }
  })

  it('an agent node is refused', () => {
    const def = section35MinusLlm()
    def.nodes.find((n) => n.id === 'notify')!.next = 'ask'
    def.nodes.push({ id: 'ask', kind: 'agent', next: 'done' } as OkflowExportInput['nodes'][number])
    expect(() => okflowToOpenWorkflow(def)).toThrow(/NON_EXPORTABLE_NODE\] ask/)
  })

  it('wait.until is refused; unbound item / steps.<id>.input references are refused', () => {
    const def = section35MinusLlm()
    def.nodes.find((n) => n.id === 'notify')!.next = 'pause'
    def.nodes.push({ id: 'pause', kind: 'wait', until: '2026-12-01T00:00:00Z', next: 'done' })
    def.nodes.find((n) => n.id === 'done')!.output = '{{ item.b.id }}'
    def.nodes.find((n) => n.id === 'notify')!.arguments = { text: '{{ steps.fetch.input.since }}' }
    try {
      okflowToOpenWorkflow(def)
      throw new Error('expected a refusal')
    } catch (e) {
      const codes = (e as OkflowExportError).issues.map((i) => `${i.code}:${i.nodeId}`)
      expect(codes).toEqual(expect.arrayContaining(['NON_EXPORTABLE_FEATURE:pause', 'UNSUPPORTED_REFERENCE:done', 'UNSUPPORTED_REFERENCE:notify']))
    }
  })
})

describe('other mappable constructs still validate against the pinned schema', () => {
  it('branch / wait (duration, event, approval) / timeout / manual trigger / check on_fail=continue', () => {
    const def: OkflowExportInput = {
      apiVersion: 'okflow/1',
      id: 'Lead_Router',
      workspace: 'Ops Team!',
      nodes: [
        { id: 'start', kind: 'trigger', on: 'webhook', next: 'route' },
        {
          id: 'route', kind: 'branch', next: 'settle',
          cases: [
            { when: "lower(trigger.payload.source) == 'web' and default(trigger.payload.score, 0) >= 50", then: ['hot'] },
            { when: '{{ len(trigger.payload.tags) > 0 }}', then: ['tagged', 'nap'] },
          ],
          default: 'cold',
        },
        { id: 'hot', kind: 'tool', tool: 'crm-create-deal', input: { name: '{{ trigger.payload.name }}', tags: ["{{ join(trigger.payload.tags, ', ') }}"] }, timeout_ms: 30000 },
        { id: 'tagged', kind: 'tool', tool: 'crm-tag', input: { id: '{{ trigger.payload["lead-id"] }}' } },
        { id: 'nap', kind: 'wait', for: 60000 },
        { id: 'cold', kind: 'wait', event: 'com.example.lead.updated' },
        { id: 'settle', kind: 'wait', approval: { from: 'owner', prompt: 'Ship it?' }, next: 'verify' },
        { id: 'verify', kind: 'check', assert: [{ expr: 'steps.hot.output.ok != false' }], on_fail: 'continue', next: 'done' },
        { id: 'done', kind: 'end' },
      ],
    }
    const result = okflowToOpenWorkflow(def)
    expect(schemaErrors(result.yaml)).toEqual([])
    const wf = result.workflow as any
    expect(wf.schedule).toBeUndefined()
    expect(wf.document).toMatchObject({ namespace: 'ops-team', name: 'lead_router'.replace('_', '-'), version: '1.0.0' })
    expect(wf.do.map((t: object) => Object.keys(t)[0])).toEqual(['route', 'route__case_0', 'route__case_1', 'route__default', 'settle', 'verify', 'done'])
    expect(wf.do[0].route.switch.at(-1)).toEqual({ default: { then: 'route__default' } })
    expect(wf.do[1].route__case_0.then).toBe('settle')
    expect(wf.do[2].route__case_1.do.map((t: object) => Object.keys(t)[0])).toEqual(['tagged', 'nap'])
    expect(wf.do[2].route__case_1.do[1].nap.wait).toEqual({ milliseconds: 60000 })
    expect(wf.do[1].route__case_0.do[0].hot.timeout).toEqual({ after: { milliseconds: 30000 } })
    expect(wf.do[2].route__case_1.do[0].tagged.with.id).toBe('${ $workflow.input["lead-id"] }')
  })

  it('a schedule-less event trigger becomes schedule.on', () => {
    const result = okflowToOpenWorkflow({
      apiVersion: 'okflow/1', id: 'on-event',
      nodes: [
        { id: 'start', kind: 'trigger', on: 'event', event: 'io.operationkit.card.done', next: 'done' },
        { id: 'done', kind: 'end', output: { ok: true } },
      ],
    })
    expect(schemaErrors(result.yaml)).toEqual([])
    expect((result.workflow as any).schedule).toEqual({ on: { one: { with: { type: 'io.operationkit.card.done' } } } })
  })
})

describe('okflowExprToJq', () => {
  it.each([
    ['steps.fetch.output.bookings', '$context.steps.fetch.output.bookings'],
    ['trigger.payload.user.email', '$workflow.input.user.email'],
    ['len(steps.a.output.items) == 3', '(($context.steps.a.output.items | length) == 3)'],
    ["date_add(now(), 2, 'hours')", '(((now | todate) | fromdate) + (2) * 3600 | todate)'],
    ['not (steps.a.output.ok == true)', '((($context.steps.a.output.ok == true)) | not)'],
  ])('%s', (src, jq) => {
    expect(okflowExprToJq(src)).toBe(jq)
  })

  it('rejects unknown functions, roots and non-literal date units', () => {
    expect(() => okflowExprToJq('eval(1)')).toThrow(/unknown function/)
    expect(() => okflowExprToJq('secrets.API_KEY')).toThrow(/unknown reference root/)
    expect(() => okflowExprToJq('date_add(now(), 1, steps.a.output.unit)')).toThrow(/literal/)
  })
})

describe('toYaml', () => {
  it('quotes YAML-ambiguous strings so they parse back unchanged', () => {
    const value = {
      on: 'yes', off: ['no', 'null', '~', 'true', '0', '1.5', '', ' lead', 'a: b', '#x', '- y', '${ .x }', 'line\nbreak', '"q"'],
      nested: { empty: {}, list: [], deep: [{ a: 1, b: [{ c: null }] }, [1, 2]] },
      'key with space': false,
    }
    expect(parseYaml(toYaml(value))).toEqual(value)
  })
})

describe('no runtime dependency', () => {
  it('the exporter source imports nothing', () => {
    const src = fs.readFileSync(EXPORTER_SRC, 'utf8')
    expect(src).not.toMatch(/^\s*import\s/m)
    expect(src).not.toMatch(/\brequire\(/)
  })

  it('the schema validator / YAML parser are devDependencies only', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(here, '../../package.json'), 'utf8'))
    for (const name of ['ajv', 'ajv-formats', 'yaml']) {
      expect(pkg.dependencies?.[name], name).toBeUndefined()
      expect(pkg.devDependencies?.[name], name).toBeDefined()
    }
    expect(fs.existsSync(path.join(SCHEMA_DIR, 'LICENSE'))).toBe(true)
    expect(fs.readFileSync(path.join(SCHEMA_DIR, 'LICENSE'), 'utf8')).toMatch(/Apache License\s+Version 2\.0/)
  })
})
