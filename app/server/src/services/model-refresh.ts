// ── Provider model refresh (obj 900679) ─────────────────────────────────────
// Pulls each connected provider's CURRENT model list and folds it into the
// registry (`models` table), so a newly released model shows up in
// Settings → Models without a code change or a hand-written seed migration.
//
// Providers:
//   anthropic  GET https://api.anthropic.com/v1/models  (paginated)
//   openai     GET https://api.openai.com/v1/models
//   xai        GET https://api.x.ai/v1/models
//   custom     GET <baseUrl>/models for every PROVIDER_API_KEY__CUSTOM__<slug>
//              (OpenAI-compatible). Listed in the report only: no session
//              engine can run a custom endpoint yet, so nothing is inserted.
//
// Credentials, tried in order until one is accepted (a 401/403 falls through to
// the next candidate, so one stale key does not hide a working one):
//   1. the BYOK key from Settings → Models → API key providers
//      (global secret PROVIDER_API_KEY__<PROVIDER>, JSON {apiKey, baseUrl?})
//   2. the server env (ANTHROPIC_API_KEY, OPENAI_API_KEY, XAI_API_KEY, …)
//   3. Anthropic only: a Claude subscription OAuth token from the env
// Only the credential NAME ever reaches the report. Values go to their own
// provider's API and nowhere else.
//
// Discovered models are inserted DISABLED (source='provider'): a fresh id can
// need a newer CLI before it runs (see the Opus 5.5 note in db/schema/models.ts),
// so an admin turns it on with one click. Existing rows are never relabelled
// unless the provider itself created them, and a model the provider stops
// listing is reported, never auto-disabled (that would strand in-flight cards).
import { getDb } from '../db/index.js'
import { getSecretValue, listSecrets } from './secrets-store.js'
import type { ModelEngine } from '@operationkit/shared'
import { catalogEntry } from '../lib/claude-model-catalog.js'

export type ProviderStatus = 'ok' | 'error' | 'skipped'

export interface ProviderRefreshResult {
  provider: string
  label: string
  /** Registry engine the models are filed under; null = listed only (custom). */
  engine: ModelEngine | null
  status: ProviderStatus
  /** Name of the credential that worked (or was last tried). Never a value. */
  credential: string | null
  /** Human-readable reason when status is error/skipped. */
  error: string | null
  http_status: number | null
  /** Usable model ids the provider returned (after filtering). */
  fetched: number
  added: string[]
  updated: string[]
  /** Registry rows on this engine the provider no longer lists. */
  missing: string[]
  /** Custom endpoints only: the ids it listed (capped). */
  listed?: string[]
}

export interface ModelRefreshReport {
  trigger: 'manual' | 'scheduled'
  started_at: string
  finished_at: string
  providers: ProviderRefreshResult[]
}

export interface ProviderModel {
  id: string
  label: string | null
}

export interface Credential {
  name: string
  value: string
  kind: 'api_key' | 'oauth'
  baseUrl?: string
}

type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
  text(): Promise<string>
}>

export interface RefreshDeps {
  fetchImpl?: FetchLike
  env?: NodeJS.ProcessEnv
  /** Reads a global secret value by key (server-only). */
  readSecret?: (key: string) => string | null
  /** Lists global secret KEYS (names only). */
  listSecretKeys?: () => string[]
  timeoutMs?: number
}

export const LAST_REFRESH_SETTING = 'model_refresh_last'
export const AUTO_REFRESH_SETTING = 'model_refresh_auto'
export const REFRESH_INTERVAL_SETTING = 'model_refresh_interval_hours'
const PROVIDER_KEY_PREFIX = 'PROVIDER_API_KEY__'
const DEFAULT_TIMEOUT_MS = 15_000
const NEW_MODEL_SORT_ORDER = 90

// ── filters: keep models a session engine can actually run ──────────────────

// Legacy chat generations (gpt-3.5, gpt-4 / gpt-4-turbo) and ChatGPT aliases are
// dropped too: the Codex CLI targets current models, and they would only bury
// the useful rows.
const OPENAI_LEGACY = /^(gpt-3|gpt-4($|-turbo|-\d)|chatgpt)/i
const OPENAI_EXCLUDE = /(embedding|tts|whisper|dall-e|image|audio|realtime|transcribe|moderation|search|instruct|davinci|babbage|computer-use|-\d{4}-\d{2}-\d{2}$|-\d{4}$)/i

