/**
 * Objective Brief panel — extracted from SessionViewer.tsx (behavior frozen).
 */
import { GitPullRequest, GitMerge, GitPullRequestClosed } from 'lucide-react'
import type { Objective, ObjectiveReview, ObjectivePR } from '@operationkit/shared'
import { renderMarkdown } from '../../lib/markdown'
import { AcceptanceCriteriaResults } from '../AcceptanceCriteriaResults'
import { Card, Badge, cn } from '../ui'

export function BriefPanel({
  objective,
  reviews,
  prs,
}: {
  objective: Objective
  reviews: ObjectiveReview[]
  prs: ObjectivePR[]
}) {
  return (
    <div className="border-b border-line bg-surface-2/40">
      <div className="mx-auto max-w-4xl space-y-3 px-4 py-3">
        {/* Metadata row */}
        <div className="flex flex-wrap items-center gap-1.5">
          {objective.agent_context && (
            <Badge tone="accent" className="uppercase">{objective.agent_context.toUpperCase()}</Badge>
          )}
          {objective.category && <Badge tone="neutral">{objective.category}</Badge>}
          {objective.workspace && <Badge tone="neutral">{objective.workspace}</Badge>}
          {objective.project && <Badge tone="info">{objective.project}</Badge>}
          {objective.pr_url && (
            <a href={objective.pr_url} target="_blank" rel="noopener noreferrer" className="inline-flex">
              <Badge tone="verify" mono className="transition-colors hover:bg-signal-verify/20">
                <GitPullRequest className="h-2.5 w-2.5" />
                #{objective.pr_number || ''}
              </Badge>
            </a>
          )}
          {objective.branch_name && !objective.pr_url && (
            <Badge tone="neutral" mono>{objective.branch_name}</Badge>
          )}
        </div>

        {/* Stats row */}
        <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-fg-3">
          {Number(objective.session_count) > 0 && (
            <span>{objective.session_count} session{objective.session_count !== 1 ? 's' : ''}</span>
          )}
          {Number(objective.total_cost_usd) > 0 && (
            <span>${Number(objective.total_cost_usd).toFixed(2)} spent</span>
          )}
          {Number(objective.total_tokens) > 0 && (
            <span>{(Number(objective.total_tokens) / 1000).toFixed(0)}k tokens</span>
          )}
        </div>

        {/* Last session summary */}
        {objective.last_session_summary && (
          <Card inset className="px-3 py-2">
            <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-fg-3">Last Session Summary</div>
            <div className="text-xs leading-relaxed text-fg-1">{objective.last_session_summary}</div>
          </Card>
        )}

        {/* Approved plan from the planning stage */}
        {objective.approved_plan && (
          <Card inset className="border-status-planning/30 bg-status-planning/[0.06] px-3 py-2">
            <div className="mb-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-status-planning">
              <span>Approved Plan</span>
              {objective.plan_approved_at && (
                <span className="font-normal text-fg-3">approved {objective.plan_approved_at.slice(0, 16).replace('T', ' ')}</span>
              )}
            </div>
            <div
              className="max-h-64 overflow-y-auto rounded bg-surface-0/50 px-2 py-1.5 text-xs leading-relaxed text-fg-1"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(objective.approved_plan) }}
            />
          </Card>
        )}

        {/* AI Review findings */}
        {objective.ai_review_findings && (() => {
          const verdict = objective.ai_review_verdict
          const tone = verdict === 'pass' ? 'verify' : verdict === 'fail' ? 'alarm' : 'amber'
          const ring = verdict === 'pass' ? 'border-signal-verify/30 bg-signal-verify/[0.07]'
            : verdict === 'fail' ? 'border-signal-alarm/30 bg-signal-alarm/[0.07]'
            : 'border-signal-amber/30 bg-signal-amber/[0.07]'
          return (
            <Card inset className={cn('px-3 py-2', ring)}>
              <div className="mb-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-fg-2">
                <span>AI Review Findings</span>
                <Badge tone={tone} className="uppercase">{verdict || '—'}</Badge>
              </div>
              <div
                className="max-h-64 overflow-y-auto rounded bg-surface-0/50 px-2 py-1.5 text-xs leading-relaxed text-fg-1"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(objective.ai_review_findings) }}
              />
            </Card>
          )
        })()}

        {/* AI Review — per-criterion results (latest iteration) */}
        {reviews.length > 0 && (
          <AcceptanceCriteriaResults review={reviews[reviews.length - 1]} />
        )}

        {/* Pull Requests — full per-objective PR log (obj 2300). Every PR opened
            from this objective, newest-first, each a link with a live state badge.
            Hidden entirely when there are none. */}
        {prs.length > 0 && (
          <Card inset className="px-3 py-2">
            <div className="mb-1.5 flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-fg-3">
              <GitPullRequest className="h-3 w-3" />
              <span>Pull Requests</span>
              <span className="text-fg-3/70">{prs.length}</span>
            </div>
            <ul className="space-y-1">
              {prs.map(pr => {
                const tone = pr.state === 'merged' ? 'accent' : pr.state === 'closed' ? 'alarm' : 'info'
                const StateIcon = pr.state === 'merged' ? GitMerge : pr.state === 'closed' ? GitPullRequestClosed : GitPullRequest
                return (
                  <li key={pr.id}>
                    <a
                      href={pr.pr_url || '#'}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group flex items-center gap-2 rounded px-1.5 py-1 transition-colors hover:bg-surface-3/60"
                    >
                      <StateIcon className="h-3.5 w-3.5 shrink-0 text-fg-3" />
                      <span className="shrink-0 font-mono text-xs text-fg-2 group-hover:text-fg-0">#{pr.pr_number}</span>
                      <span className="min-w-0 flex-1 truncate text-xs text-fg-1 group-hover:text-fg-0">
                        {pr.title || pr.branch_name || pr.repo || 'Pull request'}
                      </span>
                      <Badge tone={tone} className="shrink-0 uppercase">{pr.state}</Badge>
                    </a>
                  </li>
                )
              })}
            </ul>
          </Card>
        )}

        {/* Description */}
        {objective.description ? (
          <div>
            <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-fg-3">Description</div>
            <div
              className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg bg-surface-0/50 px-3 py-2 font-mono text-sm leading-relaxed text-fg-1"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(objective.description) }}
            />
          </div>
        ) : (
          <p className="text-sm italic text-fg-3">No description</p>
        )}
      </div>
    </div>
  )
}
