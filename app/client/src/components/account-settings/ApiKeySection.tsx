/**
 * Command Center API key — Settings → You.
 * Generate once, copy, paste into Grok Bot / any agent. Revoke or rotate here.
 */
import { useEffect, useState } from 'react'
import { api, ApiError } from '../../lib/api'
import { useConfirm } from '../ui'
import { fmtDate } from './helpers'
import type { ApiKeyIssued, ApiKeySummary } from '@command-center/shared'

export function ApiKeySection() {
  const [summary, setSummary] = useState<ApiKeySummary | null>(null)
  const [plaintext, setPlaintext] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const { confirm, confirmDialog } = useConfirm()

  async function reload() {
    setLoading(true)
    setError('')
    try {
      setSummary(await api.get<ApiKeySummary>('/auth/api-key'))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load API key')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void reload() }, [])

  async function generate() {
    if (summary?.configured) {
      const ok = await confirm({
        title: 'Replace API key?',
        message: 'The old key stops working immediately. Anything using it (Grok Bot, scripts) must get the new one.',
        confirmLabel: 'Generate new key',
        danger: true,
      })
      if (!ok) return
    }
    setBusy(true)
    setError('')
    setCopied(false)
    try {
      const issued = await api.post<ApiKeyIssued>('/auth/api-key')
      setPlaintext(issued.token)
      setSummary({ configured: true, last4: issued.last4, created_at: issued.created_at })
    } catch (err) {
      const msg = err instanceof ApiError ? (err.body as { error?: string })?.error || err.message
        : err instanceof Error ? err.message : 'Generate failed'
      setError(msg)
    } finally {
      setBusy(false)
    }
  }

  async function revoke() {
    const ok = await confirm({
      title: 'Revoke API key?',
      message: 'Grok Bot and any scripts using this key will get 401 until you generate a new one.',
      confirmLabel: 'Revoke',
      danger: true,
    })
    if (!ok) return
    setBusy(true)
    setError('')
    try {
      await api.del('/auth/api-key')
      setPlaintext(null)
      setCopied(false)
      setSummary({ configured: false, last4: null, created_at: null })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Revoke failed')
    } finally {
      setBusy(false)
    }
  }

  async function copy() {
    if (!plaintext) return
    try {
      await navigator.clipboard.writeText(plaintext)
      setCopied(true)
    } catch {
      setError('Could not copy — select the key and copy it yourself.')
    }
  }

  const configured = !!summary?.configured

  return (
    <section className="rounded-lg border border-border bg-surface-raised p-5">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-fg-0">API key</h2>
          <p className="mt-1 text-xs text-fg-3">
            For Grok Bot and other agents. Paste as <span className="font-mono">Authorization: Bearer …</span>.
            We only show the full key once.
          </p>
        </div>
        {configured && (
          <span className="shrink-0 rounded-sm bg-status-review/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-status-review">
            active
          </span>
        )}
      </div>

      {error && (
        <div className="mb-3 rounded bg-signal-alarm/10 px-3 py-2 text-sm text-signal-alarm">{error}</div>
      )}

      {loading ? (
        <div className="text-sm text-fg-3">Loading…</div>
      ) : (
        <div className="space-y-3">
          {plaintext && (
            <div className="space-y-2">
              <label className="block text-xs text-fg-2">Copy this now — it will not be shown again</label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  readOnly
                  value={plaintext}
                  className="w-full rounded border border-accent/40 bg-surface px-2.5 py-2 font-mono text-sm text-fg-0"
                />
                <button
                  type="button"
                  onClick={() => void copy()}
                  className="shrink-0 rounded-md bg-accent px-3 py-2 text-sm text-white hover:opacity-90"
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
          )}

          {!plaintext && configured && (
            <p className="font-mono text-sm text-fg-1">cc_live_••••••••{summary!.last4}</p>
          )}
          {configured && summary?.created_at && (
            <p className="text-[11px] text-fg-3">Created {fmtDate(summary.created_at)}</p>
          )}
          {!configured && !plaintext && (
            <p className="text-sm text-fg-2">No key yet. Generate one, copy it, paste it into Grok Bot.</p>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              onClick={() => void generate()}
              disabled={busy}
              className="rounded-md border border-border px-3 py-1.5 text-sm text-fg-1 transition-colors duration-fast ease-out hover:bg-surface-2 hover:text-fg-0 disabled:opacity-50"
            >
              {busy ? 'Working…' : configured ? 'Generate new key' : 'Generate API key'}
            </button>
            {configured && (
              <button
                type="button"
                onClick={() => void revoke()}
                disabled={busy}
                className="rounded-md border border-signal-alarm/40 px-3 py-1.5 text-sm text-signal-alarm transition-colors duration-fast ease-out hover:bg-signal-alarm/10 disabled:opacity-50"
              >
                Revoke
              </button>
            )}
          </div>
        </div>
      )}
      {confirmDialog}
    </section>
  )
}