export function isUsableModel(provider: 'anthropic' | 'openai' | 'xai', id: string): boolean {
  if (provider === 'anthropic') return /^claude-/i.test(id)
  if (provider === 'openai') return /^(gpt-|o\d|codex)/i.test(id) && !OPENAI_EXCLUDE.test(id) && !OPENAI_LEGACY.test(id)
  return /^grok/i.test(id) && !/(image|imagine)/i.test(id)
}

/** 'gpt-5.5-mini' → 'GPT-5.5 Mini'. Used when a provider gives no display name. */
export function prettifyModelId(id: string): string {
  return id
    .split('-')
    .map(part => {
      if (/^gpt$/i.test(part)) return 'GPT'
      if (/^o\d/i.test(part)) return part.toLowerCase()
      return part.charAt(0).toUpperCase() + part.slice(1)
    })
    .join(' ')
    .replace(/^GPT /, 'GPT-')
}

// ── credentials ─────────────────────────────────────────────────────────────

function parseStoredKey(name: string, raw: string | null): Credential | null {
  if (!raw || !raw.trim()) return null
  const trimmed = raw.trim()
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed) as { apiKey?: unknown; baseUrl?: unknown }
      if (typeof obj.apiKey === 'string' && obj.apiKey.trim()) {
        return {
          name,
          value: obj.apiKey.trim(),
          kind: 'api_key',
          baseUrl: typeof obj.baseUrl === 'string' && obj.baseUrl.trim() ? obj.baseUrl.trim() : undefined,
        }
      }
      return null
    } catch {
      // not JSON after all — treat as a bare key
    }
  }
  return { name, value: trimmed, kind: 'api_key' }
}

