/**
 * Settings → Models → "API key providers" (sprint 4b, obj 900496).
 *
 * BYOK: a provider API key (Anthropic / OpenAI / xAI / an OpenAI-compatible
 * endpoint with a custom base URL) stored through the EXISTING global-scope
 * secrets mechanism — same store, same crypto, same write-only contract as
 * My Secrets (`MySecretsSection.tsx`) and the webhook sender key. This file
 * does not touch secrets-storage internals; it only calls the existing
 * `/api/secrets` routes. `scopeType: 'global'` is already global-admin-only
 * server-side (`canAccessScope` in routes/secrets.ts), matching this page's
 * own admin gate.
 *
 * A stored key is NEVER re-displayed after save — the list below shows only
 * the provider, an optional custom base URL (not secret), and a version/date,
 * exactly like MySecretsSection's masked list.
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { api } from '../../lib/api'
import { Alert, Button, useConfirm } from '../ui'
import type { SecretSummary } from '@operationkit/shared'

const KEY_PREFIX = 'PROVIDER_API_KEY__'

type FixedProvider = 'ANTHROPIC' | 'OPENAI' | 'XAI'
const FIXED_PROVIDERS: { id: FixedProvider; label: string }[] = [
  { id: 'ANTHROPIC', label: 'Anthropic' },
  { id: 'OPENAI', label: 'OpenAI' },
  { id: 'XAI', label: 'xAI' },
]

type ProviderChoice = FixedProvider | 'CUSTOM'

interface StoredProviderKey {
  secretKey: string
  provider: string
  customSlug: string | null
  baseUrl: string | null
  version: number
  updatedAt: string
}

/** Secret value for a provider key — JSON so a custom endpoint can carry its base URL
 *  alongside the key, with no second secret and no schema change. */
function encodeValue(apiKey: string, baseUrl?: string): string {
  return JSON.stringify(baseUrl ? { apiKey, baseUrl } : { apiKey })
}

function parseStored(s: SecretSummary): StoredProviderKey | null {
  if (!s.key.startsWith(KEY_PREFIX)) return null
  const rest = s.key.slice(KEY_PREFIX.length)
  const isCustom = rest.startsWith('CUSTOM__')
  return {
    secretKey: s.key,
    provider: isCustom ? 'CUSTOM' : rest,
    customSlug: isCustom ? rest.slice('CUSTOM__'.length) : null,
    baseUrl: null, // not readable from metadata — the base URL lives inside the encrypted value
    version: s.version,
    updatedAt: s.updatedAt,
  }
}

function fmtDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })
}

function slugify(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
}

export function ProviderKeysSection() {
  const [rows, setRows] = useState<StoredProviderKey[] | null>(null)
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)
  const { confirm, confirmDialog } = useConfirm()

  async function reload() {
    try {
      const data = await api.get<SecretSummary[]>('/secrets?scopeType=global')
      const list = Array.isArray(data) ? data : []
      setRows(list.map(parseStored).filter((r): r is StoredProviderKey => r !== null))
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load provider keys')
    }
  }

  useEffect(() => { void reload() }, [])

  async function handleRemove(secretKey: string, label: string) {
    const ok = await confirm({
      title: `Remove ${label}?`,
      message: 'Anything configured to use this provider key will need a new one.',
      confirmLabel: 'Remove',
      danger: true,
    })
    if (!ok) return
    try {
      await api.del(`/secrets?scopeType=global&key=${encodeURIComponent(secretKey)}`)
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Remove failed')
    }
  }

  return (
    <section className="space-y-3 rounded-lg border border-line bg-surface-2 p-4" aria-labelledby="provider-keys-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="provider-keys-heading" className="font-display text-[15px] font-semibold tracking-[-0.01em] text-fg-0">
            API key providers
          </h3>
          <p className="mt-1 max-w-prose text-[12.5px] leading-relaxed text-fg-3">
            Bring your own key for Anthropic, OpenAI, xAI, or any OpenAI-compatible endpoint, stored the same way as
            every other secret here — encrypted, write-only, never shown again.
          </p>
        </div>
        {!adding && <Button variant="secondary" onClick={() => setAdding(true)}>Add API key provider</Button>}
      </div>

      {error && <Alert tone="alarm">{error}</Alert>}

      {rows === null ? (
        <p className="text-[12.5px] text-fg-3">Loading…</p>
      ) : rows.length === 0 && !adding ? (
        <p className="rounded-md border border-dashed border-line px-3 py-4 text-center text-[12.5px] text-fg-3">
          No provider keys yet.
        </p>
      ) : (
        <ul className="divide-y divide-line-soft rounded-md border border-line">
          {rows.map(r => {
            const label =
              r.provider === 'CUSTOM'
                ? `Custom: ${r.customSlug}`
                : FIXED_PROVIDERS.find(p => p.id === r.provider)?.label ?? r.provider
            return (
              <li key={r.secretKey} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                <div>
                  <p className="text-[13px] font-medium text-fg-0">{label}</p>
                  <p className="text-[12px] text-fg-3">v{r.version} · updated {fmtDate(r.updatedAt)}</p>
                </div>
                <Button variant="danger" size="sm" onClick={() => void handleRemove(r.secretKey, label)}>Remove</Button>
              </li>
            )
          })}
        </ul>
      )}

      {adding && (
        <AddProviderKeyForm
          existing={rows ?? []}
          onCancel={() => setAdding(false)}
          onSaved={async () => { setAdding(false); await reload() }}
        />
      )}
      {confirmDialog}
    </section>
  )
}

