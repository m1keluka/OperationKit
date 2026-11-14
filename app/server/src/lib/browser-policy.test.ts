import { describe, it, expect } from 'vitest'
import {
  resolveBrowserPolicy,
  decideEgress,
  parseOriginPattern,
  originMatches,
  isPrivateAddress,
  isLoopbackAddress,
  isMetadataAddress,
  METADATA_HOSTS,
  type BrowserPolicy,
} from './browser-policy.js'

/** A policy with nothing but the given extras — the stock install shape. */
function policy(env: Record<string, string> = {}): BrowserPolicy {
  return resolveBrowserPolicy({ OK_DOMAIN: 'ops.example.com', ...env } as NodeJS.ProcessEnv)
}

const t = (host: string, port = 443, scheme = 'https') => ({ scheme, host, port })

describe('resolveBrowserPolicy — defaults are the locked-down ones', () => {
  it('keeps the Chromium sandbox and the egress guard ON with no configuration', () => {
    const p = policy()
    expect(p.sandbox).toBe(true)
    expect(p.egressGuard).toBe(true)
    expect(p.warnings).toEqual([])
  })

  it('refuses the private network and cloud metadata by default', () => {
    const p = policy()
    expect(p.allowPrivateNetwork).toBe(false)
    expect(p.allowMetadata).toBe(false)
    for (const h of METADATA_HOSTS) expect(p.blockedOrigins).toContain(h)
  })

  it("allows loopback and the install's own domain out of the box", () => {
    const p = policy()
    expect(p.allowedOrigins).toContain('http://localhost:*')
    expect(p.allowedOrigins).toContain('https://ops.example.com')
  })

  it('takes extra origins from CARD_BROWSER_ALLOWED_ORIGINS', () => {
    const p = policy({ CARD_BROWSER_ALLOWED_ORIGINS: 'https://*.vercel.app;https://docs.example.com' })
    expect(p.allowedOrigins).toContain('https://*.vercel.app')
    expect(p.allowedOrigins).toContain('https://docs.example.com')
  })

  it('drops an unparseable allowlist entry instead of widening, and says so', () => {
    const p = policy({ CARD_BROWSER_ALLOWED_ORIGINS: 'https://ok.example.com;:::nonsense:::' })
    expect(p.allowedOrigins).toContain('https://ok.example.com')
    expect(p.allowedOrigins).not.toContain(':::nonsense:::')
    expect(p.warnings.join('\n')).toMatch(/ignoring unparseable entry/)
  })

  it('warns loudly for every control an operator widens', () => {
    const p = policy({
      CARD_BROWSER_SANDBOX: 'off',
      CARD_BROWSER_EGRESS_GUARD: 'off',
      CARD_BROWSER_ALLOW_PRIVATE_NETWORK: 'on',
      CARD_BROWSER_ALLOW_METADATA: 'on',
      CARD_BROWSER_ALLOWED_ORIGINS: '*',
    })
    const joined = p.warnings.join('\n')
    expect(joined).toMatch(/sandbox is DISABLED/)
    expect(joined).toMatch(/unrestricted network/)
    expect(joined).toMatch(/RFC1918/)
    expect(joined).toMatch(/instance-metadata/)
    expect(joined).toMatch(/allowlist is\s+effectively disabled/)
    expect(p.warnings.length).toBe(5)
  })
})

describe('parseOriginPattern / originMatches', () => {
  it('parses the forms an operator is likely to write', () => {
    expect(parseOriginPattern('example.com')).toEqual({ scheme: null, host: 'example.com', port: null })
    expect(parseOriginPattern('https://example.com:8443')).toEqual({ scheme: 'https', host: 'example.com', port: '8443' })
    expect(parseOriginPattern('http://localhost:*')).toEqual({ scheme: 'http', host: 'localhost', port: '*' })
    expect(parseOriginPattern('http://[::1]:*')).toEqual({ scheme: 'http', host: '[::1]', port: '*' })
    expect(parseOriginPattern('*')).toEqual({ scheme: null, host: '*', port: null })
  })

  it('returns null rather than guessing at garbage', () => {
    expect(parseOriginPattern('')).toBeNull()
    expect(parseOriginPattern('https://example.com:notaport')).toBeNull()
    expect(parseOriginPattern('[unclosed')).toBeNull()
  })

  it('matches a wildcard subdomain but not the bare parent or a lookalike suffix', () => {
    const pats = ['https://*.example.com']
    expect(originMatches(pats, t('preview.example.com'))).toBe(true)
    expect(originMatches(pats, t('example.com'))).toBe(false)
    expect(originMatches(pats, t('notexample.com'))).toBe(false)
    expect(originMatches(pats, t('evil-example.com'))).toBe(false)
  })

  it('honours scheme and port when the pattern names them', () => {
    expect(originMatches(['https://a.com'], t('a.com', 443, 'http'))).toBe(false)
    expect(originMatches(['https://a.com:8443'], t('a.com', 443))).toBe(false)
    expect(originMatches(['https://a.com:8443'], t('a.com', 8443))).toBe(true)
    expect(originMatches(['a.com'], t('a.com', 1234, 'http'))).toBe(true)
  })
})

