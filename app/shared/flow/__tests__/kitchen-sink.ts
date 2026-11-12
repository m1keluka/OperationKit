// A valid flow that uses every node kind, a loop nested in a loop, a branch
// inside a loop body, a spend node behind an approval wait, labels that need
// escaping, and node ids that are Mermaid keywords (`graph`, `subgraph`, `end`).
import type { FlowDefinition } from '../types.js'

export const KITCHEN_SINK: FlowDefinition = {
  apiVersion: 'okflow/1',
  id: 'kitchen-sink',
  name: 'Kitchen sink',
  version: 1,
  goal: {
    statement: 'Every account is reviewed and the report is filed.',
    end_condition: { assert: [{ expr: "steps.file_report.status == 'succeeded'", why: 'report filed' }] },
  },
  nodes: [
    { id: 'kick', kind: 'trigger', on: 'webhook', next: 'accounts' },
    { id: 'accounts', kind: 'tool', tool: 'accounts-list', effect: 'read', next: 'graph' },
    {
      id: 'graph', kind: 'loop', label: 'Accounts "A–Z" #1', over: '{{ steps.accounts.output.items }}', as: 'acct',
      max_items: 50, concurrency: 2, body: ['subgraph', 'score'], next: 'gate',
    },
    {
      id: 'subgraph', kind: 'loop', over: 'item.acct.contacts', as: 'c', max_items: 20,
      body: ['enrich'],
    },
    { id: 'enrich', kind: 'mcp', connector: 'crm', tool: 'get_contact', effect: 'read', arguments: { id: '{{ item.c.id }}', account: '{{ item.acct.id }}' } },
    {
      id: 'score', kind: 'branch',
      cases: [{ when: 'len(steps.subgraph.output) > 10', then: ['deep_dive'] }],
      default: 'tag_small',
    },
    { id: 'deep_dive', kind: 'agent', brief: 'Review account {{ item.acct.name }} <and> report risks.', agent: 'analyst', budget_usd: 1.5 },
    { id: 'tag_small', kind: 'tool', tool: 'crm-tag', effect: 'write', input: { account: '{{ item.acct.id }}', tag: 'small' } },
    { id: 'gate', kind: 'wait', approval: { from: 'owner', prompt: 'File the paid report?' }, next: 'cool_off' },
    { id: 'cool_off', kind: 'wait', for: '15m', next: 'file_report' },
    { id: 'file_report', kind: 'tool', tool: 'report-filer', effect: 'spend', input: { n: '{{ len(steps.graph.output) }}' }, next: 'verify' },
    {
      id: 'verify', kind: 'check', assert: [{ expr: "steps.file_report.output.status == 'filed'", why: 'filed > 0 rows' }],
      on_fail: 'fail', next: 'summarise',
    },
    {
      id: 'summarise', kind: 'llm', prompt: 'Summarise {{ steps.file_report.output }}', max_iterations: 3,
      output_schema: { type: 'object' }, next: 'end',
    },
    { id: 'end', kind: 'end', output: '{{ steps.summarise.output }}' },
  ],
}
