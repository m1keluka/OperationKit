/**
 * In-process login throttle. No extra npm dependency.
 *
 * Two buckets, both 15-minute windows:
 *   ip              — 30 failures (username spray)
 *   ip|username     — 10 failures (stuffing one account)
 *
 * Success clears both keys for that client. The map is per-process and resets
 * on restart, which is the right trade for a single-node self-host.
 */

const WINDOW_MS = 15 * 60 * 1000
const MAX_PER_IDENTITY = 10
const MAX_PER_IP = 30

interface Bucket {
  failures: number
  windowStart: number
}

const buckets = new Map<string, Bucket>()

function ipKey(ip: string): string {
  return `ip:${ip}`
}

function identityKey(ip: string, username: string): string {
  return `id:${ip}|${username.trim().toLowerCase()}`
}

function now(): number {
  return Date.now()
}

function getBucket(key: string): Bucket {
  const existing = buckets.get(key)
  const t = now()
  if (!existing || t - existing.windowStart >= WINDOW_MS) {
    const fresh: Bucket = { failures: 0, windowStart: t }
    buckets.set(key, fresh)
    return fresh
  }
  return existing
}

function retryAfterSec(bucket: Bucket): number {
  return Math.max(1, Math.ceil((bucket.windowStart + WINDOW_MS - now()) / 1000))
}

export function inspectLoginRateLimit(
  ip: string,
  username: string,
): { ok: true } | { ok: false; retryAfterSec: number } {
  const ipBucket = getBucket(ipKey(ip))
  if (ipBucket.failures >= MAX_PER_IP) {
    return { ok: false, retryAfterSec: retryAfterSec(ipBucket) }
  }
  const idBucket = getBucket(identityKey(ip, username))
  if (idBucket.failures >= MAX_PER_IDENTITY) {
    return { ok: false, retryAfterSec: retryAfterSec(idBucket) }
  }
  return { ok: true }
}

export function recordLoginFailure(ip: string, username: string): void {
  getBucket(ipKey(ip)).failures++
  getBucket(identityKey(ip, username)).failures++
}

export function clearLoginFailures(ip: string, username: string): void {
  buckets.delete(ipKey(ip))
  buckets.delete(identityKey(ip, username))
}

/** Test seam — the map is module-global. */
export function resetLoginRateLimit(): void {
  buckets.clear()
}

export const LOGIN_RATE_LIMIT = {
  WINDOW_MS,
  MAX_PER_IDENTITY,
  MAX_PER_IP,
} as const
