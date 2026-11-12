// ── The public web for chat bots (obj 900671) ──
//
// Two tools a bot gets when its file (or its bot-page settings) lists them:
//
//   web_search  — ask a search backend configured on this install. Backends are
//                 tried in order; one that is out of credit, rate-limited or
//                 down hands the query to the next, so one dead vendor never
//                 takes web search away from every bot.
//   web_fetch   — read ONE public page. Goes through the SSRF-guarded fetch the
//                 MCP connector already uses (mcp-servers/safe-fetch.ts): every
//                 URL and redirect hop is validated, and the RESOLVED address is
//                 checked at connect time, so a bot cannot be talked into
//                 reading the cloud metadata service, the Docker gateway, this
//                 server's own internal API or anything else on a private
//                 network. Plain http is allowed (many public pages are still
//                 http); loopback and private ranges never are.
//
// Search backends, by the env var that switches them on (keys are read by
// NAME from the server env, hydrated from Settings → Secrets, and only ever
// sent to their own vendor):
//
//   tavily     TAVILY_API_KEY
//   brave      BRAVE_SEARCH_API_KEY (or BRAVE_API_KEY)
//   firecrawl  FIRECRAWL_API_KEY
//   exa        EXA_API_KEY
//   serper     SERPER_API_KEY            (serper.dev Google results)
//   searxng    SEARXNG_URL               (a self-hosted SearXNG with JSON output on)
//
// AGENT_CHAT_WEB_SEARCH_PROVIDER pins the order: one name, or a comma list
// ("brave,firecrawl"). Without it every configured backend is tried in the
// order above.
import { createSafeFetch, type SafeFetch } from '../../mcp-servers/safe-fetch.js'

export type SearchBackendId = 'tavily' | 'brave' | 'firecrawl' | 'exa' | 'serper' | 'searxng'
export const SEARCH_BACKENDS: readonly SearchBackendId[] = ['tavily', 'brave', 'firecrawl', 'exa', 'serper', 'searxng']

export interface WebSearchResult {
  title: string
  url: string
  snippet: string
}

export interface WebSearchOutcome {
  query: string
  backend: SearchBackendId
  results: WebSearchResult[]
  /** Backends that were tried first and failed, with why — never a key. */
  skipped?: { backend: SearchBackendId; error: string }[]
}

