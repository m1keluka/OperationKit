// Wire types for /api/agent-chat (obj 719987). Mirrors routes/agent-chat.ts.
import type { ObjectiveStatus } from '@operationkit/shared'

export type AgentColour = 'blue' | 'pink' | 'green' | 'amber' | 'grey'
export type ProviderId = 'claude' | 'anthropic' | 'openai' | 'xai' | 'openai-compatible' | 'demo'

export interface ChatAgentInfo {
  slug: string
  name: string
  description: string
  avatar: string
  colour: AgentColour
  knowledge_folders: string[]
  tools: string[]
  model: string | null
  provider: ProviderId | null
  version: string | null
  author: string | null
  source: 'file' | 'demo'
  answered_by: { id: ProviderId; model: string | null }
}

export interface AgentsResponse {
  agents: ChatAgentInfo[]
  demo: boolean
  providers: Record<ProviderId, boolean>
  default_provider: string | null
  problems?: { slug: string; file: string; errors: string[] }[]
}

export interface ChatMessage {
  id: number
  role: 'user' | 'assistant' | 'tool' | 'error'
  content: string
  provider: string | null
  model: string | null
  tool_name: string | null
  meta: { draft_id?: number; objective_id?: number; provider_label?: string; ok?: boolean } | null
  created_at: string
}

export interface EmailDraftPayload { to: string; subject: string; body: string; in_reply_to?: string | null }
export interface EventDraftPayload { title: string; start: string; end: string; with: string[]; note?: string | null }

export interface ChatDraft {
  id: number
  kind: 'email' | 'event'
  connector: string
  payload: EmailDraftPayload | EventDraftPayload
  status: 'draft' | 'sent' | 'added' | 'discarded'
}

export interface ChatCard {
  id: number
  title: string
  status: ObjectiveStatus
  summary: string | null
  pr_url: string | null
  updated_at: string
  url: string
}

export interface ThreadResponse {
  messages: ChatMessage[]
  drafts: ChatDraft[]
  cards: ChatCard[]
}

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  claude: 'Claude',
  anthropic: 'Anthropic API',
  openai: 'OpenAI',
  xai: 'Grok (xAI)',
  'openai-compatible': 'Custom endpoint',
  demo: 'Demo (no AI account)',
}

/** Agent colour names → the agent-* design tokens (literal class strings so Tailwind keeps them). */
export const COLOUR_CLASSES: Record<AgentColour, { tile: string; ring: string }> = {
  blue: { tile: 'bg-agent-cto/15 text-agent-cto border-agent-cto/35', ring: 'ring-agent-cto/40' },
  pink: { tile: 'bg-agent-cmo/15 text-agent-cmo border-agent-cmo/35', ring: 'ring-agent-cmo/40' },
  green: { tile: 'bg-agent-coo/15 text-agent-coo border-agent-coo/35', ring: 'ring-agent-coo/40' },
  amber: { tile: 'bg-agent-cfo/15 text-agent-cfo border-agent-cfo/35', ring: 'ring-agent-cfo/40' },
  grey: { tile: 'bg-agent-general/15 text-agent-general border-agent-general/35', ring: 'ring-agent-general/40' },
}
