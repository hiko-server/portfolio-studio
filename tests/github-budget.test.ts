/**
 * The GitHub request budget (lib/github ghFetch, GH_BUDGET_SHARE) and the
 * TTLs of lib/githubData (GH_TTL): without a token GitHub allows 60 REST
 * requests an hour per IP, and the site must stay inside that with margin
 * in its worst hour, not on average. Unit checks of the admission rules,
 * then simulations on a fake clock against a stubbed GitHub that enforces
 * its own 60-an-hour limit: a visitor every minute for a day or two, ten
 * organizations (one page or three pages of repositories each), the owner
 * opening Admin → Home and adding organizations. Each run checks the
 * worst 60 minutes, that GitHub never had to refuse anything, and that the
 * data still arrives and stays fresh. Synthetic names only; GitHub is never
 * contacted (fetch is stubbed).
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { HOME_LIMITS, type HomeData } from '../lib/homeShape'
import { offlinePublicCalendar } from './offlineCalendar'

for (const k of ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'CF_ZONE_ID', 'CF_API_TOKEN']) delete process.env[k]
process.env.LOG_LEVEL = 'error'

const USER = 'example-person'
const MIN = 60_000
const HOUR = 60 * MIN

const originalCwd = process.cwd()
const originalFetch = globalThis.fetch
const realNow = Date.now
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'github-budget-'))
let gh: typeof import('../lib/github')
let data: typeof import('../lib/githubData')
let db: typeof import('../lib/db')
let restoreCalendar: () => void = () => undefined

let clock = 0

// ── A stubbed GitHub with its own limit ─────────────────────────────────────

type Repo = Record<string, unknown>
const repo = (owner: string, name: string, stars: number, pushedDaysAgo: number, extra: Repo = {}): Repo => ({
  id: stars * 10_000 + name.length * 100 + owner.length,
  name,
  full_name: `${owner}/${name}`,
  html_url: `https://github.com/${owner}/${name}`,
  description: null,
  stargazers_count: stars,
  forks_count: 0,
  language: 'TypeScript',
  updated_at: new Date(Date.UTC(2026, 9, 30) - pushedDaysAgo * 86_400_000).toISOString(),
  pushed_at: new Date(Date.UTC(2026, 9, 30) - pushedDaysAgo * 86_400_000).toISOString(),
  fork: false,
  archived: false,
  private: false,
  visibility: 'public',
  owner: { login: owner },
  ...extra,
})

type Github = {
  lists: Map<string, Repo[]>
  /** Clock time of every request GitHub received. */
  received: number[]
  byPath: Map<string, number[]>
  /** Requests GitHub refused because its own hourly limit was used up. */
  refused: number
}

let github: Github

/** `orgs` organizations of `perOrg` repositories each, `personal` personal ones; stars spread so the top 30 mix both. */
function makeGithub(orgs: string[], perOrg: number, personal = 12): Github {
  const lists = new Map<string, Repo[]>()
  lists.set(`/users/${USER}/repos`, [
    ...Array.from({ length: personal }, (_, i) => repo(USER, `tool-${i}`, 3 * i + 1, i)),
    repo(USER, 'a-fork', 500, 1, { fork: true }),
  ])
  orgs.forEach((org, o) => {
    lists.set(
      `/orgs/${org}/repos`,
      Array.from({ length: perOrg }, (_, i) => repo(org, `lib-${i}`, (3 * i + o) % 97, (i + o) % 300)),
    )
  })
  return { lists, received: [], byPath: new Map(), refused: 0 }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

function stubFetch() {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    assert.equal(url.host, 'api.github.com')
    const now = Date.now()
    // GitHub's limit: 60 in any hour for this IP (stricter than its fixed window).
    const lastHour = github.received.filter((t) => t > now - HOUR).length
    if (lastHour >= 60) {
      github.refused++
      return json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0' })
    }
    github.received.push(now)
    const times = github.byPath.get(url.pathname) ?? []
    times.push(now)
    github.byPath.set(url.pathname, times)

    const list = github.lists.get(url.pathname)
    if (list) {
      const page = Number(url.searchParams.get('page') || '1')
      return json(list.slice((page - 1) * 100, page * 100))
    }
    if (url.pathname === `/users/${USER}`) return json({ login: USER, followers: 3 })
    if (url.pathname === `/users/${USER}/events/public`) return json([{ id: '1', type: 'PushEvent', created_at: '2026-10-29T00:00:00Z', repo: { name: `${USER}/tool-1` }, payload: { size: 1 } }])
    const org = url.pathname.match(/^\/orgs\/([^/]+)$/)
    if (org && github.lists.has(`/orgs/${org[1]}/repos`)) return json({ login: org[1], name: `Example ${org[1]}`, public_repos: github.lists.get(`/orgs/${org[1]}/repos`)!.length, type: 'Organization' })
    const langs = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/languages$/)
    if (langs) return json({ TypeScript: 100 + langs[2].length, [langs[1] === USER ? 'Go' : 'Rust']: 10 })
    return json({ message: 'Not Found' }, 404)
  }) as typeof fetch
}

