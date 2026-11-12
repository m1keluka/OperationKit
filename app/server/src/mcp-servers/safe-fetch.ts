/**
 * SSRF-safe `fetch` for workspace MCP servers (Sprint 7.8, obj 900620).
 *
 * Same shape as `FetchLike` in connectors/dcr-client.ts, so the existing
 * DCR/CIMD client runs through it unchanged. Differences from globalThis.fetch:
 *
 *   - Every URL (including each redirect hop) passes `validateMcpUrl`.
 *   - DNS is resolved through a `lookup` hook that rejects private,
 *     link-local, metadata and other internal addresses AT CONNECT TIME, so a
 *     hostname that passed validation but rebinds to 169.254.169.254 still
 *     fails. IP-literal hosts are checked directly (Node skips `lookup` then).
 *   - Redirects are followed manually (max 3), re-validated, and an
 *     `Authorization` header is dropped when a redirect leaves the origin.
 *   - A response timeout (headers) and a body size cap.
 */
import http from 'node:http'
import https from 'node:https'
import dns from 'node:dns'
import net from 'node:net'
import { Transform } from 'node:stream'
import type { LookupFunction } from 'node:net'
import { validateMcpUrl, checkResolvedAddress } from './url-guard.js'

export type SafeFetch = (input: string, init?: RequestInit) => Promise<Response>

export class BlockedUrlError extends Error {
  readonly code = 'blocked_url'
}

export interface SafeFetchOptions {
  /** ms to wait for response headers. Default 15s. */
  timeoutMs?: number
  /** Max response body bytes. Default 8 MiB. */
  maxBodyBytes?: number
  maxRedirects?: number
  env?: NodeJS.ProcessEnv
  /** Also allow plain http:// public URLs (obj 900671, bot web_fetch). Default false. */
  allowHttp?: boolean
}

export function guardedLookup(env: NodeJS.ProcessEnv): LookupFunction {
  return ((hostname: string, options: dns.LookupOptions, callback: (...args: unknown[]) => void) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err)
      const list = (addresses as dns.LookupAddress[]) ?? []
      if (list.length === 0) return callback(new Error(`${hostname} did not resolve`))
      for (const a of list) {
        const why = checkResolvedAddress(a.address, env)
        if (why) return callback(new BlockedUrlError(`${hostname} resolves to ${why}`))
      }
      if (options?.all) return callback(null, list)
      return callback(null, list[0].address, list[0].family)
    })
  }) as unknown as LookupFunction
}

function headersToRecord(h: RequestInit['headers']): Record<string, string> {
  const out: Record<string, string> = {}
  if (!h) return out
  new Headers(h).forEach((v, k) => { out[k] = v })
  return out
}

const NULL_BODY = new Set([101, 204, 205, 304])

