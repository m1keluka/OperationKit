// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ObjectiveReview } from '@command-center/shared'
import { AcceptanceCriteriaResults } from './AcceptanceCriteriaResults'

// QW4 — prove the SessionViewer per-criterion results UI renders id / pass-fail /
// evidence rows plus screenshot links from a single objective_reviews row. The
// presentational component is extracted from SessionViewer (which renders
// <AcceptanceCriteriaResults review={reviews[reviews.length - 1]} />), so this is
// the exact markup the Brief panel shows.

const SAMPLE_REVIEW: ObjectiveReview = {
  id: 1,
  objective_id: 42,
  iteration: 2,
  reviewer_session_id: 'sess-rev',
  mode: 'browser',
  verdict: 'fail',
  criteria_results: [
    { criterion_id: 'crit-1', status: 'pass', evidence: 'INSERT writes parsed JSON', screenshot_path: null },
    { criterion_id: 'crit-2', status: 'fail', evidence: 'badge misaligned', screenshot_path: '/tmp/shots/review-2.png' },
  ],
  screenshot_paths: ['/tmp/shots/review-2.png', '/tmp/shots/overview.png'],
  markdown_body: '',
  feature_brief: '',
  cost_usd: 0,
  duration_ms: 0,
  created_at: '2026-06-16T00:00:00Z',
}

describe('AcceptanceCriteriaResults — SessionViewer per-criterion UI', () => {
  it('renders the per-criterion table + screenshots from a review row', () => {
    const html = renderToStaticMarkup(<AcceptanceCriteriaResults review={SAMPLE_REVIEW} />)

    // Header + iteration/mode
    expect(html).toContain('Acceptance Criteria Results')
    expect(html).toContain('iteration 2')
    expect(html).toContain('browser')
    // Per-criterion rows: ids, statuses, evidence
    expect(html).toContain('crit-1')
    expect(html).toContain('crit-2')
    expect(html).toContain('INSERT writes parsed JSON')
    expect(html).toContain('badge misaligned')
    expect(html).toMatch(/>pass</)
    expect(html).toMatch(/>fail</)
    // Screenshot links
    expect(html).toContain('href="/tmp/shots/review-2.png"')
    expect(html).toContain('href="/tmp/shots/overview.png"')

    // Emit the rendered markup as evidence.
    console.log('\n=== RENDERED criteria-results markup ===\n' + html)
  })

  it('renders nothing when the row carries no criteria/screenshots', () => {
    const empty = { ...SAMPLE_REVIEW, criteria_results: [], screenshot_paths: [] }
    expect(renderToStaticMarkup(<AcceptanceCriteriaResults review={empty} />)).toBe('')
  })
})
