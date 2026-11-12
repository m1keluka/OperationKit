// Web search + page reading for chat bots (obj 900671).
//
// No real network: search vendors get a fake fetch, pages get a fake guarded
// fetch, and the SSRF cases run the REAL guarded fetch against addresses it must
// refuse before any socket is opened.
import { describe, it, expect } from 'vitest'
import { htmlToText, searchBackendOrder, webFetch, webSearch, webSearchStatus, WebToolError } from './web-tools.js'
import { createSafeFetch } from '../../mcp-servers/safe-fetch.js'

type Call = { url: string; init?: RequestInit }

function fakeFetch(routes: Record<string, (call: Call) => Response>) {
  const calls: Call[] = []
  const f = async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const key = Object.keys(routes).find(k => url.startsWith(k))
    if (!key) throw new Error(`unexpected fetch ${url}`)
    return routes[key]({ url, init })
  }
  return { f, calls }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('search backend selection', () => {
  it('is not set up when no search key exists', () => {
    expect(searchBackendOrder({})).toEqual([])
    expect(webSearchStatus({})).toEqual({ available: false, backends: [] })
  })

  it('uses every configured backend in the built-in order', () => {
    expect(searchBackendOrder({ EXA_API_KEY: 'x', FIRECRAWL_API_KEY: 'y', TAVILY_API_KEY: 'z' })).toEqual(['tavily', 'firecrawl', 'exa'])
  })

  it('AGENT_CHAT_WEB_SEARCH_PROVIDER pins the order and drops unconfigured names', () => {
    const env = { EXA_API_KEY: 'x', FIRECRAWL_API_KEY: 'y', AGENT_CHAT_WEB_SEARCH_PROVIDER: 'exa, brave ,firecrawl' }
    expect(searchBackendOrder(env)).toEqual(['exa', 'firecrawl'])
  })
})

describe('web_search', () => {
  it('says plainly how to set it up when no backend is configured', async () => {
    await expect(webSearch('anything', 3, { env: {} })).rejects.toThrow(/not set up.*Settings → Secrets/)
  })

  it('requires a query', async () => {
    await expect(webSearch('  ', 3, { env: { FIRECRAWL_API_KEY: 'k' } })).rejects.toBeInstanceOf(WebToolError)
  })

  it('parses Firecrawl results and sends the key only to Firecrawl', async () => {
    const { f, calls } = fakeFetch({
      'https://api.firecrawl.dev/v1/search': () => json({ success: true, data: [
        { url: 'https://www.anthropic.com/news/claude-opus-5', title: 'Introducing Claude Opus 5', description: 'Claude Opus 5 is available today.' },
        { url: 'javascript:alert(1)', title: 'bad', description: 'dropped' },
      ] }),
    })
    const r = await webSearch('claude opus', 2, { env: { FIRECRAWL_API_KEY: 'fc-secret' }, fetch: f })
    expect(r.backend).toBe('firecrawl')
    expect(r.results).toEqual([{ url: 'https://www.anthropic.com/news/claude-opus-5', title: 'Introducing Claude Opus 5', snippet: 'Claude Opus 5 is available today.' }])
    expect(calls).toHaveLength(1)
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer fc-secret')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ query: 'claude opus', limit: 2 })
  })

  it.each([
    ['tavily', { TAVILY_API_KEY: 'k' }, 'https://api.tavily.com/search', { results: [{ title: 'T', url: 'https://t.example/', content: 'snip' }] }],
    ['brave', { BRAVE_SEARCH_API_KEY: 'k' }, 'https://api.search.brave.com/', { web: { results: [{ title: 'T', url: 'https://t.example/', description: 'snip' }] } }],
    ['exa', { EXA_API_KEY: 'k' }, 'https://api.exa.ai/search', { results: [{ title: 'T', url: 'https://t.example/', text: 'snip' }] }],
    ['serper', { SERPER_API_KEY: 'k' }, 'https://google.serper.dev/search', { organic: [{ title: 'T', link: 'https://t.example/', snippet: 'snip' }] }],
    ['searxng', { SEARXNG_URL: 'https://searx.example/' }, 'https://searx.example/search', { results: [{ title: 'T', url: 'https://t.example/', content: 'snip' }] }],
  ] as const)('parses %s results', async (backend, env, url, body) => {
    const { f } = fakeFetch({ [url]: () => json(body) })
    const r = await webSearch('q', 5, { env, fetch: f })
    expect(r.backend).toBe(backend)
    expect(r.results).toEqual([{ title: 'T', url: 'https://t.example/', snippet: 'snip' }])
  })

  it('fails over when a backend is out of credit, and reports which one was skipped', async () => {
    const { f, calls } = fakeFetch({
      'https://api.exa.ai/search': () => json({ error: 'You have exceeded your credits limit.' }, 402),
      'https://api.firecrawl.dev/v1/search': () => json({ success: true, data: [{ url: 'https://ok.example/', title: 'OK', description: 'fine' }] }),
    })
    const env = { EXA_API_KEY: 'e', FIRECRAWL_API_KEY: 'f', AGENT_CHAT_WEB_SEARCH_PROVIDER: 'exa,firecrawl' }
    const r = await webSearch('q', 3, { env, fetch: f })
    expect(calls.map(c => new URL(c.url).host)).toEqual(['api.exa.ai', 'api.firecrawl.dev'])
    expect(r.backend).toBe('firecrawl')
    expect(r.skipped?.[0]).toMatchObject({ backend: 'exa' })
    expect(r.skipped?.[0].error).toMatch(/402.*credits/)
  })

  it('names every failure when all backends fail, without leaking a key', async () => {
    const { f } = fakeFetch({ 'https://api.firecrawl.dev/': () => json({ error: 'down' }, 503) })
    const err = await webSearch('q', 3, { env: { FIRECRAWL_API_KEY: 'fc-super-secret' }, fetch: f }).catch(e => e)
    expect(err).toBeInstanceOf(WebToolError)
    expect(err.message).toMatch(/firecrawl \(HTTP 503: down\)/)
    expect(err.message).not.toContain('fc-super-secret')
  })

  it('clamps the result count', async () => {
    const { f, calls } = fakeFetch({ 'https://api.firecrawl.dev/': () => json({ data: [] }) })
    await webSearch('q', 999, { env: { FIRECRAWL_API_KEY: 'k' }, fetch: f })
    expect(JSON.parse(String(calls[0].init?.body)).limit).toBe(10)
  })
})

