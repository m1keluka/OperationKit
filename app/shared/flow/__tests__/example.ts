// The complete example from docs/design/WORKFLOWS.md §3.5, with the §3.3 goal
// substituted for `/* as in §3.3 */` and the JSONC comments removed.
import type { FlowDefinition } from '../types.js'

export const DAILY_BOOKING_TRIAGE: FlowDefinition = {
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
      judge: {
        rubric: 'The message states how many bookings were triaged and nothing else.',
        on: 'steps.notify.input.text',
        budget_usd: 0.05,
      },
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
    {
      id: 'each', kind: 'loop', over: '{{ steps.fetch.output.bookings }}', as: 'b', max_items: 200,
      body: ['classify', 'upsert_one'], next: 'upsert',
    },
    {
      id: 'classify', kind: 'llm', model: 'default', max_iterations: 1, budget_usd: 0.01,
      prompt: 'Classify this booking note into one of: sales, support, other. Note: {{ item.b.notes }}',
      output_schema: { type: 'object', properties: { category: { enum: ['sales', 'support', 'other'] } }, required: ['category'] },
    },
    {
      id: 'upsert_one', kind: 'mcp', connector: 'crm', tool: 'upsert_contact', effect: 'write',
      arguments: { external_id: '{{ item.b.id }}', tag: '{{ steps.classify.output.category }}' },
    },
    {
      id: 'upsert', kind: 'check', assert: [{ expr: 'len(steps.each.output) == len(steps.fetch.output.bookings)' }],
      on_fail: 'repair', next: 'notify',
    },
    {
      id: 'notify', kind: 'mcp', connector: 'slack', tool: 'post_message', effect: 'send',
      arguments: { channel: '#bookings', text: 'Triaged {{ len(steps.fetch.output.bookings) }} bookings.' }, next: 'done',
    },
    { id: 'done', kind: 'end', output: '{{ steps.each.output }}' },
  ],
}

/** A deep, mutable, loosely-typed copy for building negative fixtures. */
export type Loose = any
export function example(): Loose {
  return JSON.parse(JSON.stringify(DAILY_BOOKING_TRIAGE))
}
export function node(doc: Loose, id: string): Loose {
  const n = doc.nodes.find((x: Loose) => x.id === id)
  if (!n) throw new Error(`fixture has no node ${id}`)
  return n
}
