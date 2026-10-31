/**
 * GitHub connector. Wraps the existing per-person token store
 * (services/user-github-tokens.ts) — same table, same encryption, so tokens
 * linked before Connectors existed show up here unchanged.
 */
import {
  getForUser,
  getDecryptedForUser,
  upsert,
  touchValidated,
  deleteForUser,
  validatePat,
} from '../../services/user-github-tokens.js'
import type { UserGithubTokenSummary, ConnectorStatus } from '@operationkit/shared'
import { NOT_CONNECTED, type ConnectorDefinition, type ConnectOutcome } from '../types.js'

function toStatus(s: UserGithubTokenSummary | null): ConnectorStatus {
  if (!s) return NOT_CONNECTED
  return {
    state: 'connected',
    account: s.github_login,
    details: [
      { label: 'Commits as', value: s.github_email },
      { label: 'Token', value: `ends in ••••${s.token_last4}` },
    ],
    connected_at: s.created_at,
    checked_at: s.last_validated_at,
    error: null,
  }
}

async function saveValidated(userId: number, raw: string): Promise<ConnectOutcome> {
  const result = await validatePat(raw)
  if (!result.ok) return { ok: false, error: result.error }
  upsert(userId, {
    rawToken: raw,
    login: result.data.login,
    githubUserId: result.data.id,
    email: result.data.email,
    scopes: result.data.scopes,
    tokenType: result.data.type,
  })
  return { ok: true, status: toStatus(touchValidated(userId)) }
}

const github: ConnectorDefinition = {
  id: 'github',
  name: 'GitHub',
  order: 10,
  description:
    'Lets agents open pull requests and push code as you, so the work is credited to your GitHub account.',
  products: [
    { id: 'repos', name: 'Repositories', description: 'Read and change code in the repositories the token can reach.' },
    { id: 'pull-requests', name: 'Pull requests', description: 'Open and update pull requests under your name.' },
  ],
  connect: {
    kind: 'token',
    fields: [
      {
        key: 'token',
        label: 'Personal access token',
        placeholder: 'github_pat_… or ghp_…',
        help: 'Create a fine-grained token on GitHub with Contents and Pull requests set to read and write, for the repositories agents should work in.',
        secret: true,
      },
    ],
  },

  status: ctx => toStatus(getForUser(ctx.userId)),

  async connectWithFields(ctx, fields) {
    const token = (fields.token ?? '').trim()
    if (!token) return { ok: false, error: 'Paste a GitHub token first.' }
    return saveValidated(ctx.userId, token)
  },

  async check(ctx) {
    const raw = getDecryptedForUser(ctx.userId)
    if (!raw) return { ok: false, error: 'GitHub is not connected.' }
    return saveValidated(ctx.userId, raw)
  },

  async disconnect(ctx) {
    deleteForUser(ctx.userId)
  },
}

export default github
