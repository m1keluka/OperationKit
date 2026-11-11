import { describe, it, expect } from 'vitest'
import {
  discoverAuthServerMetadata,
  chooseRegistrationStrategy,
  buildClientMetadataDocument,
  registerDynamicClient,
  ensureRegisteredClient,
  generatePkceVerifier,
  pkceChallengeFromVerifier,
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  refreshAccessToken,
  type AuthServerMetadata,
  type FetchLike,
} from './dcr-client.js'

function jsonResponse(body: unknown, init?: { status?: number }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

const notionLikeMetadata: AuthServerMetadata = {
  issuer: 'https://mcp.example.com',
  authorization_endpoint: 'https://mcp.example.com/authorize',
  token_endpoint: 'https://mcp.example.com/token',
  registration_endpoint: 'https://mcp.example.com/register',
  client_id_metadata_document_supported: true,
}

describe('discoverAuthServerMetadata', () => {
  it('parses a well-formed metadata document', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(notionLikeMetadata)
    const result = await discoverAuthServerMetadata('https://mcp.example.com', fetchImpl)
    expect(result).toEqual(notionLikeMetadata)
  })

  it('requests the well-known path, stripping a trailing slash', async () => {
    let seenUrl = ''
    const fetchImpl: FetchLike = async (url) => {
      seenUrl = url
      return jsonResponse(notionLikeMetadata)
    }
    await discoverAuthServerMetadata('https://mcp.example.com/', fetchImpl)
    expect(seenUrl).toBe('https://mcp.example.com/.well-known/oauth-authorization-server')
  })

  it('returns null on a network error', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('ECONNREFUSED')
    }
    expect(await discoverAuthServerMetadata('https://mcp.example.com', fetchImpl)).toBeNull()
  })

  it('returns null on a non-2xx response', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ error: 'not_found' }, { status: 404 })
    expect(await discoverAuthServerMetadata('https://mcp.example.com', fetchImpl)).toBeNull()
  })

  it('returns null when required fields are missing', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ issuer: 'https://mcp.example.com' })
    expect(await discoverAuthServerMetadata('https://mcp.example.com', fetchImpl)).toBeNull()
  })
})

describe('chooseRegistrationStrategy', () => {
  it('prefers CIMD over DCR when both are advertised (spec priority order)', () => {
    expect(chooseRegistrationStrategy(notionLikeMetadata)).toBe('cimd')
  })

  it('falls back to DCR when only registration_endpoint is present', () => {
    expect(
      chooseRegistrationStrategy({
        ...notionLikeMetadata,
        client_id_metadata_document_supported: undefined,
      }),
    ).toBe('dcr')
  })

  it('returns none when neither is present (e.g. GitHub)', () => {
    expect(
      chooseRegistrationStrategy({
        issuer: 'https://github.com',
        authorization_endpoint: 'https://github.com/login/oauth/authorize',
        token_endpoint: 'https://github.com/login/oauth/access_token',
      }),
    ).toBe('none')
  })

  it('returns none for null metadata (discovery failed)', () => {
    expect(chooseRegistrationStrategy(null)).toBe('none')
  })
})

describe('buildClientMetadataDocument', () => {
  it('builds a public-client CIMD document (no secret, PKCE-capable)', () => {
    const doc = buildClientMetadataDocument({
      clientName: 'Command Center',
      redirectUri: 'https://ai.example.com/api/user/dcr/notion/callback',
      scope: 'read write',
    })
    expect(doc.token_endpoint_auth_method).toBe('none')
    expect(doc.redirect_uris).toEqual(['https://ai.example.com/api/user/dcr/notion/callback'])
    expect(doc.grant_types).toContain('authorization_code')
    expect(doc.scope).toBe('read write')
  })
})

