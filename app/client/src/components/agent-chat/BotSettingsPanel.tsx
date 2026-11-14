import { useMemo, useState } from 'react'
import { api } from '../../lib/api'
import { Alert, Button, cn } from '../ui'
import { HighAgencySection } from './HighAgencySection'
import { WorkspaceAccessSection } from './WorkspaceAccessSection'
import {
  PROVIDER_LABELS,
  type AgentsResponse,
  type BotConfigPatch,
  type ChatAgentInfo,
  type ProviderId,
  type ToolCatalogEntry,
  type ToolGroup,
} from './types'

/* A bot's settings, on the bot's own page (obj 900671).

   Before this, a bot's model, provider and tools could only be changed by
   editing its agent file on the server. Now an admin sets them here:
     - Default model (+ AI provider): which model answers this bot.
     - Tools: tick exactly the tools this bot may use, or switch on
       "All tools" to give it every tool, including ones added later.
   Saving writes an override on the server (the agent file is never touched);
   "Reset to file" removes the override. Everyone else sees the same panel
   read-only, so a person can tell what a bot can do before asking it.

   High Agency (obj 900748) sits at the bottom with its own Save: it is a
   schedule, not a model/tools override, so "Reset to file" never touches it. */

const GROUP_LABELS: Record<ToolGroup, string> = {
  web: 'Web',
  knowledge: 'Knowledge',
  board: 'Board',
  connectors: 'Email & calendar',
  integrations: 'Integrations',
  secrets: 'Secrets',
}

const GROUP_ORDER: ToolGroup[] = ['web', 'knowledge', 'board', 'connectors', 'integrations', 'secrets']

const PROVIDERS: ProviderId[] = ['claude', 'anthropic', 'openai', 'xai', 'openai-compatible', 'demo']

type Meta = Pick<AgentsResponse, 'tool_catalog' | 'model_suggestions' | 'default_models' | 'web' | 'providers'>

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const s = new Set(a)
  return b.every(x => s.has(x))
}

