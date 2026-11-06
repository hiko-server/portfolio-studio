/**
 * The owner's GitHub organizations (home.openSource.orgs) in the server
 * loaders (lib/githubData) against a stubbed GitHub: the personal and
 * organization repository lists merged (forks, dot-named, private and
 * internal repositories left out; de-duplicated by full name), one
 * organization failing (404, 403, network) without taking the widgets
 * down, featured resolution with a personal and an organization
 * repository of the same name, stats, languages and the activity fallback
 * over both, derived values following the organization list without a
 * TTL, the save-time refresh and the hourly request budget of the TTLs.
 * Synthetic names only; GitHub is never contacted (fetch is stubbed).
 * Runs in a throw-away working directory, so the content store is an
 * empty temp database.
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { HOME_LIMITS, type HomeData } from '../lib/homeShape'
import { findFeatured, orderRepos } from '../components/Common/githubEvents'

for (const k of ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'CF_ZONE_ID', 'CF_API_TOKEN']) delete process.env[k]
process.env.LOG_LEVEL = 'error'

const USER = 'example-person'
const MIN = 60_000
const HOUR = 60 * MIN

const originalCwd = process.cwd()
const originalFetch = globalThis.fetch
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'github-orgs-'))
let gh: typeof import('../lib/github')
let data: typeof import('../lib/githubData')
let db: typeof import('../lib/db')

type Route = (url: URL) => Response | Promise<Response>
let routes: Record<string, Route> = {}
/** Every requested URL (pathname + search) — all on api.github.com. */
let calls: string[] = []
let hosts = new Set<string>()

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

function stubFetch() {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    hosts.add(url.host)
    calls.push(url.pathname + url.search)
    const handler = routes[url.pathname]
    if (!handler) return json({ message: 'Not Found' }, 404)
    return handler(url)
  }) as typeof fetch
}

const paths = () => calls.map((c) => c.split('?')[0])

const repo = (owner: string, name: string, stars: number, extra: Record<string, unknown> = {}) => ({
  id: stars * 1000 + name.length + owner.length,
  name,
  full_name: `${owner}/${name}`,
  html_url: `https://github.com/${owner}/${name}`,
  description: `${name} by ${owner}`,
  stargazers_count: stars,
  forks_count: 0,
  language: 'TypeScript',
  updated_at: '2026-10-01T00:00:00Z',
  pushed_at: '2026-10-01T00:00:00Z',
  fork: false,
  archived: false,
  private: false,
  visibility: 'public',
  owner: { login: owner },
  ...extra,
})

const PERSONAL = [
  repo(USER, 'site', 5, { pushed_at: '2026-10-20T00:00:00Z' }),
  repo(USER, 'tool', 2, { language: 'Go', pushed_at: '2026-09-01T00:00:00Z' }),
  repo(USER, 'fork-of-x', 40, { fork: true }),
  repo(USER, '.github', 50),
]
const EXAMPLE_ORG = [
  repo('example-org', 'engine', 30, { language: 'Rust', pushed_at: '2026-10-25T00:00:00Z' }),
  repo('example-org', 'tool', 9, { pushed_at: '2026-08-01T00:00:00Z' }),
  repo('example-org', 'upstream-fork', 70, { fork: true }),
  repo('example-org', '.github', 60),
  repo('example-org', 'secret', 99, { private: true, visibility: 'private' }),
  repo('example-org', 'internal-thing', 98, { visibility: 'internal' }),
  repo('example-org', 'old', 1, { archived: true, language: null, pushed_at: '2020-01-01T00:00:00Z' }),
]
const EXAMPLE_LAB = [repo('example-lab', 'notebook', 4, { language: 'Python', pushed_at: '2026-07-01T00:00:00Z' })]

