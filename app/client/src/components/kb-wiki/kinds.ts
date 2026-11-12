/* Colour + name per knowledge-base page kind, shared by the per-page
   Connections panel (PageGraph) and the workspace graph (WorkspaceGraph).
   Token classes only, so both follow the light/dark theme. */

/** Token colour per page kind — fill for an SVG dot, bg for a list/legend dot. */
export const KIND_TONE: Record<string, { fill: string; bg: string }> = {
  person: { fill: 'fill-agent-cto', bg: 'bg-agent-cto' },
  organization: { fill: 'fill-agent-cfo', bg: 'bg-agent-cfo' },
  project: { fill: 'fill-agent-coo', bg: 'bg-agent-coo' },
  product: { fill: 'fill-agent-cmo', bg: 'bg-agent-cmo' },
  topic: { fill: 'fill-accent', bg: 'bg-accent' },
  answer: { fill: 'fill-fg-0', bg: 'bg-fg-0' },
  // Sources are the documents themselves: pale, like attachments in Obsidian, so the entities stand out.
  source: { fill: 'fill-line-strong', bg: 'bg-line-strong' },
}

export const toneOf = (kind: string) => KIND_TONE[kind] ?? { fill: 'fill-fg-2', bg: 'bg-fg-2' }

export function kindName(kind: string): string {
  if (kind === 'answer') return 'Saved answer'
  if (kind === 'source') return 'Source'
  return kind.charAt(0).toUpperCase() + kind.slice(1).replace(/[-_]+/g, ' ')
}
