/**
 * Open source section of the Home editor, pure and unit tested: the
 * repositories the featured-repo picker offers (the personal account's
 * plus those of the organizations in the form), the answers of
 * GET /api/admin/github-org and what the editor says about each
 * organization.
 */

import { extractGithubUser, isGithubLogin } from '../../../lib/githubLogin'
import { HOME_LIMITS } from '../../../lib/homeShape'
import { findFeatured } from '../../Common/githubEvents'

/**
 * One repository of the personal account or an organization. `org` is ''
 * for a personal repository. Forks (and dot-named repositories) are never
 * offered, but a featured name can stand for one (resolveFeatured).
 */
export type RepoChoice = {
  name: string
  fullName: string
  org: string
  description: string
  language: string
  stars: number
  pushedAt: string
  archived: boolean
  fork: boolean
}

/** What the editor knows about one organization of the form. */
export type OrgCheckState =
  | { status: 'checking' }
  | { status: 'ok'; login: string; name: string | null; publicRepos: number; repos: RepoChoice[]; reposAvailable: boolean }
  | { status: 'not-found' }
  /** `by`: GitHub's rate limit, this site's hourly organization checks (429), or its GitHub request budget. */
  | { status: 'rate-limited'; retryAfter: number; by: 'github' | 'site' | 'budget' }
  | { status: 'unavailable'; retryAfter?: number }
  | { status: 'session' }
  | { status: 'error' }

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const text = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Rows of GET /api/github/top-repos?all=1 or of an organization check, defensively parsed. */
export function parseRepoChoices(list: unknown): RepoChoice[] {
  if (!Array.isArray(list)) return []
  return list
    .map(obj)
    .filter((r) => typeof r.name === 'string' && r.name)
    .map((r) => {
      const org = isGithubLogin(r.org) ? r.org : ''
      const name = String(r.name)
      const full = text(r.full_name)
      return {
        name,
        fullName: full.includes('/') ? full : org ? `${org}/${name}` : name,
        org,
        description: text(r.description),
        language: text(r.language),
        stars: typeof r.stargazers_count === 'number' ? r.stargazers_count : 0,
        pushedAt: text(r.pushed_at),
        archived: r.archived === true,
        fork: r.fork === true,
      }
    })
}

/** GET /api/github/top-repos?all=1 (an older server answered with a bare list). */
export function parseRepos(body: unknown): { repos: RepoChoice[]; available: boolean } {
  if (Array.isArray(body)) return { repos: parseRepoChoices(body), available: true }
  const b = obj(body)
  return { repos: parseRepoChoices(b.repos), available: b.available !== false }
}

/** An answer of GET /api/admin/github-org (HTTP status and JSON body). */
export function parseOrgCheck(status: number, body: unknown): OrgCheckState {
  const b = obj(body)
  if (status === 401) return { status: 'session' }
  const retryAfter = typeof b.retryAfter === 'number' && b.retryAfter > 0 ? Math.ceil(b.retryAfter) : 60
  if (status === 429) return { status: 'rate-limited', retryAfter, by: 'site' }
  if (status !== 200) return { status: 'error' }
  switch (b.state) {
    case 'ok': {
      const org = obj(b.org)
      const login = isGithubLogin(org.login) ? org.login : ''
      if (!login) return { status: 'error' }
      const name = text(org.name).trim()
      return {
        status: 'ok',
        login,
        name: name || null,
        publicRepos: typeof org.publicRepos === 'number' && org.publicRepos >= 0 ? org.publicRepos : 0,
        // Only that organization's own repositories, however the answer was made.
        repos: parseRepoChoices(b.repos).filter((r) => r.org.toLowerCase() === login.toLowerCase()),
        reposAvailable: b.reposAvailable !== false,
      }
    }
    case 'not-found':
      return { status: 'not-found' }
    case 'rate-limited':
      return { status: 'rate-limited', retryAfter, by: b.by === 'budget' ? 'budget' : 'github' }
    case 'unavailable':
      return typeof b.retryAfter === 'number' && b.retryAfter > 0 ? { status: 'unavailable', retryAfter } : { status: 'unavailable' }
    default:
      return { status: 'error' }
  }
}

/** Whether "Check again" can help (the answer was not GitHub's final word). */
export function canRecheck(state: OrgCheckState | undefined): boolean {
  return !!state && (state.status === 'rate-limited' || state.status === 'unavailable' || state.status === 'error')
}

/** "45 seconds", "a minute", "12 minutes". */
export function waitWords(seconds: number): string {
  const s = Math.max(1, Math.ceil(seconds))
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`
  const m = Math.ceil(s / 60)
  return m === 1 ? 'a minute' : `${m} minutes`
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** What the editor says about an organization, and whether it is a warning. */
export function orgCheckText(state: OrgCheckState | undefined): { text: string; warn: boolean } {
  switch (state?.status) {
    case undefined:
    case 'checking':
      return { text: 'Checking on GitHub…', warn: false }
    case 'ok': {
      const parts = [state.name, plural(state.publicRepos, 'public repository', 'public repositories')].filter(Boolean)
      if (!state.reposAvailable) parts.push('its repositories couldn’t be listed right now')
      return { text: parts.join(' · '), warn: !state.reposAvailable }
    }
    case 'not-found':
      return { text: 'GitHub has no organization with this name. Check the spelling — a personal account can’t be added here. Nothing from it is shown.', warn: true }
    case 'rate-limited': {
      const lead =
        state.by === 'site'
          ? 'Too many organization checks this hour.'
          : state.by === 'budget'
            ? 'This site has used its GitHub requests for the hour.'
            : 'GitHub’s rate limit is reached.'
      return { text: `${lead} Check again in ${waitWords(state.retryAfter)}; it stays in the list.`, warn: true }
    }
    case 'unavailable':
      return state.retryAfter
        ? { text: `Couldn’t reach GitHub to check it. It stays in the list; check again in ${waitWords(state.retryAfter)}.`, warn: true }
        : { text: 'Couldn’t reach GitHub to check it. It stays in the list; check again later.', warn: true }
    case 'session':
      return { text: 'Your session has expired. Sign in again to check it.', warn: true }
    default:
      return { text: 'Couldn’t check it right now.', warn: true }
  }
}

/**
 * The login an owner typed or pasted: "example-org", "@example-org" or a
 * github.com link to it. '' when it is none of those.
 */
export function orgFromInput(raw: string): string {
  const v = raw.trim().replace(/^@/, '')
  if (isGithubLogin(v)) return v
  const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\//i.test(v) ? (/^https?:/i.test(v) ? v : `https://${v}`) : ''
  return url ? extractGithubUser(url) || '' : ''
}