function github(extra: Record<string, Route> = {}): Record<string, Route> {
  return {
    [`/users/${USER}/repos`]: () => json(PERSONAL),
    [`/users/${USER}`]: () => json({ login: USER, public_repos: 4, followers: 7 }),
    [`/users/${USER}/events/public`]: () => json([]),
    '/orgs/example-org/repos': () => json(EXAMPLE_ORG),
    '/orgs/example-lab/repos': () => json(EXAMPLE_LAB),
    '/orgs/example-org': () => json({ login: 'example-org', name: 'Example Org', public_repos: 7, type: 'Organization' }),
    [`/repos/${USER}/site/languages`]: () => json({ TypeScript: 1000 }),
    [`/repos/${USER}/tool/languages`]: () => json({ Go: 400 }),
    '/repos/example-org/engine/languages': () => json({ Rust: 3000, Shell: 10 }),
    '/repos/example-org/tool/languages': () => json({ TypeScript: 500 }),
    '/repos/example-lab/notebook/languages': () => json({ Python: 700 }),
    ...extra,
  }
}

const home = (openSource: HomeData['openSource'] = {}): HomeData =>
  ({ hero: {}, socials: { github: `https://github.com/${USER}` }, brands: [], quickAccess: [], openSource }) as unknown as HomeData

before(async () => {
  process.chdir(tmp)
  fs.mkdirSync(path.join(tmp, 'data'), { recursive: true })
  db = await import('../lib/db')
  gh = await import('../lib/github')
  data = await import('../lib/githubData')
  stubFetch()
})

after(() => {
  globalThis.fetch = originalFetch
  db.closeDb()
  process.chdir(originalCwd)
  fs.rmSync(tmp, { recursive: true, force: true })
})

beforeEach(() => {
  gh.clearGhCache()
  calls = []
  hosts = new Set()
  routes = github()
})

test('githubOrgs: valid, de-duplicated, never the personal login, at most ten; sources vs. shown settings', () => {
  assert.deepEqual(data.githubOrgs(home({ orgs: ['example-org', 'EXAMPLE-ORG', 'Example-Person', 'bad name', 'example-lab'] }), USER), ['example-org', 'example-lab'])
  assert.deepEqual(data.githubOrgs(null, USER), [])
  assert.equal(data.githubOrgs(home({ orgs: Array.from({ length: 14 }, (_, i) => `org-${i}`) }), USER).length, 10)

  const a = home({ orgs: ['example-org'] })
  assert.equal(data.githubSourcesChanged(a, home({ orgs: ['EXAMPLE-ORG'] })), false, 'case only')
  assert.equal(data.githubSourcesChanged(a, home({ orgs: ['example-org', 'example-lab'] })), true)
  assert.equal(data.githubSourcesChanged(a, { ...a, socials: { github: 'https://github.com/someone-else' } }), true)
  assert.equal(data.githubSourcesChanged(a, home({ orgs: ['example-org'], featured: [{ name: 'tool' }] })), false)
  assert.equal(data.githubSettingsChanged(a, home({ orgs: ['example-org'], featured: [{ name: 'tool' }] })), true)
  assert.equal(data.githubSettingsChanged(a, home({ orgs: ['example-org'], showVanityStats: true })), true)
  assert.equal(data.githubSettingsChanged(a, { ...a, hero: { brand: 'changed' } } as HomeData), false)
})

// ── Featured resolution (pure) ───────────────────────────────────────────────

test('findFeatured: a plain name is the personal repository even when an organization has one of that name; owner/name is exact', () => {
  const repos = [
    { name: 'tool', full_name: 'example-org/tool', org: 'example-org', stargazers_count: 9 },
    { name: 'tool', full_name: `${USER}/tool`, stargazers_count: 2 },
    { name: 'engine', full_name: 'example-org/engine', org: 'example-org', stargazers_count: 30 },
    { name: 'engine', full_name: 'example-lab/engine', org: 'example-lab', stargazers_count: 1 },
  ]
  assert.equal(findFeatured(repos, 'tool')?.full_name, `${USER}/tool`)
  assert.equal(findFeatured(repos, 'TOOL')?.full_name, `${USER}/tool`)
  assert.equal(findFeatured(repos, 'example-org/tool')?.full_name, 'example-org/tool')
  assert.equal(findFeatured(repos, `${USER}/tool`)?.full_name, `${USER}/tool`)
  // No personal repository of that name: the first organization's (the owner's order).
  assert.equal(findFeatured(repos, 'engine')?.full_name, 'example-org/engine')
  assert.equal(findFeatured(repos, 'example-lab/engine')?.full_name, 'example-lab/engine')
  assert.equal(findFeatured(repos, 'example-lab/tool'), undefined)
  assert.equal(findFeatured(repos, ''), undefined)

  // In orderRepos: both "tool"s can be featured, each once, in the owner's order.
  const out = orderRepos(repos, [{ name: 'example-org/tool', blurb: 'The organization one.' }, { name: 'tool' }, { name: 'tool' }], 6)
  assert.deepEqual(
    out.map((r) => [r.full_name, r.featured]),
    [
      ['example-org/tool', true],
      [`${USER}/tool`, true],
      // The second plain "tool" finds no free personal one and takes the next free repository of that name: none left.
      ['example-org/engine', undefined],
      ['example-lab/engine', undefined],
    ],
  )
})