const ENV_KEYS: Record<'anthropic' | 'openai' | 'xai', string[]> = {
  anthropic: ['ANTHROPIC_API_KEY', 'SESSION_JAIL_ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
  xai: ['XAI_API_KEY', 'GROK_API_KEY'],
}
const ANTHROPIC_OAUTH_ENV = ['AGENT_CHAT_CLAUDE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'SESSION_JAIL_CLAUDE_OAUTH_TOKEN']

export function resolveCredentials(
  provider: 'anthropic' | 'openai' | 'xai',
  readSecret: (key: string) => string | null,
  env: NodeJS.ProcessEnv,
): Credential[] {
  const out: Credential[] = []
  const seen = new Set<string>()
  const push = (c: Credential | null) => {
    if (!c || seen.has(c.value)) return
    seen.add(c.value)
    out.push(c)
  }
  const secretName = `${PROVIDER_KEY_PREFIX}${provider.toUpperCase()}`
  let stored: string | null = null
  try { stored = readSecret(secretName) } catch { stored = null }
  push(parseStoredKey(secretName, stored))
  for (const name of ENV_KEYS[provider]) push(parseStoredKey(name, env[name] ?? null))
  if (provider === 'anthropic') {
    for (const name of ANTHROPIC_OAUTH_ENV) {
      const v = env[name]?.trim()
      if (v) push({ name, value: v, kind: 'oauth' })
    }
  }
  return out
}

// ── fetching ────────────────────────────────────────────────────────────────

class ProviderHttpError extends Error {
  constructor(message: string, public status: number | null) { super(message) }
}

async function getJson(fetchImpl: FetchLike, url: string, headers: Record<string, string>, timeoutMs: number): Promise<unknown> {
  let res
  try {
    res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    const e = err as Error
    const why = e?.name === 'TimeoutError' || e?.name === 'AbortError'
      ? `timed out after ${Math.round(timeoutMs / 1000)}s`
      : (e?.message || 'network error')
    throw new ProviderHttpError(`Could not reach ${new URL(url).host}: ${why}`, null)
  }
  if (!res.ok) {
    let detail = ''
    try {
      const body = await res.text()
      const parsed = JSON.parse(body) as { error?: { message?: string } | string }
      detail = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? ''
    } catch { /* body not JSON */ }
    const hint = res.status === 401 || res.status === 403 ? 'credential rejected' : `HTTP ${res.status}`
    throw new ProviderHttpError(`${new URL(url).host} answered ${res.status} (${hint})${detail ? `: ${detail.slice(0, 200)}` : ''}`, res.status)
  }
  try {
    return await res.json()
  } catch {
    throw new ProviderHttpError(`${new URL(url).host} returned a non-JSON body`, res.status)
  }
}

function dataArray(body: unknown): Array<Record<string, unknown>> {
  const data = (body as { data?: unknown })?.data
  if (!Array.isArray(data)) throw new ProviderHttpError('Unexpected response shape (no data[] array)', null)
  return data.filter((d): d is Record<string, unknown> => !!d && typeof d === 'object' && typeof (d as { id?: unknown }).id === 'string')
}

async function listAnthropic(fetchImpl: FetchLike, cred: Credential, timeoutMs: number): Promise<ProviderModel[]> {
  const headers: Record<string, string> = { 'anthropic-version': '2023-06-01' }
  if (cred.kind === 'oauth') {
    headers.Authorization = `Bearer ${cred.value}`
    headers['anthropic-beta'] = 'oauth-2025-04-20'
  } else {
    headers['x-api-key'] = cred.value
  }
  const out: ProviderModel[] = []
  let afterId: string | null = null
  for (let page = 0; page < 20; page++) {
    const url = new URL('https://api.anthropic.com/v1/models')
    url.searchParams.set('limit', '1000')
    if (afterId) url.searchParams.set('after_id', afterId)
    const body = await getJson(fetchImpl, url.toString(), headers, timeoutMs)
    for (const m of dataArray(body)) {
      out.push({ id: m.id as string, label: typeof m.display_name === 'string' ? m.display_name : null })
    }
    const b = body as { has_more?: boolean; last_id?: string | null }
    if (!b.has_more || !b.last_id) break
    afterId = b.last_id
  }
  return out
}

async function listOpenAiStyle(fetchImpl: FetchLike, baseUrl: string, cred: Credential, timeoutMs: number): Promise<ProviderModel[]> {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`
  const body = await getJson(fetchImpl, url, { Authorization: `Bearer ${cred.value}` }, timeoutMs)
  return dataArray(body).map(m => ({ id: m.id as string, label: null }))
}

// ── registry upsert ─────────────────────────────────────────────────────────

interface ExistingRow { id: string; engine: string; label: string; source: string | null }

export function applyProviderModels(engine: ModelEngine, models: ProviderModel[], now: string): { added: string[]; updated: string[]; missing: string[] } {
  const db = getDb()
  const added: string[] = []
  const updated: string[] = []
  const existing = new Map(
    (db.prepare('SELECT id, engine, label, source FROM models').all() as ExistingRow[]).map(r => [r.id, r]),
  )
  const fetchedIds = new Set(models.map(m => m.id))
  const ins = db.prepare(
    `INSERT INTO models (id, label, engine, enabled, is_default, is_planner, sort_order, source, discovered_at, last_seen_at)
     VALUES (?, ?, ?, 0, 0, 0, ?, 'provider', ?, ?)`,
  )
  const seen = db.prepare('UPDATE models SET last_seen_at = ? WHERE id = ?')
  const relabel = db.prepare("UPDATE models SET label = ?, updated_at = datetime('now') WHERE id = ?")
  db.transaction(() => {
    for (const m of models) {
      const row = existing.get(m.id)
      if (!row) {
        // A curated catalog id keeps the catalog's name + position (obj 900796).
        const cat = engine === 'claude' ? catalogEntry(m.id) : undefined
        ins.run(m.id, cat?.label || m.label || prettifyModelId(m.id), engine, cat?.sort_order ?? NEW_MODEL_SORT_ORDER, now, now)
        added.push(m.id)
        continue
      }
      if (row.engine !== engine) continue // same id filed under another engine — leave it alone
      seen.run(now, m.id)
      // Only rows the refresh itself created get relabelled; curated labels
      // ("Opus 5 (legacy)") are an admin's call.
      if (row.source === 'provider' && m.label && m.label !== row.label) {
        relabel.run(m.label, m.id)
        updated.push(m.id)
      }
    }
  })()
  const missing = [...existing.values()]
    .filter(r => r.engine === engine && !fetchedIds.has(r.id))
    .map(r => r.id)
  return { added, updated, missing }
}

// ── orchestration ───────────────────────────────────────────────────────────

const FIXED: Array<{ provider: 'anthropic' | 'openai' | 'xai'; label: string; engine: ModelEngine; baseUrl: string; envHint: string }> = [
  { provider: 'anthropic', label: 'Anthropic', engine: 'claude', baseUrl: 'https://api.anthropic.com/v1', envHint: 'ANTHROPIC_API_KEY' },
  { provider: 'openai', label: 'OpenAI', engine: 'codex', baseUrl: 'https://api.openai.com/v1', envHint: 'OPENAI_API_KEY' },
  { provider: 'xai', label: 'xAI', engine: 'grok', baseUrl: 'https://api.x.ai/v1', envHint: 'XAI_API_KEY' },
]

function emptyResult(provider: string, label: string, engine: ModelEngine | null): ProviderRefreshResult {
  return { provider, label, engine, status: 'error', credential: null, error: null, http_status: null, fetched: 0, added: [], updated: [], missing: [] }
}

async function refreshFixed(
  spec: (typeof FIXED)[number],
  deps: Required<Pick<RefreshDeps, 'fetchImpl' | 'env' | 'readSecret' | 'timeoutMs'>>,
  now: string,
): Promise<ProviderRefreshResult> {
  const result = emptyResult(spec.provider, spec.label, spec.engine)
  const creds = resolveCredentials(spec.provider, deps.readSecret, deps.env)
  if (creds.length === 0) {
    result.status = 'skipped'
    result.error = `Not connected — add a ${spec.label} key under API key providers (or set ${spec.envHint}).`
    return result
  }
  let lastErr: ProviderHttpError | null = null
  for (const cred of creds) {
    result.credential = cred.name
    try {
      const raw = spec.provider === 'anthropic'
        ? await listAnthropic(deps.fetchImpl, cred, deps.timeoutMs)
        : await listOpenAiStyle(deps.fetchImpl, spec.baseUrl, cred, deps.timeoutMs)
      const usable = raw.filter(m => isUsableModel(spec.provider, m.id))
      const applied = applyProviderModels(spec.engine, usable, now)
      return { ...result, status: 'ok', error: null, http_status: 200, fetched: usable.length, ...applied }
    } catch (err) {
      lastErr = err instanceof ProviderHttpError ? err : new ProviderHttpError((err as Error)?.message || String(err), null)
      // Only a rejected credential is worth retrying with the next one; a
      // network/5xx failure would fail the same way for every key.
      if (lastErr.status !== 401 && lastErr.status !== 403) break
    }
  }
  result.status = 'error'
  result.error = lastErr?.message ?? 'Unknown error'
  result.http_status = lastErr?.status ?? null
  return result
}

async function refreshCustom(
  slug: string,
  secretKey: string,
  deps: Required<Pick<RefreshDeps, 'fetchImpl' | 'readSecret' | 'timeoutMs'>>,
): Promise<ProviderRefreshResult> {
  const result = emptyResult(`custom:${slug}`, `Custom (${slug})`, null)
  result.credential = secretKey
  let raw: string | null = null
  try { raw = deps.readSecret(secretKey) } catch { raw = null }
  const cred = parseStoredKey(secretKey, raw)
  if (!cred?.baseUrl) {
    result.status = 'error'
    result.error = 'Stored key has no base URL — re-save it with the endpoint URL.'
    return result
  }
  try {
    const models = await listOpenAiStyle(deps.fetchImpl, cred.baseUrl, cred, deps.timeoutMs)
    result.status = 'ok'
    result.http_status = 200
    result.fetched = models.length
    result.listed = models.map(m => m.id).slice(0, 50)
    result.error = null
  } catch (err) {
    const e = err instanceof ProviderHttpError ? err : new ProviderHttpError((err as Error)?.message || String(err), null)
    result.error = e.message
    result.http_status = e.status
  }
  return result
}

function defaultReadSecret(key: string): string | null {
  return getSecretValue({ scopeType: 'global' }, key, null, 'server')
}
function defaultListSecretKeys(): string[] {
  return listSecrets({ scopeType: 'global' }).map(s => s.key)
}

let inFlight: Promise<ModelRefreshReport> | null = null

/**
 * Refresh every provider in parallel and persist the report. Concurrent calls
 * share one run, so a double-click or a scheduled tick during a manual refresh
 * never hits the provider APIs twice.
 */
export function refreshProviderModels(trigger: 'manual' | 'scheduled' = 'manual', deps: RefreshDeps = {}): Promise<ModelRefreshReport> {
  if (inFlight) return inFlight
  inFlight = runRefresh(trigger, deps).finally(() => { inFlight = null })
  return inFlight
}

async function runRefresh(trigger: 'manual' | 'scheduled', deps: RefreshDeps): Promise<ModelRefreshReport> {
  const started = new Date().toISOString()
  const full = {
    fetchImpl: deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike),
    env: deps.env ?? process.env,
    readSecret: deps.readSecret ?? defaultReadSecret,
    timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
  let customKeys: string[] = []
  try {
    customKeys = (deps.listSecretKeys ?? defaultListSecretKeys)().filter(k => k.startsWith(`${PROVIDER_KEY_PREFIX}CUSTOM__`))
  } catch { customKeys = [] }

  const tasks: Array<Promise<ProviderRefreshResult>> = [
    ...FIXED.map(spec => refreshFixed(spec, full, started)),
    ...customKeys.map(k => refreshCustom(k.slice(`${PROVIDER_KEY_PREFIX}CUSTOM__`.length).toLowerCase(), k, full)),
  ]
  const settled = await Promise.allSettled(tasks)
  const providers = settled.map((s, i) => {
    if (s.status === 'fulfilled') return s.value
    const r = emptyResult(i < FIXED.length ? FIXED[i].provider : 'custom', i < FIXED.length ? FIXED[i].label : 'Custom', null)
    r.error = (s.reason as Error)?.message || 'Refresh failed'
    return r
  })
  const report: ModelRefreshReport = { trigger, started_at: started, finished_at: new Date().toISOString(), providers }
  try {
    getDb()
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(LAST_REFRESH_SETTING, JSON.stringify(report))
  } catch (err) {
    console.warn('[model-refresh] could not persist report:', (err as Error).message)
  }
  const summary = providers.map(p => `${p.provider}=${p.status}${p.added.length ? `(+${p.added.length})` : ''}`).join(' ')
  console.log(`[model-refresh] ${trigger}: ${summary}`)
  return report
}

export function getLastRefreshReport(): ModelRefreshReport | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(LAST_REFRESH_SETTING) as { value: string } | undefined
  if (!row) return null
  try { return JSON.parse(row.value) as ModelRefreshReport } catch { return null }
}

function readSetting(key: string): string | null {
  try {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value ?? null
  } catch { return null }
}

/** Hours between automatic refreshes; 0 = automatic refresh off. */
export function autoRefreshIntervalHours(): number {
  if (readSetting(AUTO_REFRESH_SETTING) === '0') return 0
  const n = Number(readSetting(REFRESH_INTERVAL_SETTING) ?? '24')
  return Number.isFinite(n) && n > 0 ? n : 24
}

/**
 * Host-only scheduler (never on a scratch instance — index.ts gates the call).
 * Checks hourly and refreshes when the last report is older than the
 * configured interval, so a restart neither skips nor double-fires a refresh.
 */
export function startModelRefreshScheduler(): void {
  const tick = () => {
    const hours = autoRefreshIntervalHours()
    if (hours === 0) return
    const last = getLastRefreshReport()
    const age = last ? Date.now() - Date.parse(last.finished_at) : Infinity
    if (Number.isFinite(age) && age < hours * 3600_000) return
    refreshProviderModels('scheduled').catch(err => {
      console.error('[model-refresh] scheduled refresh failed:', (err as Error).message)
    })
  }
  setTimeout(tick, 2 * 60 * 1000).unref()
  setInterval(tick, 60 * 60 * 1000).unref()
}
