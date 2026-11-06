/**
 * Server-only GitHub loaders shared by the /api/github/* routes and the
 * pages that render GitHub data into their HTML (`loadGithubSummary`).
 *
 *   - The owner's repositories are the personal account's
 *     (GET /users/:u/repos) plus the public repositories of the GitHub
 *     organizations the owner chose in Admin (home.openSource.orgs;
 *     GET /orgs/:org/repos?type=public). Organizations are never added
 *     from memberships: only the owner knows which ones hold their work.
 *   - Each list is its own cache entry (`repos:<user>`, `org-repos:<org>`)
 *     feeding stats, top repos, languages, the activity fallback and the
 *     admin repo picker, so it is fetched once per TTL however many widgets
 *     need it, and adding or removing an organization never refetches the
 *     other lists. Languages are cached per repository for the same reason.
 *   - What is derived from the lists (the merged set, top repos, the stats
 *     totals, the language breakdown, the activity fallback) is computed on
 *     every call from those entries and is never cached itself: a saved
 *     change of the organizations or the featured list applies on the next
 *     render (the home save regenerates the pages), not after a TTL.
 *   - Every loader goes through lib/github `cachedGh` (TTL, in-flight
 *     sharing, stale-while-revalidate, stale-on-error) and never rejects:
 *     GitHub being down is data (`available: false`), not an exception. An
 *     organization that fails (renamed or deleted, forbidden, unreachable)
 *     is skipped and logged once while the others still show; only the
 *     personal list failing makes the widgets unavailable.
 *   - The GitHub login comes from the public home document's socials and
 *     the organizations from its openSource.orgs; both are validated
 *     (isGithubLogin) before they are put into a URL, and every URL is on
 *     api.github.com.
 */

import { HOME_LIMITS, type HomeData } from './homeShape'
import { GhUnavailable, cachedGh, extractGithubUser, ghFetch, ghGraphql, isGithubLogin, reportOnce } from './github'
import { readPublicHome } from './home'
import { log } from './log'
import { safeFetch } from './security/safeFetch'
import {
  buildCalendar,
  featuredList,
  orderRepos,
  type GhContributions,
  type GhEvent,
  type GhEventsPayload,
  type GhLanguages,
  type GhRepo,
  type GhRepoChoice,
  type GhStats,
  type GhTopRepos,
  type GithubSummary,
} from '../components/Common/githubEvents'

export type {
  ContributionDay,
  ContributionLevel,
  ContributionWeek,
  GhContributions,
  GhEvent,
  GhEventsPayload,
  GhLanguages,
  GhRepo,
  GhRepoChoice,
  GhStats,
  GhTopRepos,
  GithubSummary,
} from '../components/Common/githubEvents'

const SEC = 1000
const MIN = 60 * SEC

/**
 * How long each GitHub entry is fresh (lib/github cachedGh).
 *
 * Rate budget. Without GITHUB_TOKEN, GitHub's REST API allows 60 requests
 * per hour per IP (5000 with one). cachedGh serves a stale value while ONE
 * background refresh runs, so an entry costs at most one load per TTL while
 * the site has visitors, and nothing without. The hourly upper bound with
 * the maximum of 10 organizations (HOME_LIMITS.orgsMax), each list on one
 * page (≤ 100 repositories; tests/github-orgs.test.ts recomputes it):
 *
 *   personal repositories    60 / 15                   =  4
 *   organization lists       10 × 60 / 60              = 10
 *   events feed              60 / 10                   =  6
 *   profile (followers)      60 / 240                  =  0.25
 *   languages                30 repositories × 60 / 720 =  2.5
 *   ─────────────────────────────────────────────────────────────
 *   steady state                                       ≈ 22.75  (38 % of 60)
 *
 * A cold process (the first visit after a deploy) loads everything once —
 * 1 + 10 + 1 + 1 + 30 = 43 requests — and that first hour also sees the
 * refreshes due in it (3 personal, 5 events): 51, under 60. The
 * contribution calendar is not on api.github.com without a token (GraphQL
 * needs one). Failures of the entries that come in
 * numbers (organization lists, per-repository languages) are retried after
 * MANY_FAILURE_TTL, not every minute.
 */
