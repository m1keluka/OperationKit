/**
 * A copy-paste prompt for "have your coding agent do this" (obj 900497).
 * Token-bound styling only.
 */
import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button, cn } from '../ui'

export function CopyButton({ text, label = 'Copy', className }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // Older browsers / insecure origins: fall back to a hidden textarea.
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      try { document.execCommand('copy') } finally { ta.remove() }
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <Button type="button" size="sm" variant="secondary" className={className} onClick={copy}
      leftIcon={copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}>
      {copied ? 'Copied' : label}
    </Button>
  )
}

export function AgentPromptBox({ title, prompt, className }: { title: string; prompt: string; className?: string }) {
  return (
    <div className={cn('rounded-md border border-line bg-surface-1', className)}>
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <span className="text-[12px] font-medium text-fg-1">{title}</span>
        <CopyButton text={prompt} label="Copy prompt" />
      </div>
      <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11.5px] leading-relaxed text-fg-2">{prompt}</pre>
    </div>
  )
}