// ── Loaders ──────────────────────────────────────────────────────────────────

test('top repos merge the personal and organization lists: own work only, org-marked, featured plain name = the personal repository', async () => {
  const h = home({ orgs: ['example-org', 'example-lab'], featured: [{ name: 'tool', blurb: 'Mine.' }] })
  const top = await data.loadTopRepos(USER, h)
  assert.equal(top.available, true)
  assert.deepEqual(
    top.repos.map((r) => [r.full_name, r.org ?? null, r.featured ?? false]),
    [
      [`${USER}/tool`, null, true],
      ['example-org/engine', 'example-org', false],
      ['example-org/tool', 'example-org', false],
      [`${USER}/site`, null, false],
      ['example-lab/notebook', 'example-lab', false],
      ['example-org/old', 'example-org', false], // archived: still the owner's public work
    ],
  )
  assert.equal(top.repos[0].blurb, 'Mine.')
  for (const r of top.repos) {
    assert.equal('fork' in r, false)
    assert.equal('archived' in r, false)
    assert.equal('owner' in r, false)
  }
  // Each list fetched once, public repositories of the organization asked for, only api.github.com.
  assert.deepEqual(paths().sort(), ['/orgs/example-lab/repos', '/orgs/example-org/repos', `/users/${USER}/repos`].sort())
  assert.ok(calls.some((c) => c.startsWith('/orgs/example-org/repos?') && c.includes('type=public')))
  assert.deepEqual(Array.from(hosts), ['api.github.com'])

  // Featured owner/name picks the organization's "tool".
  const orgPick = await data.loadTopRepos(USER, home({ orgs: ['example-org'], featured: [{ name: 'example-org/tool' }] }))
  assert.equal(orgPick.repos[0].full_name, 'example-org/tool')
  assert.equal(orgPick.repos[0].featured, true)
})

test('repo choices (admin picker) list organization repositories with full_name and org, archived marked', async () => {
  const choices = await data.loadRepoChoices(USER, home({ orgs: ['example-org'] }))
  assert.equal(choices.available, true)
  assert.deepEqual(
    choices.repos.map((r) => r.full_name),
    ['example-org/engine', `${USER}/site`, `${USER}/tool`, 'example-org/tool', 'example-org/old'],
  )
  const engine = choices.repos[0]
  assert.equal(engine.org, 'example-org')
  assert.equal(engine.name, 'engine')
  assert.equal('org' in choices.repos[1], false)
  assert.equal(choices.repos[4].archived, true)
  assert.equal('archived' in choices.repos[0], false)
})

