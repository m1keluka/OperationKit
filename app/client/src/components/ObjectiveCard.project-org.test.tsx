// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Objective } from '@operationkit/shared'
import { ObjectiveCard } from './ObjectiveCard'

// Tests for project chip and org/workspace chip in All-Orgs view (obj 710597).

const base = {
  id: 1,
  title: 'Test objective',
  description: '',
  status: 'queue',
  type: 'task',
  effort: 'normal',
  category: 'general',
  agent_context: 'cto',
  workspace: 'example',
  project: null,
  project_id: null,
  project_name: null,
  project_color: null,
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
  model: null,
  ran_on_fallback: false,
  fallback_detected_at: null,
  ran_model: null,
  created_at: '2026-09-11T00:00:00Z',
  updated_at: '2026-09-11T00:00:00Z',
} as unknown as Objective

function render(o: Partial<Objective>, showOrgChip = false): string {
  return renderToStaticMarkup(
    <ObjectiveCard
      objective={{ ...base, ...o } as Objective}
      onOpenTerminal={() => {}}
      onEdit={() => {}}
      onChangeStatus={() => {}}
      showOrgChip={showOrgChip}
    />
  )
}

describe('ObjectiveCard — project chip (obj 710597)', () => {
  it('renders a project chip with the project name when project_name is present', () => {
    const html = render({ project_name: 'Alpha Project', project_id: 1 })
    expect(html).toContain('Alpha Project')
    expect(html).toContain('data-testid="project-chip"')
  })

  it('renders a color dot when project_color is set', () => {
    const html = render({ project_name: 'Alpha Project', project_id: 1, project_color: '#6366f1' })
    expect(html).toContain('#6366f1')
    expect(html).toContain('Alpha Project')
  })

  it('does NOT render a project chip when project_name is null', () => {
    const html = render({ project_name: null, project_id: null })
    expect(html).not.toContain('data-testid="project-chip"')
  })

  it('does NOT render a project chip when project_name is undefined', () => {
    const o = { ...base }
    delete (o as any).project_name
    const html = renderToStaticMarkup(
      <ObjectiveCard
        objective={o as Objective}
        onOpenTerminal={() => {}}
        onEdit={() => {}}
        onChangeStatus={() => {}}
      />
    )
    expect(html).not.toContain('data-testid="project-chip"')
  })
})

describe('ObjectiveCard — org chip in All-Organizations view (obj 710597)', () => {
  it('renders the org chip prominently (Building2 icon) when showOrgChip=true', () => {
    const html = render({ workspace: 'example' }, true)
    // chip present
    expect(html).toContain('data-testid="org-chip"')
    // content shows workspace name
    expect(html).toContain('example')
  })

  it('renders the org chip quietly (no icon wrapper) when showOrgChip=false', () => {
    const html = render({ workspace: 'example' }, false)
    expect(html).toContain('data-testid="org-chip"')
    expect(html).toContain('example')
  })

  it('shows both project chip and org chip in multi-org view', () => {
    const html = render({ workspace: 'example2', project_name: 'Beta', project_id: 2 }, true)
    expect(html).toContain('data-testid="project-chip"')
    expect(html).toContain('Beta')
    expect(html).toContain('data-testid="org-chip"')
    expect(html).toContain('example2')
  })
})