describe('registerDynamicClient', () => {
  it('registers successfully and returns issued credentials', async () => {
    const fetchImpl: FetchLike = async (url, init) => {
      expect(url).toBe(notionLikeMetadata.registration_endpoint)
      expect(init?.method).toBe('POST')
      const body = JSON.parse(String(init?.body))
      expect(body.redirect_uris).toEqual(['https://ai.example.com/cb'])
      return jsonResponse({ client_id: 'client-abc', client_secret: 'shh', client_id_issued_at: 123 })
    }
    const result = await registerDynamicClient(
      notionLikeMetadata,
      { client_name: 'Command Center', redirect_uris: ['https://ai.example.com/cb'] },
      fetchImpl,
    )
    expect(result).toEqual({
      ok: true,
      data: { client_id: 'client-abc', client_secret: 'shh', client_id_issued_at: 123, client_secret_expires_at: undefined },
    })
  })

  it('fails when the metadata has no registration_endpoint', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({})
    const result = await registerDynamicClient(
      { ...notionLikeMetadata, registration_endpoint: undefined },
      { client_name: 'x', redirect_uris: ['https://ai.example.com/cb'] },
      fetchImpl,
    )
    expect(result.ok).toBe(false)
  })

  it('fails on a non-2xx response', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ error: 'invalid_client_metadata' }, { status: 400 })
    const result = await registerDynamicClient(
      notionLikeMetadata,
      { client_name: 'x', redirect_uris: ['https://ai.example.com/cb'] },
      fetchImpl,
    )
    expect(result).toEqual({ ok: false, error: 'Registration rejected (HTTP 400).' })
  })

  it('fails when the response has no client_id', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ not_a_client_id: true })
    const result = await registerDynamicClient(
      notionLikeMetadata,
      { client_name: 'x', redirect_uris: ['https://ai.example.com/cb'] },
      fetchImpl,
    )
    expect(result.ok).toBe(false)
  })
})

describe('ensureRegisteredClient', () => {
  it('uses CIMD (no registration call) when the provider advertises it', async () => {
    let registrationCalls = 0
    const fetchImpl: FetchLike = async (url) => {
      if (url.endsWith('/.well-known/oauth-authorization-server')) return jsonResponse(notionLikeMetadata)
      registrationCalls++
      return jsonResponse({ client_id: 'should-not-be-called' })
    }
    const result = await ensureRegisteredClient({
      issuerBaseUrl: 'https://mcp.example.com',
      clientName: 'Command Center',
      redirectUri: 'https://ai.example.com/api/user/dcr/notion/callback',
      cimdMetadataUrl: 'https://ai.example.com/api/connectors/dcr-client-metadata/notion.json',
      fetchImpl,
    })
    expect(result).toEqual({
      ok: true,
      data: { method: 'cimd', clientId: 'https://ai.example.com/api/connectors/dcr-client-metadata/notion.json', metadata: notionLikeMetadata },
    })
    expect(registrationCalls).toBe(0)
  })

  it('falls back to DCR when CIMD is not advertised', async () => {
    const dcrOnly: AuthServerMetadata = { ...notionLikeMetadata, client_id_metadata_document_supported: undefined }
    const fetchImpl: FetchLike = async (url) => {
      if (url.endsWith('/.well-known/oauth-authorization-server')) return jsonResponse(dcrOnly)
      return jsonResponse({ client_id: 'registered-client', client_secret: 'secret-value' })
    }
    const result = await ensureRegisteredClient({
      issuerBaseUrl: 'https://mcp.example.com',
      clientName: 'Command Center',
      redirectUri: 'https://ai.example.com/cb',
      cimdMetadataUrl: 'https://ai.example.com/meta.json',
      fetchImpl,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.method).toBe('dcr')
      expect(result.data.clientId).toBe('registered-client')
      expect(result.data.clientSecret).toBe('secret-value')
    }
  })

  it('fails when the provider supports neither (e.g. GitHub) — caller should use an API key', async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse(
        {
          issuer: 'https://github.com',
          authorization_endpoint: 'https://github.com/login/oauth/authorize',
          token_endpoint: 'https://github.com/login/oauth/access_token',
        },
      )
    const result = await ensureRegisteredClient({
      issuerBaseUrl: 'https://github.com',
      clientName: 'Command Center',
      redirectUri: 'https://ai.example.com/cb',
      cimdMetadataUrl: 'https://ai.example.com/meta.json',
      fetchImpl,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/API key fallback/)
  })

  it('fails when discovery itself fails (404/.well-known missing)', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ error: 'not_found' }, { status: 404 })
    const result = await ensureRegisteredClient({
      issuerBaseUrl: 'https://unreachable.example.com',
      clientName: 'Command Center',
      redirectUri: 'https://ai.example.com/cb',
      cimdMetadataUrl: 'https://ai.example.com/meta.json',
      fetchImpl,
    })
    expect(result.ok).toBe(false)
  })
})