/** Why `raw` cannot be added to `orgs` (null: it can). */
export function orgInputProblem(raw: string, orgs: readonly string[], githubUser: string | null | undefined): string | null {
  if (!raw.trim()) return 'Enter the organization’s GitHub name.'
  const login = orgFromInput(raw)
  if (!login) return 'Enter a GitHub organization name: letters, digits and single hyphens, at most 39 characters.'
  if (githubUser && login.toLowerCase() === githubUser.toLowerCase()) return 'That is your personal account — its repositories are always included.'
  if (orgs.some((o) => o.toLowerCase() === login.toLowerCase())) return `${login} is already in the list.`
  if (orgs.length >= HOME_LIMITS.orgsMax) return `Up to ${HOME_LIMITS.orgsMax} organizations.`
  return null
}

const lower = (s: string) => s.toLowerCase()

/** What the picker offers: the owner's own work (no forks, no dot-named repositories), as the home page fills its cards. */
const offered = (r: RepoChoice) => !r.fork && !r.name.startsWith('.')

/**
 * Every repository of the form's sources in the home page's order
 * (lib/githubData loadRepoSet): the personal account's first, then each
 * organization of the form in the owner's order — from its check when that
 * answered, else from the saved list the server already merged in. Forks
 * included: this is what a featured name is resolved against. An
 * organization removed from the form is left out.
 */
export function sourceRepos(base: readonly RepoChoice[], orgs: readonly string[], checks: Readonly<Record<string, OrgCheckState | undefined>>): RepoChoice[] {
  const seen = new Set<string>()
  const out: RepoChoice[] = []
  const add = (r: RepoChoice) => {
    const key = lower(r.fullName)
    if (seen.has(key)) return
    seen.add(key)
    out.push(r)
  }
  for (const r of base) if (!r.org) add(r)
  for (const org of orgs) {
    const check = checks[lower(org)]
    if (check?.status === 'ok') check.repos.forEach(add)
    for (const r of base) if (r.org && lower(r.org) === lower(org)) add(r)
  }
  return out
}

/** The repositories the picker offers among `sources` (sourceRepos): the owner's own work, most recently pushed first. */
export function pickerRepos(sources: readonly RepoChoice[]): RepoChoice[] {
  const t = (r: RepoChoice) => {
    const v = Date.parse(r.pushedAt)
    return Number.isFinite(v) ? v : 0
  }
  return sources.filter(offered).sort((a, b) => t(b) - t(a) || a.fullName.localeCompare(b.fullName))
}

/** The picker's RepoChoice as findFeatured sees a repository. */
const asRepoLike = (r: RepoChoice) => ({ name: r.name, full_name: r.fullName, stargazers_count: r.stars, fork: r.fork, ...(r.org ? { org: r.org } : {}), choice: r })

/**
 * Which repository each featured name stands for, resolved exactly like
 * the home page does (findFeatured over `sources` in their order:
 * "owner/name" exactly; a plain name the personal repository first — a
 * fork too — then the first organization in the owner's order), by
 * featured item id. `sources` comes from sourceRepos.
 */
export function resolveFeatured(sources: readonly RepoChoice[], featured: ReadonlyArray<{ _id: string; name: string }>): Map<string, RepoChoice> {
  const like = sources.map(asRepoLike)
  const taken = new Set<(typeof like)[number]>()
  const out = new Map<string, RepoChoice>()
  for (const f of featured) {
    const hit = findFeatured(like, f.name, taken)
    if (!hit) continue
    taken.add(hit)
    out.set(f._id, hit.choice)
  }
  return out
}

/**
 * Why a featured name stands for nothing the home page can show: its
 * owner is neither the personal account nor an organization of the form
 * ("org" — e.g. the owner just removed that organization), or no
 * repository of the sources has that name ("missing").
 */
export function featuredGap(name: string, orgs: readonly string[], githubUser?: string | null): 'org' | 'missing' {
  const slash = name.indexOf('/')
  if (slash <= 0) return 'missing'
  const owner = lower(name.slice(0, slash))
  if (githubUser && lower(githubUser) === owner) return 'missing'
  return orgs.some((o) => lower(o) === owner) ? 'missing' : 'org'
}

/** What the picker stores for a repository: the plain name for a personal one, "org/name" for an organization's. */
export const featuredNameFor = (r: RepoChoice): string => (r.org ? r.fullName : r.name)

/**
 * Whether a typed name stands for a repository the picker lists (then it is
 * picked from the list instead): resolved among `sources` as the home page
 * would, so a plain name that means a personal fork can still be typed.
 */
export function namesListedRepo(sources: readonly RepoChoice[], name: string): boolean {
  const hit = findFeatured(sources.map(asRepoLike), name)
  return !!hit && offered(hit.choice)
}
