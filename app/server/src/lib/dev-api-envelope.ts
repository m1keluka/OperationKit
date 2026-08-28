/**
 * Error envelope + request-id helpers for the Universal Development API
 * (obj-704214). Spec: universal-development-api.md §1.
 *
 * CC's pre-existing routers answer errors as a bare `{ error: 'message' }`
 * string. The Development API deliberately deviates: its clients include a
 * widget embedded in ANOTHER platform's browser bundle that we cannot
 * force-upgrade, so it needs a STABLE machine-readable `code` to decide
 * retry-vs-drop (api.md §4.1 "the localStorage retry contract"). A human string
 * cannot carry that. The deviation is scoped to the new routers only — no
 * existing route's response shape changes.
 */
import crypto from 'crypto'
import type { Request, Response } from 'express'

/** Canonical machine codes (api.md §1). Never localised, never renamed. */
export type DevErrorCode =
  | 'validation_failed'
  | 'payload_too_large'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'integration_disconnected'
  | 'rate_limited'
  | 'internal_error'

export interface DevErrorDetail {
  field: string
  issue: string
}

/** Default HTTP status per code, so callers rarely pass one explicitly. */
const STATUS_BY_CODE: Record<DevErrorCode, number> = {
  validation_failed: 400,
  payload_too_large: 413,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  integration_disconnected: 503,
  rate_limited: 429,
  internal_error: 500,
}

/**
 * Resolve (and memoise on the response) the request id. Echoed from
 * `X-Request-Id` when the caller supplied one, else generated. Every response —
 * success or error — carries it (api.md §1 rule c).
 */
export function requestId(req: Request, res: Response): string {
  const existing = res.getHeader('X-Request-Id')
  if (typeof existing === 'string' && existing) return existing
  const incoming = req.header('x-request-id')?.trim()
  const id = incoming && incoming.length <= 128 ? incoming : `req_${crypto.randomUUID()}`
  res.setHeader('X-Request-Id', id)
  return id
}

/**
 * Send the canonical error envelope.
 *
 * `message` must never echo a submitted credential, even truncated (api.md §1
 * rule b) — callers are responsible for not passing one in.
 */
export function sendDevError(
  req: Request,
  res: Response,
  code: DevErrorCode,
  message: string,
  opts: { details?: DevErrorDetail[]; status?: number; retryAfter?: number } = {},
): void {
  const status = opts.status ?? STATUS_BY_CODE[code]
  if (opts.retryAfter !== undefined) res.setHeader('Retry-After', String(opts.retryAfter))
  res.status(status).json({
    error: {
      code,
      message,
      ...(opts.details && opts.details.length ? { details: opts.details } : {}),
      request_id: requestId(req, res),
    },
  })
}

/** Send a success envelope `{ data, ...extra }` with the request id header set. */
export function sendDevData(
  req: Request,
  res: Response,
  status: number,
  data: unknown,
  extra: Record<string, unknown> = {},
): void {
  requestId(req, res)
  res.status(status).json({ data, ...extra })
}

// ── Validation helpers ──────────────────────────────────────────────────────
// Hand-rolled to match the surrounding CC style (no zod anywhere in this repo).

export class DevValidationError extends Error {
  details: DevErrorDetail[]
  constructor(details: DevErrorDetail[]) {
    super(details.map(d => `${d.field}: ${d.issue}`).join('; '))
    this.name = 'DevValidationError'
    this.details = details
  }
}

/** Collects field issues so a client sees ALL of them, not just the first. */
export class FieldChecker {
  readonly details: DevErrorDetail[] = []

  fail(field: string, issue: string): void {
    this.details.push({ field, issue })
  }

  get ok(): boolean {
    return this.details.length === 0
  }

  /** Trimmed string, length-capped. Returns undefined when absent/blank. */
  optionalString(value: unknown, field: string, max: number): string | undefined {
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'string') {
      this.fail(field, 'must be a string')
      return undefined
    }
    const trimmed = value.trim()
    if (!trimmed) return undefined
    if (trimmed.length > max) {
      this.fail(field, `must be at most ${max} characters`)
      return undefined
    }
    return trimmed
  }

  requiredString(value: unknown, field: string, max: number): string | undefined {
    const v = this.optionalString(value, field, max)
    if (v === undefined && !this.details.some(d => d.field === field)) {
      this.fail(field, 'required')
    }
    return v
  }

  enum<T extends string>(value: unknown, field: string, allowed: readonly T[]): T | undefined {
    if (value === undefined || value === null || value === '') return undefined
    if (typeof value !== 'string' || !allowed.includes(value as T)) {
      this.fail(field, `must be one of ${allowed.join('|')}`)
      return undefined
    }
    return value as T
  }

  /** Integer within [min,max]. Used for impact/effort (1..3). */
  intInRange(value: unknown, field: string, min: number, max: number): number | undefined {
    if (value === undefined || value === null) return undefined
    const n = typeof value === 'number' ? value : Number(value)
    if (!Number.isInteger(n) || n < min || n > max) {
      this.fail(field, `must be an integer between ${min} and ${max}`)
      return undefined
    }
    return n
  }

  /** https: URL, length-capped. */
  httpsUrl(value: unknown, field: string, max: number): string | undefined {
    const s = this.optionalString(value, field, max)
    if (s === undefined) return undefined
    try {
      const u = new URL(s)
      if (u.protocol !== 'https:') {
        this.fail(field, 'must be an https: URL')
        return undefined
      }
      return s
    } catch {
      this.fail(field, 'must be a valid URL')
      return undefined
    }
  }

  /** Throws a DevValidationError carrying every collected issue. */
  throwIfFailed(): void {
    if (!this.ok) throw new DevValidationError(this.details)
  }
}

/**
 * Escape a user string for use as a LIKE pattern operand. `%` and `_` are LIKE
 * wildcards; unescaped, `q=%` matches every row (api.md §5.1 `q`). Pair with
 * `ESCAPE '\'` in the SQL.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, m => `\\${m}`)
}

/** Opaque base64 cursor over an arbitrary JSON position object. */
export function encodeCursor(position: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(position), 'utf8').toString('base64url')
}

export function decodeCursor(cursor: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}