const home = (orgs: string[]): HomeData =>
  ({ hero: {}, socials: { github: `https://github.com/${USER}` }, brands: [], quickAccess: [], openSource: { orgs } }) as unknown as HomeData

const ORGS = Array.from({ length: HOME_LIMITS.orgsMax }, (_, i) => `example-org-${i}`)

before(async () => {
  process.chdir(tmp)
  fs.mkdirSync(path.join(tmp, 'data'), { recursive: true })
  db = await import('../lib/db')
  gh = await import('../lib/github')
  data = await import('../lib/githubData')
  stubFetch()
  restoreCalendar = offlinePublicCalendar()
})

after(() => {
  Date.now = realNow
  globalThis.fetch = originalFetch
  restoreCalendar()
  db.closeDb()
  process.chdir(originalCwd)
  fs.rmSync(tmp, { recursive: true, force: true })
})

beforeEach(() => {
  clock = Date.UTC(2026, 10, 1, 0, 0, 30)
  Date.now = () => clock
  gh.clearGhCache()
  github = makeGithub(ORGS, 20)
})

/** Let the background refreshes the last calls started finish (the stub answers at once). */
async function settle() {
  for (let i = 0; i < 12; i++) await new Promise((resolve) => setImmediate(resolve))
}

/** One visitor's page: every widget's loader, as loadGithubSummary runs them. */
async function visit(h: HomeData) {
  const [stats, top, langs, events] = await Promise.all([data.loadStats(USER, h), data.loadTopRepos(USER, h), data.loadLanguages(USER, h), data.loadEvents(USER, h)])
  await settle()
  return { stats, top, langs, events }
}

/** The most requests GitHub received in any 60 minutes. */
function worstHour(times: readonly number[]): number {
  let worst = 0
  let start = 0
  for (let end = 0; end < times.length; end++) {
    while (times[end] - times[start] >= HOUR) start++
    worst = Math.max(worst, end - start + 1)
  }
  return worst
}

/** The longest time between two loads of `pathname` after `from` (the staleness a visitor can see is at most this). */
function longestGap(pathname: string, from: number): number {
  const times = (github.byPath.get(pathname) ?? []).filter((t) => t >= from)
  let gap = 0
  for (let i = 1; i < times.length; i++) gap = Math.max(gap, times[i] - times[i - 1])
  return gap
}

// ── Admission rules ──────────────────────────────────────────────────────────

