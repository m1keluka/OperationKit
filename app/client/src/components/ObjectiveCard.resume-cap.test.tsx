// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Objective } from '@operationkit/shared'
import { ObjectiveCard } from './ObjectiveCard'

// obj 64 — card badge for a capped (fresh-seeded) restart.

const base = {
  id: 1,
  title: 'A long-running objective',
  description: '',
  status: 'working',
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
  model: 'claude-fable-5',
  ran_on_fallback: false,
  fallback_detected_at: null,
  ran_model: null,
  created_at: '2026-07-07T00:00:00Z',
  updated_at: '2026-07-07T00:00:00Z',
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

// obj 64 (Part A): when a respawn skipped `--resume` because the session chain hit
// the history cap, the card says so (objectives.last_start_reason).
describe('ObjectiveCard — fresh start after history cap (obj 64)', () => {
  it('shows the badge when the last start was fresh_seeded_after_cap', () => {
    const html = render({ last_start_reason: 'fresh_seeded_after_cap' })
    expect(html).toContain('data-testid="fresh-after-cap"')
    expect(html).toContain('fresh start · history capped')
  })

  it('shows nothing for ordinary start reasons', () => {
    expect(render({ last_start_reason: 'follow_up' })).not.toContain('fresh-after-cap')
    expect(render({ last_start_reason: null })).not.toContain('fresh-after-cap')
  })
})
