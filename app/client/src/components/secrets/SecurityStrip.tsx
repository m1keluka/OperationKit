/**
 * The three promises the Secrets page makes, said once at the top instead of
 * scattered through hint text (obj 900749). Every one is enforced server-side:
 *   - write-only:  no route returns a value (D1, obj 900540)
 *   - encrypted:   AES-256-GCM at rest under a KEK outside session mounts
 *   - use by name: bots name a secret; the broker injects it to allowed hosts
 *                  and redacts the reply (obj 715532 / 900749)
 */
import { Bot, Lock, ShieldCheck } from 'lucide-react'

const ITEMS = [
  { icon: Lock, title: 'Write-only', text: 'Never shown again after you save it. Rotate to change it.' },
  { icon: ShieldCheck, title: 'Encrypted and scoped', text: 'Encrypted at rest. Each secret reaches only its scope.' },
  { icon: Bot, title: 'Bots use it by name', text: 'The server adds the value to allowed hosts only. Bots never see it.' },
] as const

export function SecurityStrip({ compact = false }: { compact?: boolean }) {
  return (
    <ul
      data-testid="secrets-security-strip"
      className={`grid gap-2 ${compact ? 'sm:grid-cols-3' : 'mb-4 sm:grid-cols-3'}`}
      aria-label="How secrets are protected"
    >
      {ITEMS.map(({ icon: Icon, title, text }) => (
        <li key={title} className="flex items-start gap-2 rounded-md border border-border bg-surface-raised px-3 py-2">
          <Icon aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-status-working" />
          <span className="min-w-0">
            <span className="block text-[13px] font-medium text-fg-0">{title}</span>
            <span className="block text-[12px] leading-snug text-fg-3">{text}</span>
          </span>
        </li>
      ))}
    </ul>
  )
}