export const GH_TTL = {
  repos: 15 * MIN,
  orgRepos: 60 * MIN,
  events: 10 * MIN,
  profile: 4 * 60 * MIN,
  languages: 12 * 60 * MIN,
  contributions: 60 * MIN,
} as const

/** Failure memo of the organization lists and per-repository languages (see GH_TTL). */
export const MANY_FAILURE_TTL = 10 * MIN

const API = 'https://api.github.com'
const TOP_REPOS = 6
/** Repositories whose languages are counted (the owner's most starred, then most recent). */
export const LANGUAGE_REPOS = 30
const LANGUAGE_CONCURRENCY = 8
/** Pages of 100 read per repository list (personal or organization). */
export const MAX_REPO_PAGES = 3
const MAX_EVENTS = 30
/** Default server-side budget for loadGithubSummary (below the pages' 1.5 s race). */
const SUMMARY_BUDGET_MS = 1200

const glog = log.child({ module: 'githubData' })

type RepoRecord = GhRepo & { fork: boolean; archived: boolean }

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/** Run a GitHub loader, logging (then rethrowing) its failure so cachedGh can memo it. */
async function logged<T>(what: string, user: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    glog.warn('GitHub data unavailable', { what, user, err })
    throw err
  }
}

/** At most `n` of these loads at a time, however many entries refresh at once (polite to the rate limit). */
function slots(n: number) {
  let active = 0
  const waiting: Array<() => void> = []
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active < n) active++
    else await new Promise<void>((resolve) => waiting.push(resolve)) // the finishing load hands its slot over
    try {
      return await fn()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else active--
    }
  }
}

// ── Context ──────────────────────────────────────────────────────────────────

export type GithubContext = { home: HomeData | null; user: string | null }

/** The public home document and the GitHub login it links (server-side; throws on a store failure). */
export function githubContext(): GithubContext {
  const home = readPublicHome()
  return { home, user: extractGithubUser(home?.socials?.github) }
}

/**
 * The organizations whose repositories count as the owner's
 * (home.openSource.orgs): valid logins only, the first spelling of names
 * that differ in case, never the personal login itself, at most
 * HOME_LIMITS.orgsMax — the stored list is validated on write, this keeps
 * an older or hand-edited document from reaching a URL.
 */
export function githubOrgs(home: HomeData | null | undefined, user?: string | null): string[] {
  const raw = home?.openSource?.orgs
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>(user ? [user.toLowerCase()] : [])
  const out: string[] = []
  for (const item of raw) {
    const login = typeof item === 'string' ? item.trim() : ''
    if (!isGithubLogin(login) || seen.has(login.toLowerCase())) continue
    seen.add(login.toLowerCase())
    out.push(login)
    if (out.length >= HOME_LIMITS.orgsMax) break
  }
  return out
}

/**
 * Whether a home save changed where the GitHub data comes from (the linked
 * profile or the organizations) — the lists to load are then new.
 */
export function githubSourcesChanged(before: HomeData | null | undefined, after: HomeData | null | undefined): boolean {
  const login = (h: HomeData | null | undefined) => (extractGithubUser(h?.socials?.github) || '').toLowerCase()
  const orgs = (h: HomeData | null | undefined) => githubOrgs(h, extractGithubUser(h?.socials?.github)).map((o) => o.toLowerCase()).join(',')
  return login(before) !== login(after) || orgs(before) !== orgs(after)
}

/**
 * Whether a home save changed anything the /api/github/* answers show: the
 * sources above, the featured list or the vanity-stats switch.
 */
export function githubSettingsChanged(before: HomeData | null | undefined, after: HomeData | null | undefined): boolean {
  const shown = (h: HomeData | null | undefined) =>
    JSON.stringify([featuredList(h?.openSource?.featured), h?.openSource?.showVanityStats === true])
  return githubSourcesChanged(before, after) || shown(before) !== shown(after)
}

// ── Repositories (shared) ────────────────────────────────────────────────────

