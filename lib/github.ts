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
import { log } from './log'

// Once GitHub rejects the configured token with a 401, stop sending it for an
// hour so we don't waste a failing request on every call (a rotated token is
// picked up again without a restart). Kept in the shared state below.
const TOKEN_RETRY_MS = 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 8000

const BASE_HEADERS: Record<string, string> = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'lucian-dev.com-site',
}

/** Thrown by loaders when GitHub answered but not usefully (rate limit, 404…). */
export class GhUnavailable extends Error {}

/** What a GitHub request is for (see the request budget below). */
export type GhPurpose = 'refresh' | 'load'

/** Whose limit a request counts against: the server's IP (no token) or the token's. */
export type GhMode = 'anonymous' | 'token'

/**
 * Thrown by ghFetch instead of sending a request the budget has no room
 * for: nothing was sent; `retryAt` is when there is room again.
 * Recognised by its `code` (isGhDeferred), since every webpack runtime has
 * its own copy of this class.
 */
export class GhDeferred extends GhUnavailable {
  readonly code = 'GH_DEFERRED'
  readonly retryAt: number
  readonly purpose: GhPurpose
  constructor(retryAt: number, purpose: GhPurpose) {
    super(`GitHub request budget: ${purpose} deferred`)
    this.retryAt = retryAt
    this.purpose = purpose
  }
}

export const isGhDeferred = (err: unknown): err is { code: 'GH_DEFERRED'; retryAt: number; purpose: GhPurpose } =>
  !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'GH_DEFERRED' && typeof (err as { retryAt?: unknown }).retryAt === 'number'

/** `realAt`: when the value was last loaded successfully (absent for a fallback). */
type Entry<T> = { value: T; expires: number; realAt?: number }
type Answer = { value: unknown; expires: number }

/** GitHub's own count of a window (its x-ratelimit-* headers). */
type GhWindow = { limit: number; remaining: number; resetAt: number }

type GhShared = {
  store: Map<string, Entry<unknown>>
  inflight: Map<string, Promise<unknown>>
  answers: Map<string, Answer>
  answerLoads: Map<string, Promise<unknown>>
  reported: Map<string, string>
  token: { badUntil: number }
  /** When each request of the last hour was sent (ascending), and GitHub's latest count, per mode. */
  budget: { sent: Record<GhMode, number[]>; github: Record<GhMode, GhWindow | null> }
}

const freshBudget = (): GhShared['budget'] => ({ sent: { anonymous: [], token: [] }, github: { anonymous: null, token: null } })

/**
 * One state per process for everything below: the cache, the in-flight
 * loads, the admin answers, the problems reported and the rejected token.
 * Next bundles the pages and the API routes into separate webpack runtimes,
 * each with its own copy of this module; kept on globalThis (like the rate
 * limiters, lib/security/rateLimitCore), the pages' server renders,
 * /api/github/* and the admin routes share it. Otherwise each runtime would
 * ask GitHub for the same data — twice the request budget of
 * lib/githubData GH_TTL — and a home save warming the cache from its API
 * route would not reach the pages it then regenerates.
 */
function ghShared(): GhShared {
  const registry = globalThis as unknown as Record<symbol, GhShared | undefined>
  const key = Symbol.for('lucian-dev.github.shared')
  let state = registry[key]
  if (!state) {
    state = { store: new Map(), inflight: new Map(), answers: new Map(), answerLoads: new Map(), reported: new Map(), token: { badUntil: 0 }, budget: freshBudget() }
    registry[key] = state
  }
  state.budget ??= freshBudget() // a state made by an older copy of this module (a dev reload)
  return state
}

const shared = ghShared()
const { store, inflight, answers, answerLoads, reported, token: tokenState } = shared
const ghLog = log.child({ module: 'github' })

export { extractGithubUser, isGithubLogin } from './githubLogin'

type GhInit = RequestInit & { next?: { revalidate?: number }; purpose?: GhPurpose }

// ── Request budget ──────────────────────────────────────────────────────────

const HOUR_MS = 60 * 60 * 1000

/** GitHub's REST limit per hour: per IP without a token, per token with one. */
export const GH_RATE_LIMIT: Readonly<Record<GhMode, number>> = { anonymous: 60, token: 5000 }

