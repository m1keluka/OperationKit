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
  // Whole-vault graph (obj 900815): every folder is a kind. The common vault folders get a fixed colour…
  decision: { fill: 'fill-info', bg: 'bg-info' },
  architecture: { fill: 'fill-agent-general', bg: 'bg-agent-general' },
  audit: { fill: 'fill-warning', bg: 'bg-warning' },
  strategy: { fill: 'fill-success', bg: 'bg-success' },
  prd: { fill: 'fill-danger', bg: 'bg-danger' },
  runbook: { fill: 'fill-warning/60', bg: 'bg-warning/60' },
  bot: { fill: 'fill-info/60', bg: 'bg-info/60' },
  note: { fill: 'fill-fg-2', bg: 'bg-fg-2' },
}

/** …and any other folder name gets one of these, picked by its name so it is the same on every load. */
const EXTRA_TONES: Array<{ fill: string; bg: string }> = [
  { fill: 'fill-agent-cto/60', bg: 'bg-agent-cto/60' },
  { fill: 'fill-agent-cfo/60', bg: 'bg-agent-cfo/60' },
  { fill: 'fill-agent-coo/60', bg: 'bg-agent-coo/60' },
  { fill: 'fill-agent-cmo/60', bg: 'bg-agent-cmo/60' },
  { fill: 'fill-accent/60', bg: 'bg-accent/60' },
  { fill: 'fill-success/60', bg: 'bg-success/60' },
  { fill: 'fill-danger/60', bg: 'bg-danger/60' },
  { fill: 'fill-agent-general/60', bg: 'bg-agent-general/60' },
]

function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h
}

export const toneOf = (kind: string) => KIND_TONE[kind] ?? (kind === 'generated' ? { fill: 'fill-fg-2', bg: 'bg-fg-2' } : EXTRA_TONES[hash(kind) % EXTRA_TONES.length])

export function kindName(kind: string): string {
  if (kind === 'answer') return 'Saved answer'
  if (kind === 'source') return 'Source'
  if (kind === 'prd') return 'PRD'
  return kind.charAt(0).toUpperCase() + kind.slice(1).replace(/[-_]+/g, ' ')
}
