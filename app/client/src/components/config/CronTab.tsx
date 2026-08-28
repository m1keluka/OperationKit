/**
 * Cron Jobs Settings tab — extracted from ConfigPage.tsx (behavior frozen).
 */
import { useState, useEffect } from 'react'
import { Clock } from 'lucide-react'
import {
  Card, Badge, EmptyState, Skeleton,
} from '../ui'
import { api } from '../../lib/api'
import { formatBytes, formatName } from './config-form'

interface CronJob {
  name: string
  schedule: string
  scheduleHuman: string
  scriptPath: string
  logFile: string
  logTail: string
  logSize: number
  timezone: string
}

export function CronTab() {
  const [jobs, setJobs] = useState<CronJob[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedLog, setExpandedLog] = useState<string | null>(null)

  useEffect(() => {
    api.get<CronJob[]>('/admin/cron')
      .then(data => setJobs(Array.isArray(data) ? data : []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i} inset>
            <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-56" />
              </div>
              <Skeleton className="h-3 w-24" />
            </div>
          </Card>
        ))}
      </div>
    )
  }

  if (jobs.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<Clock className="h-5 w-5" />}
          title="No cron jobs found"
          description="Cron entries need a “# command-center: name” comment tag to appear here."
        />
      </Card>
    )
  }

  return (
    <div className="space-y-3">
      {jobs.map(job => (
        <Card key={job.name} inset>
          <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-display text-[14px] font-semibold text-fg-0">{formatName(job.name)}</h3>
                <Badge tone="verify">Active</Badge>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-fg-3">
                <span>{job.scheduleHuman}</span>
                {job.timezone !== 'UTC' && <Badge tone="neutral" mono>{job.timezone}</Badge>}
                <span className="font-mono text-[11px]">{job.schedule}</span>
              </div>
            </div>
            <div className="shrink-0 text-left font-mono text-[11px] text-fg-3 sm:text-right">
              <div>{job.scriptPath.split('/').pop()}</div>
              {job.logSize > 0 && <div className="mt-0.5">Log: {formatBytes(job.logSize)}</div>}
            </div>
          </div>
          {job.logTail && (
            <>
              <button
                onClick={() => setExpandedLog(expandedLog === job.name ? null : job.name)}
                className="w-full border-t border-line px-4 py-2 text-left text-[12px] text-fg-3 transition-colors hover:bg-surface-3"
              >
                {expandedLog === job.name ? 'Hide log' : 'Show log'} ({job.logTail.split('\n').length} lines)
              </button>
              {expandedLog === job.name && (
                <pre className="max-h-80 overflow-auto border-t border-line bg-surface-1 px-4 py-3 font-mono text-[11px] leading-relaxed text-fg-2">
                  {job.logTail}
                </pre>
              )}
            </>
          )}
        </Card>
      ))}
    </div>
  )
}