describe('PKCE helpers', () => {
  it('generates a verifier of plausible length and a deterministic S256 challenge', () => {
    const verifier = generatePkceVerifier()
    expect(verifier.length).toBeGreaterThanOrEqual(43)
    const challenge1 = pkceChallengeFromVerifier(verifier)
    const challenge2 = pkceChallengeFromVerifier(verifier)
    expect(challenge1).toBe(challenge2)
    expect(challenge1).not.toBe(verifier)
  })

  it('produces different verifiers on each call', () => {
    expect(generatePkceVerifier()).not.toBe(generatePkceVerifier())
  })
})

describe('buildAuthorizationUrl', () => {
  it('includes PKCE params when a code challenge is given', () => {
    const url = buildAuthorizationUrl(notionLikeMetadata, {
      clientId: 'client-abc',
      redirectUri: 'https://ai.example.com/cb',
      scope: 'read',
      state: 'state-123',
      codeChallenge: 'challenge-xyz',
    })
    const parsed = new URL(url)
    expect(parsed.origin + parsed.pathname).toBe('https://mcp.example.com/authorize')
    expect(parsed.searchParams.get('client_id')).toBe('client-abc')
    expect(parsed.searchParams.get('code_challenge')).toBe('challenge-xyz')
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256')
    expect(parsed.searchParams.get('state')).toBe('state-123')
  })

  it('omits PKCE params when no code challenge is given', () => {
    const url = buildAuthorizationUrl(notionLikeMetadata, {
      clientId: 'client-abc',
      redirectUri: 'https://ai.example.com/cb',
      state: 'state-123',
    })
    expect(new URL(url).searchParams.has('code_challenge')).toBe(false)
  })
})

describe('exchangeAuthorizationCode', () => {
  it('posts the authorization_code grant and returns tokens', async () => {
    const fetchImpl: FetchLike = async (url, init) => {
      expect(url).toBe('https://mcp.example.com/token')
      const body = new URLSearchParams(String(init?.body))
      expect(body.get('grant_type')).toBe('authorization_code')
      expect(body.get('code')).toBe('auth-code-1')
      expect(body.get('code_verifier')).toBe('verifier-1')
      return jsonResponse({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 })
    }
    const result = await exchangeAuthorizationCode(
      notionLikeMetadata,
      { code: 'auth-code-1', redirectUri: 'https://ai.example.com/cb', clientId: 'client-abc', codeVerifier: 'verifier-1' },
      fetchImpl,
    )
    expect(result).toEqual({ ok: true, data: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 } })
  })

  it('fails when the provider rejects the code', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ error: 'invalid_grant' }, { status: 400 })
    const result = await exchangeAuthorizationCode(
      notionLikeMetadata,
      { code: 'bad', redirectUri: 'https://ai.example.com/cb', clientId: 'client-abc' },
      fetchImpl,
    )
    expect(result.ok).toBe(false)
  })

  it('fails on a network error', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('ETIMEDOUT')
    }
    const result = await exchangeAuthorizationCode(
      notionLikeMetadata,
      { code: 'x', redirectUri: 'https://ai.example.com/cb', clientId: 'client-abc' },
      fetchImpl,
    )
    expect(result).toEqual({ ok: false, error: 'Could not reach https://mcp.example.com/token: ETIMEDOUT' })
  })
})

describe('refreshAccessToken', () => {
  it('posts the refresh_token grant and returns a new access token', async () => {
    const fetchImpl: FetchLike = async (url, init) => {
      const body = new URLSearchParams(String(init?.body))
      expect(body.get('grant_type')).toBe('refresh_token')
      expect(body.get('refresh_token')).toBe('rt-1')
      expect(body.get('client_secret')).toBe('secret-value')
      return jsonResponse({ access_token: 'at-2', expires_in: 3600 })
    }
    const result = await refreshAccessToken(
      notionLikeMetadata,
      { refreshToken: 'rt-1', clientId: 'client-abc', clientSecret: 'secret-value' },
      fetchImpl,
    )
    expect(result).toEqual({ ok: true, data: { access_token: 'at-2', expires_in: 3600 } })
  })

  it('fails when the response has no access_token', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ ok: true })
    const result = await refreshAccessToken(
      notionLikeMetadata,
      { refreshToken: 'rt-1', clientId: 'client-abc' },
      fetchImpl,
    )
    expect(result.ok).toBe(false)
  })
})
