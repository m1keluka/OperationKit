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
  /** "How to use" text for the info panel (obj 900672). Older servers omit it. */
  how_to_use?: string
  /** Example prompts for the info panel and an empty conversation (obj 900672). */
  example_prompts?: string[]
  source: 'file' | 'demo' | 'builtin'
  answered_by: { id: ProviderId; model: string | null }
  /** obj 900671 — optional so an older server's answer still renders. */
  all_tools?: boolean
  effective_tools?: string[]
  file_defaults?: { provider: ProviderId | null; model: string | null; tools: string[] }
  config?: BotConfigInfo | null
  /** obj 900747 — the About the "i" panel shows, resolved server-side. Older servers omit it. */
  about?: BotAbout
  /** GET /agents/:slug only: the bot's instructions (system prompt), shown read-only. */
  system_prompt?: string
  /** GET /agents/:slug only: the same instructions with secret-shaped values masked, for display. */
  instructions?: string
  /** obj 900748 — High Agency summary for the list. Older servers omit it. */
  high_agency?: { enabled: boolean; times_per_day: number }
}

/**
 * A bot's About (obj 900747). Text the bot's file sets wins per field; the rest
 * is generated from its instructions, tools and reach and refreshed whenever the
 * bot is created or changed.
 */
export interface BotAbout {
  description: string
  how_to_use: string
  example_prompts: string[]
  sources: { description: 'file' | 'generated'; how_to_use: 'file' | 'generated'; example_prompts: 'file' | 'generated' }
  generated_by: 'model' | 'rules' | null
  generated_at: string | null
  /** A fresh model-written About is on its way. */
  pending: boolean
}

/** An admin's bot-page overrides (obj 900671). null fields = the agent file's value. */
export interface BotConfigInfo {
  provider: ProviderId | null
  model: string | null
  tools: string[] | null
  all_tools: boolean
  updated_by: string | null
  updated_at: string
}

export type ToolGroup = 'web' | 'knowledge' | 'board' | 'connectors' | 'integrations' | 'secrets'

export interface ToolCatalogEntry {
  name: string
  label: string
  description: string
  group: ToolGroup
  /** Not granted by "All tools"; must be ticked on its own (obj 900749 — secret use). */
  explicit_only?: boolean
}

export interface AgentsResponse {
  agents: ChatAgentInfo[]
  demo: boolean
  providers: Record<ProviderId, boolean>
  default_provider: string | null
  problems?: { slug: string; file: string; errors: string[] }[]
  /** obj 900671 */
  tool_catalog?: ToolCatalogEntry[]
  model_suggestions?: Partial<Record<ProviderId, string[]>>
  default_models?: Partial<Record<ProviderId, string>>
  web?: { available: boolean; backends: string[] }
}

/** Body of PUT /agent-chat/agents/:slug/config (obj 900671). */
export interface BotConfigPatch {
  provider?: ProviderId | null
  model?: string | null
  tools?: string[] | null
  all_tools?: boolean
}

/** A bot's High Agency setting, as GET/PUT /agent-chat/agents/:slug/high-agency return it (obj 900748). */
export interface HighAgencyInfo {
  slug: string
  enabled: boolean
  times_per_day: number
  first_hour: number
  workspace: string | null
  allow_cards: boolean
  allow_workflows: boolean
  run_as_user_id: number | null
  routine_id: number | null
  updated_by: string | null
  updated_at: string | null
  /** UTC "HH:MM" wake times for the saved setting. */
  wake_times: string[]
  cron: string
  next_wake_at: string | null
  routine: {
    id: number
    enabled: boolean
    last_run_at: string | null
    auto_paused_at: string | null
    auto_pause_reason: string | null
  } | null
  last_wake: { objective_id: number; status: string; created_at: string } | null
}

export interface HighAgencyResponse {
  high_agency: HighAgencyInfo
  cadences: number[]
  max_cards_per_wake: number
  /** Admin only: where wake cards may land. */
  workspace_options?: string[]
  /** POST …/wake only: what the wake did. */
  result?: { ok: boolean; reason?: string; objective_id?: number }
}

/** Body of PUT /agent-chat/agents/:slug/high-agency. */
export interface HighAgencyPatch {
  enabled?: boolean
  times_per_day?: number
  first_hour?: number
  workspace?: string | null
  allow_cards?: boolean
  allow_workflows?: boolean
}

/** An image attached to a chat message (obj 900157). */
export interface ChatImage {
  id: number
  name: string
  media_type: string
  size: number
  /** Owner-only server route that serves the bytes. */
  url: string
}

export interface ChatMessage {
  id: number
  role: 'user' | 'assistant' | 'tool' | 'error'
  content: string
  provider: string | null
  model: string | null
  tool_name: string | null
  meta: { draft_id?: number; objective_id?: number; provider_label?: string; ok?: boolean } | null
  images?: ChatImage[]
  created_at: string
}

/** Image types the server accepts — kept in step with services/agent-chat/attachments.ts. */
export const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
export const MAX_IMAGES_PER_MESSAGE = 4
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

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

/**
 * One side thread — a concurrent task lane beside the main conversation
 * (obj 900370). `null` as a lane id means the MAIN conversation, which has no
 * row of its own and can never be closed.
 */
export interface ChatThread {
  id: number
  title: string
  pinned: boolean
  archived: boolean
  last_active_at: string | null
  created_at: string
  updated_at: string
  message_count: number
}

export interface ThreadsResponse {
  threads: ChatThread[]
  /** 0 means no ceiling. */
  max_open: number
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
  blue: { tile: 'bg-agent-cto/10 text-agent-cto border-agent-cto/35', ring: 'ring-agent-cto/40' },
  pink: { tile: 'bg-agent-cmo/10 text-agent-cmo border-agent-cmo/35', ring: 'ring-agent-cmo/40' },
  green: { tile: 'bg-agent-coo/10 text-agent-coo border-agent-coo/35', ring: 'ring-agent-coo/40' },
  amber: { tile: 'bg-agent-cfo/10 text-agent-cfo border-agent-cfo/35', ring: 'ring-agent-cfo/40' },
  grey: { tile: 'bg-agent-general/10 text-agent-general border-agent-general/35', ring: 'ring-agent-general/40' },
}
