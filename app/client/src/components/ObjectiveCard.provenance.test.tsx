// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Objective } from '@operationkit/shared'
import { ObjectiveCard } from './ObjectiveCard'

// prov-ui (obj 2386): the board card must VISIBLY differentiate a
// strategy-invoked objective from a manual one. Manual is the unmarked baseline;
// origin='strategy' renders the STRATEGY-INVOKED chip; origin='routine'/'job_reply'
// render their own chips. Proven at the DOM level via the real card component.

const base = {
  id: 1,
  title: 'An objective',
  description: '',
  status: 'queue',
  type: 'task',
  effort: 'normal',
  category: 'general',
  agent_context: 'cto',
  workspace: 'example',
  project: null,
  parent_id: null,
  is_strategy: false,
  delegate_mode: false,
  has_blockers: false,
  create_pr: false,
  skip_ai_review: false,
  created_by: 1,
  session_id: null,
  transcript_path: null,
  last_session_summary: null,
  session_count: 0,
  total_cost_usd: 0,
  total_tokens: 0,
  branch_name: null,
  pr_url: null,
  pr_number: null,
  assigned_user_id: null,
  assigned_user_ids: [],
  created_at: '2026-06-29T00:00:00Z',
  updated_at: '2026-06-29T00:00:00Z',
} as unknown as Objective

function render(o: Partial<Objective>): string {
  return renderToStaticMarkup(
    <ObjectiveCard
      objective={{ ...base, ...o } as Objective}
      onOpenTerminal={() => {}}
      onEdit={() => {}}
      onChangeStatus={() => {}}
    />
  )
}

describe('ObjectiveCard — provenance badge (obj 2386)', () => {
  it('renders the STRATEGY-INVOKED chip for origin=strategy', () => {
    const html = render({ origin: 'strategy' })
    expect(html).toContain('STRATEGY-INVOKED')
  })

  it('renders NO origin chip for a manual objective (unmarked baseline)', () => {
    const html = render({ origin: 'manual' })
    expect(html).not.toContain('STRATEGY-INVOKED')
    expect(html).not.toContain('ROUTINE')
    expect(html).not.toContain('FROM JOB')
  })

  it('renders the ROUTINE chip for origin=routine', () => {
    expect(render({ origin: 'routine' })).toContain('ROUTINE')
  })

  it('renders the FROM JOB chip for origin=job_reply', () => {
    expect(render({ origin: 'job_reply' })).toContain('FROM JOB')
  })

  it('does NOT show the origin chip on a row that is itself a Strategy', () => {
    // A Strategy already carries the STRATEGY badge; the origin chip is suppressed.
    const html = render({ origin: 'strategy', is_strategy: true })
    expect(html).toContain('STRATEGY') // the tier badge
    expect(html).not.toContain('STRATEGY-INVOKED') // not the origin chip
  })
})