function toRepo(r: Record<string, unknown>, org?: string): RepoRecord {
  const repo: RepoRecord = {
    id: num(r.id),
    name: str(r.name),
    full_name: str(r.full_name),
    html_url: str(r.html_url),
    description: typeof r.description === 'string' ? r.description : null,
    stargazers_count: num(r.stargazers_count),
    forks_count: num(r.forks_count),
    language: typeof r.language === 'string' ? r.language : null,
    updated_at: str(r.updated_at),
    pushed_at: str(r.pushed_at) || str(r.updated_at),
    fork: r.fork === true,
    archived: r.archived === true,
  }
  if (org) {
    const owner = str(obj(r.owner).login)
    repo.org = isGithubLogin(owner) ? owner : org
  }
  return repo
}

/** Public repositories only, whatever a token could see (a private or internal one never reaches a page). */
const isPublic = (r: Record<string, unknown>) => r.private !== true && (r.visibility === undefined || r.visibility === 'public')

/**
 * Up to MAX_REPO_PAGES pages of a repository list. null when the first page
 * is a 404 (no such account); any other failure of the first page throws
 * (GhUnavailable) and a later page that fails ends the list.
 */
async function fetchRepoList(firstUrl: string, org?: string): Promise<RepoRecord[] | null> {
  const out: RepoRecord[] = []
  for (let page = 1; page <= MAX_REPO_PAGES; page++) {
    const res = await ghFetch(`${firstUrl}&page=${page}`)
    if (!res.ok) {
      if (page === 1) {
        if (res.status === 404) return null
        throw new GhUnavailable(`repos ${res.status}`)
      }
      break
    }
    const list = (await res.json()) as unknown
    if (!Array.isArray(list)) throw new GhUnavailable('repos: unexpected body')
    for (const item of list) {
      const r = obj(item)
      if (isPublic(r)) out.push(toRepo(r, org))
    }
    if (list.length < 100) break
  }
  return out.filter((r) => r.name && r.full_name)
}

/** Every public repository of the personal account (cached, shared); null when GitHub is unavailable. */
function loadPersonalRepos(user: string): Promise<RepoRecord[] | null> {
  return cachedGh<RepoRecord[] | null>(`repos:${user}`, GH_TTL.repos, null, () =>
    logged('repos', user, async () => {
      const repos = await fetchRepoList(`${API}/users/${user}/repos?per_page=100&sort=updated`)
      if (!repos) throw new GhUnavailable('repos 404')
      return repos
    }),
  )
}

/** `missing`: GitHub answered 404 (renamed, deleted, or a personal account); `unavailable`: no answer yet. */
type OrgRepos = { state: 'ok' | 'missing' | 'unavailable'; repos: RepoRecord[] }

/**
 * The public repositories of one of the owner's organizations — its own
 * cache entry, so changing the list of organizations refetches nothing
 * else. A 404 is an answer (kept for the TTL like a list: an org is not
 * retried every minute); any other failure keeps the last list for up to a
 * day, else the organization is skipped. Problems are logged once per
 * episode.
 */
function loadOrgRepos(org: string): Promise<OrgRepos> {
  const key = org.toLowerCase()
  return cachedGh<OrgRepos>(
    `org-repos:${key}`,
    GH_TTL.orgRepos,
    { state: 'unavailable', repos: [] },
    async () => {
      let repos: RepoRecord[] | null
      try {
        repos = await fetchRepoList(`${API}/orgs/${org}/repos?type=public&per_page=100&sort=updated`, org)
      } catch (err) {
        reportOnce(`org:${key}`, 'unavailable', () => glog.warn('GitHub organization repositories unavailable; skipped until they load', { org, err }))
        throw err
      }
      if (!repos) {
        reportOnce(`org:${key}`, 'missing', () => glog.warn('GitHub organization not found (renamed or deleted?); its repositories are skipped', { org }))
        return { state: 'missing', repos: [] }
      }
      reportOnce(`org:${key}`, null, () => undefined)
      return { state: 'ok', repos }
    },
    { failureTtlMs: MANY_FAILURE_TTL },
  )
}