test('the budget: refreshes stop at half of GitHub’s limit, loads at three quarters, in any 60 minutes', async () => {
  assert.deepEqual(gh.GH_RATE_LIMIT, { anonymous: 60, token: 5000 })
  assert.equal(gh.ghCeiling('anonymous', 'refresh'), 30)
  assert.equal(gh.ghCeiling('anonymous', 'load'), 45)
  assert.equal(gh.ghCeiling('token', 'refresh'), 2500)
  assert.equal(gh.ghCeiling('token', 'load'), 3750)

  const url = 'https://api.github.com/users/example-person'
  const first = clock
  for (let i = 0; i < 30; i++) {
    await gh.ghFetch(url, { purpose: 'refresh' })
    clock += 10_000
  }
  const refused = await gh.ghFetch(url, { purpose: 'refresh' }).then(
    () => null,
    (err: unknown) => err,
  )
  if (!gh.isGhDeferred(refused)) return assert.fail('the 31st refresh of the hour is not sent')
  assert.equal(refused.retryAt, first + HOUR, 'room again when the oldest request leaves the window')
  for (let i = 0; i < 15; i++) await gh.ghFetch(url) // loads: up to 45
  await assert.rejects(gh.ghFetch(url), (err: unknown) => gh.isGhDeferred(err) && err.purpose === 'load')
  assert.equal(github.received.length, 45, 'nothing over the budget reached GitHub')
  assert.deepEqual(gh.ghBudgetState().sentLastHour, 45)

  clock = first + HOUR + 1
  await gh.ghFetch(url) // the first one left the window: room for one load (44 + 1)…
  await assert.rejects(gh.ghFetch(url, { purpose: 'refresh' }), (err: unknown) => gh.isGhDeferred(err)) // …not for a refresh
  clock = first + 30 * 10_000 + HOUR + 1
  await gh.ghFetch(url, { purpose: 'refresh' }) // the refreshes and loads of that hour have all left it
  assert.equal(github.received.length, 47)
})

