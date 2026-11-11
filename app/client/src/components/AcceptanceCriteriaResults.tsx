import type { ObjectiveReview } from '@operationkit/shared'
import { Card, Badge } from './ui'

// Per-criterion AI-review results (id / pass-fail / evidence) plus screenshots,
// surfaced in the SessionViewer Brief panel. Pure presentational component so it
// renders from a single `objective_reviews` row (the latest iteration). Mission
// Control tokens only — no raw colors.

export function AcceptanceCriteriaResults({ review }: { review: ObjectiveReview }) {
  if (!review.criteria_results.length && !review.screenshot_paths.length) return null
  return (
    <Card inset className="px-3 py-2">
      <div className="mb-1.5 flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-fg-3">
        <span>Acceptance Criteria Results</span>
        <span className="text-fg-3/80">iteration {review.iteration} · {review.mode}</span>
      </div>
      {review.criteria_results.length > 0 && (
        <div className="space-y-1">
          {review.criteria_results.map((r, i) => (
            <div key={`${r.criterion_id}-${i}`} className="flex items-start gap-2 text-xs">
              <Badge
                tone={r.status === 'pass' ? 'verify' : r.status === 'fail' ? 'alarm' : 'neutral'}
                className="mt-0.5 shrink-0 uppercase"
              >
                {r.status}
              </Badge>
              <div className="min-w-0">
                <span className="font-mono text-fg-2">{r.criterion_id}</span>
                {r.evidence && <span className="text-fg-1"> — {r.evidence}</span>}
                {r.screenshot_path && (
                  <a
                    href={r.screenshot_path}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-1 break-all text-accent hover:underline"
                  >
                    [screenshot]
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {review.screenshot_paths.length > 0 && (
        <div className="mt-2 border-t border-line pt-2">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-fg-3">Screenshots</div>
          <ul className="space-y-0.5">
            {review.screenshot_paths.map((p, i) => (
              <li key={`${p}-${i}`} className="text-xs">
                <a href={p} target="_blank" rel="noreferrer" className="break-all font-mono text-accent hover:underline">
                  {p}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  )
}