/**
 * The owner's repositories: the personal account's, then each
 * organization's in the owner's order, one entry per full name (GitHub's
 * paging can repeat one). null when the personal list is unavailable; an
 * organization that is not available is left out.
 */
async function loadRepoSet(user: string, orgs: readonly string[]): Promise<RepoRecord[] | null> {
  const [personal, ...lists] = await Promise.all([loadPersonalRepos(user), ...orgs.map(loadOrgRepos)])
  if (!personal) return null
  const seen = new Set<string>()
  const out: RepoRecord[] = []
  for (const r of [personal, ...lists.map((l) => l.repos)].flat()) {
    const key = r.full_name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(r)
  }
  return out
}

/**
 * The owner's own work: no forks, no dot-named repositories (.github and
 * the like). Archived repositories stay — they are still public work —
 * personal or organization alike; the fill order (stars, then recency)
 * decides whether one is shown.
 */
const ownWork = (repos: readonly RepoRecord[]) => repos.filter((r) => !r.fork && !r.name.startsWith('.'))

const publicRepo = ({ fork: _fork, archived: _archived, ...repo }: RepoRecord & { featured?: true; blurb?: string }): GhRepo => {
  void _fork
  void _archived
  return repo
}

/** Picker rows: the owner's own work, most recently pushed first. */
function repoChoices(repos: readonly RepoRecord[]): GhRepoChoice[] {
  return ownWork(repos)
    .sort((a, b) => Date.parse(b.pushed_at || '') - Date.parse(a.pushed_at || '') || a.full_name.localeCompare(b.full_name))
    .map((r) => ({
      name: r.name,
      full_name: r.full_name,
      ...(r.org ? { org: r.org } : {}),
      ...(r.archived ? { archived: true as const } : {}),
      description: r.description,
      language: r.language,
      stargazers_count: r.stargazers_count,
      pushed_at: r.pushed_at,
    }))
}

/** Featured repos first (home.openSource.featured), then by stars / recency, up to 6. */
export async function loadTopRepos(user: string, home: HomeData | null): Promise<GhTopRepos> {
  const repos = await loadRepoSet(user, githubOrgs(home, user))
  if (!repos) return { repos: [], available: false }
  const featured = featuredList(home?.openSource?.featured)
  return { repos: orderRepos(repos, featured, TOP_REPOS).map(publicRepo), available: true, asOf: Date.now() }
}

/**
 * All public non-fork repositories of the personal account and the owner's
 * organizations, most recently pushed first (admin featured-repo picker).
 */
export async function loadRepoChoices(user: string, home?: HomeData | null): Promise<{ repos: GhRepoChoice[]; available: boolean }> {
  const repos = await loadRepoSet(user, githubOrgs(home, user))
  if (!repos) return { repos: [], available: false }
  return { repos: repoChoices(repos), available: true }
}

// ── Languages ────────────────────────────────────────────────────────────────

const languageSlot = slots(LANGUAGE_CONCURRENCY)

/**
 * Bytes per language of one repository, cached per repository: a change of
 * the organizations only loads the repositories that are new. A 404 (gone
 * since the list was read) is an empty answer; any other failure is
 * retried after MANY_FAILURE_TTL (null meanwhile: that repository is left
 * out of the breakdown).
 */
function loadRepoLanguages(fullName: string): Promise<Record<string, number> | null> {
  return cachedGh<Record<string, number> | null>(
    `languages:${fullName.toLowerCase()}`,
    GH_TTL.languages,
    null,
    () =>
      languageSlot(async () => {
        const res = await ghFetch(`${API}/repos/${fullName.split('/').map(encodeURIComponent).join('/')}/languages`)
        if (res.status === 404) return {}
        if (!res.ok) throw new GhUnavailable(`languages ${res.status}`)
        const body = obj(await res.json())
        const out: Record<string, number> = {}
        for (const [k, v] of Object.entries(body)) if (num(v) > 0) out[k] = num(v)
        return out
      }),
    { failureTtlMs: MANY_FAILURE_TTL },
  )
}

