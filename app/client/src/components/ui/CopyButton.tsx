import { useState } from 'react'
import { Button } from './Button'
import { cn } from './cn'

/**
 * Small "copy to clipboard" action button, for paste-ready snippets (MCP
 * config, curl examples, …). Falls back silently if the clipboard API is
 * unavailable — the snippet stays visible/selectable either way.
 */
export function CopyButton({
  value,
  label = 'Copy',
  copiedLabel = 'Copied',
  className,
}: {
  value: string
  label?: string
  copiedLabel?: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard API unavailable/denied — the snippet is still selectable by hand.
    }
  }

  return (
    <Button type="button" variant="secondary" className={cn('shrink-0', className)} onClick={() => void copy()}>
      {copied ? copiedLabel : label}
    </Button>
  )
}
