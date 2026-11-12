/**
 * Integrations: "New Integration" + the Integrations bot (obj 900682).
 *
 * Extends Sprint 7 (#900499: connector catalog + setup guides) and Sprint 7.8
 * (#900620: connect any MCP server). The bot is a board card whose session
 * connects an MCP server through the SAME 900620 path, or scaffolds an okit
 * http-api Tool, and asks for keys through the card's in-chat secret request
 * (`POST /api/objectives/:id/request-secret`, the masked form). No type here
 * ever carries a credential value — only secret NAMES.
 */

/** POST /api/integrations/builder — "Make my own". Both fields optional: the bot asks for what is missing. */
export interface IntegrationBuilderCreateRequest {
  workspace: string
  /** What to integrate, in the person's words ("our Acme CRM", "Shopify orders"). */
  target?: string
  /** API docs: a URL, or pasted text. */
  docs?: string
}

export interface IntegrationBuilderCreateResponse {
  ok: true
  objective_id: number
  workspace: string
  /** true when the card's session is running now. */
  started: boolean
  /** Why it did not start (session cap, …) — the card is in the queue. */
  start_detail: string | null
  /**
   * false when `settings.session_secret_access` is off: the bot cannot open the
   * in-chat secret form, so it asks the person to add keys in Settings → Secrets.
   */
  secret_form_enabled: boolean
}

export type IntegrationBuildKind = 'mcp_server' | 'tool'

/** Something an Integrations bot built. Listed on the main Integrations view (connected). */
export interface IntegrationBuildSummary {
  id: number
  objective_id: number
  workspace: string
  kind: IntegrationBuildKind
  /** `mcp_server`: the workspace MCP server id; `tool`: the okit Tool slug. */
  ref: string
  name: string
  description: string | null
  /** Env-var NAMES the integration reads (never values). */
  secret_names: string[]
  created_at: string
}
