/**
 * Send-time SSRF guard for outbound agent webhooks (obj 900270, covers #900244).
 * DNS is faked through the seam; nothing leaves the box.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import net from 'net'
import {
  isBlockedAddress,
  resolveWebhookDestination,
  setWebhookDnsLookup,
  pinnedLookup,
  pinnedRequestOptions,
  pinnedHttpsPost,
  NOT_PUBLIC_ERROR,
  DNS_TIMEOUT_MS,
  type ResolvedAddress,
} from './webhook-egress.js'

const PUBLIC_V4 = '93.184.216.34'
const PUBLIC_V6 = '2606:2800:220:1:248:1893:25c8:1946'

function fakeDns(table: Record<string, ResolvedAddress[] | Error>) {
  const calls: string[] = []
  setWebhookDnsLookup(async host => {
    calls.push(host)
    const r = table[host]
    if (!r) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' })
    if (r instanceof Error) throw r
    return r
  })
  return calls
}
const v4 = (address: string): ResolvedAddress => ({ address, family: 4 })
const v6 = (address: string): ResolvedAddress => ({ address, family: 6 })

afterEach(() => setWebhookDnsLookup(null))

describe('isBlockedAddress', () => {
  it('blocks loopback, private, link-local, CGNAT, metadata, multicast and reserved IPv4', () => {
    for (const ip of [
      '127.0.0.1', '127.255.255.254', '0.0.0.0', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.0.1',
      '169.254.169.254', // AWS / GCP / Azure metadata
      '169.254.0.1', '100.64.0.1', '100.100.100.200', // CGNAT incl. Alibaba metadata
      '192.0.0.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    ]) expect(isBlockedAddress(ip), ip).toBe(true)
  })

  it('blocks IPv6 loopback, unique-local, link-local, multicast, and every IPv4-embedding form', () => {
    for (const ip of [
      '::1', '::', 'fc00::1', 'fd00:ec2::254', 'fe80::1', 'fe80::1%eth0', 'fec0::1', 'ff02::1', '2001:db8::1',
      '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '::ffff:10.0.0.1', '[::ffff:7f00:1]',
      '::ffff:8.8.8.8', // mapped is refused outright, even when the v4 inside is public
      '::127.0.0.1', // deprecated IPv4-compatible
      '64:ff9b::7f00:1', '64:ff9b:1::1', '2002:7f00:1::1', '2001:0:4136:e378::1', // NAT64, 6to4, Teredo
      '::ffff:0:7f00:1', '::ffff:0:a9fe:a9fe', // IPv4-translated (SIIT)
      '3fff::1', '5f00::1', // documentation (RFC 9637), SRv6 SIDs
    ]) expect(isBlockedAddress(ip), ip).toBe(true)
  })

  it('allows ordinary public addresses', () => {
    for (const ip of [PUBLIC_V4, '8.8.8.8', '1.1.1.1', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '2606:4700:4700::1111', PUBLIC_V6]) {
      expect(isBlockedAddress(ip), ip).toBe(false)
    }
  })

  it('fails closed on anything that is not an IP', () => {
    for (const s of ['', 'localhost', 'example.com', '999.1.1.1', '1.2.3', 'not-an-ip']) expect(isBlockedAddress(s), s).toBe(true)
  })
})

describe('resolveWebhookDestination', () => {
  it('legit public host: resolves and returns the address to pin', async () => {
    fakeDns({ 'hooks.example.com': [v4(PUBLIC_V4)] })
    expect(await resolveWebhookDestination('https://hooks.example.com/cc')).toEqual({ ok: true, address: PUBLIC_V4, family: 4, hostname: 'hooks.example.com', addresses: [v4(PUBLIC_V4)] })
    fakeDns({ 'v6.example.com': [v6(PUBLIC_V6)] })
    expect(await resolveWebhookDestination('https://v6.example.com/cc')).toMatchObject({ ok: true, address: PUBLIC_V6, family: 6 })
  })

  it('refuses a public name that resolves to loopback / private / link-local / metadata / CGNAT', async () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.10', '172.20.0.5', '169.254.169.254', '100.100.100.200', '0.0.0.0']) {
      fakeDns({ 'evil.example.com': [v4(ip)] })
      const r = await resolveWebhookDestination('https://evil.example.com/x')
      expect(r, ip).toEqual({ ok: false, error: NOT_PUBLIC_ERROR })
    }
  })

  it('refuses IPv6 answers that are loopback, ULA, link-local or IPv4-mapped', async () => {
    for (const ip of ['::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254']) {
      fakeDns({ 'evil6.example.com': [v6(ip)] })
      expect((await resolveWebhookDestination('https://evil6.example.com/x')).ok, ip).toBe(false)
    }
  })

  it('mixed answers: one private record poisons the whole set (never "pick the public one")', async () => {
    fakeDns({ 'mixed.example.com': [v4(PUBLIC_V4), v4('127.0.0.1')] })
    expect((await resolveWebhookDestination('https://mixed.example.com/x')).ok).toBe(false)
    fakeDns({ 'mixed6.example.com': [v6(PUBLIC_V6), v6('::ffff:10.0.0.1')] })
    expect((await resolveWebhookDestination('https://mixed6.example.com/x')).ok).toBe(false)
  })

  it('refuses IP literals and private names without a DNS query', async () => {
    const calls = fakeDns({})
    for (const url of [
      'https://127.0.0.1/x', 'https://[::1]/x', 'https://[::ffff:127.0.0.1]/x', 'https://169.254.169.254/latest/meta-data',
      'https://100.64.0.1/x', 'https://0x7f.0.0.1/x', 'https://2130706433/x', // WHATWG URL normalises these to 127.0.0.1
      'https://localhost/x', 'https://a.localhost/x', 'https://printer.local/x', 'https://metadata.google.internal/x',
    ]) expect((await resolveWebhookDestination(url)).ok, url).toBe(false)
    expect(calls).toEqual([])
  })

  it('allows a public IP literal without DNS', async () => {
    const calls = fakeDns({})
    expect(await resolveWebhookDestination(`https://${PUBLIC_V4}/x`)).toMatchObject({ ok: true, address: PUBLIC_V4 })
    expect(calls).toEqual([])
  })

  it('DNS failure, an empty answer and a private answer all give the SAME error (no internal-name probing)', async () => {
    fakeDns({ 'empty.example.com': [], 'litellm': [v4('172.18.0.5')] })
    expect(await resolveWebhookDestination('https://nx.example.com/x')).toEqual({ ok: false, error: NOT_PUBLIC_ERROR })
    expect(await resolveWebhookDestination('https://empty.example.com/x')).toEqual({ ok: false, error: NOT_PUBLIC_ERROR })
    expect(await resolveWebhookDestination('https://litellm/x')).toEqual({ ok: false, error: NOT_PUBLIC_ERROR })
  })

  it('a resolver that never answers is cut off after DNS_TIMEOUT_MS', async () => {
    vi.useFakeTimers()
    try {
      setWebhookDnsLookup(() => new Promise(() => { /* never settles */ }))
      const p = resolveWebhookDestination('https://slow.example.com/x')
      await vi.advanceTimersByTimeAsync(DNS_TIMEOUT_MS + 1)
      expect(await p).toEqual({ ok: false, error: NOT_PUBLIC_ERROR })
    } finally {
      vi.useRealTimers()
    }
  })

  it('pins every validated answer so multi-record / dual-stack fallback still works', async () => {
    fakeDns({ 'multi.example.com': [v6(PUBLIC_V6), v4(PUBLIC_V4)] })
    const dest = await resolveWebhookDestination('https://multi.example.com/x')
    expect(dest).toMatchObject({ ok: true, address: PUBLIC_V6, family: 6, addresses: [v6(PUBLIC_V6), v4(PUBLIC_V4)] })
    if (!dest.ok) throw new Error('unreachable')
    const lookup = pinnedLookup(dest.address, dest.family, dest.addresses)
    const all = await new Promise(r => lookup('multi.example.com', { all: true }, (...a: unknown[]) => r(a)))
    expect(all).toEqual([null, [{ address: PUBLIC_V6, family: 6 }, { address: PUBLIC_V4, family: 4 }]])
  })

  it('keeps the save-time rules: https only, no embedded credentials', async () => {
    fakeDns({ 'hooks.example.com': [v4(PUBLIC_V4)] })
    expect((await resolveWebhookDestination('http://hooks.example.com/x')).ok).toBe(false)
    expect((await resolveWebhookDestination('https://u:p@hooks.example.com/x')).ok).toBe(false)
    expect((await resolveWebhookDestination('not a url')).ok).toBe(false)
  })
})

