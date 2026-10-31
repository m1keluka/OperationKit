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
 * Connections belong to one person. Agents only ever receive a credential at
 * session start, as an environment variable, and only when the connection's
 * access rules (connectors/access.ts) allow that agent in that workspace.
 */
import type {
  ConnectorConnectMethod,
  ConnectorProduct,
  ConnectorStatus,
} from '@operationkit/shared'

export interface ConnectorContext {
  userId: number
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
