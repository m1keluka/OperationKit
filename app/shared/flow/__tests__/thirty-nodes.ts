// A 30-node okflow/1 definition for the viewer V2 layout test (card B7: "a
// 30-node flow lays out without overlap") and the B7 smoke screenshots. It uses
// every structure the canvas has to place: a branch with case + default blocks,
// two loops (one with a branch inside its body), an approval wait guarding a
// send, write/send/spend effects, llm and agent nodes.
import type { FlowDefinition } from '../types.js'

export const THIRTY_NODE_FLOW: FlowDefinition = {
  apiVersion: 'okflow/1',
  id: 'weekly-account-review',
  name: 'Weekly account review (30 nodes)',
  workspace: 'acme',
  version: 2,
  goal: {
    statement: 'Every active account is scored and the owner approved the summary that went out.',
    end_condition: { assert: [{ expr: 'len(steps.score_each.output) == len(steps.accounts.output.items)', why: 'nothing dropped' }] },
  },
  budget: { run_usd: 2 },
  nodes: [
    { id: 'start', kind: 'trigger', on: 'schedule', schedule: { cron: '0 7 * * 1' }, next: 'accounts' },
    { id: 'accounts', kind: 'tool', tool: 'crm-accounts-list', effect: 'read', retry: { max: 3, backoff: 'exponential', delay_ms: 2000 },
      mock: { output: { items: [{ id: 'a1', tier: 'gold' }] } }, next: 'usage' },
    { id: 'usage', kind: 'tool', tool: 'usage-metrics', effect: 'read', input: { since: '{{ date_add(now(), -7, \'day\') }}' }, next: 'route' },
    {
      id: 'route', kind: 'branch',
      cases: [
        { when: 'len(steps.accounts.output.items) == 0', then: ['note_empty', 'stop_empty'] },
        { when: 'len(steps.accounts.output.items) > 150', then: ['split_batches', 'warn_large'] },
      ],
      default: ['normalize'],
      next: 'score_each',
    },
    { id: 'note_empty', kind: 'tool', tool: 'log-note', effect: 'write', mock: { output: { ok: true } } },
    { id: 'stop_empty', kind: 'check', assert: [{ expr: 'true', why: 'empty week is fine' }], on_fail: 'continue' },
    { id: 'split_batches', kind: 'tool', tool: 'batch-split', effect: 'read' },
    { id: 'warn_large', kind: 'mcp', connector: 'slack', tool: 'post_message', effect: 'send',
      arguments: { channel: '#ops', text: 'large week' }, mock: { output: { ok: true } } },
    { id: 'normalize', kind: 'tool', tool: 'accounts-normalize', effect: 'read' },
    {
      id: 'score_each', kind: 'loop', label: 'Score every account', over: '{{ steps.accounts.output.items }}', as: 'acct', max_items: 200,
      body: ['enrich', 'score', 'tier_gate', 'save_score'], next: 'score_check',
    },
    { id: 'enrich', kind: 'mcp', connector: 'clearbit', tool: 'company_lookup', effect: 'read', arguments: { id: '{{ item.acct.id }}' } },
    { id: 'score', kind: 'llm', model: 'default', max_iterations: 2, budget_usd: 0.02,
      prompt: 'Score account {{ item.acct.id }} 0-100.', output_schema: { type: 'object', properties: { score: { type: 'number' } }, required: ['score'] } },
    {
      id: 'tier_gate', kind: 'branch',
      cases: [{ when: 'steps.score.output.score < 30', then: ['flag_risk'] }],
    },
    { id: 'flag_risk', kind: 'tool', tool: 'crm-flag', effect: 'write', mock: { output: { ok: true } } },
    { id: 'save_score', kind: 'mcp', connector: 'crm', tool: 'update_field', effect: 'write',
      arguments: { id: '{{ item.acct.id }}', score: '{{ steps.score.output.score }}' }, mock: { output: { ok: true } } },
    { id: 'score_check', kind: 'check', assert: [{ expr: 'len(steps.score_each.output) > 0', why: 'scores written' }], on_fail: 'repair', next: 'contacts' },
    { id: 'contacts', kind: 'tool', tool: 'crm-contacts-list', effect: 'read', next: 'contact_each' },
    {
      id: 'contact_each', kind: 'loop', over: '{{ steps.contacts.output.items }}', as: 'c', max_items: 100, concurrency: 1,
      body: ['dedupe', 'verify_email', 'tag_contact'], next: 'summarize',
    },
    { id: 'dedupe', kind: 'tool', tool: 'contact-dedupe', effect: 'read' },
    { id: 'verify_email', kind: 'tool', tool: 'email-verify', effect: 'spend', mock: { output: { valid: true } } },
    { id: 'tag_contact', kind: 'mcp', connector: 'crm', tool: 'tag_contact', effect: 'write', mock: { output: { ok: true } } },
    { id: 'summarize', kind: 'llm', max_iterations: 1, budget_usd: 0.05, prompt: 'Summarise the week.',
      output_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, next: 'deep_dive' },
    { id: 'deep_dive', kind: 'agent', brief: 'Investigate the three lowest-scoring accounts.', agent: 'general', budget_usd: 1, next: 'report_doc' },
    { id: 'report_doc', kind: 'mcp', connector: 'gdocs', tool: 'create_doc', effect: 'write', mock: { output: { url: 'https://example.test/doc' } }, next: 'cool_off' },
    { id: 'cool_off', kind: 'wait', for: '15m', next: 'owner_ok' },
    { id: 'owner_ok', kind: 'wait', approval: { from: 'owner', prompt: 'Send the weekly summary?' }, next: 'post_summary' },
    { id: 'post_summary', kind: 'mcp', connector: 'slack', tool: 'post_message', effect: 'send',
      arguments: { channel: '#accounts', text: '{{ steps.summarize.output.text }}' }, mock: { output: { ok: true } }, next: 'archive' },
    { id: 'archive', kind: 'tool', tool: 'archive-run', effect: 'write', mock: { output: { ok: true } }, next: 'final_check' },
    { id: 'final_check', kind: 'check', assert: [{ expr: 'steps.post_summary.output.ok == true', why: 'summary posted' }], next: 'done' },
    { id: 'done', kind: 'end', output: '{{ steps.score_each.output }}' },
  ],
}
