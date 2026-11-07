/**
 * Fixed-window counters, runtime-neutral (used by lib/rateLimit.ts on Node
 * and by the edge /api/og route).
 *
 * Memory is bounded: when `maxKeys` is reached, expired windows are dropped
 * first, then the oldest half. Keys embed the client's IP bucket, so evicting
 * someone else's window needs a flood from many distinct networks.
 */

export type WindowHit = { allowed: boolean; remaining: number; resetAt: number }

export type FixedWindowLimiter = {
  hit(key: string, limit: number, windowMs: number, now?: number): WindowHit
  /**
   * The window's state WITHOUT counting this call: whether a hit would be
   * allowed now. For budgets charged only on failure (a failed sign-in on
   * /mcp): peek first, refuse when it says no, and `hit` only after a
   * failure, so valid traffic never spends the bucket.
   */
  peek(key: string, limit: number, now?: number): WindowHit
  size(): number
}

export function createFixedWindowLimiter(maxKeys = 10_000): FixedWindowLimiter {
  const buckets = new Map<string, { count: number; resetAt: number }>()

  const sweep = (now: number) => {
    if (buckets.size < maxKeys) return
    buckets.forEach((b, k) => {
      if (b.resetAt <= now) buckets.delete(k)
    })
    if (buckets.size >= maxKeys) {
      const keys = Array.from(buckets.keys())
      for (let i = 0; i < keys.length / 2; i++) buckets.delete(keys[i])
    }
  }

  return {
    hit(key, limit, windowMs, now = Date.now()) {
      sweep(now)
      const bucket = buckets.get(key)
      if (!bucket || bucket.resetAt <= now) {
        const resetAt = now + windowMs
        buckets.set(key, { count: 1, resetAt })
        return { allowed: limit >= 1, remaining: Math.max(0, limit - 1), resetAt }
      }
      if (bucket.count < limit) {
        bucket.count += 1
        return { allowed: true, remaining: limit - bucket.count, resetAt: bucket.resetAt }
      }
      return { allowed: false, remaining: 0, resetAt: bucket.resetAt }
    },
    peek(key, limit, now = Date.now()) {
      const bucket = buckets.get(key)
      if (!bucket || bucket.resetAt <= now) return { allowed: limit >= 1, remaining: Math.max(0, limit), resetAt: now }
      return { allowed: bucket.count < limit, remaining: Math.max(0, limit - bucket.count), resetAt: bucket.resetAt }
    },
    size: () => buckets.size,
  }
}

/**
 * One limiter per name for the whole process. Kept on globalThis so every
 * route bundle (and dev-mode module reloads) share the same counters instead
 * of each getting a private, easily-bypassed copy.
 */
export function sharedLimiter(name: string, maxKeys = 10_000): FixedWindowLimiter {
  const registry = globalThis as unknown as Record<symbol, FixedWindowLimiter | undefined>
  const key = Symbol.for(`lucian-dev.rateLimit.${name}`)
  let limiter = registry[key]
  // A limiter made by an older copy of this module (dev reload) lacks `peek`: replace it.
  if (!limiter || typeof limiter.peek !== 'function') {
    limiter = createFixedWindowLimiter(maxKeys)
    registry[key] = limiter
  }
  return limiter
}