function once(input: string, init: RequestInit, opts: Required<Omit<SafeFetchOptions, 'env'>> & { env: NodeJS.ProcessEnv }): Promise<Response> {
  return new Promise((resolve, reject) => {
    const check = validateMcpUrl(input, opts.env, { allowHttp: opts.allowHttp })
    if (!check.ok) return reject(new BlockedUrlError(check.error))
    const url = check.url
    const host = url.hostname.replace(/^\[|\]$/g, '')
    if (net.isIP(host)) {
      const why = checkResolvedAddress(host, opts.env)
      if (why) return reject(new BlockedUrlError(why))
    }
    const mod = url.protocol === 'https:' ? https : http
    const headers = headersToRecord(init.headers)
    let body: string | Buffer | undefined
    if (typeof init.body === 'string') body = init.body
    else if (init.body instanceof URLSearchParams) body = init.body.toString()
    else if (init.body instanceof Uint8Array) body = Buffer.from(init.body)
    else if (init.body != null) return reject(new Error('safe-fetch: unsupported body type'))
    if (body !== undefined && !Object.keys(headers).some(k => k.toLowerCase() === 'content-length')) {
      headers['content-length'] = String(Buffer.byteLength(body))
    }

    // codeql[js/request-forgery] -- this module IS the SSRF guard: validateMcpUrl() vetted the URL above, literal IPs are re-checked, and guardedLookup() re-checks every DNS answer at connect time (url-guard.test.ts, web-tools.test.ts)
    const req = mod.request(
      url,
      { method: init.method ?? 'GET', headers, lookup: guardedLookup(opts.env), agent: false },
      res => {
        clearTimeout(timer)
        const status = res.statusCode ?? 0
        const resHeaders = new Headers()
        for (const [k, v] of Object.entries(res.headers)) {
          if (Array.isArray(v)) v.forEach(x => resHeaders.append(k, x))
          else if (v != null) resHeaders.set(k, String(v))
        }
        if (NULL_BODY.has(status) || init.method === 'HEAD') {
          res.resume()
          return resolve(new Response(null, { status, headers: resHeaders }))
        }
        let seen = 0
        const cap = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            seen += chunk.length
            if (seen > opts.maxBodyBytes) return cb(new Error(`response larger than ${opts.maxBodyBytes} bytes`))
            cb(null, chunk)
          },
        })
        res.pipe(cap)
        res.on('error', e => cap.destroy(e))
        // Hand-rolled instead of Readable.toWeb: cancelling a toWeb stream
        // mid-SSE leaves Node pushing into a closed controller (ERR_INVALID_STATE).
        let done = false
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            cap.on('data', (chunk: Buffer) => {
              if (done) return
              try { controller.enqueue(new Uint8Array(chunk)) } catch { done = true }
            })
            cap.on('end', () => {
              if (done) return
              done = true
              try { controller.close() } catch { /* already closed */ }
            })
            cap.on('error', err => {
              if (done) return
              done = true
              try { controller.error(err) } catch { /* already closed */ }
            })
          },
          cancel() {
            done = true
            res.destroy()
          },
        })
        // Response requires a 200-599 status; anything else is a protocol error.
        if (status < 200 || status > 599) {
          res.destroy()
          return reject(new Error(`unexpected HTTP status ${status}`))
        }
        resolve(new Response(stream, { status, headers: resHeaders }))
      },
    )
    const timer = setTimeout(() => req.destroy(new Error(`timed out after ${opts.timeoutMs}ms`)), opts.timeoutMs)
    const signal = init.signal
    if (signal) {
      if (signal.aborted) req.destroy(new Error('aborted'))
      else signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true })
    }
    req.on('error', err => {
      clearTimeout(timer)
      reject(err)
    })
    if (body !== undefined) req.write(body)
    req.end()
  })
}

/** Build an SSRF-guarded fetch. */
export function createSafeFetch(options: SafeFetchOptions = {}): SafeFetch {
  const opts = {
    timeoutMs: options.timeoutMs ?? 15_000,
    maxBodyBytes: options.maxBodyBytes ?? 8 * 1024 * 1024,
    maxRedirects: options.maxRedirects ?? 3,
    env: options.env ?? process.env,
    allowHttp: options.allowHttp ?? false,
  }
  return async (input: string, init: RequestInit = {}) => {
    let url = input
    let currentInit = { ...init }
    for (let hop = 0; ; hop++) {
      const res = await once(url, currentInit, opts)
      const loc = res.headers.get('location')
      const redirect = [301, 302, 303, 307, 308].includes(res.status) && loc && init.redirect !== 'manual'
      if (!redirect) return res
      if (hop >= opts.maxRedirects) throw new Error(`too many redirects (more than ${opts.maxRedirects})`)
      await res.body?.cancel().catch(() => {})
      const next = new URL(loc!, url)
      const sameOrigin = next.origin === new URL(url).origin
      const headers = headersToRecord(currentInit.headers)
      if (!sameOrigin) {
        for (const k of Object.keys(headers)) if (k.toLowerCase() === 'authorization') delete headers[k]
      }
      const method = (currentInit.method ?? 'GET').toUpperCase()
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        currentInit = { ...currentInit, method: 'GET', body: undefined, headers }
      } else {
        currentInit = { ...currentInit, headers }
      }
      url = next.toString()
    }
  }
}

/** Default instance used by the routes. */
export const safeFetch: SafeFetch = createSafeFetch()