test('GitHub’s own count wins when it is higher (something else shares the IP)', async () => {
  const reset = String(Math.ceil((clock + 20 * MIN) / 1000))
  let remaining = 23 // 37 used by something else before the first request
  globalThis.fetch = (async () => json({}, 200, { 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': String(--remaining), 'x-ratelimit-reset': reset })) as typeof fetch
  try {
    await gh.ghFetch('https://api.github.com/users/example-person') // GitHub: 38 used
    assert.equal(gh.ghBudgetState().githubRemaining, 22)
    await assert.rejects(gh.ghFetch('https://api.github.com/users/example-person', { purpose: 'refresh' }), (err: unknown) => gh.isGhDeferred(err) && err.retryAt === Number(reset) * 1000)
    for (let i = 0; i < 7; i++) await gh.ghFetch('https://api.github.com/users/example-person')
    // 45 used by GitHub's count: loads wait for its reset too.
    await assert.rejects(gh.ghFetch('https://api.github.com/users/example-person'), (err: unknown) => gh.isGhDeferred(err))
    clock = Number(reset) * 1000 + 1
    await gh.ghFetch('https://api.github.com/users/example-person', { purpose: 'refresh' })
  } finally {
    stubFetch()
  }
})

test('with a token the budget is the token’s (5000 an hour), and a rejected token falls back inside the anonymous one', async () => {
  process.env.GITHUB_TOKEN = 'test-token'
  let auth = 0
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const headers = (init?.headers || {}) as Record<string, string>
    if (headers.Authorization) auth++
    return json({})
  }) as typeof fetch
  try {
    for (let i = 0; i < 100; i++) await gh.ghFetch('https://api.github.com/users/example-person', { purpose: 'refresh' })
    assert.equal(auth, 100)
    assert.equal(gh.ghBudgetState().mode, 'token')
    globalThis.fetch = (async (_url: string, init?: RequestInit) => json({}, ((init?.headers || {}) as Record<string, string>).Authorization ? 401 : 200)) as typeof fetch
    await gh.ghFetch('https://api.github.com/users/example-person')
    assert.equal(gh.ghBudgetState().mode, 'anonymous')
    assert.equal(gh.ghBudgetState().sentLastHour, 1)
  } finally {
    delete process.env.GITHUB_TOKEN
    stubFetch()
  }
})

test('a refresh the budget defers keeps the last value, is not logged as a failure, and is tried again when there is room', async () => {
  let loads = 0
  const loader = async ({ purpose }: { purpose: 'refresh' | 'load' }) => {
    loads++
    await gh.ghFetch('https://api.github.com/users/example-person', { purpose })
    return `value ${loads}`
  }
  const get = () => gh.cachedGh('budget:key', 10 * MIN, 'fallback', loader, { failureTtlMs: 10 * MIN })
  const warn: unknown[] = []
  const realWarn = console.warn
  assert.equal(await get(), 'value 1')
  // Fill the refresh band with other requests, then let the entry go stale.
  const fullAt = clock
  for (let i = 0; i < 29; i++) await gh.ghFetch('https://api.github.com/users/example-person')
  clock += 11 * MIN
  console.warn = (...args: unknown[]) => void warn.push(args)
  try {
    assert.equal(await get(), 'value 1', 'the stale value at once')
    await settle()
  } finally {
    console.warn = realWarn
  }
  assert.equal(loads, 2, 'the refresh ran…')
  assert.equal(github.received.length, 30, '…and sent nothing')
  assert.deepEqual(warn, [], 'a deferral is not a failure')
  assert.equal(await get(), 'value 1', 'still the last value')
  assert.equal(loads, 2, 'memoised: not tried again on every call')
  // Once the requests of the full hour have left the window, the refresh goes out.
  clock = fullAt + HOUR + 1
  assert.equal(await get(), 'value 1')
  await settle()
  assert.equal(loads, 3)
  assert.equal(await get(), 'value 3')
})

// ── The TTLs: what the widgets need (an average, not a bound) ────────────────

test('GH_TTL: the average with ten organizations of one page is about 23 requests an hour, under the refresh band', () => {
  const { GH_TTL, LANGUAGE_REPOS, MANY_FAILURE_TTL, ORG_CHECKS_PER_HOUR } = data
  const perHour = (ttl: number) => HOUR / ttl
  // The table in lib/githubData's GH_TTL comment, line by line.
  const average = perHour(GH_TTL.repos) + HOME_LIMITS.orgsMax * perHour(GH_TTL.orgRepos) + perHour(GH_TTL.events) + perHour(GH_TTL.profile) + LANGUAGE_REPOS * perHour(GH_TTL.languages)
  assert.equal(average, 22.75)
  assert.ok(average < gh.ghCeiling('anonymous', 'refresh'), 'on average every refresh finds room')
  // A cold start loads everything at once: 1 + 10 + 1 + 1 + 30, inside the load band.
  assert.equal(1 + HOME_LIMITS.orgsMax + 1 + 1 + LANGUAGE_REPOS, 43)
  assert.ok(43 <= gh.ghCeiling('anonymous', 'load'))
  assert.equal(ORG_CHECKS_PER_HOUR, 10)
  assert.ok(MANY_FAILURE_TTL >= 10 * MIN)
  assert.ok(GH_TTL.orgRepos >= HOUR)
  assert.ok(GH_TTL.orgCheck >= HOUR && GH_TTL.orgCheckMissing <= 15 * MIN)
})

// ── Simulations: the worst hour ─────────────────────────────────────────────

test('ten organizations, a visitor a minute for 26 hours, the owner opening Admin → Home: never more than 45 in any hour', async () => {
  const h = home(ORGS)
  const start = clock
  for (let minute = 0; minute < 26 * 60; minute++) {
    const out = await visit(h)
    if (minute === 0) {
      // The cold start: the whole first page is there at once.
      assert.equal(out.top.available, true)
      assert.equal(out.langs.available, true)
      assert.ok(out.top.repos.some((r) => r.org))
    }
    // The owner opens the editor after the deploy and again later: every saved organization is checked.
    if (minute === 5 || minute === 12 * 60 + 2 || minute === 18 * 60) {
      for (const org of ORGS) {
        const check = await data.checkSavedGithubOrg(org)
        assert.equal(check.state, 'ok', org)
      }
      await settle()
    }
    // …and adds an organization (a GitHub lookup and its list).
    if (minute === 7 || minute === 12 * 60 + 5) {
      github.lists.set('/orgs/example-new/repos', [repo('example-new', 'fresh', 1, 0)])
      assert.equal((await data.checkGithubOrg('example-new')).state, 'ok')
      await settle()
    }
    clock += MIN
  }
  const worst = worstHour(github.received)
  assert.ok(worst <= 45, `worst hour ${worst}`)
  assert.equal(github.refused, 0, 'GitHub never had to refuse a request')
  // After the cold start, refreshes alone stay in their band; the owner's second addition (2 requests) may add to it.
  const warm = worstHour(github.received.filter((t) => t >= start + 2 * HOUR))
  assert.ok(warm <= gh.ghCeiling('anonymous', 'refresh') + 2, `worst warm hour ${warm}`)
  // Opening the editor asked GitHub nothing about the saved organizations.
  assert.ok(!Array.from(github.byPath.keys()).some((p) => /^\/orgs\/example-org-\d+$/.test(p)))
  // Fresh: after the first hour, the personal list and the feed are never much older than their TTLs.
  assert.ok(longestGap(`/users/${USER}/repos`, start + HOUR) <= 45 * MIN, `personal list gap ${longestGap(`/users/${USER}/repos`, start + HOUR) / MIN} min`)
  assert.ok(longestGap(`/users/${USER}/events/public`, start + HOUR) <= 45 * MIN)
  for (const org of ORGS) assert.ok(longestGap(`/orgs/${org}/repos`, start + HOUR) <= 2 * HOUR, org)
  // The 12-hour wave of the per-repository languages was spread over the next hours, and every one was refreshed.
  const languageLoads = Array.from(github.byPath.entries()).filter(([p]) => p.endsWith('/languages'))
  assert.equal(languageLoads.length, data.LANGUAGE_REPOS)
  const firstRefresh = new Set<number>()
  for (const [p, times] of languageLoads) {
    assert.ok(times.length >= 2, `${p} refreshed`)
    assert.ok(times[1] - times[0] <= data.GH_TTL.languages + 4 * HOUR, `${p} within four hours of its TTL`)
    firstRefresh.add(Math.floor((times[1] - start) / HOUR))
  }
  assert.ok(firstRefresh.size >= 2, 'not all in one hour')
  const final = await visit(h)
  assert.equal(final.langs.available, true)
  assert.equal(final.stats.public_repos, 12 + ORGS.length * 20)
})

test('ten organizations of 250 repositories (three pages each): the worst hour still holds, and every list arrives', async () => {
  github = makeGithub(ORGS, 250)
  const h = home(ORGS)
  let complete = -1
  for (let minute = 0; minute < 16 * 60; minute++) {
    const out = await visit(h)
    if (complete < 0 && out.stats.public_repos === 12 + ORGS.length * 250) complete = minute
    clock += MIN
  }
  const worst = worstHour(github.received)
  assert.ok(worst <= 45, `worst hour ${worst}`)
  assert.equal(github.refused, 0)
  // 3 + 30 + 1 + 1 + 30 = 65 requests do not fit one hour: the lists come first, the rest of the languages in the next hour.
  assert.ok(complete >= 0 && complete <= 2 * 60, `every list in ${complete} minutes`)
  const final = await visit(h)
  assert.equal(final.stats.public_repos, 12 + ORGS.length * 250)
  assert.equal(final.langs.available, true)
  assert.equal(Array.from(github.byPath.keys()).filter((p) => p.endsWith('/languages')).length, data.LANGUAGE_REPOS, 'every counted repository’s languages arrived')
  // Lists of three pages need more refreshes than the band allows: they are served older, never past their freshness by much.
  assert.ok(longestGap(`/users/${USER}/repos`, clock - 12 * HOUR) <= 75 * MIN)
  for (const org of ORGS) assert.ok(longestGap(`/orgs/${org}/repos`, clock - 12 * HOUR) <= 3 * HOUR, org)
})

test('a warm site: the owner adds ten organizations (one mistyped) and saves — the hour stays inside the budget', async () => {
  const before = home([])
  for (let minute = 0; minute < 3 * 60; minute++) {
    await visit(before)
    clock += MIN
  }
  // Ten checks for the new organizations (the eleventh, a typo, is not found) …
  for (const org of [...ORGS, 'example-typo']) {
    const check = await data.checkGithubOrg(org)
    assert.equal(check.state, org === 'example-typo' ? 'not-found' : 'ok', org)
  }
  await settle()
  // … then the save warms the new lists and the visitors carry on.
  const after = home(ORGS)
  for (let minute = 0; minute < 6 * 60; minute++) {
    await visit(after)
    clock += MIN
  }
  const worst = worstHour(github.received)
  assert.ok(worst <= 45, `worst hour ${worst}`)
  assert.equal(github.refused, 0)
  const final = await visit(after)
  assert.equal(final.stats.public_repos, 12 + ORGS.length * 20)
})