describe('address classification', () => {
  it('recognises RFC1918, CGNAT, link-local and unique-local', () => {
    for (const ip of ['10.0.0.1', '172.16.5.4', '172.31.255.255', '192.168.1.1', '100.64.0.1', '169.254.1.1', 'fd12::1', 'fe80::1']) {
      expect(isPrivateAddress(ip), ip).toBe(true)
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700::1111']) {
      expect(isPrivateAddress(ip), ip).toBe(false)
    }
  })

  it('sees through IPv4-mapped IPv6 (the classic bypass)', () => {
    expect(isPrivateAddress('::ffff:10.0.0.1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isMetadataAddress('::ffff:169.254.169.254')).toBe(true)
  })

  it('recognises loopback and metadata', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('127.9.9.9')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('10.0.0.1')).toBe(false)
    expect(isMetadataAddress('169.254.169.254')).toBe(true)
    expect(isMetadataAddress('100.100.100.200')).toBe(true)
    expect(isMetadataAddress('fd00:ec2::254')).toBe(true)
    expect(isMetadataAddress('8.8.8.8')).toBe(false)
  })
})

describe('decideEgress — the rule the proxy enforces', () => {
  it('allows the install\'s own domain', () => {
    expect(decideEgress(policy(), t('ops.example.com'), ['203.0.113.10']).allow).toBe(true)
  })

  it('allows a localhost preview server', () => {
    expect(decideEgress(policy(), t('localhost', 5173, 'http'), ['127.0.0.1']).allow).toBe(true)
    expect(decideEgress(policy(), t('127.0.0.1', 5173, 'http'), ['127.0.0.1']).allow).toBe(true)
  })

  it('blocks an off-allowlist public site', () => {
    const d = decideEgress(policy(), t('evil.example.net'), ['203.0.113.99'])
    expect(d.allow).toBe(false)
    expect(d.allow === false && d.reason).toMatch(/not in the card browser's allowed origins/)
  })

  it('blocks cloud metadata by host AND by resolved address, even if allowlisted', () => {
    const wide = policy({ CARD_BROWSER_ALLOWED_ORIGINS: '*' })
    const byHost = decideEgress(wide, t('169.254.169.254', 80, 'http'), ['169.254.169.254'])
    expect(byHost.allow).toBe(false)
    expect(byHost.allow === false && byHost.reason).toMatch(/metadata/)
    // The interesting one: an allowlisted NAME pointed at the metadata address.
    const byAddr = decideEgress(wide, t('imds.example.com'), ['169.254.169.254'])
    expect(byAddr.allow).toBe(false)
    expect(byAddr.allow === false && byAddr.reason).toMatch(/metadata/)
  })

  it('blocks the private network even for an allowlisted name (SSRF into the LAN)', () => {
    const p = policy({ CARD_BROWSER_ALLOWED_ORIGINS: 'https://intranet.example.com' })
    const d = decideEgress(p, t('intranet.example.com'), ['10.1.2.3'])
    expect(d.allow).toBe(false)
    expect(d.allow === false && d.reason).toMatch(/private address 10\.1\.2\.3/)
  })

  it('refuses DNS rebinding: an allowlisted public name that answers 127.0.0.1', () => {
    const p = policy({ CARD_BROWSER_ALLOWED_ORIGINS: 'https://rebind.example.com' })
    const d = decideEgress(p, t('rebind.example.com'), ['127.0.0.1'])
    expect(d.allow).toBe(false)
    expect(d.allow === false && d.reason).toMatch(/DNS rebinding refused/)
  })

  it('evaluates the blocklist before the allowlist', () => {
    const p = policy({
      CARD_BROWSER_ALLOWED_ORIGINS: 'https://*.example.com',
      CARD_BROWSER_BLOCKED_ORIGINS: 'https://secrets.example.com',
    })
    expect(decideEgress(p, t('ok.example.com'), ['203.0.113.1']).allow).toBe(true)
    const d = decideEgress(p, t('secrets.example.com'), ['203.0.113.1'])
    expect(d.allow).toBe(false)
    expect(d.allow === false && d.reason).toMatch(/block list/)
  })

  it('opens the private network ONLY when the operator opts in', () => {
    const p = policy({
      CARD_BROWSER_ALLOWED_ORIGINS: 'https://intranet.example.com',
      CARD_BROWSER_ALLOW_PRIVATE_NETWORK: 'on',
    })
    expect(decideEgress(p, t('intranet.example.com'), ['10.1.2.3']).allow).toBe(true)
    // …and metadata stays blocked even then: it is a separate switch.
    expect(decideEgress(p, t('intranet.example.com'), ['169.254.169.254']).allow).toBe(false)
  })

  it('blocks loopback entirely when BROWSER_ALLOW_LOOPBACK is off', () => {
    const p = policy({ CARD_BROWSER_ALLOW_LOOPBACK: 'off' })
    const d = decideEgress(p, t('localhost', 3002, 'http'), ['127.0.0.1'])
    expect(d.allow).toBe(false)
  })

  it('blocks when ANY resolved address is bad, not just the first', () => {
    const p = policy({ CARD_BROWSER_ALLOWED_ORIGINS: 'https://multi.example.com' })
    const d = decideEgress(p, t('multi.example.com'), ['203.0.113.1', '10.0.0.5'])
    expect(d.allow).toBe(false)
  })
})
