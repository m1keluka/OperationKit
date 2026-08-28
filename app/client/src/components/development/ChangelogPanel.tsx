import { useCallback, useEffect, useState } from 'react'
import { Newspaper } from 'lucide-react'
import { Alert, Badge, Button, Card, CardBody, CardHeader, EmptyState, Skeleton } from '../ui'
import {
  listChangelog, notifyChangelog, publishChangelog, relativeTime, retranslateChangelog,
  type ChangelogEntryRow,
} from '../../lib/devItems'

/* Changelog tab (PRD §5.3) — the admin view: drafts and skipped entries are
   visible here (A12 returns everything), which is exactly the opposite of the
   public per-platform feed (P4). Publish / skip / retranslate / notify are
   A14 / A15 / A16. */
export function ChangelogPanel({ workspaces, search }: { workspaces: string[]; search: string }) {
  const [rows, setRows] = useState<ChangelogEntryRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)

  const load = useCallback(() => {
    listChangelog({ workspace: workspaces.length ? workspaces : undefined, q: search || undefined })
      .then(r => setRows(r.data))
      .catch(err => setError(err instanceof Error ? err.message : 'Could not load the changelog'))
  }, [workspaces, search])

  useEffect(() => { load() }, [load])

  const act = async (id: number, fn: () => Promise<unknown>) => {
    setBusyId(id)
    try { await fn(); load() } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed')
    } finally { setBusyId(null) }
  }

  if (error) return <Alert tone="alarm" title="Changelog">{error}</Alert>
  if (!rows) {
    return (
      <div className="flex flex-col gap-2">
        {[0, 1, 2].map(i => <Skeleton key={i} className="h-24 w-full rounded-lg" />)}
      </div>
    )
  }
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-line bg-surface-2">
        <EmptyState
          icon={<Newspaper className="h-5 w-5" strokeWidth={1.6} />}
          title="No changelog entries"
          description="Entries are drafted automatically when a PR that closes a DEV item merges."
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {rows.map(e => (
        <Card key={e.id}>
          <CardHeader
            title={e.headline}
            eyebrow={
              <span className="flex flex-wrap items-center gap-2">
                <Badge tone={e.status === 'published' ? 'verify' : e.status === 'draft' ? 'amber' : 'neutral'}>{e.status}</Badge>
                {e.category && <Badge tone="neutral">{e.category}</Badge>}
                {e.workspace && <span className="font-mono text-[11px] text-fg-3">{e.workspace}</span>}
                {e.repo && e.pr_number && (
                  <span className="font-mono text-[11px] text-fg-3">{e.repo}#{e.pr_number}</span>
                )}
                {e.dev_item_id && <span className="font-mono text-[11px] text-accent-hover">DEV-{e.dev_item_id}</span>}
              </span>
            }
            actions={
              <div className="flex flex-wrap gap-1.5">
                {e.status !== 'published' && (
                  <Button size="sm" loading={busyId === e.id} onClick={() => act(e.id, () => publishChangelog(e.id, 'publish'))}>Publish</Button>
                )}
                {e.status === 'published' && (
                  <Button size="sm" variant="secondary" loading={busyId === e.id} onClick={() => act(e.id, () => publishChangelog(e.id, 'unpublish'))}>Unpublish</Button>
                )}
                {e.status !== 'skipped' && (
                  <Button size="sm" variant="ghost" onClick={() => act(e.id, () => publishChangelog(e.id, 'skip'))}>Skip</Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => act(e.id, () => retranslateChangelog(e.id))}>Retranslate</Button>
                {e.status === 'published' && (
                  <Button size="sm" variant="ghost" onClick={() => act(e.id, () => notifyChangelog(e.id))}>
                    {e.notified_at ? 'Resend' : 'Notify'}
                  </Button>
                )}
              </div>
            }
          />
          <CardBody className="pt-0">
            {e.body_stakeholder && <p className="text-[13px] leading-relaxed text-fg-1">{e.body_stakeholder}</p>}
            {e.how_to && <p className="mt-2 text-[12.5px] text-fg-2"><span className="text-fg-3">How to use: </span>{e.how_to}</p>}
            <div className="mt-2 flex flex-wrap gap-x-4 font-mono text-[10.5px] text-fg-3">
              <span>merged {relativeTime(e.merged_at)}</span>
              <span>published {e.published_at ? relativeTime(e.published_at) : '—'}</span>
              <span>notified {e.notified_at ? relativeTime(e.notified_at) : '—'}</span>
              {e.title_eng && <span className="max-w-[40ch] truncate">eng: {e.title_eng}</span>}
            </div>
          </CardBody>
        </Card>
      ))}
    </div>
  )
}
