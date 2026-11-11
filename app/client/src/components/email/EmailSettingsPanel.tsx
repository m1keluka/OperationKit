/**
 * Settings → Email (obj 900497) — STANDALONE admin panel component.
 *
 * Pick a provider (SMTP / Resend / Postmark), set the sender, paste the
 * install owner's OWN credential (stored encrypted in the secrets store as a
 * service-only secret, never shown back), send a test email, and follow the
 * DNS help (SPF / DKIM / DMARC). Mounted at Settings → Email
 * (components/settings/SettingsEmail.tsx, Sprint 4b's settings sidebar).
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { CheckCircle2, CircleAlert, Mail, Send } from 'lucide-react'
import { Alert, Badge, Button, Card, CardHeader, Skeleton, cn, useConfirm } from '../ui'
import { inputCls, selectCls, SectionLabel } from '../config/config-form'
import {
  emailAgentPrompt, emailApi, PROVIDER_LABEL,
  type DnsHelp, type EmailProvider, type EmailSetup, type EmailSetupInput, type SmtpSecurity,
} from '../../lib/email'
import { AgentPromptBox, CopyButton } from './AgentPromptBox'

const PROVIDERS: Array<{ id: EmailProvider; blurb: string }> = [
  { id: 'resend', blurb: 'Simplest. Add your domain in Resend, paste an API key.' },
  { id: 'postmark', blurb: 'Great deliverability. Paste a Server API token.' },
  { id: 'smtp', blurb: 'Any mail service: Google Workspace, Microsoft 365, SES, Mailgun…' },
]

const CREDENTIAL_LABEL: Record<EmailProvider, string> = {
  smtp: 'SMTP password',
  resend: 'Resend API key',
  postmark: 'Postmark Server API token',
}

const SECURITY_PORT: Record<SmtpSecurity, number> = { starttls: 587, tls: 465, none: 25 }

function domainOf(addr: string): string {
  const at = addr.lastIndexOf('@')
  return at < 0 ? '' : addr.slice(at + 1).trim().toLowerCase()
}

function toInput(s: EmailSetup, fallbackUrl: string): EmailSetupInput {
  return {
    provider: s.provider,
    from_name: s.from_name,
    from_address: s.from_address,
    reply_to: s.reply_to,
    app_url: s.app_url || fallbackUrl,
    smtp: { ...s.smtp },
    credential: '',
  }
}

function Field({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor: string }) {
  return (
    <div className="min-w-0 space-y-1">
      <label htmlFor={htmlFor} className="block text-[12px] font-medium text-fg-1">{label}</label>
      {children}
      {hint && <p className="text-[11px] leading-snug text-fg-3">{hint}</p>}
    </div>
  )
}

export function EmailStatusBadge({ setup }: { setup: EmailSetup | null }) {
  if (!setup || !setup.provider) return <Badge tone="neutral">Not set up</Badge>
  if (!setup.configured) return <Badge tone="amber">Incomplete</Badge>
  if (setup.last_test?.ok) return <Badge tone="verify">Working</Badge>
  if (setup.last_test && !setup.last_test.ok) return <Badge tone="alarm">Last test failed</Badge>
  return <Badge tone="amber">Send a test</Badge>
}

export interface EmailSettingsPanelProps {
  /** Called after every successful load/save/test (e.g. to refresh a checklist). */
  onChange?: (setup: EmailSetup) => void
  className?: string
}

