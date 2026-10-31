// ── Connectors (obj 720115) ──
//
// A connector links an outside account (GitHub, Google Workspace, …) to a
// person in this app. The server keeps the credential encrypted and NEVER sends
// it back: every type below is a summary that describes a connection without
// containing it.

/** One input the person fills in to connect with a key or token. */
export interface ConnectorField {
  key: string
  label: string
  /** Shown in the box before anything is typed. */
  placeholder?: string
  /** One plain-language line under the box. */
  help?: string
  /** true = rendered as a password box and cleared after use. */
  secret: boolean
}

/** How a person connects: paste a key/token, or sign in on the provider's site. */
export type ConnectorConnectMethod =
  | { kind: 'token'; fields: ConnectorField[] }
  | { kind: 'oauth'; button_label: string }

/** Something the connector unlocks, e.g. Gmail inside Google Workspace. */
export interface ConnectorProduct {
  id: string
  name: string
  description: string
}

export type ConnectorState = 'connected' | 'not_connected' | 'error'

export interface ConnectorStatus {
  state: ConnectorState
  /** Who it is connected as — a login or email, never a secret. */
  account: string | null
  /** Extra label/value rows, e.g. "Token ends in ••••a1B2". */
  details: { label: string; value: string }[]
  connected_at: string | null
  checked_at: string | null
  /** Plain-language problem when state is 'error'. */
  error: string | null
}

/**
 * Who may use a connection. `null` means "all" (the default, so existing
 * connections keep working); an array is an allow-list. An empty array means
 * nobody — the credential stays stored but no agent session receives it.
 */
export interface ConnectorAccess {
  agents: string[] | null
  workspaces: string[] | null
}

export interface ConnectorSummary {
  id: string
  name: string
  description: string
  products: ConnectorProduct[]
  connect: ConnectorConnectMethod
  /** false when the server is not set up for this connector yet. */
  available: boolean
  /** Why it is unavailable, written for the person reading Settings. */
  unavailable_reason: string | null
  /** true when "Check connection" is supported. */
  can_check: boolean
  status: ConnectorStatus
  access: ConnectorAccess
}

/** POST /api/connectors/:id/connect — either finished, or go sign in. */
export type ConnectorConnectResponse =
  | { status: ConnectorStatus }
  | { redirect_url: string }
