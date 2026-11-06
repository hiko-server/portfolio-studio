/**
 * Shared GitHub API helpers for the `/api/github/*` routes.
 *
 * Why this exists: every GitHub route used to build its own `Authorization`
 * header inline. When the configured `GITHUB_TOKEN` is revoked or expired,
 * GitHub answers `401 Bad credentials` to EVERY authenticated request — so a
 * single stale token made the whole "Open Source" section (stats, top repos,
 * languages, activity) go blank. That is strictly worse than having no token
 * at all, because unauthenticated access still works (at 60 req/hr).
 *
 * `ghFetch` makes the section resilient: it tries the token once, and the first
 * time GitHub rejects it with a 401 it remembers the token is bad for the rest
 * of the process and transparently retries unauthenticated. A dead token can
 * never blank the section again — it just degrades to the lower rate limit.
 */

import type { NextApiRequest, NextApiResponse } from 'next'
import { extractGithubUser } from './githubLogin'
import { readPublicHome } from './home'

// Once GitHub rejects the configured token with a 401, stop sending it for an
// hour so we don't waste a failing request on every call (a rotated token is
// picked up again without a restart).
let tokenBadUntil = 0
const TOKEN_RETRY_MS = 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 8000

const BASE_HEADERS: Record<string, string> = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'lucian-dev.com-site',
}

/** Thrown by loaders when GitHub answered but not usefully (rate limit, 404…). */
export class GhUnavailable extends Error {}

export { extractGithubUser, isGithubLogin } from './githubLogin'

type GhInit = RequestInit & { next?: { revalidate?: number } }

/**
 * Fetch the GitHub REST API with graceful auth degradation.
 *
 * - With a usable `GITHUB_TOKEN`: sends `Authorization: Bearer <token>`.
 * - If GitHub returns 401 (revoked/expired token): records that the token is
 *   bad and retries the SAME request unauthenticated, so the caller still gets
 *   real data instead of an error.
 * - With no token configured: goes straight to unauthenticated.
 */
export async function ghFetch(url: string, init: GhInit = {}): Promise<Response> {
  const token = process.env.GITHUB_TOKEN
  const headers = { ...BASE_HEADERS, ...(init.headers as Record<string, string> | undefined) }
  // A hung GitHub connection must never hold an API request (and a server
  // worker) open indefinitely.
  const { next: _next, ...rest } = init
  void _next
  const withTimeout = (): RequestInit => ({ ...rest, signal: rest.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS) })

  if (token && Date.now() >= tokenBadUntil) {
    const res = await fetch(url, { ...withTimeout(), headers: { ...headers, Authorization: `Bearer ${token}` } })
    if (res.status !== 401) return res
    // Token rejected — don't let one bad credential blank the whole section.
    tokenBadUntil = Date.now() + TOKEN_RETRY_MS
  }

  return fetch(url, { ...withTimeout(), headers })
}

// ── GraphQL ─────────────────────────────────────────────────────────────────

/**
 * POST a GraphQL query to GitHub. GraphQL has no anonymous access, so this
 * requires a usable `GITHUB_TOKEN`: without one (or after GitHub rejected it
 * with a 401, which is remembered exactly like ghFetch does) it throws
 * GhUnavailable and callers use their unauthenticated source instead.
 * Same timeout as ghFetch; wrap calls in cachedGh for in-flight sharing and
 * the failure memo.
 */
export async function ghGraphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const token = process.env.GITHUB_TOKEN
  if (!token || Date.now() < tokenBadUntil) throw new GhUnavailable('graphql needs a usable GITHUB_TOKEN')
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { ...BASE_HEADERS, 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (res.status === 401) {
    tokenBadUntil = Date.now() + TOKEN_RETRY_MS
    throw new GhUnavailable('graphql 401')
  }
  if (!res.ok) throw new GhUnavailable(`graphql ${res.status}`)
  const body = (await res.json()) as { data?: T; errors?: Array<{ message?: string }> }
  if (body.errors?.length || !body.data) {
    throw new GhUnavailable(`graphql error: ${body.errors?.[0]?.message || 'no data'}`)
  }
  return body.data
}

// ── Shared response cache ───────────────────────────────────────────────────

/** `realAt`: when the value was last loaded successfully (absent for a fallback). */
type Entry<T> = { value: T; expires: number; realAt?: number }
const store = new Map<string, Entry<unknown>>()
const inflight = new Map<string, Promise<unknown>>()
/** How long a failed load is memoised by default (see cachedGh `failureTtlMs`). */
export const FAILURE_TTL_MS = 60 * 1000
/** A real value is still served (while a refresh runs, or after failures) for this long. */
const MAX_STALE_MS = 24 * 60 * 60 * 1000

export type GhCacheOptions = {
  /**
   * How long a failure is memoised before the next attempt (default a
   * minute). Entries that come in numbers (one per organisation, one per
   * repository's languages) wait longer, so an outage or a rate limit is
   * not retried by each of them every minute.
   */
  failureTtlMs?: number
}

const usable = <T>(e: Entry<T> | undefined, now: number): e is Entry<T> & { realAt: number } =>
  !!e && typeof e.realAt === 'number' && now - e.realAt < MAX_STALE_MS

