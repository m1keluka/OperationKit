import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { Card, CardHeader, CardBody } from '../ui/Card'
import { Button } from '../ui/Button'
import { CopyButton } from '../ui/CopyButton'
import type { Branding, BrandTokens } from '../../hooks/useBranding'
import { invalidateBranding } from '../../hooks/useBranding'
import { BrandLogo } from '../BrandLogo'
import { useAuth } from '../../context/AuthContext'

/** Copy-paste prompt for "have your coding agent set this up" (goal #5, docs/branding.md). */
export function brandingAgentPrompt(websiteUrl: string): string {
  const url = websiteUrl.trim() || '<your company website URL>'
  return `Here is my company website: ${url}. Read the brand colors and logo from it and configure this install's branding (name, colors, logo files) via the env/config file per docs/branding.md.`
}

const TOKEN_FIELDS: Array<{ key: keyof BrandTokens; label: string; help?: string }> = [
  { key: 'accent', label: 'Accent' },
  { key: 'accentHover', label: 'Accent (hover)' },
  { key: 'accentPress', label: 'Accent (pressed)' },
  { key: 'accentFg', label: 'Text on accent', help: 'Foreground color for text/icons on top of the accent fill.' },
  { key: 'verify', label: 'Verify / done (light)' },
  { key: 'verifyOnDark', label: 'Verify / done (dark)' },
  { key: 'caution', label: 'Caution / blocked (light)' },
  { key: 'cautionOnDark', label: 'Caution / blocked (dark)' },
]

const LOGO_SLOTS: Array<{ slot: 'wordmark' | 'wordmark-dark' | 'icon' | 'favicon'; label: string; help: string }> = [
  { slot: 'wordmark', label: 'Wordmark (light bg)', help: 'Full logo with product name, shown on light surfaces.' },
  { slot: 'wordmark-dark', label: 'Wordmark (dark bg)', help: 'Optional — falls back to the light-bg wordmark if unset.' },
  { slot: 'icon', label: 'Icon', help: 'Square mark used for the sign-in page and collapsed nav; also generates app icons.' },
  { slot: 'favicon', label: 'Favicon', help: 'Browser tab icon (.ico, .svg or .png). Falls back to the icon above if unset.' },
]

function HexInput({ value, onChange, disabled, label }: { value: string; onChange: (v: string) => void; disabled?: boolean; label: string }) {
  return (
    <label className="flex flex-wrap items-center gap-2 text-[13px] text-fg-1">
      <span className="w-36 shrink-0">{label}</span>
      <input
        type="color"
        value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : '#000000'}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        className="h-9 w-10 shrink-0 cursor-pointer rounded-md border border-line bg-surface-1 disabled:cursor-not-allowed disabled:opacity-50"
      />
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        className="h-9 w-28 rounded-md border border-line bg-surface-1 px-2 font-mono text-[13px] text-fg-0 disabled:opacity-50"
      />
    </label>
  )
}

/**
 * Settings > Branding panel (obj 900494). Admin-only. Sets the install's brand
 * name, accent/status palette and logos (wordmark/icon/favicon), with a live
 * preview and the copy-paste "set this up for me" agent prompt. Standalone and
 * exported so the settings-reorg card (Sprint 4b) can mount it — this
 * component does not touch settings navigation itself.
 */