/**
 * The share of GitHub's hourly limit this process lets itself use within
 * any 60 minutes, by what a request is for:
 *   - `refresh`: a background refresh while the last value is served
 *     (cachedGh's stale-while-revalidate) — nobody waits for it, so it only
 *     goes out while less than half the limit was used;
 *   - `load`: something not loaded yet that a widget or the admin waits for
 *     — up to three quarters.
 * Without a token that is 30 and 45 of 60. So a cold start's loads and the
 * admin's organization checks always find the band above the refreshes,
 * and whatever the TTLs, the number of organizations or the size of their
 * lists, no 60 minutes ever see more than 45 requests from this process;
 * the last quarter is the margin (anything else on the same IP, clock
 * skew). GitHub's own count (x-ratelimit-remaining) is honoured too, should
 * something else use the same IP or token.
 */
export const GH_BUDGET_SHARE: Readonly<Record<GhPurpose, number>> = { refresh: 0.5, load: 0.75 }

/** Requests of the last 60 minutes under which one more of `purpose` may go (anonymous: refresh 30, load 45). */
export function ghCeiling(mode: GhMode, purpose: GhPurpose, limit = GH_RATE_LIMIT[mode]): number {
  return Math.floor(limit * GH_BUDGET_SHARE[purpose])
}

const tokenUsable = (now = Date.now()) => !!process.env.GITHUB_TOKEN && now >= tokenState.badUntil

function windowOf(mode: GhMode, now: number) {
  const sent = shared.budget.sent[mode]
  while (sent.length && sent[0] <= now - HOUR_MS) sent.shift()
  const gh = shared.budget.github[mode]
  return { sent, gh: gh && gh.resetAt > now ? gh : null }
}

/**
 * Count one request of `purpose` against the budget, or throw GhDeferred
 * when there is no room (nothing is sent then). Logged once per episode.
 */
function admit(mode: GhMode, purpose: GhPurpose, now = Date.now()): void {
  const { sent, gh } = windowOf(mode, now)
  const ceiling = ghCeiling(mode, purpose)
  const ghCeilingNow = gh ? ghCeiling(mode, purpose, gh.limit) : Infinity
  const ghUsed = gh ? gh.limit - gh.remaining : 0
  if (sent.length < ceiling && ghUsed < ghCeilingNow) {
    sent.push(now)
    if (gh) gh.remaining = Math.max(0, gh.remaining - 1) // until GitHub's answer says otherwise
    if (sent.length <= ghCeiling(mode, 'refresh')) reportOnce(`budget:${mode}`, null, () => undefined)
    return
  }
  // Room again once enough of the oldest requests leave the window (or GitHub's window resets).
  const ownRetry = sent.length >= ceiling ? sent[sent.length - ceiling] + HOUR_MS : now
  const retryAt = Math.max(ownRetry, gh && ghUsed >= ghCeilingNow ? gh.resetAt : now, now + 1000)
  reportOnce(`budget:${mode}`, purpose, () =>
    ghLog.info('GitHub request budget reached; requests wait (the last values are served)', {
      mode,
      purpose,
      sentLastHour: sent.length,
      githubRemaining: gh?.remaining ?? null,
      retryInSeconds: Math.ceil((retryAt - now) / 1000),
    }),
  )
  throw new GhDeferred(retryAt, purpose)
}

/** GitHub's own count of the window, from a response (core REST limit only). */
function noteRateLimit(mode: GhMode, res: Response, now = Date.now()): void {
  const resource = res.headers.get('x-ratelimit-resource')
  if (resource && resource !== 'core') return
  const remaining = Number(res.headers.get('x-ratelimit-remaining') ?? NaN)
  const reset = Number(res.headers.get('x-ratelimit-reset') ?? NaN)
  if (!Number.isFinite(remaining) || !Number.isFinite(reset) || reset * 1000 <= now) return
  const limit = Number(res.headers.get('x-ratelimit-limit') ?? NaN)
  shared.budget.github[mode] = { limit: Number.isFinite(limit) && limit > 0 ? limit : GH_RATE_LIMIT[mode], remaining: Math.max(0, remaining), resetAt: reset * 1000 }
}

/** The budget as it stands (tests, diagnostics): requests of the last hour and the ceilings. */
export function ghBudgetState(now = Date.now()): { mode: GhMode; sentLastHour: number; githubRemaining: number | null; ceilings: Record<GhPurpose, number> } {
  const mode: GhMode = tokenUsable(now) ? 'token' : 'anonymous'
  const { sent, gh } = windowOf(mode, now)
  return { mode, sentLastHour: sent.length, githubRemaining: gh?.remaining ?? null, ceilings: { refresh: ghCeiling(mode, 'refresh'), load: ghCeiling(mode, 'load') } }
}

