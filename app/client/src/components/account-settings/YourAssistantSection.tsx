/**
 * Your Assistant card — extracted from AccountSettings.tsx (behavior frozen).
 *
 * Every authenticated user can name and configure their own personal assistant.
 * Loads via GET /api/assistant/config and persists partial edits via PUT. The
 * AI/mentor tab reads the same config to show the user's assistant name.
 */
import { useEffect, useState, type FormEvent } from 'react'
import { useAssistantConfig, type AutonomyLevel } from '../../hooks/useAssistantConfig'

const AUTONOMY_OPTIONS: { value: AutonomyLevel; label: string; help: string }[] = [
  { value: 'read_only', label: 'Read only', help: 'Can read and draft, but never acts on your behalf.' },
  { value: 'confirm_all', label: 'Confirm everything', help: 'Asks before every action it takes.' },
  { value: 'confirm_external', label: 'Confirm external', help: 'Acts locally, but confirms anything that leaves the machine (email, SMS).' },
  { value: 'autonomous', label: 'Autonomous', help: 'Acts without confirmation. Use with care.' },
]

export function YourAssistantSection() {
  const { config, loading, error, save } = useAssistantConfig()

  // Local draft, seeded from the loaded config.
  const [displayName, setDisplayName] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [autonomy, setAutonomy] = useState<AutonomyLevel>('confirm_external')
  const [enabled, setEnabled] = useState(true)

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [saved, setSaved] = useState(false)

  // Seed the draft once the config arrives (and on any external refresh).
  useEffect(() => {
    if (!config) return
    setDisplayName(config.persona.displayName ?? '')
    setSystemPrompt(config.persona.systemPrompt ?? '')
    setAutonomy(config.autonomy.level)
    setEnabled(config.enabled)
  }, [config])

  async function handleSave(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setSaveError('')
    setSaved(false)
    try {
      await save({
        persona: { displayName: displayName.trim(), systemPrompt },
        autonomy: { level: autonomy },
        enabled,
      })
      setSaved(true)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const helpFor = AUTONOMY_OPTIONS.find(o => o.value === autonomy)?.help ?? ''

  return (
    <section className="mt-5 rounded-lg border border-border bg-surface-raised p-5">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-fg-0">Your Assistant</h2>
          <p className="mt-1 text-xs text-fg-3">
            Name your personal assistant and set how it behaves. This name appears in the AI tab.
          </p>
        </div>
        {config && !enabled && (
          <span className="shrink-0 rounded-sm bg-fg-3/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-fg-3">
            disabled
          </span>
        )}
      </div>

      {error && (
        <div className="mb-3 rounded bg-signal-alarm/10 px-3 py-2 text-sm text-signal-alarm">{error}</div>
      )}

      {loading ? (
        <div className="text-sm text-fg-3">Loading…</div>
      ) : (
        <form onSubmit={handleSave} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="assistant-name" className="block text-xs text-fg-2">
              Assistant name
            </label>
            <input
              id="assistant-name"
              type="text"
              value={displayName}
              onChange={e => { setDisplayName(e.target.value); setSaved(false) }}
              placeholder="Assistant"
              className="w-full rounded border border-border bg-surface px-2.5 py-2 text-sm text-fg-0 outline-none focus:border-accent"
            />
            <p className="text-[11px] text-fg-3">What you want to call your assistant.</p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="assistant-prompt" className="block text-xs text-fg-2">
              Instructions / persona
            </label>
            <textarea
              id="assistant-prompt"
              value={systemPrompt}
              onChange={e => { setSystemPrompt(e.target.value); setSaved(false) }}
              rows={4}
              placeholder="How should your assistant behave? Tone, priorities, what to confirm…"
              className="w-full resize-y rounded border border-border bg-surface px-2.5 py-2 text-sm text-fg-0 outline-none focus:border-accent"
            />
            <p className="text-[11px] text-fg-3">Appended to the assistant's system prompt at spawn.</p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="assistant-autonomy" className="block text-xs text-fg-2">
              Autonomy
            </label>
            <select
              id="assistant-autonomy"
              value={autonomy}
              onChange={e => { setAutonomy(e.target.value as AutonomyLevel); setSaved(false) }}
              className="w-full rounded border border-border bg-surface px-2.5 py-2 text-sm text-fg-0 outline-none focus:border-accent"
            >
              {AUTONOMY_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <p className="text-[11px] text-fg-3">{helpFor}</p>
          </div>

          <label className="flex items-center gap-2 text-sm text-fg-1">
            <input
              type="checkbox"
              checked={enabled}
              onChange={e => { setEnabled(e.target.checked); setSaved(false) }}
              className="h-4 w-4 rounded border-border bg-surface text-accent focus:ring-accent"
            />
            Enabled
          </label>

          {saveError && (
            <div className="rounded bg-signal-alarm/10 px-3 py-2 text-sm text-signal-alarm">{saveError}</div>
          )}

          <div className="flex items-center gap-3 pt-1">
            <button
              type="submit"
              disabled={saving}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-fg-0 transition-colors duration-fast ease-out hover:bg-accent-hover disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            {saved && <span className="text-sm text-status-review">Saved.</span>}
          </div>
        </form>
      )}
    </section>
  )
}
