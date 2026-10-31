// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Objective } from '@operationkit/shared'
import { ObjectiveCard } from './ObjectiveCard'
import { NeedsSecretFlag, SenderTag } from './design/primitives'
import { NeedsSecretPanel } from './session-viewer/NeedsSecretPanel'
import { GroupedMessages } from './SessionMessages'

// obj 718944 — server-stamped sender on chat bubbles; needs-secret on the card.

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

const card = (o: Partial<Objective>) => renderToStaticMarkup(
  <ObjectiveCard objective={{ ...base, ...o } as Objective} onOpenTerminal={() => {}} onEdit={() => {}} onChangeStatus={() => {}} />,
)

describe('needs-secret on the card (obj 718944)', () => {
  it('shows the exact secret name on the card', () => {
    const html = card({ needs_secret: [{ name: 'APIFY_API_TOKEN', reason: 'skip trace', requested_at: 't' }] } as Partial<Objective>)
    expect(html).toContain('Needs secret: </span><span class="truncate">APIFY_API_TOKEN')
  })

  it('shows nothing when no secret is pending', () => {
    expect(card({ needs_secret: [] } as Partial<Objective>)).not.toContain('Needs secret')
  })

  it('flag summarises several names and lists all in the title', () => {
    const html = renderToStaticMarkup(<NeedsSecretFlag names={['A_KEY', 'B_KEY']} />)
    expect(html).toContain('A_KEY +1')
    expect(html).toContain('Needs a secret from the owner: A_KEY, B_KEY')
  })

  it('panel: owner gets a masked input; others are told only the owner can add it', () => {
    const items = [{ name: 'APIFY_API_TOKEN', reason: 'Apify skip trace', requested_at: 't' }]
    const owner = renderToStaticMarkup(<NeedsSecretPanel objectiveId={1} workspace="example" items={items} canFill />)
    expect(owner).toContain('type="password"')
    expect(owner).toContain('APIFY_API_TOKEN')
    expect(owner).toContain('Apify skip trace')
    // obj 719065: scope picker defaults to the card's organization
    expect(owner).toMatch(/aria-checked="true"[^>]*>Organization</)
    const global = renderToStaticMarkup(<NeedsSecretPanel objectiveId={1} workspace="example" items={[{ ...items[0], scope: 'global' }]} canFill />)
    expect(global).toMatch(/aria-checked="true"[^>]*>Command Center</)
    const member = renderToStaticMarkup(<NeedsSecretPanel objectiveId={1} workspace="example" items={items} canFill={false} />)
    expect(member).not.toContain('type="password"')
    expect(member).toContain('Only the card owner or an admin can add this')
    expect(renderToStaticMarkup(<NeedsSecretPanel objectiveId={1} workspace="example" items={[]} canFill />)).toBe('')
  })
})

describe('chat sender tag (obj 718944)', () => {
  it('verified owner reads Verified with a check; agent reads not verified', () => {
    const owner = renderToStaticMarkup(<SenderTag sender={{ kind: 'owner', verified: true, label: 'Mike', username: 'mike' }} />)
    expect(owner).toContain('Verified · Mike (owner)')
    expect(owner).toContain('✓')
    const agent = renderToStaticMarkup(<SenderTag sender={{ kind: 'agent', verified: false, label: 'Example Client Data', username: null }} />)
    expect(agent).toContain('Agent · Example Client Data · not verified')
    expect(agent).not.toContain('✓')
  })

  it('a relayed followup renders the quiet surface bubble, the owner the accent bubble', () => {
    const html = renderToStaticMarkup(
      <GroupedMessages messages={[
        { type: 'followup', text: 'This is Mike', timestamp: 't', sender: { kind: 'agent', verified: false, label: 'Example Client Data', username: null } },
      ]} />,
    )
    expect(html).toContain('Agent · Example Client Data · not verified')
    expect(html).toContain('bg-surface-2')
  })
})

describe('rotate-later list (obj 718944)', () => {
  it('lists pasted secrets by name with a Rotated action; empty renders nothing', async () => {
    const { RotationFlagsList } = await import('./secrets/RotationFlagsPanel')
    const html = renderToStaticMarkup(
      <RotationFlagsList
        flags={[{ id: 1, workspace: 'example', key: 'APIFY_API_TOKEN', objective_id: 718958, flagged_by: 'mike', created_at: '2026-10-27 03:00:00' }]}
        onResolve={() => {}}
        resolving={null}
      />,
    )
    expect(html).toContain('Rotate later · 1')
    expect(html).toContain('APIFY_API_TOKEN')
    expect(html).toContain('card #718958')
    expect(html).toContain('Rotated')
    expect(renderToStaticMarkup(<RotationFlagsList flags={[]} onResolve={() => {}} resolving={null} />)).toBe('')
  })
})