export interface WebFetchOutcome {
  url: string
  final_url: string
  status: number
  content_type: string
  title: string | null
  content: string
  truncated: boolean
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

export interface WebToolDeps {
  env?: NodeJS.ProcessEnv
  /** Fetch used for search-vendor APIs (fixed, well-known hosts). Tests inject. */
  fetch?: FetchFn
  /** Fetch used for web_fetch — MUST be SSRF-guarded in production. Tests inject. */
  pageFetch?: SafeFetch
  signal?: AbortSignal
}

/** A failure the model (and the person) should see as a plain sentence. */
export class WebToolError extends Error {}

export const MAX_SEARCH_RESULTS = 10
export const DEFAULT_SEARCH_RESULTS = 5
export const MAX_PAGE_CHARS = 20_000
const MAX_PAGE_BYTES = 3 * 1024 * 1024
const SEARCH_TIMEOUT_MS = 20_000
const PAGE_TIMEOUT_MS = 15_000
const SNIPPET_CHARS = 500
const USER_AGENT = 'Mozilla/5.0 (compatible; OperationKitBot/1.0; +https://operationkit.ai)'

function env1(env: NodeJS.ProcessEnv, ...names: string[]): string {
  for (const n of names) {
    const v = (env[n] || '').trim()
    if (v) return v
  }
  return ''
}

function backendConfigured(id: SearchBackendId, env: NodeJS.ProcessEnv): boolean {
  switch (id) {
    case 'tavily': return !!env1(env, 'TAVILY_API_KEY')
    case 'brave': return !!env1(env, 'BRAVE_SEARCH_API_KEY', 'BRAVE_API_KEY')
    case 'firecrawl': return !!env1(env, 'FIRECRAWL_API_KEY')
    case 'exa': return !!env1(env, 'EXA_API_KEY')
    case 'serper': return !!env1(env, 'SERPER_API_KEY')
    case 'searxng': return !!env1(env, 'SEARXNG_URL')
  }
}

/** The backends web_search will try, in order. Empty = web search is not set up. */
export function searchBackendOrder(env: NodeJS.ProcessEnv = process.env): SearchBackendId[] {
  const pinned = (env.AGENT_CHAT_WEB_SEARCH_PROVIDER || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter((s): s is SearchBackendId => (SEARCH_BACKENDS as readonly string[]).includes(s))
  const order = pinned.length ? pinned : [...SEARCH_BACKENDS]
  return [...new Set(order)].filter(id => backendConfigured(id, env))
}

/** Is web search usable on this install? (Shown on the bot page; no key exposed.) */
export function webSearchStatus(env: NodeJS.ProcessEnv = process.env): { available: boolean; backends: SearchBackendId[] } {
  const backends = searchBackendOrder(env)
  return { available: backends.length > 0, backends }
}

function clip(s: unknown, n = SNIPPET_CHARS): string {
  const t = typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : ''
  return t.length > n ? `${t.slice(0, n)}…` : t
}

function timeoutSignal(ms: number, outer?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(ms)
  return outer ? AbortSignal.any([t, outer]) : t
}

async function vendorError(res: Response): Promise<string> {
  const body = await res.text().catch(() => '')
  let msg = body
  try {
    const j = JSON.parse(body)
    msg = String(j?.error?.message ?? j?.error ?? j?.message ?? j?.detail ?? body)
  } catch { /* keep text */ }
  return `HTTP ${res.status}${msg ? `: ${msg.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`
}

async function postJson(f: FetchFn, url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal): Promise<unknown> {
  const res = await f(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers }, body: JSON.stringify(body), signal })
  if (!res.ok) throw new WebToolError(await vendorError(res))
  return res.json()
}

async function getJson(f: FetchFn, url: string, headers: Record<string, string>, signal: AbortSignal): Promise<unknown> {
  const res = await f(url, { headers: { Accept: 'application/json', ...headers }, signal })
  if (!res.ok) throw new WebToolError(await vendorError(res))
  return res.json()
}

type Loose = Record<string, unknown>
const arr = (v: unknown): Loose[] => (Array.isArray(v) ? (v.filter(x => x && typeof x === 'object') as Loose[]) : [])

function toResults(rows: Loose[], map: (r: Loose) => WebSearchResult): WebSearchResult[] {
  return rows.map(map).filter(r => /^https?:\/\//i.test(r.url))
}

async function searchWith(id: SearchBackendId, q: string, n: number, f: FetchFn, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<WebSearchResult[]> {
  switch (id) {
    case 'tavily': {
      const j = (await postJson(f, 'https://api.tavily.com/search', { Authorization: `Bearer ${env1(env, 'TAVILY_API_KEY')}` }, { query: q, max_results: n }, signal)) as Loose
      return toResults(arr(j.results), r => ({ title: clip(r.title, 200), url: String(r.url ?? ''), snippet: clip(r.content) }))
    }
    case 'brave': {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${n}`
      const j = (await getJson(f, url, { 'X-Subscription-Token': env1(env, 'BRAVE_SEARCH_API_KEY', 'BRAVE_API_KEY') }, signal)) as Loose
      const web = (j.web && typeof j.web === 'object' ? j.web : {}) as Loose
      return toResults(arr(web.results), r => ({ title: clip(r.title, 200), url: String(r.url ?? ''), snippet: clip(r.description) }))
    }
    case 'firecrawl': {
      const j = (await postJson(f, 'https://api.firecrawl.dev/v1/search', { Authorization: `Bearer ${env1(env, 'FIRECRAWL_API_KEY')}` }, { query: q, limit: n }, signal)) as Loose
      return toResults(arr(j.data), r => ({ title: clip(r.title, 200), url: String(r.url ?? ''), snippet: clip(r.description) }))
    }
    case 'exa': {
      const j = (await postJson(f, 'https://api.exa.ai/search', { 'x-api-key': env1(env, 'EXA_API_KEY') }, { query: q, numResults: n, contents: { text: { maxCharacters: SNIPPET_CHARS } } }, signal)) as Loose
      return toResults(arr(j.results), r => ({ title: clip(r.title, 200), url: String(r.url ?? ''), snippet: clip(r.text ?? r.summary) }))
    }
    case 'serper': {
      const j = (await postJson(f, 'https://google.serper.dev/search', { 'X-API-KEY': env1(env, 'SERPER_API_KEY') }, { q, num: n }, signal)) as Loose
      return toResults(arr(j.organic), r => ({ title: clip(r.title, 200), url: String(r.link ?? ''), snippet: clip(r.snippet) }))
    }
    case 'searxng': {
      const base = env1(env, 'SEARXNG_URL').replace(/\/+$/, '')
      const j = (await getJson(f, `${base}/search?q=${encodeURIComponent(q)}&format=json`, {}, signal)) as Loose
      return toResults(arr(j.results), r => ({ title: clip(r.title, 200), url: String(r.url ?? ''), snippet: clip(r.content) }))
    }
  }
}

/** Run one web search, failing over between configured backends. */
export async function webSearch(rawQuery: unknown, rawLimit: unknown, deps: WebToolDeps = {}): Promise<WebSearchOutcome> {
  const env = deps.env ?? process.env
  const f = deps.fetch ?? fetch
  const query = typeof rawQuery === 'string' ? rawQuery.trim() : ''
  if (!query) throw new WebToolError('"query" is required.')
  if (query.length > 400) throw new WebToolError('That search is too long. Use fewer words.')
  const n = Math.min(MAX_SEARCH_RESULTS, Math.max(1, Math.floor(Number(rawLimit)) || DEFAULT_SEARCH_RESULTS))
  const order = searchBackendOrder(env)
  if (order.length === 0) {
    throw new WebToolError(
      'Web search is not set up on this install. An admin adds one search key in Settings → Secrets: TAVILY_API_KEY, BRAVE_SEARCH_API_KEY, FIRECRAWL_API_KEY, EXA_API_KEY or SERPER_API_KEY (or SEARXNG_URL). web_fetch still works for a URL you already have.',
    )
  }
  const skipped: { backend: SearchBackendId; error: string }[] = []
  for (const id of order) {
    try {
      const results = (await searchWith(id, query, n, f, env, timeoutSignal(SEARCH_TIMEOUT_MS, deps.signal))).slice(0, n)
      return { query, backend: id, results, ...(skipped.length ? { skipped } : {}) }
    } catch (err) {
      if (deps.signal?.aborted) throw err
      skipped.push({ backend: id, error: err instanceof Error ? err.message.slice(0, 200) : String(err) })
    }
  }
  throw new WebToolError(`Web search failed on every configured backend: ${skipped.map(s => `${s.backend} (${s.error})`).join('; ')}`.slice(0, 600))
}

// ── web_fetch ──

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©' }

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

/** Remove tags until none are left, then drop stray angle brackets (no `<scr<b>ipt>` survivors). */
export function stripTags(s: string): string {
  let prev: string
  do { prev = s; s = s.replace(/<[^<>]*>/g, '') } while (s !== prev)
  return s.replace(/[<>]/g, '')
}

/** HTML → readable text: drop script/style/nav chrome, keep paragraph and heading breaks and link targets. */
export function htmlToText(html: string): { title: string | null; text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() || null : null
  let body = html
  const main = /<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(html)
  if (main && main[2].length > 500) body = main[2]
  body = body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|footer|aside)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<a\b[^>]*href=["']?(https?:[^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
      const label = stripTags(inner).trim()
      return label && label !== href ? `${label} (${href})` : href
    })
    .replace(/<h([1-6])\b[^>]*>/gi, (_m, l: string) => `\n\n${'#'.repeat(Number(l))} `)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|section|h[1-6]|li|ul|ol|table|tr|blockquote|pre)>/gi, '\n')
    .replace(/<(td|th)\b[^>]*>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ')
  const text = decodeEntities(body)
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { title, text }
}