/**
 * Bytes per language across the owner's LANGUAGE_REPOS most starred (then
 * most recent) repositories of their own work — personal and
 * organization. Repositories without a detected language have no code to
 * count and are not asked for.
 */
export async function loadLanguages(user: string, home?: HomeData | null): Promise<GhLanguages> {
  const repos = await loadRepoSet(user, githubOrgs(home, user))
  if (!repos) return { total: 0, breakdown: {}, available: false }
  const chosen = ownWork(repos)
    .filter((r) => r.language)
    .sort((a, b) => b.stargazers_count - a.stargazers_count || Date.parse(b.updated_at) - Date.parse(a.updated_at))
    .slice(0, LANGUAGE_REPOS)
  const breakdown: Record<string, number> = {}
  let total = 0
  for (const langs of await Promise.all(chosen.map((r) => loadRepoLanguages(r.full_name)))) {
    for (const [k, v] of Object.entries(langs || {})) {
      breakdown[k] = (breakdown[k] || 0) + v
      total += v
    }
  }
  return { total, breakdown, available: true }
}

// ── Events ───────────────────────────────────────────────────────────────────

type RawEvent = {
  id?: unknown
  type?: unknown
  created_at?: unknown
  repo?: { name?: unknown }
  payload?: Record<string, any>
}

/** Ship only what the feed renders (no actor / full payload blobs). */
function slimEvent(e: RawEvent): GhEvent {
  const p = e.payload || {}
  const repo = str(e.repo?.name)
  const number = typeof p.number === 'number' ? p.number : p.pull_request?.number
  const size = Array.isArray(p.commits) ? p.commits.length : p.size
  const issue = p.issue?.number
  const payload: NonNullable<GhEvent['payload']> = {}
  if (typeof p.action === 'string') payload.action = p.action
  if (typeof number === 'number') payload.number = number
  if (typeof p.ref_type === 'string') payload.ref_type = p.ref_type
  if (typeof size === 'number') payload.size = size
  if (typeof issue === 'number') payload.issue = { number: issue }
  return {
    id: String(e.id ?? ''),
    type: str(e.type),
    created_at: str(e.created_at),
    ...(repo ? { repo: { name: repo } } : {}),
    payload,
  }
}

/** The public events feed, slimmed (cached); null while it cannot be loaded (the last feed is kept for up to a day). */
function loadEventFeed(user: string): Promise<GhEvent[] | null> {
  return cachedGh<GhEvent[] | null>(`events:${user}`, GH_TTL.events, null, () =>
    logged('events', user, async () => {
      const res = await ghFetch(`${API}/users/${user}/events/public?per_page=${MAX_EVENTS}`)
      if (!res.ok) throw new GhUnavailable(`events ${res.status}`)
      const body = (await res.json()) as unknown
      return Array.isArray(body) ? (body as RawEvent[]).slice(0, MAX_EVENTS).map(slimEvent) : []
    }),
  )
}

/**
 * Recent public activity (the feed includes the owner's events in any
 * repository, organizations' too). GitHub's feed only goes back ~90 days:
 * without public activity in that window — or while the feed cannot be
 * loaded — the most recently pushed repositories of the owner's work
 * (personal and organization) stand in, so the section still says
 * something true. Unavailable only when neither can be loaded.
 */
export async function loadEvents(user: string, home?: HomeData | null): Promise<GhEventsPayload> {
  const feed = await loadEventFeed(user)
  if (feed?.length) return { events: feed, available: true, asOf: Date.now() }
  const repos = await loadRepoSet(user, githubOrgs(home, user))
  if (!repos) return feed ? { events: [], available: true, asOf: Date.now() } : { events: [], available: false }
  const events = ownWork(repos)
    .sort((a, b) => Date.parse(b.pushed_at) - Date.parse(a.pushed_at))
    .slice(0, 12)
    .map((r) => ({ id: `repo-${r.full_name}`, type: 'RepoUpdateEvent', created_at: r.pushed_at, repo: { name: r.full_name }, payload: {} }))
  return { events, available: true, asOf: Date.now() }
}

// ── Contribution calendar ────────────────────────────────────────────────────

