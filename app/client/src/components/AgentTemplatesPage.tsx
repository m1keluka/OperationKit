import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { useAgents } from '../hooks/useAgents'
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  PageContainer,
  PageHeader,
  Skeleton,
  cn,
} from './ui'

/**
 * Agent templates gallery (obj 719986). Lists the templates available on this
 * install and the agents already on it; imports an agent file (upload or a
 * server folder) and exports any agent to a file. The marketplace itself is
 * out of scope — see docs/agents/marketplace.md for where it plugs in.
 */

interface Problem { field: string; message: string }

interface TemplateSummary {
  slug: string
  name: string
  description: string
  avatar: string | null
  colour: string | null
  version: string
  author: string
  tools: string[]
  knowledge_folders: string[]
  schedules: number
  source: 'starter' | 'local'
  installed: boolean
  installed_version: string | null
  update_available: boolean
}

interface InstalledAgent {
  slug: string
  name: string
  description: string
  version: string | null
  author: string | null
  origin: 'template' | 'import' | 'export' | null
  template_slug: string | null
  has_file: boolean
  archived: boolean
}

interface Gallery {
  templates: TemplateSummary[]
  installed: InstalledAgent[]
  problems: Array<{ path: string; errors: Problem[] }>
  import_roots: string[]
}

interface ParsedAgent {
  name: string
  slug: string
  description: string
  version: string
  author: string
  tools: string[]
  knowledge_folders: string[]
  schedules: unknown[]
}

type ValidateResult =
  | { ok: true; agent: ParsedAgent; warnings: Problem[] }
  | { ok: false; errors: Problem[]; warnings: Problem[] }

interface Pending {
  filename: string
  content: string
  result: ValidateResult
}

// Colour names from the agent file → the shipped agent identity tokens.
const COLOUR_TW: Record<string, string> = {
  blue: 'bg-agent-cto',
  pink: 'bg-agent-cmo',
  green: 'bg-agent-coo',
  amber: 'bg-agent-cfo',
  grey: 'bg-agent-general',
}

function monogram(t: { avatar: string | null; slug: string }): string {
  if (t.avatar) return t.avatar
  const p = t.slug.split('-').filter(Boolean)
  return (p.length >= 2 ? p[0][0] + p[1][0] : t.slug.slice(0, 2)).toUpperCase()
}

function readText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text()
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result ?? ''))
    r.onerror = () => reject(r.error)
    r.readAsText(file)
  })
}

function errorProblems(err: unknown): { message: string; errors: Problem[] } {
  const e = err as { message?: string; body?: { error?: string; errors?: Problem[] } }
  return { message: e.body?.error || e.message || 'Something went wrong', errors: e.body?.errors ?? [] }
}

function ProblemList({ items, tone }: { items: Problem[]; tone: 'alarm' | 'amber' }) {
  if (!items.length) return null
  return (
    <ul className={cn('mt-1.5 space-y-1 text-[12.5px]', tone === 'alarm' ? 'text-signal-alarm' : 'text-signal-amber')}>
      {items.map((p, i) => (
        <li key={i}>
          <span className="font-mono">{p.field}</span>
          <span className="text-fg-1"> — {p.message}</span>
        </li>
      ))}
    </ul>
  )
}