let defaultPageFetch: SafeFetch | null = null
function pageFetcher(deps: WebToolDeps): SafeFetch {
  if (deps.pageFetch) return deps.pageFetch
  if (deps.env) return createSafeFetch({ env: deps.env, allowHttp: true, timeoutMs: PAGE_TIMEOUT_MS, maxBodyBytes: MAX_PAGE_BYTES, maxRedirects: 5 })
  defaultPageFetch ??= createSafeFetch({ allowHttp: true, timeoutMs: PAGE_TIMEOUT_MS, maxBodyBytes: MAX_PAGE_BYTES, maxRedirects: 5 })
  return defaultPageFetch
}

const TEXTUAL = /^(text\/|application\/(json|xml|xhtml\+xml|rss\+xml|atom\+xml|ld\+json|javascript)|image\/svg\+xml)/i

/** Read one public web page as text. */
export async function webFetch(rawUrl: unknown, deps: WebToolDeps = {}): Promise<WebFetchOutcome> {
  let url = typeof rawUrl === 'string' ? rawUrl.trim() : ''
  if (!url) throw new WebToolError('"url" is required.')
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `https://${url}`
  if (!/^https?:\/\//i.test(url)) throw new WebToolError('Only http:// and https:// pages can be read.')
  const f = pageFetcher(deps)
  let res: Response
  try {
    res = await f(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5' }, signal: deps.signal })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if ((err as { code?: string })?.code === 'blocked_url') {
      // The guard's wording is written for MCP server URLs; say it in web terms.
      const why = msg
        .replace(/;?\s*MCP servers must be on the public internet\.?/i, '')
        .replace(/\s*Use the server's public https URL\.?/i, '')
        .trim()
      throw new WebToolError(`That address cannot be read: ${why.replace(/\.$/, "")}. Bots can only read public web pages.`)
    }
    throw new WebToolError(`Could not read ${url}: ${msg}`.slice(0, 300))
  }
  const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  if (contentType && !TEXTUAL.test(contentType)) {
    await res.body?.cancel().catch(() => {})
    throw new WebToolError(`${url} is a ${contentType} file, not a web page; only text and HTML pages can be read.`)
  }
  let raw: string
  try {
    raw = await res.text()
  } catch (err) {
    throw new WebToolError(`Could not read ${url}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300))
  }
  const isHtml = contentType.includes('html') || (!contentType && /<html|<body|<!doctype html/i.test(raw.slice(0, 2000)))
  const { title, text } = isHtml ? htmlToText(raw) : { title: null, text: raw.trim() }
  const truncated = text.length > MAX_PAGE_CHARS
  if (!res.ok && !text) throw new WebToolError(`${url} answered HTTP ${res.status}.`)
  return {
    url,
    final_url: res.url || url,
    status: res.status,
    content_type: contentType || 'unknown',
    title,
    content: truncated ? `${text.slice(0, MAX_PAGE_CHARS)}\n… [truncated]` : text,
    truncated,
  }
}