const CALENDAR_QUERY = `query($login: String!) {
  user(login: $login) {
    contributionsCollection {
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount } }
      }
    }
  }
}`

type CalendarQuery = {
  user: {
    contributionsCollection: {
      contributionCalendar: {
        totalContributions: number
        weeks: Array<{ contributionDays: Array<{ date: string; contributionCount: number }> }>
      }
    }
  } | null
}

async function fetchContributions(user: string): Promise<GhContributions> {
  if (process.env.GITHUB_TOKEN) {
    try {
      const data = await ghGraphql<CalendarQuery>(CALENDAR_QUERY, { login: user })
      const cal = data.user?.contributionsCollection?.contributionCalendar
      if (!cal || !Array.isArray(cal.weeks)) throw new GhUnavailable('graphql: no calendar')
      const days = cal.weeks.flatMap((w) => (Array.isArray(w?.contributionDays) ? w.contributionDays : []))
      return buildCalendar(
        days.map((d) => ({ date: d.date, count: d.contributionCount })),
        cal.totalContributions,
      )
    } catch (err) {
      glog.warn('contribution calendar: GraphQL failed, using the public calendar', { user, err })
    }
  }
  // Public calendar (no token needed), fetched server-side so the CSP stays unchanged.
  const res = await safeFetch(`https://github-contributions-api.jogruber.de/v4/${user}?y=last`, {
    headers: { Accept: 'application/json', 'User-Agent': 'lucian-dev.com-site' },
    timeoutMs: 8000,
    maxBytes: 1_000_000,
  })
  if (res.status !== 200) throw new GhUnavailable(`public calendar ${res.status}`)
  const body = JSON.parse(res.body.toString('utf8')) as { total?: { lastYear?: unknown }; contributions?: unknown }
  const days = Array.isArray(body?.contributions) ? (body.contributions as Array<{ date: string; count: number }>) : []
  if (!days.length) throw new GhUnavailable('public calendar: no days')
  const total = typeof body.total?.lastYear === 'number' ? body.total.lastYear : undefined
  return buildCalendar(days, total)
}

export function loadContributions(user: string): Promise<GhContributions> {
  return cachedGh<GhContributions>(`contributions:${user}`, GH_TTL.contributions, { available: false }, () =>
    logged('contributions', user, () => fetchContributions(user)),
  )
}

// ── Stats ────────────────────────────────────────────────────────────────────

/** The personal account's follower count (GET /users/:u, cached); null when GitHub is unavailable. */
function loadProfile(user: string): Promise<{ followers: number } | null> {
  return cachedGh<{ followers: number } | null>(`profile:${user}`, GH_TTL.profile, null, () =>
    logged('profile', user, async () => {
      const res = await ghFetch(`${API}/users/${user}`)
      if (!res.ok) throw new GhUnavailable(`user ${res.status}`)
      return { followers: num(obj(await res.json()).followers) }
    }),
  )
}

/**
 * Stats tiles: public repos, contributions (last year) and language count,
 * plus followers / stars only when the owner opted in. Assembled on every
 * call from the cached parts, so toggling `showVanityStats` or changing the
 * organizations applies at once.
 *
 * `public_repos` and `total_stars` describe the same set as the rest of the
 * section — what a visitor can see and open: the public repositories of the
 * personal account and the owner's organizations that are the owner's own
 * work (no forks, no dot-named repositories; archived ones count). So the
 * count is not GitHub's profile figure, which includes forks and knows
 * nothing of the organizations, and the stars are those of the repositories
 * the section can show.
 */
export async function loadStats(user: string, home: HomeData | null): Promise<GhStats> {
  const [repos, profile, languages, contributions] = await Promise.all([
    loadRepoSet(user, githubOrgs(home, user)),
    loadProfile(user),
    loadLanguages(user, home),
    loadContributions(user),
  ])
  const extras = {
    languages: languages.available ? Object.keys(languages.breakdown).length : null,
    contributions: contributions.available && typeof contributions.total === 'number' ? contributions.total : null,
    showVanity: home?.openSource?.showVanityStats === true,
  }
  if (!repos || !profile) return { user, public_repos: 0, followers: 0, total_stars: 0, available: false, ...extras }
  const own = ownWork(repos)
  return {
    user,
    public_repos: own.length,
    followers: profile.followers,
    total_stars: own.reduce((sum, r) => sum + r.stargazers_count, 0),
    available: true,
    ...extras,
  }
}

