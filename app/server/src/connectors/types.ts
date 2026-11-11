/**
 * Connector contract (obj 720115).
 *
 * A connector is ONE file in `connectors/defs/` that default-exports a
 * `ConnectorDefinition`. The registry finds it on its own — adding Slack,
 * Microsoft 365 or an MCP server means adding one file there, nothing else.
 *
 * Rules every connector must follow:
 *   - Store credentials server-side, encrypted (services/crypto.ts), and never
 *     return them. `status()` describes a connection; it never contains one.
 *   - Never log a credential.
 *   - Fail closed in `status()`: report 'error' with a plain sentence rather
 *     than throwing.
 *
 * Connections belong to one person, and that is enforced rather than assumed:
 * EVERY read of a stored credential goes through `canUseConnectorCredential`
 * (services/connector-guard.ts), which denies by default and denies across
 * users regardless of role. A connector that needs the credential outside
 * `status()`/`check()` must declare `readCredential` below instead of
 * reaching into its own storage, so a new connector is owner-scoped without its
 * author having to remember to make it so.
 *
 * Agents only ever receive a credential at session start, as an environment
 * variable, and only when the guard allows that actor, agent and workspace.
 */
import type {
  ConnectorConnectMethod,
  ConnectorProduct,
  ConnectorStatus,
} from '@operationkit/shared'

export interface ConnectorContext {
  /** The person whose connection this is. Never anybody else's. */
  userId: number
}

/**
 * Who is asking for a credential, and in aid of what. Mirrors
 * `ConnectorCredentialRequest` without importing the service layer, so a
 * connector file stays a plain description of a provider.
 */
export interface ConnectorCredentialUse {
  actor: ConnectorActorRef
  agent?: string | null
  workspace?: string | null
  /** The work was assigned to the owner by somebody else. */
  delegated?: boolean
}

export interface ConnectorActorRef {
  kind: 'user' | 'agent_key' | 'session' | 'server'
  userId: number | null | undefined
  keyId?: number
  keyLabel?: string
  connectors?: string[] | null
  objectiveId?: number | null
  agentKey?: { keyId: number; keyLabel: string; connectors: string[] | null } | null
}

export type ConnectOutcome =
  | { ok: true; status: ConnectorStatus }
  | { ok: true; redirectUrl: string }
  | { ok: false; error: string }

/**
 * Which of the catalog's four UX flows this integration uses (Sprint 7
 * integrations proposal, PR #681, §3). Tells Settings → Connectors which flow
 * to render and lets a reviewer see, per connector, which of the proposal's
 * options (a-d) was chosen without reading the implementation:
 *   - 'dcr_mcp'                — remote MCP server, client registers itself via
 *                                OAuth 2.1 Dynamic Client Registration / CIMD
 *   - 'oauth_guided'           — a per-provider OAuth app this install owns
 *                                (today's `connect: { kind: 'oauth' }` flow)
 *   - 'api_key'                — paste a key/token (today's `connect: { kind: 'token' }` flow)
 *   - 'self_hosted_aggregator' — deferred to a self-hosted aggregator (e.g. Nango)
 */
export type ConnectorAuthPath = 'dcr_mcp' | 'oauth_guided' | 'api_key' | 'self_hosted_aggregator'

/** Every value `auth_path` may take. Exported so the registry can validate against one list. */
export const CONNECTOR_AUTH_PATHS: readonly ConnectorAuthPath[] = [
  'dcr_mcp',
  'oauth_guided',
  'api_key',
  'self_hosted_aggregator',
]

/** OAuth endpoints for an `auth_path: 'oauth_guided'` connector. Informational today — the guided wizard that renders these is a later follow-up. */
export interface ConnectorOAuthEndpoints {
  authorize_url: string
  token_url: string
  scopes: string[]
}

/** One field an `auth_path: 'api_key'` connector asks for, beyond the existing `connect.fields`. */
export interface ConnectorApiKeyField {
  key: string
  label: string
  where_to_get_it_url?: string
}

export interface ConnectorDefinition {
  /** Stable id used in URLs and access rules, e.g. 'github'. Lower-case, dashes. */
  id: string
  name: string
  /** One plain sentence: what connecting this lets agents do. */
  description: string
  products?: ConnectorProduct[]
  connect: ConnectorConnectMethod
  /**
   * Which catalog UX flow this integration uses (see `ConnectorAuthPath`).
   * Required so every connector states its path explicitly rather than
   * leaving it to be inferred from `connect.kind`.
   */
  auth_path: ConnectorAuthPath
  /** Path to a setup walkthrough, e.g. `docs/connectors/guides/github.md`. Omit until a guide exists. */
  setup_guide?: string
  /** Remote MCP endpoint, for `auth_path: 'dcr_mcp'`. */
  mcp_url?: string
  /** OAuth endpoints/scopes, for `auth_path: 'oauth_guided'`. */
  oauth?: ConnectorOAuthEndpoints
  /** Extra key fields a wizard would prompt for, for `auth_path: 'api_key'`. */
  api_key_fields?: ConnectorApiKeyField[]
  /** Sort position in Settings (lower first). */
  order?: number
  /** Is the server set up for this connector? Omit when it always is. */
  availability?(): { ok: true } | { ok: false; reason: string }
  status(ctx: ConnectorContext): ConnectorStatus | Promise<ConnectorStatus>
  /**
   * Hand back the credential material this connector contributes to a session,
   * as environment variables. The registry calls this ONLY after the owner
   * guard has passed, and returns `{}` otherwise — so implementing it cannot
   * leak across users even if the implementation forgets to check. Omit it when
   * the connector contributes nothing to a session env.
   */
  readCredential?(ctx: ConnectorContext, use: ConnectorCredentialUse): Record<string, string>
  /** Called with the filled-in fields when `connect.kind === 'token'`. */
  connectWithFields?(ctx: ConnectorContext, fields: Record<string, string>): Promise<ConnectOutcome>
  /** Called when `connect.kind === 'oauth'`; returns where to send the browser. */
  startOAuth?(ctx: ConnectorContext): Promise<ConnectOutcome>
  /** Re-test a stored connection. Omit when there is nothing to test. */
  check?(ctx: ConnectorContext): Promise<ConnectOutcome>
  disconnect(ctx: ConnectorContext): Promise<void>
}

export const NOT_CONNECTED: ConnectorStatus = {
  state: 'not_connected',
  account: null,
  details: [],
  connected_at: null,
  checked_at: null,
  error: null,
}