test('one organization failing (404, 403, network) is skipped; the personal list failing makes everything unavailable', async () => {
  routes = github({
    '/orgs/example-lab/repos': () => json({ message: 'Not Found' }, 404),
    '/orgs/example-gone/repos': () => json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0' }),
    '/orgs/example-down/repos': () => {
      throw new TypeError('fetch failed')
    },
  })
  const h = home({ orgs: ['example-org', 'example-lab', 'example-gone', 'example-down'] })
  const [top, stats, langs] = await Promise.all([data.loadTopRepos(USER, h), data.loadStats(USER, h), data.loadLanguages(USER, h)])
  assert.equal(top.available, true)
  assert.ok(top.repos.some((r) => r.org === 'example-org'))
  assert.ok(!top.repos.some((r) => r.org && r.org !== 'example-org'))
  assert.equal(stats.available, true)
  assert.equal(langs.available, true)

  // Within the TTL / the failure memo, no organization is asked again.
  calls = []
  await data.loadTopRepos(USER, h)
  assert.deepEqual(calls, [])

  // The personal list is the base: without it the widgets are unavailable, whatever the organizations do.
  gh.clearGhCache()
  routes = github({ [`/users/${USER}/repos`]: () => json({ message: 'boom' }, 500) })
  const down = await data.loadTopRepos(USER, home({ orgs: ['example-org'] }))
  assert.deepEqual(down, { repos: [], available: false })
  assert.equal((await data.loadStats(USER, home({ orgs: ['example-org'] }))).available, false)
})

test('an organization that loaded once keeps its last list when a refresh fails; failures wait MANY_FAILURE_TTL', async () => {
  const realNow = Date.now
  let clock = realNow()
  Date.now = () => clock
  try {
    const h = home({ orgs: ['example-org'] })
    assert.ok((await data.loadTopRepos(USER, h)).repos.some((r) => r.full_name === 'example-org/engine'))
    routes = github({ '/orgs/example-org/repos': () => json({ message: 'unavailable' }, 502) })
    clock += data.GH_TTL.orgRepos + 1
    // Stale-while-revalidate: the old list at once, the refresh fails in the background…
    assert.ok((await data.loadTopRepos(USER, h)).repos.some((r) => r.full_name === 'example-org/engine'))
    await new Promise((r) => setImmediate(r))
    // …and the last list is still served after it.
    assert.ok((await data.loadTopRepos(USER, h)).repos.some((r) => r.full_name === 'example-org/engine'))
    const failedAt = calls.filter((c) => c.startsWith('/orgs/example-org/repos')).length
    clock += 2 * MIN // past the default one-minute memo, inside the organization's
    await data.loadTopRepos(USER, h)
    await new Promise((r) => setImmediate(r))
    assert.equal(calls.filter((c) => c.startsWith('/orgs/example-org/repos')).length, failedAt, 'not retried every minute')
    clock += data.MANY_FAILURE_TTL
    await data.loadTopRepos(USER, h)
    await new Promise((r) => setImmediate(r))
    assert.equal(calls.filter((c) => c.startsWith('/orgs/example-org/repos')).length, failedAt + 1)
  } finally {
    Date.now = realNow
  }
})

test('de-duplication by full name: a repository repeated across pages or organizations listed twice counts once', async () => {
  routes = github({ '/orgs/example-org/repos': () => json([...EXAMPLE_ORG, EXAMPLE_ORG[0], { ...EXAMPLE_ORG[1], full_name: 'EXAMPLE-ORG/tool' }]) })
  const h = home({ orgs: ['example-org', 'Example-Org'] })
  const choices = await data.loadRepoChoices(USER, h)
  const names = choices.repos.map((r) => r.full_name.toLowerCase())
  assert.equal(names.length, new Set(names).size)
  assert.equal(calls.filter((c) => c.startsWith('/orgs/')).length, 1)
  const stats = await data.loadStats(USER, h)
  assert.equal(stats.public_repos, 5)
})

test('stats count the own work of the personal account and the organizations; languages include organization repositories', async () => {
  const h = home({ orgs: ['example-org', 'example-lab'], showVanityStats: true })
  const stats = await data.loadStats(USER, h)
  // site, tool | engine, tool, old | notebook — no forks, dot-named, private or internal repositories.
  assert.equal(stats.public_repos, 6)
  assert.equal(stats.total_stars, 5 + 2 + 30 + 9 + 1 + 4)
  assert.equal(stats.followers, 7)
  assert.equal(stats.showVanity, true)
  assert.equal(stats.available, true)

  const langs = await data.loadLanguages(USER, h)
  assert.deepEqual(langs, { total: 1000 + 400 + 3010 + 500 + 700, breakdown: { TypeScript: 1500, Go: 400, Rust: 3000, Shell: 10, Python: 700 }, available: true })
  assert.equal(stats.languages, 5)
  // A repository without a detected language has no code to count: not asked for.
  assert.ok(!calls.some((c) => c.includes('/old/languages')))
  assert.ok(!calls.some((c) => c.includes('fork') || c.includes('.github') || c.includes('secret') || c.includes('internal-thing')))
})

