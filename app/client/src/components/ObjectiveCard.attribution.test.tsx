// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Objective } from '@operationkit/shared'
import { ObjectiveCard } from './ObjectiveCard'

// Model-attribution badges (obj 701053): a Fable-selected objective whose
// transcript-derived main loop ran on Fable shows the positive 'Fable 5 ✓'
// chip; a real main-loop fallback shows the amber 'Fallback ⚠ ⚠' chip;
// sub-agent Opus usage alone (ran_on_fallback=0) never shows the warning.

const base = {
  id: 1,
  title: 'A fable objective',
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

describe('ObjectiveCard — model attribution badges (obj 701053)', () => {
  it("shows 'Fable 5 ✓' when the main loop verifiably ran on the requested Fable model", () => {
    const html = render({ ran_model: 'claude-fable-5' })
    expect(html).toContain('Fable 5 ✓')
    expect(html).not.toContain('Fallback ⚠')
  })

  it('shows the fallback warning ONLY for a real main-loop fallback', () => {
    const html = render({ ran_on_fallback: true, ran_model: 'claude-opus-4-8,claude-fable-5', fallback_detected_at: '2026-07-06 14:49:22' })
    expect(html).toContain('Fallback ⚠')
    expect(html).not.toContain('Fable 5 ✓')
  })

  it('shows NEITHER chip before any transcript attribution exists (ran_model null)', () => {
    const html = render({})
    expect(html).not.toContain('Fable 5 ✓')
    expect(html).not.toContain('Fallback ⚠')
  })

  it('does not stamp ✓ on non-Fable (default-model) objectives', () => {
    const html = render({ model: 'claude-opus-4-8', ran_model: 'claude-opus-4-8' } as Partial<Objective>)
    expect(html).not.toContain('Opus 4.8 ✓')
  })
})