function AddProviderKeyForm({ existing, onCancel, onSaved }: {
  existing: StoredProviderKey[]
  onCancel: () => void
  onSaved: () => Promise<void>
}) {
  const [provider, setProvider] = useState<ProviderChoice>('ANTHROPIC')
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const slug = useMemo(() => slugify(name), [name])
  const secretKey = provider === 'CUSTOM' ? `${KEY_PREFIX}CUSTOM__${slug}` : `${KEY_PREFIX}${provider}`
  const duplicate = existing.some(r => r.secretKey === secretKey)

  const canSave =
    apiKey.trim().length > 0 &&
    (provider !== 'CUSTOM' || (slug.length > 0 && baseUrl.trim().length > 0)) &&
    !duplicate

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!canSave) return
    setSaving(true)
    setError('')
    try {
      const value = provider === 'CUSTOM' ? encodeValue(apiKey.trim(), baseUrl.trim()) : encodeValue(apiKey.trim())
      await api.post('/secrets', { scopeType: 'global', key: secretKey, value })
      await onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 rounded-md border border-line bg-surface-1 p-4">
      {error && <Alert tone="alarm">{error}</Alert>}
      {duplicate && <Alert tone="amber">A key for this provider already exists — remove it first to replace it.</Alert>}

      <div>
        <label htmlFor="provider-key-provider" className="mb-1 block text-xs text-fg-2">Provider</label>
        <select
          id="provider-key-provider"
          value={provider}
          onChange={e => setProvider(e.target.value as ProviderChoice)}
          className="min-h-[40px] w-full rounded border border-line bg-surface px-2 text-sm text-fg-0"
        >
          {FIXED_PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          <option value="CUSTOM">OpenAI-compatible (custom base URL)</option>
        </select>
      </div>

      {provider === 'CUSTOM' && (
        <>
          <div>
            <label htmlFor="provider-key-name" className="mb-1 block text-xs text-fg-2">Name</label>
            <input
              id="provider-key-name"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Together AI"
              className="min-h-[40px] w-full rounded border border-line bg-surface px-2.5 py-2 text-sm text-fg-0"
            />
          </div>
          <div>
            <label htmlFor="provider-key-base-url" className="mb-1 block text-xs text-fg-2">Base URL</label>
            <input
              id="provider-key-base-url"
              type="url"
              value={baseUrl}
              onChange={e => setBaseUrl(e.target.value)}
              placeholder="https://api.example.com/v1"
              className="min-h-[40px] w-full rounded border border-line bg-surface px-2.5 py-2 font-mono text-sm text-fg-0"
            />
          </div>
        </>
      )}

      <div>
        <label htmlFor="provider-key-value" className="mb-1 block text-xs text-fg-2">API key</label>
        <input
          id="provider-key-value"
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={e => setApiKey(e.target.value)}
          placeholder="Stored encrypted; never shown again"
          className="min-h-[40px] w-full rounded border border-line bg-surface px-2.5 py-2 font-mono text-sm text-fg-0"
        />
      </div>

      <div className="flex flex-wrap gap-2 pt-1">
        <Button type="submit" variant="primary" loading={saving} disabled={!canSave}>Save key</Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button>
      </div>
    </form>
  )
}