export function BotSettingsPanel({
  agent,
  meta,
  isAdmin,
  onSaved,
  onClose,
}: {
  agent: ChatAgentInfo
  meta: Meta
  isAdmin: boolean
  onSaved: (agent: ChatAgentInfo) => void
  onClose: () => void
}) {
  const catalog: ToolCatalogEntry[] = meta.tool_catalog ?? []
  const fileDefaults = agent.file_defaults ?? { provider: agent.provider, model: agent.model, tools: agent.tools }
  const cfg = agent.config ?? null

  const [provider, setProvider] = useState<ProviderId | ''>(cfg?.provider ?? '')
  const [model, setModel] = useState<string>(cfg?.model ?? '')
  const [allTools, setAllTools] = useState<boolean>(agent.all_tools ?? false)
  const [tools, setTools] = useState<string[]>(() => {
    const base = cfg?.tools ?? fileDefaults.tools
    return base.filter(t => catalog.some(c => c.name === t))
  })
  const [saving, setSaving] = useState(false)
  // obj 900797: a grant/revoke can change where High Agency may wake (or switch
  // it off), so the High Agency section reloads after one.
  const [accessVersion, setAccessVersion] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // The provider a turn would use if saved now: the picked one, else the one
  // answering today (the file's, the install default, or automatic).
  const effectiveProvider: ProviderId = provider || fileDefaults.provider || agent.answered_by.id
  const suggestions = meta.model_suggestions?.[effectiveProvider] ?? []
  const modelFallback = fileDefaults.model || meta.default_models?.[effectiveProvider] || ''
  const datalistId = `bot-model-suggestions-${agent.slug}`

  const byGroup = useMemo(() => {
    const m = new Map<ToolGroup, ToolCatalogEntry[]>()
    for (const t of catalog) m.set(t.group, [...(m.get(t.group) ?? []), t])
    return GROUP_ORDER.filter(g => m.has(g)).map(g => ({ group: g, tools: m.get(g)! }))
  }, [catalog])

  const webPicked = allTools || tools.includes('web_search')
  const webMissing = webPicked && meta.web && !meta.web.available

  const toggle = (name: string) => {
    setSaved(false)
    setTools(cur => (cur.includes(name) ? cur.filter(t => t !== name) : [...cur, name]))
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    setSaved(false)
    // A file that says `tools: [all]` would win back over a null override, so
    // switching "All tools" off for such a bot must always send the explicit list.
    const fileAll = fileDefaults.tools.some(t => t === 'all' || t === '*')
    const body: BotConfigPatch = {
      provider: provider || null,
      model: model.trim() || null,
      all_tools: allTools,
      // Same as the file → no override, so a later file change still applies.
      tools: !fileAll && sameSet(tools, fileDefaults.tools.filter(t => catalog.some(c => c.name === t))) ? null : tools,
    }
    try {
      const r = await api.put<{ agent: ChatAgentInfo }>(`/agent-chat/agents/${encodeURIComponent(agent.slug)}/config`, body)
      onSaved(r.agent)
      setSaved(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save these settings')
    } finally {
      setSaving(false)
    }
  }

  const reset = async () => {
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const r = await api.del<{ agent: ChatAgentInfo }>(`/agent-chat/agents/${encodeURIComponent(agent.slug)}/config`)
      setProvider('')
      setModel('')
      setAllTools(r.agent.all_tools ?? false)
      setTools(r.agent.tools.filter(t => catalog.some(c => c.name === t)))
      onSaved(r.agent)
      setSaved(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reset this bot')
    } finally {
      setSaving(false)
    }
  }

  const inputCls =
    'min-h-[40px] w-full rounded-md border border-line bg-surface-0 px-2 text-[13px] text-fg-0 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-60'
  const enabledNames = new Set(agent.effective_tools ?? agent.tools)

  return (
    <section aria-label={`Settings for ${agent.name}`} className="border-b border-line bg-surface-1 px-3 py-3 sm:px-6">
      <div className="mx-auto flex max-w-[760px] flex-col gap-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-display text-[14px] font-semibold text-fg-0">Bot settings</h3>
          {/* A real, visible button (Operator's 2026-11-12 walkthrough: the old ghost
              "Done" read as plain text on this surface, so he closed the panel
              with the header Settings toggle instead). Secondary, not primary,
              so it never competes with Save below; the `!` overrides are needed
              because cn() does not de-dupe the secondary variant's own fill/border/text. */}
          <Button
            variant="secondary"
            size="sm"
            onClick={onClose}
            aria-label={`Done: close settings for ${agent.name}`}
            className="min-h-[44px] min-w-[72px] font-medium sm:min-h-0 !border-line-strong !bg-surface-2 !text-fg-0 hover:!bg-surface-3"
          >
            Done
          </Button>
        </div>

        {!isAdmin && (
          <p className="text-[12px] text-fg-2">Only an admin can change a bot&apos;s model or tools.</p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor={`bot-model-${agent.slug}`} className="mb-1 block text-[12px] font-medium text-fg-1">Default model</label>
            <input
              id={`bot-model-${agent.slug}`}
              list={datalistId}
              value={model}
              disabled={!isAdmin || saving}
              placeholder={modelFallback ? `${modelFallback} (default)` : 'Model id'}
              onChange={e => { setModel(e.target.value); setSaved(false) }}
              className={inputCls}
            />
            <datalist id={datalistId}>
              {suggestions.map(m => <option key={m} value={m} />)}
            </datalist>
            <p className="mt-1 text-[12px] text-fg-2">
              Answers now with <span className="text-fg-1">{PROVIDER_LABELS[agent.answered_by.id]}{agent.answered_by.model ? ` · ${agent.answered_by.model}` : ''}</span>. Leave empty for the default.
            </p>
          </div>
          <div>
            <label htmlFor={`bot-provider-${agent.slug}`} className="mb-1 block text-[12px] font-medium text-fg-1">AI provider</label>
            <select
              id={`bot-provider-${agent.slug}`}
              value={provider}
              disabled={!isAdmin || saving}
              onChange={e => { setProvider(e.target.value as ProviderId | ''); setSaved(false) }}
              className={inputCls}
            >
              <option value="">{fileDefaults.provider ? `${PROVIDER_LABELS[fileDefaults.provider]} (from the bot file)` : 'Automatic (install default)'}</option>
              {PROVIDERS.map(p => (
                <option key={p} value={p}>
                  {PROVIDER_LABELS[p]}{meta.providers && !meta.providers[p] ? ' — not set up' : ''}
                </option>
              ))}
            </select>
          </div>
        </div>

        <fieldset className="flex flex-col gap-2" disabled={!isAdmin || saving}>
          <legend className="mb-1 text-[12px] font-medium text-fg-1">Tools</legend>
          <label className="flex items-start gap-2 rounded-md border border-line bg-surface-0 px-3 py-2">
            <input
              type="checkbox"
              checked={allTools}
              onChange={e => { setAllTools(e.target.checked); setSaved(false) }}
              className="mt-0.5"
              aria-describedby={`bot-all-tools-help-${agent.slug}`}
            />
            <span>
              <span className="block text-[13px] font-medium text-fg-0">All tools</span>
              <span id={`bot-all-tools-help-${agent.slug}`} className="block text-[12px] text-fg-2">
                Every tool below, plus any added later. Email and calendar stay draft-only. Secrets must be ticked on their own.
              </span>
            </span>
          </label>
          {byGroup.map(({ group, tools: entries }) => (
            <div key={group}>
              <p className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-fg-2">{GROUP_LABELS[group]}</p>
              <div className="grid gap-1 sm:grid-cols-2">
                {entries.map(t => {
                  // obj 900749: an explicit-only tool (secret use) is never implied by "All tools".
                  const implied = allTools && !t.explicit_only
                  const checked = implied || (isAdmin ? tools.includes(t.name) : enabledNames.has(t.name))
                  return (
                    <label key={t.name} className={cn('flex items-start gap-2 rounded-md px-2 py-1.5', implied && 'opacity-70')}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={implied}
                        onChange={() => toggle(t.name)}
                        className="mt-0.5"
                        aria-label={t.label}
                      />
                      <span>
                        <span className="block text-[13px] text-fg-0">{t.label}</span>
                        <span className="block text-[12px] text-fg-2">{t.description}</span>
                      </span>
                    </label>
                  )
                })}
              </div>
            </div>
          ))}
        </fieldset>

        {webMissing && (
          <Alert tone="amber">
            Web search is not set up on this install yet. Add one search key in Settings → Secrets (TAVILY_API_KEY, BRAVE_SEARCH_API_KEY, FIRECRAWL_API_KEY, EXA_API_KEY or SERPER_API_KEY). Reading a page by its URL works without one.
          </Alert>
        )}
        {error && <Alert tone="alarm">{error}</Alert>}

        {isAdmin && (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" size="sm" loading={saving} onClick={() => void save()}>Save</Button>
            <Button variant="ghost" size="sm" disabled={saving || !cfg} onClick={() => void reset()}>Reset to file</Button>
            {saved && <span role="status" className="text-[12px] text-fg-2">Saved.</span>}
            {cfg?.updated_by && !saved && (
              <span className="text-[12px] text-fg-2">Changed by {cfg.updated_by}</span>
            )}
          </div>
        )}

        <WorkspaceAccessSection agent={agent} isAdmin={isAdmin} onChanged={() => setAccessVersion(v => v + 1)} />

        <HighAgencySection key={accessVersion} agent={agent} isAdmin={isAdmin} />
      </div>
    </section>
  )
}