export function EmailSettingsPanel({ onChange, className }: EmailSettingsPanelProps) {
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const [setup, setSetup] = useState<EmailSetup | null>(null)
  const [form, setForm] = useState<EmailSetupInput | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState<{ tone: 'verify' | 'alarm'; text: string } | null>(null)
  const [testTo, setTestTo] = useState('')
  const [testing, setTesting] = useState(false)
  const [testMsg, setTestMsg] = useState<{ tone: 'verify' | 'alarm'; text: string } | null>(null)
  const [dns, setDns] = useState<DnsHelp | null>(null)
  const { confirm, confirmDialog } = useConfirm()

  const apply = useCallback((s: EmailSetup) => {
    setSetup(s)
    setForm(toInput(s, origin))
    onChange?.(s)
  }, [onChange, origin])

  useEffect(() => {
    emailApi.get().then(apply).catch(e => setLoadError(e instanceof Error ? e.message : 'Could not load email settings'))
  }, [apply])

  const provider = form?.provider ?? null
  const domain = domainOf(form?.from_address ?? '')
  useEffect(() => {
    if (!provider) { setDns(null); return }
    let alive = true
    const t = setTimeout(() => {
      emailApi.dns(provider, domain).then(d => { if (alive) setDns(d) }).catch(() => { if (alive) setDns(null) })
    }, 400)
    return () => { alive = false; clearTimeout(t) }
  }, [provider, domain])

  const prompt = useMemo(() => emailAgentPrompt(form?.app_url || origin), [form?.app_url, origin])

  if (loadError) return <Alert tone="alarm" title="Email settings">{loadError}</Alert>
  if (!setup || !form) {
    return (
      <Card className={cn('space-y-3', className)}>
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </Card>
    )
  }

  const set = (patch: Partial<EmailSetupInput>) => setForm(f => (f ? { ...f, ...patch } : f))
  const setSmtp = (patch: Partial<EmailSetupInput['smtp']>) => setForm(f => (f ? { ...f, smtp: { ...f.smtp, ...patch } } : f))
  const hasStoredCredential = !!(provider && setup.has_credential[provider])

  async function save(e?: FormEvent) {
    e?.preventDefault()
    if (!form) return
    setSaving(true)
    setSaveMsg(null)
    try {
      const next = await emailApi.save(form)
      apply(next)
      setSaveMsg({ tone: 'verify', text: next.configured ? 'Saved. Now send a test email.' : `Saved. Still needed: ${next.problems.join(', ')}.` })
    } catch (err) {
      setSaveMsg({ tone: 'alarm', text: err instanceof Error ? err.message : 'Could not save' })
    } finally {
      setSaving(false)
    }
  }

  async function sendTest() {
    setTesting(true)
    setTestMsg(null)
    try {
      const r = await emailApi.test(testTo.trim())
      apply(r)
      setTestMsg({ tone: 'verify', text: `Test email sent to ${testTo.trim()}. Check the inbox (and spam, the first time).` })
    } catch (err) {
      const body = (err as { body?: EmailSetup & { error?: string } }).body
      if (body && 'provider' in body) apply(body)
      setTestMsg({ tone: 'alarm', text: err instanceof Error ? err.message : 'Test failed' })
    } finally {
      setTesting(false)
    }
  }

  async function turnOff() {
    if (!(await confirm({
      title: 'Turn off email?',
      message: 'The stored email credentials are deleted. Invites and password resets go back to showing the password on screen.',
      confirmLabel: 'Turn off',
      danger: true,
    }))) return
    apply(await emailApi.disable())
    setSaveMsg(null)
    setTestMsg(null)
  }

  const dirty = JSON.stringify(toInput(setup, origin)) !== JSON.stringify(form)

  return (
    <div className={cn('space-y-4', className)} data-testid="email-settings-panel">
      {confirmDialog}
      <Card inset>
        <CardHeader
          eyebrow="Settings"
          title={<span className="flex items-center gap-2"><Mail className="h-4 w-4 text-fg-2" aria-hidden="true" />Email</span>}
          actions={<EmailStatusBadge setup={setup} />}
        />
        <div className="space-y-3 px-4 pb-4 text-[13px] text-fg-2">
          <p>
            The address this site sends sign-in links, invites and password resets from. It uses <strong className="text-fg-1">your own</strong> email
            provider account — nothing is relayed through anyone else.
          </p>
          {!setup.provider && (
            <Alert tone="amber" title="Email is not set up yet">
              Until it is, new users and password resets show the temporary password on screen for you to share.
            </Alert>
          )}
          {setup.provider && setup.problems.length > 0 && (
            <Alert tone="amber" title="Almost there">{setup.problems.join(' · ')}</Alert>
          )}
        </div>
      </Card>

      <form onSubmit={save} className="space-y-4">
        <Card inset>
          <CardHeader eyebrow="Step 1" title="Provider" />
          <div role="radiogroup" aria-label="Email provider" className="grid gap-2 px-4 pb-4 sm:grid-cols-3">
            {PROVIDERS.map(p => {
              const active = provider === p.id
              return (
                <button
                  key={p.id} type="button" role="radio" aria-checked={active}
                  onClick={() => set({ provider: p.id, smtp: form.smtp })}
                  className={cn(
                    'rounded-md border p-3 text-left transition-colors',
                    active ? 'border-accent bg-[var(--accent-tint)]' : 'border-line bg-surface-1 hover:border-line-strong',
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[13px] font-medium text-fg-0">{PROVIDER_LABEL[p.id]}</span>
                    {setup.has_credential[p.id] && <Badge tone="neutral">key saved</Badge>}
                  </div>
                  <p className="mt-1 text-[11.5px] leading-snug text-fg-3">{p.blurb}</p>
                </button>
              )
            })}
          </div>
        </Card>

        {provider && (
          <Card inset>
            <CardHeader eyebrow="Step 2" title="Sender and credentials" />
            <div className="grid gap-3 px-4 pb-4 sm:grid-cols-2">
              <Field label="From name" htmlFor="email-from-name" hint="Shown as the sender, e.g. your company name.">
                <input id="email-from-name" className={inputCls} value={form.from_name} placeholder="Your company"
                  onChange={e => set({ from_name: e.target.value })} />
              </Field>
              <Field label="From address" htmlFor="email-from-address" hint="Must be on a domain you verified with the provider.">
                <input id="email-from-address" type="email" className={inputCls} value={form.from_address} placeholder="no-reply@yourdomain.com"
                  onChange={e => set({ from_address: e.target.value })} />
              </Field>
              <Field label="Reply-to (optional)" htmlFor="email-reply-to" hint="Where replies go. Leave blank to use the from address.">
                <input id="email-reply-to" type="email" className={inputCls} value={form.reply_to} placeholder="help@yourdomain.com"
                  onChange={e => set({ reply_to: e.target.value })} />
              </Field>
              <Field label="This site's address" htmlFor="email-app-url" hint="Links in emails point here.">
                <input id="email-app-url" type="url" className={inputCls} value={form.app_url} placeholder="https://ops.yourdomain.com"
                  onChange={e => set({ app_url: e.target.value })} />
              </Field>

              {provider === 'smtp' && (
                <>
                  <Field label="SMTP host" htmlFor="email-smtp-host">
                    <input id="email-smtp-host" className={inputCls} value={form.smtp.host} placeholder="smtp.yourprovider.com"
                      onChange={e => setSmtp({ host: e.target.value })} />
                  </Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Security" htmlFor="email-smtp-security">
                      <select id="email-smtp-security" className={cn(selectCls, 'w-full')} value={form.smtp.security}
                        onChange={e => { const s = e.target.value as SmtpSecurity; setSmtp({ security: s, port: SECURITY_PORT[s] }) }}>
                        <option value="starttls">STARTTLS</option>
                        <option value="tls">TLS</option>
                        <option value="none">None (local only)</option>
                      </select>
                    </Field>
                    <Field label="Port" htmlFor="email-smtp-port">
                      <input id="email-smtp-port" inputMode="numeric" className={inputCls} value={String(form.smtp.port || '')}
                        onChange={e => setSmtp({ port: Number(e.target.value.replace(/\D/g, '')) || 0 })} />
                    </Field>
                  </div>
                  <Field label="Username" htmlFor="email-smtp-user" hint="Leave blank if the server needs no sign-in.">
                    <input id="email-smtp-user" className={inputCls} value={form.smtp.username} autoComplete="off"
                      onChange={e => setSmtp({ username: e.target.value })} />
                  </Field>
                </>
              )}

              {(provider !== 'smtp' || form.smtp.username) && (
                <Field
                  label={CREDENTIAL_LABEL[provider]} htmlFor="email-credential"
                  hint={<>Stored encrypted in Secrets as <code className="font-mono">{setup.credential_keys[provider]}</code>. Never shown again; agent sessions never receive it.</>}
                >
                  <input id="email-credential" type="password" autoComplete="new-password" className={cn(inputCls, 'font-mono')}
                    value={form.credential ?? ''}
                    placeholder={hasStoredCredential ? '•••••••• saved — leave blank to keep' : 'paste it here'}
                    onChange={e => set({ credential: e.target.value })} />
                </Field>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
              <Button type="submit" variant="primary" size="sm" loading={saving} disabled={!dirty && !!setup.provider}>Save</Button>
              {setup.provider && (
                <Button type="button" variant="ghost" size="sm" onClick={turnOff}>Turn off email</Button>
              )}
              {saveMsg && <span className={cn('text-[12px]', saveMsg.tone === 'verify' ? 'text-signal-verify' : 'text-signal-alarm')} role="status">{saveMsg.text}</span>}
            </div>
          </Card>
        )}
      </form>

      {setup.provider && (
        <Card inset>
          <CardHeader eyebrow="Step 3" title="Send a test email" />
          <div className="space-y-3 px-4 pb-4">
            <div className="flex flex-col gap-2 sm:flex-row">
              <input aria-label="Send test to" type="email" className={cn(inputCls, 'sm:flex-1')} placeholder="you@yourdomain.com"
                value={testTo} onChange={e => setTestTo(e.target.value)} />
              <Button type="button" variant="primary" size="sm" className="shrink-0" loading={testing}
                disabled={!setup.configured || dirty || !testTo.includes('@')} onClick={sendTest}
                leftIcon={<Send className="h-3.5 w-3.5" />}>
                Send test email
              </Button>
            </div>
            {dirty && <p className="text-[11.5px] text-fg-3">Save your changes first.</p>}
            {testMsg && <Alert tone={testMsg.tone} title={testMsg.tone === 'verify' ? 'Sent' : 'Test failed'}>{testMsg.text}</Alert>}
            {!testMsg && setup.last_test && (
              <p className={cn('flex items-center gap-1.5 text-[12px]', setup.last_test.ok ? 'text-signal-verify' : 'text-signal-alarm')}>
                {setup.last_test.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <CircleAlert className="h-3.5 w-3.5" />}
                Last test {setup.last_test.ok ? 'sent' : 'failed'} {new Date(setup.last_test.at).toLocaleString()} (to *@{setup.last_test.to_domain})
                {setup.last_test.error ? ` — ${setup.last_test.error}` : ''}
              </p>
            )}
          </div>
        </Card>
      )}

      {provider && dns && <DnsHelpCard dns={dns} />}

      <AgentPromptBox title="Have your coding agent set up email" prompt={prompt} />
    </div>
  )
}

function DnsHelpCard({ dns }: { dns: DnsHelp }) {
  const check = dns.check
  return (
    <Card inset>
      <CardHeader eyebrow="DNS" title={`Records for ${dns.domain}`} />
      <div className="space-y-4 px-4 pb-4 text-[13px] text-fg-2">
        <p>So inboxes trust your mail, your domain needs these records. {dns.where_to_get}</p>
        <ol className="list-decimal space-y-1 pl-5">
          {dns.steps.map(s => <li key={s}>{s}</li>)}
        </ol>
        <div className="space-y-2">
          {dns.records.map(r => (
            <div key={`${r.purpose}-${r.host}`} className="rounded-md border border-line bg-surface-1 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="accent">{r.purpose}</Badge>
                <Badge tone="neutral">{r.type}</Badge>
                <code className="min-w-0 break-all font-mono text-[12px] text-fg-0">{r.host}</code>
                <CopyButton text={r.host} label="Copy name" className="ml-auto" />
              </div>
              <div className="mt-2 flex flex-wrap items-start gap-2">
                <code className="min-w-0 flex-1 break-all font-mono text-[12px] text-fg-1">{r.value}</code>
                {!r.value.includes('…') && !r.value.includes('<') && <CopyButton text={r.value} label="Copy value" />}
              </div>
              <p className="mt-1 text-[11.5px] text-fg-3">{r.note}</p>
            </div>
          ))}
        </div>
        {check && !check.error && (
          <div>
            <SectionLabel>What {check.domain} publishes now</SectionLabel>
            <ul className="space-y-1 text-[12px]">
              <li className={check.spf ? 'text-signal-verify' : 'text-signal-amber'}>
                SPF: {check.spf ? <code className="break-all font-mono">{check.spf}</code> : 'not found'}
              </li>
              <li className={check.dmarc ? 'text-signal-verify' : 'text-signal-amber'}>
                DMARC: {check.dmarc ? <code className="break-all font-mono">{check.dmarc}</code> : 'not found'}
              </li>
              <li className="text-fg-3">DKIM: check the provider's dashboard — it shows a green "verified" once the record is live.</li>
            </ul>
          </div>
        )}
      </div>
    </Card>
  )
}

export default EmailSettingsPanel
