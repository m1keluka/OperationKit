import { describe, it, expect } from 'vitest'
import { validateMcpUrl, blockedAddressReason, checkResolvedAddress, localDevAllowed } from './url-guard.js'
import { createSafeFetch, BlockedUrlError, guardedLookup } from './safe-fetch.js'

const PROD = { NODE_ENV: 'production' } as NodeJS.ProcessEnv
const DEV = { NODE_ENV: 'development' } as NodeJS.ProcessEnv

describe('validateMcpUrl — scheme rules', () => {
  it('accepts a public https URL', () => {
    const r = validateMcpUrl('https://mcp.example.com/mcp', PROD)
    expect(r.ok).toBe(true)
  })

  it('rejects plain http to a public host, even in dev', () => {
    for (const env of [PROD, DEV]) {
      const r = validateMcpUrl('http://mcp.example.com/mcp', env)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toMatch(/https/)
    }
  })

  it('rejects other schemes', () => {
    for (const u of ['ftp://mcp.example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'ws://mcp.example.com/mcp']) {
      expect(validateMcpUrl(u, PROD).ok).toBe(false)
    }
  })

  it('allows http://localhost only in local-dev mode', () => {
    for (const u of ['http://localhost:8080/mcp', 'http://127.0.0.1:3000/mcp', 'http://[::1]:9000/mcp']) {
      expect(validateMcpUrl(u, DEV).ok).toBe(true)
      expect(validateMcpUrl(u, PROD).ok).toBe(false)
    }
    expect(validateMcpUrl('https://localhost/mcp', PROD).ok).toBe(false)
  })

  it('local-dev can be forced off or on explicitly', () => {
    expect(localDevAllowed({ NODE_ENV: 'test', CC_MCP_ALLOW_LOCALHOST: '0' } as NodeJS.ProcessEnv)).toBe(false)
    expect(localDevAllowed({ NODE_ENV: 'production', CC_MCP_ALLOW_LOCALHOST: '1' } as NodeJS.ProcessEnv)).toBe(true)
  })

  it('rejects credentials in the URL, garbage and empty input', () => {
    expect(validateMcpUrl('https://user:pass@mcp.example.com/mcp', PROD).ok).toBe(false)
    expect(validateMcpUrl('not a url', PROD).ok).toBe(false)
    expect(validateMcpUrl('', PROD).ok).toBe(false)
  })
})

describe('validateMcpUrl — SSRF guard', () => {
  const blocked = [
    'https://169.254.169.254/latest/meta-data/', // cloud metadata
    'https://metadata.google.internal/computeMetadata/v1/',
    'https://10.0.0.5/mcp',
    'https://172.16.3.4/mcp',
    'https://192.168.1.10/mcp',
    'https://100.64.0.1/mcp', // CGNAT
    'https://0.0.0.0/mcp',
    'https://[fe80::1]/mcp', // link-local v6
    'https://[fd00:ec2::254]/mcp', // AWS IMDS over IPv6
    'https://[::ffff:169.254.169.254]/mcp', // v4-mapped metadata
    'https://[::ffff:a9fe:a9fe]/mcp', // same, hex form
    'https://2852039166/mcp', // decimal 169.254.169.254
    'https://0xa9fea9fe/mcp', // hex 169.254.169.254
    'https://0251.0376.0251.0376/mcp', // octal 169.254.169.254
    'https://host.docker.internal/mcp',
    'https://printer.local/mcp',
    'https://intranet/mcp', // single-label
  ]
  for (const u of blocked) {
    it(`blocks ${u}`, () => {
      const r = validateMcpUrl(u, PROD)
      expect(r.ok).toBe(false)
    })
  }

  it('blocks private ranges even when local-dev is on (only loopback is relaxed)', () => {
    expect(validateMcpUrl('https://169.254.169.254/', DEV).ok).toBe(false)
    expect(validateMcpUrl('http://10.1.2.3/', DEV).ok).toBe(false)
  })
})

describe('blockedAddressReason / checkResolvedAddress (connect-time check)', () => {
  it('classifies resolved addresses', () => {
    expect(blockedAddressReason('169.254.169.254')).toMatch(/link-local|metadata/)
    expect(blockedAddressReason('10.0.0.1')).toBe('private')
    expect(blockedAddressReason('127.0.0.1')).toBe('loopback')
    expect(blockedAddressReason('::1')).toBe('loopback')
    expect(blockedAddressReason('fd12:3456::1')).toMatch(/unique-local/)
    expect(blockedAddressReason('64:ff9b::a9fe:a9fe')).toMatch(/link-local/) // NAT64-embedded metadata
    expect(blockedAddressReason('8.8.8.8')).toBeNull()
    expect(blockedAddressReason('2606:4700:4700::1111')).toBeNull()
  })

  it('loopback is dialable only in local-dev mode', () => {
    expect(checkResolvedAddress('127.0.0.1', DEV)).toBeNull()
    expect(checkResolvedAddress('127.0.0.1', PROD)).toMatch(/loopback/)
    expect(checkResolvedAddress('169.254.169.254', DEV)).toMatch(/link-local/)
  })
})

describe('safe fetch', () => {
  it('the connect-time lookup hook refuses a name that RESOLVES to a blocked address (anti DNS-rebinding)', async () => {
    // A public-looking name can resolve to an internal IP; the syntax check
    // cannot see that, so the lookup hook re-checks every resolved address.
    // `localhost` resolves via /etc/hosts (no network) to loopback.
    const lookup = guardedLookup(PROD) as unknown as (h: string, o: object, cb: (err: Error | null) => void) => void
    const err = await new Promise<Error | null>(resolve => lookup('localhost', {}, e => resolve(e)))
    expect(err).toBeInstanceOf(BlockedUrlError)
    const devLookup = guardedLookup(DEV) as unknown as (h: string, o: object, cb: (err: Error | null, a?: unknown) => void) => void
    const ok = await new Promise<Error | null>(resolve => devLookup('localhost', {}, e => resolve(e)))
    expect(ok).toBeNull()
  })

  it('refuses https://localhost in production before any lookup', async () => {
    const f = createSafeFetch({ env: PROD, timeoutMs: 2000 })
    await expect(f('https://localhost/')).rejects.toBeInstanceOf(BlockedUrlError)
  })

  it('refuses a metadata IP literal without dialling it', async () => {
    const f = createSafeFetch({ env: DEV, timeoutMs: 2000 })
    await expect(f('https://169.254.169.254/latest/meta-data/')).rejects.toBeInstanceOf(BlockedUrlError)
  })
})
