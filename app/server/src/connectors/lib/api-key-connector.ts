/**
 * Factory for an `auth_path: 'api_key'` catalog entry (obj 900508, Sprint
 * 7.4 preload), backed by the generic `connector_credentials` store
 * (services/generic-connector-credentials.ts) instead of a bespoke
 * per-vendor table. Each new def file (cloudflare.ts, airtable.ts, ...) is
 * just metadata + an optional `verify` call — the storage/guard plumbing
 * lives here once.
 */
import * as store from '../../services/generic-connector-credentials.js'
import { NOT_CONNECTED, type ConnectorDefinition, type ConnectOutcome, type ConnectorApiKeyField } from '../types.js'
import type { ConnectorProduct, ConnectorStatus } from '@operationkit/shared'

export interface ApiKeyConnectorOptions {
  id: string
  name: string
  description: string
  order?: number
  setup_guide: string
  products?: ConnectorProduct[]
  /** Fields the person pastes in, e.g. one `api_key` field. First field is the "primary" one masked as last4. */
  fields: ConnectorApiKeyField[]
  /**
   * Verify the pasted fields against the vendor's own API and resolve a
   * human-readable account label (e.g. a workspace/org name). Returning
   * `{ ok: false }` keeps nothing stored. Omit for a vendor with no cheap
   * "who am I" check — the fields are then stored unverified, same as a
   * plain secret pasted into Settings → Secrets.
   */
  verify?: (fields: Record<string, string>) => Promise<{ ok: true; account: string | null } | { ok: false; error: string }>
}

function toStatus(id: string, userId: number): ConnectorStatus {
  const s = store.getForUser(id, userId)
  if (!s) return NOT_CONNECTED
  return {
    state: s.last_error ? 'error' : 'connected',
    account: s.account_label,
    details: s.last4 ? [{ label: 'Key ends in', value: `••••${s.last4}` }] : [],
    connected_at: s.connected_at,
    checked_at: s.checked_at,
    error: s.last_error,
  }
}

export function apiKeyConnector(opts: ApiKeyConnectorOptions): ConnectorDefinition {
  const primaryKey = opts.fields[0]?.key ?? 'api_key'

  return {
    id: opts.id,
    name: opts.name,
    description: opts.description,
    order: opts.order,
    auth_path: 'api_key',
    setup_guide: opts.setup_guide,
    products: opts.products,
    api_key_fields: opts.fields,
    connect: {
      kind: 'token',
      fields: opts.fields.map(f => ({
        key: f.key,
        label: f.label,
        help: f.where_to_get_it_url ? `Get it at ${f.where_to_get_it_url}` : undefined,
        secret: true,
      })),
    },

    status: ctx => toStatus(opts.id, ctx.userId),

    async connectWithFields(ctx, fields): Promise<ConnectOutcome> {
      const primary = (fields[primaryKey] ?? '').trim()
      if (!primary) return { ok: false, error: `Paste a ${opts.fields[0]?.label ?? 'key'} first.` }
      let accountLabel: string | null = null
      if (opts.verify) {
        const result = await opts.verify(fields)
        if (!result.ok) return { ok: false, error: result.error }
        accountLabel = result.account
      }
      store.upsert(opts.id, ctx.userId, {
        fields,
        accountLabel,
        last4: store.last4(fields, primaryKey),
      })
      return { ok: true, status: toStatus(opts.id, ctx.userId) }
    },

    async check(ctx): Promise<ConnectOutcome> {
      const raw = store.getDecryptedForUser(opts.id, ctx.userId, { kind: 'user', userId: ctx.userId })
      if (!raw) return { ok: false, error: 'Not connected.' }
      if (!opts.verify) return { ok: true, status: toStatus(opts.id, ctx.userId) }
      const result = await opts.verify(raw)
      if (!result.ok) {
        store.recordError(opts.id, ctx.userId, result.error)
        return { ok: false, error: result.error }
      }
      store.upsert(opts.id, ctx.userId, { fields: raw, accountLabel: result.account, last4: store.last4(raw, primaryKey) })
      return { ok: true, status: toStatus(opts.id, ctx.userId) }
    },

    async disconnect(ctx) {
      store.deleteForUser(opts.id, ctx.userId)
    },
  }
}