/**
 * Fetch the GitHub REST API with graceful auth degradation, inside the
 * request budget above.
 *
 * - With a usable `GITHUB_TOKEN`: sends `Authorization: Bearer <token>`.
 * - If GitHub returns 401 (revoked/expired token): records that the token is
 *   bad and retries the SAME request unauthenticated, so the caller still gets
 *   real data instead of an error.
 * - With no token configured: goes straight to unauthenticated.
 * - `purpose` (default `load`): what the request is for. One the budget
 *   has no room for is not sent: GhDeferred is thrown instead.
 */
export async function ghFetch(url: string, init: GhInit = {}): Promise<Response> {
  const token = process.env.GITHUB_TOKEN
  const headers = { ...BASE_HEADERS, ...(init.headers as Record<string, string> | undefined) }
  // A hung GitHub connection must never hold an API request (and a server
  // worker) open indefinitely.
  const { next: _next, purpose = 'load', ...rest } = init
  void _next
  const withTimeout = (): RequestInit => ({ ...rest, signal: rest.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS) })

  if (token && tokenUsable()) {
    admit('token', purpose)
    const res = await fetch(url, { ...withTimeout(), headers: { ...headers, Authorization: `Bearer ${token}` } })
    if (res.status !== 401) {
      noteRateLimit('token', res)
      return res
    }
    // Token rejected — don't let one bad credential blank the whole section.
    tokenState.badUntil = Date.now() + TOKEN_RETRY_MS
  }

  admit('anonymous', purpose)
  const res = await fetch(url, { ...withTimeout(), headers })
  noteRateLimit('anonymous', res)
  return res
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
  if (!token || Date.now() < tokenState.badUntil) throw new GhUnavailable('graphql needs a usable GITHUB_TOKEN')
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { ...BASE_HEADERS, 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (res.status === 401) {
    tokenState.badUntil = Date.now() + TOKEN_RETRY_MS
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

/** How long a failed load is memoised by default (see cachedGh `failureTtlMs`). */
export const FAILURE_TTL_MS = 60 * 1000
/** A real value is still served (while a refresh runs, or after failures) for this long. */
const MAX_STALE_MS = 24 * 60 * 60 * 1000

export type GhCacheOptions = {
  /**
   * How long a failure is memoised before the next attempt (default a
   * minute). Entries that come in numbers (one per organisation, one per
   * repository's languages) wait longer, so an outage or a rate limit is
   * not retried by each of them every minute. A load the request budget
   * deferred (GhDeferred) is tried again when there is room, at the latest
   * after this long.
   */
  failureTtlMs?: number
}

/** What cachedGh tells its loader: `background` when the last value is served while it runs (ghFetch purpose `refresh`). */
export type GhLoadContext = { background: boolean; purpose: GhPurpose }

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
export async function cachedGh<T>(
  key: string,
  ttlMs: number,
  fallback: T,
  loader: (ctx: GhLoadContext) => Promise<T>,
  opts: GhCacheOptions = {},
): Promise<T> {
  const failureTtl = Math.max(0, opts.failureTtlMs ?? FAILURE_TTL_MS)
  const now = Date.now()
  const hit = store.get(key) as Entry<T> | undefined
  if (hit && hit.expires > now) return hit.value

  let pending = inflight.get(key) as Promise<T> | undefined
  if (!pending) {
    const background = usable(hit, now)
    pending = (async () => {
      try {
        const value = await loader({ background, purpose: background ? 'refresh' : 'load' })
        store.set(key, { value, expires: Date.now() + ttlMs, realAt: Date.now() })
        return value
      } catch (err) {
        const at = Date.now()
        // Deferred by the budget: again when there is room (not before a second, not after failureTtl).
        const expires = isGhDeferred(err) ? Math.min(at + failureTtl, Math.max(at + 1000, err.retryAt)) : at + failureTtl
        const last = store.get(key) as Entry<T> | undefined
        const entry: Entry<T> = usable(last, at) ? { value: last.value, expires, realAt: last.realAt } : { value: fallback, expires }
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

/** Milliseconds until `key` is loaded again (its value, or the failure memo, expires); 0 when nothing is memoised. */
export function ghExpiresIn(key: string): number {
  const hit = store.get(key)
  return hit ? Math.max(0, hit.expires - Date.now()) : 0
}

// ── Answers an admin waits for ──────────────────────────────────────────────


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

/** Test seam: forget every cached GitHub value, answer and reported problem, and the request budget's count. */
export function clearGhCache() {
  store.clear()
  inflight.clear()
  answers.clear()
  answerLoads.clear()
  reported.clear()
  shared.budget = freshBudget()
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