test('derived values follow the organization list at once; only the new list (and its languages) is fetched', async () => {
  const one = home({ orgs: ['example-org'] })
  await Promise.all([data.loadTopRepos(USER, one), data.loadLanguages(USER, one), data.loadStats(USER, one), data.loadEvents(USER, one)])
  assert.ok(!(await data.loadRepoChoices(USER, one)).repos.some((r) => r.org === 'example-lab'))

  calls = []
  const two = home({ orgs: ['example-org', 'example-lab'] })
  const [top, langs, stats, events] = await Promise.all([data.loadTopRepos(USER, two), data.loadLanguages(USER, two), data.loadStats(USER, two), data.loadEvents(USER, two)])
  assert.ok(top.repos.some((r) => r.full_name === 'example-lab/notebook'))
  assert.equal(langs.breakdown.Python, 700)
  assert.equal(stats.public_repos, 6)
  assert.ok(events.events.some((e) => e.repo?.name === 'example-lab/notebook'))
  assert.deepEqual(paths().sort(), ['/orgs/example-lab/repos', '/repos/example-lab/notebook/languages'])

  calls = []
  const none = home({})
  const [top0, stats0, langs0] = await Promise.all([data.loadTopRepos(USER, none), data.loadStats(USER, none), data.loadLanguages(USER, none)])
  assert.ok(top0.repos.every((r) => !r.org))
  assert.equal(stats0.public_repos, 2)
  assert.deepEqual(Object.keys(langs0.breakdown).sort(), ['Go', 'TypeScript'])
  assert.deepEqual(calls, [], 'removing organizations refetches nothing')
})

test('the activity fallback includes organization repositories (most recently pushed first)', async () => {
  const events = await data.loadEvents(USER, home({ orgs: ['example-org'] }))
  assert.equal(events.available, true)
  assert.deepEqual(
    events.events.map((e) => e.repo?.name),
    ['example-org/engine', `${USER}/site`, `${USER}/tool`, 'example-org/tool', 'example-org/old'],
  )
  // A feed that cannot be loaded falls back the same way; neither → unavailable.
  gh.clearGhCache()
  routes = github({ [`/users/${USER}/events/public`]: () => json({ message: 'down' }, 503) })
  assert.equal((await data.loadEvents(USER, home({ orgs: ['example-org'] }))).events[0].repo?.name, 'example-org/engine')
  gh.clearGhCache()
  routes = github({ [`/users/${USER}/events/public`]: () => json({}, 503), [`/users/${USER}/repos`]: () => json({}, 503) })
  assert.deepEqual(await data.loadEvents(USER, home({ orgs: ['example-org'] })), { events: [], available: false })
})

test('loadGithubSummary reads the organizations from the stored home document', async () => {
  const { writeHome } = await import('../lib/home')
  const saved = await writeHome(home({ orgs: ['example-org'] }))
  assert.ok(saved.ok)
  const summary = await data.loadGithubSummary(undefined, { budgetMs: 2000 })
  assert.ok(summary?.topRepos?.repos.some((r) => r.org === 'example-org'))
  assert.equal(summary?.stats?.public_repos, 5)
})

