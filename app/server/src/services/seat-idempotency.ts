/**
 * Idempotent seat writes (obj 720330). A double-click, an impatient retry, or a
 * browser that timed out while the server was still finishing must never create
 * a second seat or burn a single-use sign-in code twice.
 *
 *   - Same key while the first call is still running → the second caller awaits
 *     the FIRST call's result (one write, two identical replies).
 *   - Same key after a call SUCCEEDED (within the TTL) → the stored result is
 *     replayed (no new write).
 *   - A FAILED call is not remembered, so the operator can correct the input
 *     (e.g. paste the right code) and retry with the same key.
 *
 * In memory on purpose: keys are short-lived (a sign-in link lives 10 minutes)
 * and nothing secret is ever part of a key or a stored result — callers store
 * only HTTP status + the masked response body.
 */

export interface OnceResult<T> {
  value: T
  /** true when this call did not run `fn` (joined an in-flight call or replayed a stored success). */
  replayed: boolean
}

export interface Once<T> {
  run(key: string, fn: () => Promise<T>, succeeded: (value: T) => boolean): Promise<OnceResult<T>>
  /** Forget everything (tests). */
  clear(): void
  /** How many successful results are remembered (tests). */
  size(): number
}

export function createOnce<T>(ttlMs: number, max = 500, now: () => number = Date.now): Once<T> {
  const inflight = new Map<string, Promise<T>>()
  const done = new Map<string, { value: T; at: number }>()

  const sweep = () => {
    const t = now()
    for (const [k, v] of done) if (t - v.at > ttlMs) done.delete(k)
    while (done.size > max) done.delete(done.keys().next().value as string)
  }

  return {
    async run(key, fn, succeeded) {
      sweep()
      const stored = done.get(key)
      if (stored) return { value: stored.value, replayed: true }
      const running = inflight.get(key)
      if (running) return { value: await running, replayed: true }
      const p = (async () => fn())()
      inflight.set(key, p)
      try {
        const value = await p
        if (succeeded(value)) done.set(key, { value, at: now() })
        return { value, replayed: false }
      } finally {
        inflight.delete(key)
      }
    },
    clear() {
      inflight.clear()
      done.clear()
    },
    size() {
      return done.size
    },
  }
}

/** A client-supplied idempotency key: short, URL-safe, or null when absent / malformed. */
export function parseIdempotencyKey(v: unknown): string | null {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(v) ? v : null
}
