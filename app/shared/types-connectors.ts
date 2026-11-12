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
  /**
   * Lend this connection to cards somebody ELSE assigned to me. Off by default:
   * routing work to a person is normal, but it must not silently hand that
   * person's outside accounts to whoever did the routing.
   */
  allow_delegated?: boolean
}

/** One withheld credential, for the admin audit view. Never carries a value. */
export interface ConnectorDenial {
  id: number
  connector_id: string
  owner_user_id: number | null
  actor_kind: string
  actor_user_id: number | null
  key_label: string | null
  objective_id: number | null
  reason: string
  detail: string
  at: string
}

/**
 * Which catalog UX flow a connector uses (Sprint 7 proposal, PR #681 §3).
 * Mirrors `ConnectorAuthPath` in `server/src/connectors/types.ts` — kept as a
 * plain string union here since the shared package cannot import server code.
 */
export type ConnectorAuthPath = 'dcr_mcp' | 'oauth_guided' | 'api_key' | 'self_hosted_aggregator'

/**
 * Guided-OAuth setup detail (obj 900506, Sprint 7.2) — present only when
 * `auth_path === 'oauth_guided'`. `redirect_uri` is computed server-side from
 * this install's own domain (never a shared/Example callback), so the guided
 * wizard can show it pre-filled rather than asking the person to guess it.
 */
export interface ConnectorOAuthSetup {
  redirect_uri: string
  scopes: string[]
}

/**
 * OPTIONAL, opt-in shared third-party OAuth app (Sprint 7.7, obj 900511).
 * Present only for connectors that MAY use one (`shared_app_eligible`);
 * `null` everywhere else. `enabled` is false on every fresh install — there
 * is no built-in issuer or client id, and Operation Kit runs no shared app.
 * Using one is a dependency on the third party the admin picked.
 */
export interface ConnectorSharedApp {
  /** The admin turned it on AND the config is complete. */
  enabled: boolean
  /** A config is saved (on or off). */
  configured: boolean
  issuer: string | null
  client_id: string | null
  redirect_uri: string | null
  provider_label: string | null
  /** This install's own callback — where the third party must relay `code` + `state`. */
  install_callback_uri: string
  /** The install has its own app for this connector, so the shared app is NOT used even if on. */
  own_app_configured: boolean
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
  auth_path: ConnectorAuthPath | null
  /** Set only for `auth_path === 'oauth_guided'` connectors. */
  oauth_setup: ConnectorOAuthSetup | null
  /** Relative path to this connector's setup walkthrough, e.g. `docs/connectors/guides/slack.md`. */
  setup_guide: string | null
  /** Opt-in shared third-party app state; `null` unless this connector may use one. Optional for older servers. */
  shared_app?: ConnectorSharedApp | null
}

/** POST /api/connectors/:id/connect — either finished, or go sign in. */
export type ConnectorConnectResponse =
  | { status: ConnectorStatus }
  | { redirect_url: string }