/**
 * Memoise a GitHub-backed value per process:
 *   - fresh values are served for `ttlMs`;
 *   - after that the last real value is served immediately while ONE
 *     background refresh runs (stale-while-revalidate, for up to a day), so
 *     a page render never waits on GitHub just because a TTL ran out;
 *   - concurrent cache misses share one in-flight request (no stampede
 *     against the 60 req/hr unauthenticated limit);
 *   - failures are cached as `fallback` for a minute (`opts.failureTtlMs`;
 *     the last real value younger than a day is preferred), so an outage
 *     isn't retried on every page view.
 * Never rejects.
 */
export async function cachedGh<T>(key: string, ttlMs: number, fallback: T, loader: () => Promise<T>, opts: GhCacheOptions = {}): Promise<T> {
  const failureTtl = Math.max(0, opts.failureTtlMs ?? FAILURE_TTL_MS)
  const now = Date.now()
  const hit = store.get(key) as Entry<T> | undefined
  if (hit && hit.expires > now) return hit.value

  let pending = inflight.get(key) as Promise<T> | undefined
  if (!pending) {
    pending = (async () => {
      try {
        const value = await loader()
        store.set(key, { value, expires: Date.now() + ttlMs, realAt: Date.now() })
        return value
      } catch {
        const last = store.get(key) as Entry<T> | undefined
        const entry: Entry<T> = usable(last, Date.now())
          ? { value: last.value, expires: Date.now() + failureTtl, realAt: last.realAt }
          : { value: fallback, expires: Date.now() + failureTtl }
        store.set(key, entry)
        return entry.value
      } finally {
        inflight.delete(key)
      }
    })()
    inflight.set(key, pending)
  }
  // Serve the last real value while the refresh runs.
  if (usable(hit, now)) return hit.value
  return pending
}

/**
 * True when `key` holds a value cachedGh can answer with at once (fresh, or
 * a real value it serves while refreshing): asking for it never waits on
 * GitHub.
 */
export function isGhCached(key: string): boolean {
  const now = Date.now()
  const hit = store.get(key)
  return !!hit && (hit.expires > now || usable(hit, now))
}

// ── Answers an admin waits for ──────────────────────────────────────────────

type Answer = { value: unknown; expires: number }
const answers = new Map<string, Answer>()
const answerLoads = new Map<string, Promise<unknown>>()

/** The memoised answer for `key` while it is fresh (cachedAnswer), else undefined. */
export function peekAnswer<T>(key: string): T | undefined {
  const hit = answers.get(key)
  return hit && hit.expires > Date.now() ? (hit.value as T) : undefined
}

/**
 * A memo without stale-while-revalidate, for answers someone is waiting for
 * (the admin's organization check): each answer carries its own lifetime
 * (a confirmation for hours, "not found" for minutes, a rate limit until it
 * resets), a miss waits for the load, and concurrent misses share it. The
 * loader turns every failure into an answer; should it throw anyway,
 * nothing is memoised and the error propagates.
 */
export async function cachedAnswer<T>(key: string, loader: () => Promise<{ value: T; ttlMs: number }>): Promise<T> {
  const fresh = peekAnswer<T>(key)
  if (fresh !== undefined) return fresh
  let pending = answerLoads.get(key) as Promise<T> | undefined
  if (!pending) {
    pending = (async () => {
      try {
        const { value, ttlMs } = await loader()
        answers.set(key, { value, expires: Date.now() + Math.max(0, ttlMs) })
        return value
      } finally {
        answerLoads.delete(key)
      }
    })()
    answerLoads.set(key, pending)
  }
  return pending
}

// ── One log line per failure episode ────────────────────────────────────────

const reported = new Map<string, string>()

/**
 * Report `problem` for `key` once: `report` runs when the problem is new or
 * different from the last one reported, and `problem: null` (resolved)
 * forgets it, so the next failure is reported again. Entries refreshed in
 * the background (an organization's repositories) would otherwise log the
 * same failure at every attempt.
 */
export function reportOnce(key: string, problem: string | null, report: () => void): void {
  if (problem === null) {
    reported.delete(key)
    return
  }
  if (reported.get(key) === problem) return
  reported.set(key, problem)
  report()
}

/** Test seam: forget every cached GitHub value, answer and reported problem. */
export function clearGhCache() {
  store.clear()
  inflight.clear()
  answers.clear()
  answerLoads.clear()
  reported.clear()
}

/** Let browsers / the CDN reuse public GitHub summaries instead of hitting us per view. */
export function setPublicCache(res: NextApiResponse, sMaxAge = 600) {
  res.setHeader('Cache-Control', `public, max-age=60, s-maxage=${sMaxAge}, stale-while-revalidate=3600`)
}

/**
 * Cache header for a GitHub summary: the normal public cache when the data is
 * real, a short one when GitHub was unavailable — so an outage response is
 * not pinned in browsers / the CDN for the full TTL and a retry can recover.
 */
export function setGhCache(res: NextApiResponse, available: boolean, sMaxAge = 600) {
  if (available) setPublicCache(res, sMaxAge)
  else res.setHeader('Cache-Control', 'public, max-age=15, s-maxage=30')
}

/** The /api/github/* routes are read-only: anything but GET / HEAD gets a 405. */
export function allowRead(req: NextApiRequest, res: NextApiResponse): boolean {
  if (req.method === 'GET' || req.method === 'HEAD') return true
  res.setHeader('Allow', 'GET, HEAD')
  res.status(405).json({ error: 'Method not allowed' })
  return false
}

/** GitHub login from the public home document's socials (server-side). */
export function publicGithubUser(): string | null {
  return extractGithubUser(readPublicHome()?.socials?.github)
}