describe('web_fetch', () => {
  const page = (body: string, type = 'text/html; charset=utf-8', status = 200) =>
    async () => new Response(body, { status, headers: { 'content-type': type } })

  it('returns readable text and the title of an HTML page', async () => {
    const html = `<!doctype html><html><head><title>Pricing &amp; Plans</title><style>.x{}</style><script>evil()</script></head>
      <body><nav>Home | About</nav><h1>Plans</h1><p>Starter costs $10&nbsp;a month.</p><ul><li>One</li><li>Two</li></ul>
      <a href="https://example.com/buy">Buy now</a></body></html>`
    const r = await webFetch('https://example.com/pricing', { pageFetch: page(html) })
    expect(r.title).toBe('Pricing & Plans')
    expect(r.content).toContain('# Plans')
    expect(r.content).toContain('Starter costs $10 a month.')
    expect(r.content).toContain('- One')
    expect(r.content).toContain('Buy now (https://example.com/buy)')
    expect(r.content).not.toMatch(/evil|\.x\{\}|Home \| About/)
    expect(r.status).toBe(200)
    expect(r.truncated).toBe(false)
  })

  it('adds https:// to a bare host and returns plain text as-is', async () => {
    let seen = ''
    const r = await webFetch('example.com/robots.txt', { pageFetch: async (u: string) => { seen = u; return new Response('User-agent: *', { headers: { 'content-type': 'text/plain' } }) } })
    expect(seen).toBe('https://example.com/robots.txt')
    expect(r.content).toBe('User-agent: *')
  })

  it('truncates very long pages', async () => {
    const r = await webFetch('https://example.com/', { pageFetch: page('a'.repeat(30_000), 'text/plain') })
    expect(r.truncated).toBe(true)
    expect(r.content.length).toBeLessThan(20_100)
  })

  it('refuses binary files and non-web schemes', async () => {
    await expect(webFetch('https://example.com/x.pdf', { pageFetch: page('%PDF', 'application/pdf') })).rejects.toThrow(/application\/pdf/)
    await expect(webFetch('file:///etc/passwd', { pageFetch: page('') })).rejects.toThrow(/Only http/)
    await expect(webFetch('', { pageFetch: page('') })).rejects.toThrow(/required/)
  })

  // The real guarded fetch: these must be refused before any connection.
  const guarded = createSafeFetch({ env: { NODE_ENV: 'production' } as NodeJS.ProcessEnv, allowHttp: true, timeoutMs: 2000 })
  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1:3002/api/internal/objectives',
    'http://localhost:3002/',
    'http://10.0.0.5/',
    'http://[::ffff:169.254.169.254]/',
    'http://metadata.google.internal/',
    'http://2852039166/',
    'https://user:pass@example.com/',
  ])('blocks %s (SSRF)', async url => {
    await expect(webFetch(url, { pageFetch: guarded })).rejects.toThrow(/cannot be read|Could not read/)
  })
})

describe('htmlToText', () => {
  it('prefers the main/article block when it has real content', () => {
    const html = `<header>Site chrome</header><main>${'<p>Body text.</p>'.repeat(40)}</main><footer>Footer</footer>`
    const { text } = htmlToText(html)
    expect(text).toContain('Body text.')
    expect(text).not.toContain('Site chrome')
  })

  it('decodes numeric entities', () => {
    expect(htmlToText('<p>caf&#233; &#x2014; ok</p>').text).toBe('café — ok')
  })
})
