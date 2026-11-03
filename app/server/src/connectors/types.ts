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

export interface ConnectorDefinition {
  /** Stable id used in URLs and access rules, e.g. 'github'. Lower-case, dashes. */
  id: string
  name: string
  /** One plain sentence: what connecting this lets agents do. */
  description: string
  products?: ConnectorProduct[]
  connect: ConnectorConnectMethod
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
