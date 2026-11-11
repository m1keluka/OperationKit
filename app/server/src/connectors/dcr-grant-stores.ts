/**
 * Static map from a `dcr_mcp` connector id to its own `storeOAuthGrant`
 * (Sprint 7.3, obj 900507). routes/user-dcr.ts's ONE callback route is
 * generic across every `dcr_mcp` connector except this one seam: persisting
 * the grant is each connector's own storage call (defs/notion.ts,
 * defs/linear.ts), so a connector that later needs to resolve its own account
 * label from the token response can do so without the callback route growing
 * a per-vendor branch. A plain object, not a dynamic `import()`, so adding a
 * connector here is a one-line, statically-checked change.
 */
import { CONNECTOR_ID as NOTION_ID, storeOAuthGrant as storeNotionGrant } from './defs/notion.js'
import { CONNECTOR_ID as LINEAR_ID, storeOAuthGrant as storeLinearGrant } from './defs/linear.js'

export interface DcrGrantTokens {
  accessToken: string
  refreshToken?: string
  expiresAt?: string | null
  scopes?: string | null
}

export const DCR_GRANT_STORES: Record<string, (userId: number, tokens: DcrGrantTokens) => void> = {
  [NOTION_ID]: storeNotionGrant,
  [LINEAR_ID]: storeLinearGrant,
}
