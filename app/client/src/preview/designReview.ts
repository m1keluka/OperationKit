export type DesignTool = 'comment' | 'text'

export type DesignPin = {
  id: string
  kind: 'comment' | 'text'
  selector: string
  tag: string
  text: string
  note: string
  before?: string
  after?: string
}

export function newPinId(): string {
  return `pin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

export function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim())
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch {
    return false
  }
}

const URL_RE = /https?:\/\/[^\s)\]>'"]+/gi

export function extractPreviewUrls(...blobs: Array<string | null | undefined>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const blob of blobs) {
    if (!blob) continue
    const matches = blob.match(URL_RE) || []
    for (const raw of matches) {
      const cleaned = raw.replace(/[.,;]+$/, '')
      if (/github\.com\//i.test(cleaned)) continue
      if (seen.has(cleaned)) continue
      seen.add(cleaned)
      out.push(cleaned)
    }
  }
  return out
}

export function compileDesignFollowUp(pins: DesignPin[]): string {
  const comments = pins.filter(p => p.kind === 'comment')
  const texts = pins.filter(p => p.kind === 'text')
  const lines = ['## Design review', '']
  if (comments.length === 0 && texts.length === 0) return ''
  comments.forEach((p, i) => {
    lines.push(`### Comment ${i + 1} — \`${p.selector || p.tag}\``)
    if (p.text) lines.push(`Current text: "${p.text.slice(0, 180)}"`)
    lines.push(p.note.trim() || '(no note)')
    lines.push('')
  })
  texts.forEach((p, i) => {
    lines.push(`### Text edit ${i + 1} — \`${p.selector || p.tag}\``)
    lines.push(`- From: ${JSON.stringify(p.before ?? p.text)}`)
    lines.push(`- To: ${JSON.stringify(p.after ?? p.note)}`)
    lines.push('')
  })
  lines.push('Apply only these targeted changes. Do not rewrite unrelated sections.')
  return lines.join('\n').trim()
}