function TemplateCard({
  t,
  busy,
  onInstall,
}: {
  t: TemplateSummary
  busy: boolean
  onInstall: (t: TemplateSummary, overwrite: boolean) => void
}) {
  let action
  if (!t.installed) {
    action = <Button variant="primary" loading={busy} onClick={() => onInstall(t, false)}>Add agent</Button>
  } else if (t.update_available) {
    action = <Button variant="primary" loading={busy} onClick={() => onInstall(t, true)}>Update to v{t.version}</Button>
  } else {
    action = <Button variant="secondary" loading={busy} onClick={() => onInstall(t, true)}>Reinstall</Button>
  }
  return (
    <Card className="flex h-full flex-col transition-colors duration-200 hover:border-line-strong">
      <CardBody className="flex flex-1 flex-col gap-3">
        <div className="flex items-start gap-3">
          <span
            className={cn(
              'grid h-10 w-10 shrink-0 place-items-center rounded-md font-mono text-[13px] font-semibold text-surface-0',
              COLOUR_TW[t.colour ?? 'grey'] ?? COLOUR_TW.grey,
            )}
            aria-hidden="true"
          >
            {monogram(t)}
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="font-display text-[15px] font-semibold leading-snug text-fg-0">{t.name}</h3>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <Badge mono>v{t.version}</Badge>
              <Badge>{t.source === 'starter' ? 'Starter' : 'Local'}</Badge>
              {t.installed && <Badge tone="verify">Installed{t.installed_version ? ` · v${t.installed_version}` : ''}</Badge>}
            </div>
          </div>
        </div>
        <p className="text-[13px] leading-relaxed text-fg-1">{t.description}</p>
        <dl className="space-y-1.5 text-[12px]">
          {t.tools.length > 0 && (
            <div className="flex flex-wrap gap-1">
              <dt className="sr-only">Tools</dt>
              {t.tools.map(x => <dd key={x}><Badge mono>{x}</Badge></dd>)}
            </div>
          )}
          {t.knowledge_folders.length > 0 && (
            <div className="text-fg-2">
              <dt className="inline text-fg-3">Folders: </dt>
              <dd className="inline font-mono">{t.knowledge_folders.join(', ')}</dd>
            </div>
          )}
          {t.schedules > 0 && (
            <div className="text-fg-2">
              <dt className="inline text-fg-3">Schedules: </dt>
              <dd className="inline">{t.schedules} (added switched off)</dd>
            </div>
          )}
        </dl>
        <div className="mt-auto flex items-center justify-between gap-2 pt-1">
          <span className="truncate text-[12px] text-fg-3">by {t.author}</span>
          {action}
        </div>
      </CardBody>
    </Card>
  )
}

