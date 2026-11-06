/**
 * GET /api/admin/github-org — the admin Home editor's check of a GitHub
 * organization (lib/githubData checkGithubOrg) against a stubbed GitHub:
 * the session, GET only, the login validated before anything is fetched,
 * a confirmed organization with its own repositories from the shared list
 * entry, "not found" (a personal account included), GitHub's rate limits
 * and outages as answers, and the site-wide hourly cap on GitHub lookups
 * that answers in memory do not spend. Synthetic names only; GitHub is
 * never contacted (fetch is stubbed).
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import jwt from 'jsonwebtoken'

import type { HomeData } from '../lib/homeShape'

for (const k of ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'CF_ZONE_ID', 'CF_API_TOKEN']) delete process.env[k]
process.env.LOG_LEVEL = 'error'
const SECRET = 'github-org-check-test-secret'
process.env.JWT_SECRET = SECRET

const USER = 'example-person'
const MIN = 60_000
const HOUR = 60 * MIN

const originalCwd = process.cwd()
const originalFetch = globalThis.fetch
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'github-org-check-'))
let gh: typeof import('../lib/github')
let data: typeof import('../lib/githubData')
let db: typeof import('../lib/db')
let closeAuthDb: () => void
let route: (req: any, res: any) => unknown
let sessionId = ''

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
  route = (await import('../pages/api/admin/github-org')).default
  closeAuthDb = (await import('../lib/adminAuth/db')).closeAuthDb
  const { createSession } = await import('../lib/adminAuth/sessions')
  sessionId = createSession({ method: 'password', ttlMs: 3_600_000, device: null, ipPrefix: null, country: null }).id
  stubFetch()
})

after(() => {
  globalThis.fetch = originalFetch
  closeAuthDb()
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

// ── GET /api/admin/github-org ────────────────────────────────────────────────

async function check(login: unknown, { auth = true, method = 'GET', ip = '127.0.0.41' } = {}) {
  const token = jwt.sign({ role: 'admin', email: 'owner@example.test', sid: sessionId }, SECRET, { algorithm: 'HS256' })
  const out = { statusCode: 200, body: undefined as any, headers: {} as Record<string, string> }
  const res: any = {
    status(c: number) {
      out.statusCode = c
      return res
    },
    setHeader(k: string, v: unknown) {
      out.headers[k.toLowerCase()] = String(v)
      return res
    },
    getHeader: (k: string) => out.headers[k.toLowerCase()],
    json(b: unknown) {
      out.body = JSON.parse(JSON.stringify(b))
      return res
    },
    end() {
      return res
    },
  }
  const query = login === undefined ? {} : { login }
  const cookies = auth ? { cv_admin_token: token } : {}
  await route({ method, url: '/api/admin/github-org', query, body: undefined, cookies, headers: auth ? { cookie: `cv_admin_token=${token}` } : {}, socket: { remoteAddress: ip } }, res)
  return out
}

test('org check: session required, GET only, the login validated before anything is fetched', async () => {
  assert.equal((await check('example-org', { auth: false })).statusCode, 401)
  assert.equal((await check('example-org', { method: 'POST' })).statusCode, 405)
  for (const bad of ['', 'bad name', '-x', '../users/x', 'example-org/repos', 'x'.repeat(40), ['example-org'], undefined]) {
    const out = await check(bad)
    assert.equal(out.statusCode, 400, String(bad))
    assert.equal(out.body.state, 'invalid')
  }
  assert.deepEqual(calls, [])
})

test('org check: an organization → its name, count and own repositories (from the shared list entry), no-store', async () => {
  const out = await check('example-org')
  assert.equal(out.statusCode, 200)
  assert.equal(out.headers['cache-control'], 'no-store')
  assert.equal(out.body.state, 'ok')
  assert.deepEqual(out.body.org, { login: 'example-org', name: 'Example Org', publicRepos: 7, url: 'https://github.com/example-org' })
  assert.equal(out.body.reposAvailable, true)
  assert.deepEqual(
    out.body.repos.map((r: { full_name: string; org: string }) => [r.full_name, r.org]),
    [
      ['example-org/engine', 'example-org'],
      ['example-org/tool', 'example-org'],
      ['example-org/old', 'example-org'],
    ],
  )
  assert.deepEqual(paths().sort(), ['/orgs/example-org', '/orgs/example-org/repos'])
  assert.deepEqual(Array.from(hosts), ['api.github.com'])
  // Memoised: a second check, and then the widgets, ask GitHub nothing.
  calls = []
  assert.equal((await check('EXAMPLE-ORG')).body.state, 'ok')
  await data.loadTopRepos(USER, home({ orgs: ['example-org'] }))
  assert.deepEqual(paths(), [`/users/${USER}/repos`])
})

test('org check: not found (or a personal account), GitHub rate limit and GitHub unavailable are answers, not errors', async () => {
  routes = github({
    '/orgs/example-person': () => json({ message: 'Not Found' }, 404),
    '/orgs/example-limited': () => json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.ceil(Date.now() / 1000) + 600) }),
    '/orgs/example-secondary': () => json({ message: 'secondary rate limit' }, 403, { 'retry-after': '120' }),
    '/orgs/example-broken': () => json({ message: 'Server Error' }, 500),
    '/orgs/example-user': () => json({ login: 'example-user', type: 'User' }),
  })
  assert.deepEqual((await check('example-person')).body, { state: 'not-found', login: 'example-person' })
  assert.deepEqual((await check('example-user')).body, { state: 'not-found', login: 'example-user' })
  const limited = await check('example-limited')
  assert.equal(limited.statusCode, 200)
  assert.equal(limited.body.state, 'rate-limited')
  assert.ok(limited.body.retryAfter > 500 && limited.body.retryAfter <= 601)
  const secondary = await check('example-secondary')
  assert.equal(secondary.body.state, 'rate-limited')
  assert.ok(secondary.body.retryAfter > 100 && secondary.body.retryAfter <= 120)
  assert.deepEqual((await check('example-broken')).body, { state: 'unavailable', login: 'example-broken' })
  // Only the profile was asked for each; no repository list of a non-organization.
  assert.ok(paths().every((p) => !p.endsWith('/repos')))
})

test('org check: GitHub lookups are capped site-wide per hour; answers in memory cost nothing', async () => {
  const realNow = Date.now
  let clock = realNow() + 2 * HOUR // a fresh limiter window (and a session of that time)
  Date.now = () => clock
  const earlierSession = sessionId
  try {
    const { createSession } = await import('../lib/adminAuth/sessions')
    sessionId = createSession({ method: 'password', ttlMs: 3 * HOUR, device: null, ipPrefix: null, country: null }).id
    routes = github(
      Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`/orgs/example-org-${i}`, () => json({ message: 'Not Found' }, 404)])),
    )
    for (let i = 0; i < data.ORG_CHECKS_PER_HOUR; i++) {
      const out = await check(`example-org-${i}`, { ip: `127.0.0.${50 + i}` })
      assert.equal(out.statusCode, 200, `lookup ${i}`)
    }
    const refused = await check('example-org-11', { ip: '127.0.0.90' })
    assert.equal(refused.statusCode, 429)
    assert.equal(refused.body.state, 'rate-limited')
    assert.equal(refused.body.by, 'site')
    assert.ok(Number(refused.headers['retry-after']) > 0)
    assert.ok(!paths().includes('/orgs/example-org-11'), 'nothing fetched once refused')
    // Already answered: free.
    assert.equal((await check('example-org-3', { ip: '127.0.0.91' })).body.state, 'not-found')
    clock += HOUR
    assert.equal((await check('example-org-11', { ip: '127.0.0.92' })).statusCode, 200)
  } finally {
    Date.now = realNow
    sessionId = earlierSession
  }
})
