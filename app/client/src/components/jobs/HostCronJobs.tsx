/**
 * Host cron jobs — a section of the Jobs page (obj 900495; was Settings → Platform).
 *
 * These are entries in the server's own crontab (shell scripts the host runs on a
 * schedule, outside the app's routine scheduler) that carry a
 * `# command-center: <name>` tag. They are listed read-only so every scheduled
 * thing on the install is visible in one place.
 *
 * The old full-card "No cron jobs found" empty state is gone: most installs have
 * none, so an empty list collapses to one explanatory line.
 */
import { useState, useEffect } from 'react'
import { Server } from 'lucide-react'
import { Card, Badge, Skeleton } from '../ui'
import { api } from '../../lib/api'
import { formatBytes, formatName } from '../config/config-form'
import { HOST_CRON_ANCHOR } from '../../lib/routes'

export interface CronJob {
  name: string
  schedule: string
  scheduleHuman: string
  scriptPath: string
  logFile: string
  logTail: string
  logSize: number
  timezone: string
}

export const HOST_CRON_EXPLAINER =
  'Scripts in this server’s crontab that run on their own schedule, outside the routine scheduler above — backups, cleanup, health checks. Only entries tagged “# command-center: <name>” are listed. Edit them on the host.'

export function HostCronJobs({ initial }: { initial?: CronJob[] } = {}) {
  const [jobs, setJobs] = useState<CronJob[]>(initial ?? [])
  const [loading, setLoading] = useState(!initial)
  const [failed, setFailed] = useState(false)
  const [expandedLog, setExpandedLog] = useState<string | null>(null)

  useEffect(() => {
    if (initial) return
    api.get<CronJob[]>('/admin/cron')
      .then(data => setJobs(Array.isArray(data) ? data : []))
      .catch(() => setFailed(true))
      .finally(() => setLoading(false))
  }, [initial])

  return (
    <section id={HOST_CRON_ANCHOR} aria-labelledby="host-cron-heading" className="mb-6 scroll-mt-4 space-y-2">
      <h3
        id="host-cron-heading"
        className="flex items-center gap-2 font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-fg-3"
      >
        <Server className="h-3.5 w-3.5" strokeWidth={1.75} /> Host cron jobs
        {!loading && <span className="font-mono text-fg-3">{jobs.length}</span>}
      </h3>
      <p className="max-w-3xl text-[12.5px] leading-snug text-fg-2">{HOST_CRON_EXPLAINER}</p>

      {loading ? (
        <Card inset>
          <div className="space-y-2 p-4">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-56" />
          </div>
        </Card>
      ) : failed ? (
        <p className="text-[12.5px] text-signal-amber">Couldn’t read the host crontab from the server.</p>
      ) : jobs.length === 0 ? (
        <p data-testid="host-cron-none" className="text-[12.5px] text-fg-3">None tagged on this server.</p>
      ) : (
        <div className="space-y-3">
          {jobs.map(job => (
            <Card key={job.name} inset>
              <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="font-display text-[14px] font-semibold text-fg-0">{formatName(job.name)}</h4>
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
                    aria-expanded={expandedLog === job.name}
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
      )}
    </section>
  )
}