describe('pinning (DNS rebinding / TOCTOU)', () => {
  it('a rebinding resolver (public, then 127.0.0.1) is asked ONCE; the socket lookup returns only the checked address', async () => {
    let n = 0
    setWebhookDnsLookup(async () => (n++ === 0 ? [v4(PUBLIC_V4)] : [v4('127.0.0.1')]))
    const dest = await resolveWebhookDestination('https://rebind.example.com/x')
    expect(dest).toMatchObject({ ok: true, address: PUBLIC_V4 })
    if (!dest.ok) throw new Error('unreachable')
    const opts = pinnedRequestOptions('https://rebind.example.com:8443/hook?a=1', {
      method: 'POST', headers: { 'X-Test': '1' }, body: '{"x":1}', signal: AbortSignal.timeout(1000), redirect: 'manual',
      address: dest.address, family: dest.family,
    })
    expect(n).toBe(1) // building the request never re-resolves
    expect(opts).toMatchObject({ host: 'rebind.example.com', servername: 'rebind.example.com', port: 8443, path: '/hook?a=1', method: 'POST', agent: false })
    expect((opts.headers as Record<string, string>)['Content-Length']).toBe('7')
    const lookup = opts.lookup as unknown as (h: string, o: unknown, cb: (...a: unknown[]) => void) => void
    const single = await new Promise(r => lookup('rebind.example.com', {}, (...a) => r(a)))
    expect(single).toEqual([null, PUBLIC_V4, 4])
    const all = await new Promise(r => lookup('anything-else.example', { all: true }, (...a) => r(a)))
    expect(all).toEqual([null, [{ address: PUBLIC_V4, family: 4 }]])
    expect(n).toBe(1)
  })

  it('pinnedLookup supports the (hostname, callback) call shape too', async () => {
    const lookup = pinnedLookup(PUBLIC_V6, 6)
    const r = await new Promise(res => lookup('x', (...a: unknown[]) => res(a)))
    expect(r).toEqual([null, PUBLIC_V6, 6])
  })

  it('the real transport connects to the pinned address (not the name), and refuses a non-public socket', async () => {
    // A name that resolves nowhere reaches this local listener ONLY through the pin;
    // the connected-socket re-check then refuses it because it is loopback.
    let connections = 0
    const srv = net.createServer(s => { connections++; s.on('error', () => {}); setTimeout(() => s.destroy(), 200) })
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()))
    const port = (srv.address() as net.AddressInfo).port
    try {
      await expect(pinnedHttpsPost(`https://pinned.invalid:${port}/hook`, {
        method: 'POST', headers: {}, body: '{}', signal: AbortSignal.timeout(3000), redirect: 'manual', address: '127.0.0.1', family: 4,
      })).rejects.toThrow(/non-public address/)
      expect(connections).toBe(1)
    } finally {
      await new Promise<void>(r => srv.close(() => r()))
    }
  })
})