test('refreshGithubData: new sources are loaded before the pages regenerate; shown settings purge the edge answers; nothing else', async () => {
  const { writeHome } = await import('../lib/home')
  const before = home({ orgs: ['example-org'] })
  const after = home({ orgs: ['example-org', 'example-lab'] })
  assert.ok((await writeHome(after)).ok)
  assert.deepEqual(await data.refreshGithubData(before, after), { warmed: true, purged: true })
  assert.ok(paths().includes('/orgs/example-lab/repos'), 'the new organization was loaded')
  assert.deepEqual(data.GITHUB_API_PATHS, ['/api/github/stats', '/api/github/top-repos', '/api/github/languages', '/api/github/events'])

  calls = []
  assert.deepEqual(await data.refreshGithubData(after, home({ orgs: ['example-org', 'example-lab'], featured: [{ name: 'tool' }] })), { warmed: false, purged: true })
  assert.deepEqual(await data.refreshGithubData(after, { ...after, hero: { brand: 'x' } } as HomeData), { warmed: false, purged: false })
  assert.deepEqual(calls, [], 'no Cloudflare configuration: nothing is sent anywhere')
})

// ── Rate budget ──────────────────────────────────────────────────────────────

test('TTLs: the anonymous budget (60 requests / hour) holds with margin at ten organizations', () => {
  const { GH_TTL, LANGUAGE_REPOS, MANY_FAILURE_TTL, ORG_CHECKS_PER_HOUR } = data
  const orgs = HOME_LIMITS.orgsMax
  const perHour = (ttl: number) => HOUR / ttl
  // The table in lib/githubData's GH_TTL comment, line by line.
  const steady = perHour(GH_TTL.repos) + orgs * perHour(GH_TTL.orgRepos) + perHour(GH_TTL.events) + perHour(GH_TTL.profile) + LANGUAGE_REPOS * perHour(GH_TTL.languages)
  assert.equal(steady, 22.75)
  assert.ok(steady <= 60 * 0.4, 'steady state under 40 % of the anonymous budget')
  // A cold start loads everything once, plus the refreshes due within that first hour.
  const refreshesWithinHour = (ttl: number) => Math.max(0, Math.ceil(HOUR / ttl) - 1)
  const cold =
    1 + orgs + 1 + 1 + LANGUAGE_REPOS + refreshesWithinHour(GH_TTL.repos) + orgs * refreshesWithinHour(GH_TTL.orgRepos) + refreshesWithinHour(GH_TTL.events)
  assert.equal(cold, 51)
  assert.ok(cold < 60)
  // The admin check: a profile and (at most) the organization's first page per lookup.
  assert.ok(steady + 2 * ORG_CHECKS_PER_HOUR < 60)
  assert.equal(ORG_CHECKS_PER_HOUR, 10)
  // Entries that come in numbers are not retried every minute after a failure.
  assert.ok(MANY_FAILURE_TTL >= 10 * MIN)
  assert.ok(GH_TTL.orgRepos >= HOUR)
  assert.ok(GH_TTL.orgCheck >= HOUR && GH_TTL.orgCheckMissing <= 15 * MIN)
})

test('cachedGh failureTtlMs: a failure is memoised for the given time instead of a minute', async () => {
  const realNow = Date.now
  let clock = realNow()
  Date.now = () => clock
  try {
    let n = 0
    const failing = async (): Promise<string> => {
      n++
      throw new Error('down')
    }
    assert.equal(await gh.cachedGh('many', 1000, 'fallback', failing, { failureTtlMs: 10 * MIN }), 'fallback')
    clock += 2 * MIN
    assert.equal(await gh.cachedGh('many', 1000, 'fallback', failing, { failureTtlMs: 10 * MIN }), 'fallback')
    assert.equal(n, 1)
    clock += 9 * MIN
    await gh.cachedGh('many', 1000, 'fallback', failing, { failureTtlMs: 10 * MIN })
    assert.equal(n, 2)
  } finally {
    Date.now = realNow
  }
})

test('reportOnce: one report per failure episode', () => {
  const said: string[] = []
  const say = (what: string) => () => said.push(what)
  gh.reportOnce('org:example-org', 'missing', say('missing'))
  gh.reportOnce('org:example-org', 'missing', say('missing again'))
  gh.reportOnce('org:example-org', 'unavailable', say('unavailable'))
  gh.reportOnce('org:example-org', null, say('resolved'))
  gh.reportOnce('org:example-org', 'unavailable', say('unavailable again'))
  assert.deepEqual(said, ['missing', 'unavailable', 'unavailable again'])
})
