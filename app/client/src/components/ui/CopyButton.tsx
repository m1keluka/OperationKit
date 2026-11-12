import { useEffect, useRef, useState } from 'react'
import { Button } from './Button'
import { cn } from './cn'

/** How long the "Copied" / "Copy failed" confirmation stays before the label resets. */
export const COPY_FEEDBACK_MS = 2000

/**
 * Write `value` to the clipboard. Uses the async Clipboard API when present and
 * falls back to a hidden-textarea `execCommand('copy')` when the API is missing
 * (non-secure context) or rejects (permission/focus). Resolves true on success.
 */
export async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = value
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = typeof document.execCommand === 'function' && document.execCommand('copy')
    ta.remove()
    return !!ok
  } catch {
    return false
  }
}

/**
 * Small "copy to clipboard" action button, for paste-ready snippets (MCP
 * config, curl examples, agent prompts, …). Always gives visible feedback:
 * the label flips to `copiedLabel` (or `failedLabel` if nothing could be
 * copied) for COPY_FEEDBACK_MS, then restores. The change is announced to
 * screen readers via a polite live region.
 */
export function CopyButton({
  value,
  label = 'Copy',
  copiedLabel = 'Copied',
  failedLabel = 'Copy failed',
  size,
  className,
}: {
  value: string
  label?: string
  copiedLabel?: string
  failedLabel?: string
  size?: 'sm' | 'md'
  className?: string
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  async function copy() {
    const ok = await copyText(value)
    setState(ok ? 'copied' : 'failed')
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setState('idle'), COPY_FEEDBACK_MS)
  }

  const text = state === 'copied' ? copiedLabel : state === 'failed' ? failedLabel : label

  return (
    <Button
      type="button"
      variant="secondary"
      size={size}
      className={cn('shrink-0', className)}
      onClick={() => void copy()}
      data-copy-state={state}
    >
      {state === 'copied' && <span aria-hidden="true">✓</span>}
      <span aria-live="polite">{text}</span>
    </Button>
  )
}