export function BrandingPanel() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'

  const [branding, setBranding] = useState<Branding | null>(null)
  const [name, setName] = useState('')
  const [tokens, setTokens] = useState<BrandTokens | null>(null)
  const [poweredBy, setPoweredBy] = useState(false)
  const [websiteUrl, setWebsiteUrl] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [uploading, setUploading] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/branding', { credentials: 'include' })
      .then(r => r.json())
      .then((b: Branding) => {
        if (cancelled) return
        setBranding(b)
        setName(b.name)
        setTokens(b.tokens)
        setPoweredBy(!!b.powered_by)
      })
      .catch(err => !cancelled && setError(err instanceof Error ? err.message : 'Could not load branding'))
    return () => { cancelled = true }
  }, [])

  if (!isAdmin) {
    return (
      <Card>
        <CardBody>
          <p className="text-[13px] text-fg-2">Only an admin can view or change branding.</p>
        </CardBody>
      </Card>
    )
  }

  const locked = new Set(branding?.env_locked_fields ?? [])

  function setToken(key: keyof BrandTokens, value: string) {
    setTokens(t => (t ? { ...t, [key]: value } : t))
  }

  async function save() {
    if (!tokens) return
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const res = await fetch('/api/branding', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, tokens, powered_by: poweredBy }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || 'Save failed')
      const b: Branding = await res.json()
      setBranding(b)
      setTokens(b.tokens)
      void invalidateBranding(b) // live-apply name, logo, tokens and favicon everywhere — no reload
      setNotice('Saved.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function reset() {
    setSaving(true)
    setError('')
    try {
      const res = await fetch('/api/branding/reset', { method: 'POST', credentials: 'include' })
      if (!res.ok) throw new Error('Reset failed')
      const b: Branding = await res.json()
      setBranding(b)
      setName(b.name)
      setTokens(b.tokens)
      setPoweredBy(!!b.powered_by)
      void invalidateBranding(b)
      setNotice('Reset to the default brand.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reset failed')
    } finally {
      setSaving(false)
    }
  }

  async function uploadLogo(slot: string, file: File) {
    setUploading(slot)
    setError('')
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch(`/api/branding/upload/${slot}`, { method: 'POST', credentials: 'include', body: form })
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || 'Upload failed')
      const b: Branding = await res.json()
      setBranding(b)
      void invalidateBranding(b) // header, sign-in, favicon pick the new file up immediately
      setNotice(`${slot} updated.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(null)
    }
  }

  async function clearLogo(slot: string) {
    setUploading(slot)
    try {
      const res = await fetch(`/api/branding/upload/${slot}`, { method: 'DELETE', credentials: 'include' })
      if (res.ok) {
        const b: Branding = await res.json()
        setBranding(b)
        void invalidateBranding(b)
      }
    } finally {
      setUploading(null)
    }
  }

  const assetUrl: Record<string, string | null> = {
    wordmark: branding?.wordmark_url ?? null,
    'wordmark-dark': branding?.wordmark_dark_url ?? null,
    icon: branding?.icon_url ?? null,
    favicon: branding?.favicon_url ?? null,
  }

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div className="rounded-md border border-signal-alarm/30 bg-signal-alarm/10 px-3 py-2 text-[13px] text-signal-alarm">
          {error}
        </div>
      )}
      {notice && !error && (
        <div className="rounded-md border border-signal-verify/30 bg-signal-verify/10 px-3 py-2 text-[13px] text-signal-verify">
          {notice}
        </div>
      )}

      <Card>
        <CardHeader
          title="Brand"
          eyebrow="Settings · Branding"
          actions={
            <>
              <Button size="sm" variant="ghost" onClick={reset} disabled={saving}>Reset to default</Button>
              <Button size="sm" variant="primary" onClick={save} loading={saving}>Save</Button>
            </>
          }
        />
        <CardBody className="flex flex-col gap-4">
          <label className="flex flex-wrap items-center gap-2 text-[13px] text-fg-1">
            <span className="w-36 shrink-0">Product name</span>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              disabled={locked.has('name')}
              maxLength={60}
              className="h-9 w-full min-w-0 rounded-md border border-line bg-surface-1 px-2.5 text-[14px] text-fg-0 disabled:opacity-50 sm:w-64"
            />
            {locked.has('name') && <span className="text-fg-3">set via OK_BRAND_NAME env var</span>}
          </label>

          <label className="flex items-start gap-2 text-[13px] text-fg-1">
            <input
              type="checkbox"
              checked={poweredBy}
              onChange={e => setPoweredBy(e.target.checked)}
              disabled={locked.has('powered_by')}
              className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
            />
            <span>
              Show a small “Powered by” credit for the underlying platform on the sign-in page
              <span className="block text-[12px] text-fg-3">Off by default — leave it off for a fully white-labeled install.</span>
            </span>
          </label>

          {tokens && (
            <div className="flex flex-col gap-2">
              {TOKEN_FIELDS.map(f => (
                <div key={f.key} className="flex items-center gap-2">
                  <HexInput
                    label={f.label}
                    value={tokens[f.key]}
                    onChange={v => setToken(f.key, v)}
                    disabled={locked.has(f.key)}
                  />
                  {locked.has(f.key) && (
                    <span className="text-[12px] text-fg-3">env-locked</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      {tokens && branding && <LivePreview tokens={tokens} name={name} branding={branding} />}

      <Card>
        <CardHeader title="Logos & favicon" eyebrow="SVG, PNG or ICO · 2MB max" />
        <CardBody className="flex flex-col gap-4">
          {LOGO_SLOTS.map(({ slot, label, help }) => (
            <div key={slot} className="flex flex-wrap items-center gap-3">
              <div
                className="flex h-12 w-24 shrink-0 items-center justify-center rounded-md border border-line"
                style={{ background: slot === 'wordmark-dark' ? 'var(--ok-ink)' : 'var(--ok-paper)' }}
              >
                {assetUrl[slot]
                  ? <img src={assetUrl[slot]!} alt="" className="max-h-10 max-w-20 object-contain" />
                  : <span className="text-[12px] text-fg-3">not set</span>}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] text-fg-0">{label}</div>
                <div className="text-[12px] text-fg-3">{help}</div>
              </div>
              <label className="shrink-0">
                <input
                  type="file"
                  accept=".svg,.png,.ico,image/svg+xml,image/png,image/x-icon"
                  className="hidden"
                  disabled={uploading === slot}
                  onChange={e => {
                    const file = e.target.files?.[0]
                    if (file) void uploadLogo(slot, file)
                    e.target.value = ''
                  }}
                />
                <span className="inline-flex h-8 cursor-pointer items-center rounded-md border border-line bg-surface-1 px-3 text-[12.5px] text-fg-1 hover:border-line-strong hover:bg-surface-3">
                  {uploading === slot ? 'Uploading…' : 'Upload'}
                </span>
              </label>
              <Button size="sm" variant="ghost" onClick={() => clearLogo(slot)} disabled={uploading === slot}>Clear</Button>
            </div>
          ))}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Set this up with your coding agent" eyebrow="Copy-paste prompt" />
        <CardBody className="flex flex-col gap-3">
          <label className="flex flex-wrap items-center gap-2 text-[13px] text-fg-1">
            <span className="shrink-0">Company website</span>
            <input
              type="url"
              placeholder="https://acme.com"
              value={websiteUrl}
              onChange={e => setWebsiteUrl(e.target.value)}
              className="h-9 w-full min-w-0 rounded-md border border-line bg-surface-1 px-2.5 text-[14px] text-fg-0 sm:w-72"
            />
          </label>
          <div className="flex items-start gap-2">
            <pre className="flex-1 whitespace-pre-wrap rounded-md border border-line bg-surface-1 p-3 font-mono text-[12px] text-fg-1">
              {brandingAgentPrompt(websiteUrl)}
            </pre>
            <CopyButton size="sm" value={brandingAgentPrompt(websiteUrl)} />
          </div>
          <p className="text-[12px] text-fg-3">
            Paste this into Claude Code (or any coding agent) pointed at this repo. Full reference: docs/branding.md.
            Using a custom domain? See docs/custom-domain.md.
          </p>
        </CardBody>
      </Card>
    </div>
  )
}

/** Scoped live preview — applies the DRAFT tokens only to this subtree via
 * inline CSS custom properties, so editing doesn't repaint the whole app
 * until Save. */
function LivePreview({ tokens, name, branding }: { tokens: BrandTokens; name: string; branding: Branding }) {
  const style = {
    '--accent': tokens.accent,
    '--accent-hover': tokens.accentHover,
    '--accent-press': tokens.accentPress,
    '--accent-fg': tokens.accentFg,
    '--brand-verify': tokens.verify,
    '--brand-caution': tokens.caution,
  } as CSSProperties
  const draft: Branding = { ...branding, name: name || branding.name, tokens }
  return (
    <Card>
      <CardHeader title="Live preview" eyebrow="Updates as you edit, before you Save" />
      <CardBody>
        <div style={style} className="flex flex-wrap items-center gap-4 rounded-md border border-line bg-surface-0 p-4">
          <BrandLogo branding={draft} size="md" />
          <Button variant="primary" size="sm">Primary action</Button>
          <Button variant="secondary" size="sm">Secondary</Button>
          <span className="rounded-full border border-signal-verify px-2 py-0.5 text-[12px] font-medium text-signal-verify">Done</span>
          <span className="rounded-full border border-signal-alarm px-2 py-0.5 text-[12px] font-medium text-signal-alarm">Blocked</span>
        </div>
      </CardBody>
    </Card>
  )
}