export function AgentTemplatesPage() {
  const { refresh: refreshRoster } = useAgents()
  const [data, setData] = useState<Gallery | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ tone: 'verify' | 'alarm'; text: string; errors?: Problem[] } | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [serverPath, setServerPath] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    try {
      setLoadError(null)
      setData(await api.get<Gallery>('/agent-templates'))
    } catch (err) {
      setLoadError(errorProblems(err).message)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const afterChange = async (text: string) => {
    setNotice({ tone: 'verify', text })
    await Promise.all([load(), refreshRoster()])
  }

  const install = async (t: TemplateSummary, overwrite: boolean) => {
    setBusy(`tpl:${t.slug}`)
    setNotice(null)
    try {
      await api.post(`/agent-templates/templates/${t.slug}/install`, { overwrite })
      await afterChange(`${t.name} ${overwrite ? 'updated' : 'added'}. It now appears in every agent picker.`)
    } catch (err) {
      const p = errorProblems(err)
      setNotice({ tone: 'alarm', text: p.message, errors: p.errors })
    } finally {
      setBusy(null)
    }
  }

  const onFile = async (file: File | undefined) => {
    if (!file) return
    setNotice(null)
    try {
      const content = await readText(file)
      const result = await api.post<ValidateResult>('/agent-templates/validate', { content, filename: file.name })
      setPending({ filename: file.name, content, result })
    } catch (err) {
      setNotice({ tone: 'alarm', text: errorProblems(err).message })
    }
  }

  const confirmImport = async (overwrite: boolean) => {
    if (!pending) return
    setBusy('import')
    try {
      const r = await api.post<{ slug: string; action: string }>('/agent-templates/import', {
        content: pending.content,
        filename: pending.filename,
        overwrite,
      })
      setPending(null)
      await afterChange(`Agent "${r.slug}" ${r.action === 'created' ? 'added' : 'updated'}.`)
    } catch (err) {
      const p = errorProblems(err)
      setNotice({ tone: 'alarm', text: p.message, errors: p.errors })
    } finally {
      setBusy(null)
    }
  }

  const importPath = async () => {
    if (!serverPath.trim()) return
    setBusy('path')
    setNotice(null)
    try {
      const r = await api.post<{ slug: string; action: string }>('/agent-templates/import', { path: serverPath.trim() })
      setServerPath('')
      await afterChange(`Agent "${r.slug}" ${r.action === 'created' ? 'added' : 'updated'} from ${serverPath.trim()}.`)
    } catch (err) {
      const p = errorProblems(err)
      setNotice({ tone: 'alarm', text: p.message, errors: p.errors })
    } finally {
      setBusy(null)
    }
  }

  const pendingExists = pending?.result.ok
    ? data?.installed.some(a => a.slug === (pending.result as { agent: ParsedAgent }).agent.slug && !a.archived)
    : false

  return (
    <PageContainer>
      <PageHeader
        title="Agent templates"
        breadcrumbs={[{ label: 'Agents', href: '/agents' }, { label: 'Templates' }]}
        description="Each agent is one file you can copy, share and re-import. Add a starter agent, import a file someone sent you, or export an agent to share it."
        actions={
          <>
            <input
              ref={fileInput}
              type="file"
              accept=".yaml,.yml,.md,text/yaml,text/markdown"
              className="sr-only"
              aria-label="Choose an agent file to import"
              onChange={e => { void onFile(e.target.files?.[0]); e.target.value = '' }}
            />
            <Button variant="primary" onClick={() => fileInput.current?.click()}>Import agent file</Button>
          </>
        }
      />

      {notice && (
        <Alert tone={notice.tone} className="mb-5">
          {notice.text}
          {notice.errors && <ProblemList items={notice.errors} tone="alarm" />}
        </Alert>
      )}

      {pending && (
        <Card className="mb-6">
          <CardBody>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <p className="text-[12px] text-fg-3">Checking <span className="font-mono">{pending.filename}</span></p>
                {pending.result.ok ? (
                  <>
                    <h2 className="mt-1 font-display text-[16px] font-semibold text-fg-0">
                      {pending.result.agent.name} <span className="font-mono text-[12px] font-normal text-fg-2">{pending.result.agent.slug}</span>
                    </h2>
                    <p className="mt-1 text-[13px] text-fg-1">{pending.result.agent.description}</p>
                    <p className="mt-1 text-[12px] text-fg-2">v{pending.result.agent.version} · by {pending.result.agent.author}</p>
                    {pendingExists && (
                      <p className="mt-2 text-[12.5px] text-signal-amber">An agent with this slug already exists. Replacing it overwrites its instructions.</p>
                    )}
                  </>
                ) : (
                  <p className="mt-1 text-[13px] font-medium text-signal-alarm">This file can't be imported yet. Fix these and try again:</p>
                )}
                {!pending.result.ok && <ProblemList items={pending.result.errors} tone="alarm" />}
                {pending.result.warnings.length > 0 && (
                  <>
                    <p className="mt-2 text-[12px] text-fg-3">Notes (the file still imports):</p>
                    <ProblemList items={pending.result.warnings} tone="amber" />
                  </>
                )}
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <Button variant="secondary" onClick={() => setPending(null)}>Cancel</Button>
                {pending.result.ok && (
                  <Button variant="primary" loading={busy === 'import'} onClick={() => void confirmImport(!!pendingExists)}>
                    {pendingExists ? 'Replace agent' : 'Add agent'}
                  </Button>
                )}
              </div>
            </div>
          </CardBody>
        </Card>
      )}

      {loadError && (
        <Alert tone="alarm" title="Couldn't load templates" className="mb-5">
          {loadError} <Button size="sm" variant="ghost" onClick={() => void load()}>Try again</Button>
        </Alert>
      )}

      <section aria-labelledby="tpl-available" className="mb-8">
        <h2 id="tpl-available" className="mb-3 font-display text-[16px] font-semibold text-fg-0">Available templates</h2>
        {!data && !loadError ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true">
            {[0, 1, 2].map(i => <Skeleton key={i} className="h-56 rounded-lg" />)}
          </div>
        ) : data && data.templates.length === 0 ? (
          <Card><EmptyState title="No templates on this server" description="Starter templates ship with Operation Kit. Drop agent files into the local templates folder to list them here." /></Card>
        ) : data ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {data.templates.map(t => (
              <TemplateCard key={t.slug} t={t} busy={busy === `tpl:${t.slug}`} onInstall={(x, o) => void install(x, o)} />
            ))}
          </div>
        ) : null}
        {data && data.problems.length > 0 && (
          <Alert tone="amber" title="Some template files could not be read" className="mt-4">
            {data.problems.map(p => (
              <div key={p.path} className="mt-1">
                <span className="font-mono text-[12px]">{p.path}</span>
                <ProblemList items={p.errors} tone="alarm" />
              </div>
            ))}
          </Alert>
        )}
      </section>

      <section aria-labelledby="tpl-installed" className="mb-8">
        <h2 id="tpl-installed" className="mb-3 font-display text-[16px] font-semibold text-fg-0">Agents on this install</h2>
        <Card>
          {!data ? (
            <CardBody><div className="space-y-3" aria-busy="true">{[0, 1, 2].map(i => <Skeleton key={i} className="h-10" />)}</div></CardBody>
          ) : data.installed.filter(a => !a.archived).length === 0 ? (
            <EmptyState compact title="No agents yet" description="Add a starter template above, or import an agent file." />
          ) : (
            <ul className="divide-y divide-line">
              {data.installed.filter(a => !a.archived).map(a => (
                <li key={a.slug} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="text-[13.5px] font-medium text-fg-0">
                      {a.name} <span className="font-mono text-[12px] font-normal text-fg-3">{a.slug}</span>
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      {a.version ? <Badge mono>v{a.version}</Badge> : <Badge>No file yet</Badge>}
                      {a.author && <span className="text-[12px] text-fg-2">by {a.author}</span>}
                      {a.origin === 'template' && <Badge tone="info">From template</Badge>}
                      {a.origin === 'import' && <Badge tone="info">Imported</Badge>}
                    </div>
                  </div>
                  <a
                    href={`/api/agent-templates/agents/${encodeURIComponent(a.slug)}/export`}
                    download={`${a.slug}.agent.yaml`}
                    className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-line bg-surface-1 px-4 text-[13px] font-medium text-fg-1 transition-colors duration-fast hover:border-line-strong hover:bg-surface-3 hover:text-fg-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 sm:min-h-[36px]"
                    aria-label={`Export ${a.name} as an agent file`}
                  >
                    Export
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      <section aria-labelledby="tpl-path">
        <h2 id="tpl-path" className="mb-1 font-display text-[16px] font-semibold text-fg-0">Import from a folder on the server</h2>
        <p className="mb-3 max-w-prose text-[13px] text-fg-2">
          For files already copied to this server. For safety, only these folders are allowed:{' '}
          {data ? data.import_roots.map((r, i) => (
            <span key={r}>{i > 0 && ', '}<span className="font-mono text-[12px] text-fg-1">{r}</span></span>
          )) : '…'}
        </p>
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={e => { e.preventDefault(); void importPath() }}
        >
          <label htmlFor="tpl-server-path" className="sr-only">Path to an agent file or folder</label>
          <input
            id="tpl-server-path"
            value={serverPath}
            onChange={e => setServerPath(e.target.value)}
            placeholder="…/agent-imports/my-agent/agent.yaml"
            className="min-h-[44px] flex-1 rounded-md border border-line bg-surface-1 px-3 font-mono text-[13px] text-fg-0 placeholder:text-fg-3 transition-colors duration-fast hover:border-line-strong focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 sm:min-h-[36px]"
          />
          <Button type="submit" loading={busy === 'path'} disabled={!serverPath.trim()}>Import</Button>
        </form>
      </section>
    </PageContainer>
  )
}