// ── No profile linked ────────────────────────────────────────────────────────

/** What every widget gets when the home document links no GitHub profile (nothing is broken). */
export function noProfileSummary(): GithubSummary {
  return {
    stats: { user: '', public_repos: 0, followers: 0, total_stars: 0, languages: null, contributions: null, showVanity: false, available: true },
    topRepos: { repos: [], available: true },
    languages: { total: 0, breakdown: {}, available: true },
    events: { events: [], available: true },
    contributions: { available: false },
  }
}

// ── After a home change ──────────────────────────────────────────────────────

/** The public GitHub answers the edge may hold (their query-less URLs: what the widgets fetch). */
export const GITHUB_API_PATHS = ['/api/github/stats', '/api/github/top-repos', '/api/github/languages', '/api/github/events'] as const

/** How long a home save waits for new GitHub lists before the pages are regenerated. */
export const GITHUB_WARM_MS = 3000

/**
 * After the home document changed (a save or a restore), before its pages
 * are regenerated: when it changed where the GitHub data comes from (the
 * profile link or the organizations), load the new lists first — bounded by
 * `budgetMs`; what is not ready keeps loading and the widgets fetch it — so
 * the regenerated pages already show them; when it changed anything the
 * /api/github/* answers show, purge those from the edge (env-gated, fire
 * and forget). Never throws.
 */
export async function refreshGithubData(
  before: HomeData | null | undefined,
  after: HomeData | null | undefined,
  opts: { budgetMs?: number } = {},
): Promise<{ warmed: boolean; purged: boolean }> {
  const out = { warmed: false, purged: false }
  try {
    if (githubSourcesChanged(before, after)) {
      out.warmed = true
      await loadGithubSummary(undefined, { budgetMs: opts.budgetMs ?? GITHUB_WARM_MS })
    }
    if (githubSettingsChanged(before, after)) {
      out.purged = true
      const { purgeEdgeUrls } = await import('./revalidate')
      void purgeEdgeUrls(GITHUB_API_PATHS)
    }
  } catch (err) {
    glog.warn('GitHub refresh after a home change failed', { err })
  }
  return out
}

// ── Summary for server-rendered pages ────────────────────────────────────────

/**
 * Everything the GitHub widgets render, for getServerSideProps /
 * getStaticProps. Each part is raced against `budgetMs`: a part that is not
 * ready in time is `null` and that widget fetches it in the browser (the
 * load keeps running and warms the cache for the next render). `user`
 * defaults to the login linked from the public home document; with no
 * profile linked every widget gets its honest empty state.
 * Never throws: null when the store or the login cannot be read.
 */
export async function loadGithubSummary(user?: string, opts: { budgetMs?: number } = {}): Promise<GithubSummary | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    let ctx: GithubContext
    try {
      ctx = githubContext()
    } catch (err) {
      glog.warn('GitHub summary: home document unreadable', { err })
      if (user === undefined) return null
      ctx = { home: null, user: null }
    }
    const login = user ?? ctx.user
    if (!login) return user === undefined ? noProfileSummary() : null
    if (!isGithubLogin(login)) return null

    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), Math.max(0, opts.budgetMs ?? SUMMARY_BUDGET_MS))
    })
    const within = <T>(p: Promise<T>): Promise<T | null> => Promise.race([p, deadline])

    const [stats, topRepos, languages, events, contributions] = await Promise.all([
      within(loadStats(login, ctx.home)),
      within(loadTopRepos(login, ctx.home)),
      within(loadLanguages(login, ctx.home)),
      within(loadEvents(login, ctx.home)),
      within(loadContributions(login)),
    ])
    return { stats, topRepos, languages, events, contributions }
  } catch (err) {
    glog.warn('GitHub summary failed', { err })
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}
