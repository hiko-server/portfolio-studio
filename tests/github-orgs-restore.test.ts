/**
 * Restoring a home version brings its GitHub sources with it: a restore
 * that changes the organizations (or the linked profile) loads their
 * repository lists before the pages regenerate, from Admin → Versions
 * (POST /api/versions?type=home) as from the Home editor's own restore
 * (POST /api/home) — and the MongoDB backup restore (pages/api/mongo, which
 * needs a database to run) is wired the same way. Against a stubbed GitHub
 * in a throw-away content store; synthetic names only.
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import jwt from 'jsonwebtoken'

import type { HomeData } from '../lib/homeShape'
import { offlinePublicCalendar } from './offlineCalendar'

for (const k of ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'CF_ZONE_ID', 'CF_API_TOKEN', 'INDEXNOW_KEY']) delete process.env[k]
process.env.LOG_LEVEL = 'error'
const SECRET = 'github-orgs-restore-secret'
process.env.JWT_SECRET = SECRET

const USER = 'example-person'
const repoRoot = process.cwd()
const originalFetch = globalThis.fetch
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'github-orgs-restore-'))
type Handler = (req: any, res: any) => unknown
let versions: Handler
let homeApi: Handler
let gh: typeof import('../lib/github')
let homeStore: typeof import('../lib/home')
let closeDb: () => void
let restoreCalendar: () => void = () => undefined

/** What happened, in order: GitHub requests ("fetch /path") and page regenerations ("revalidate /path"). */
let events: string[] = []

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const repo = (owner: string, name: string) => ({
  id: name.length + owner.length,
  name,
  full_name: `${owner}/${name}`,
  html_url: `https://github.com/${owner}/${name}`,
  description: null,
  stargazers_count: 1,
  forks_count: 0,
  language: null,
  updated_at: '2026-10-01T00:00:00Z',
  pushed_at: '2026-10-01T00:00:00Z',
  fork: false,
  private: false,
  visibility: 'public',
  owner: { login: owner },
})
const GITHUB: Record<string, () => Response> = {
  [`/users/${USER}/repos`]: () => json([repo(USER, 'site')]),
  [`/users/${USER}`]: () => json({ login: USER, followers: 1 }),
  [`/users/${USER}/events/public`]: () => json([]),
  '/orgs/example-org/repos': () => json([repo('example-org', 'engine')]),
  '/orgs/example-lab/repos': () => json([repo('example-lab', 'notebook')]),
}

const home = (orgs: string[]): HomeData =>
  ({ hero: {}, socials: { github: `https://github.com/${USER}` }, brands: [], quickAccess: [], openSource: { orgs } }) as unknown as HomeData

async function call(handler: Handler, opts: { method?: string; query?: Record<string, string>; body?: unknown }) {
  const token = jwt.sign({ role: 'admin', email: 'owner@example.test' }, SECRET, { algorithm: 'HS256' })
  const out = { statusCode: 200, headers: {} as Record<string, string>, body: undefined as any }
  const res: any = {
    get statusCode() {
      return out.statusCode
    },
    set statusCode(c: number) {
      out.statusCode = c
    },
    status(c: number) {
      out.statusCode = c
      return res
    },
    setHeader(n: string, v: unknown) {
      out.headers[n.toLowerCase()] = String(v)
      return res
    },
    getHeader: (n: string) => out.headers[n.toLowerCase()],
    json(b: unknown) {
      out.body = JSON.parse(JSON.stringify(b))
      return res
    },
    send(b: unknown) {
      out.body = b
      return res
    },
    end(payload?: string) {
      if (typeof payload === 'string' && /json/.test(out.headers['content-type'] || '')) out.body = JSON.parse(payload)
      return res
    },
    async revalidate(p: string) {
      events.push(`revalidate ${p}`)
    },
  }
  const req = {
    method: opts.method || 'GET',
    query: opts.query || {},
    body: opts.body,
    cookies: { cv_admin_token: token },
    headers: { cookie: `cv_admin_token=${token}` },
    socket: { remoteAddress: '127.0.0.1' },
  }
  await handler(req, res)
  return out
}

before(async () => {
  process.chdir(tmp)
  fs.mkdirSync(path.join(tmp, 'data'), { recursive: true })
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    assert.equal(url.host, 'api.github.com')
    events.push(`fetch ${url.pathname}`)
    return (GITHUB[url.pathname] || (() => json({ message: 'Not Found' }, 404)))()
  }) as typeof fetch
  restoreCalendar = offlinePublicCalendar()
  gh = await import('../lib/github')
  homeStore = await import('../lib/home')
  versions = (await import('../pages/api/versions')).default
  homeApi = (await import('../pages/api/home')).default
  closeDb = (await import('../lib/db')).closeDb
})

after(() => {
  globalThis.fetch = originalFetch
  restoreCalendar()
  closeDb()
  process.chdir(repoRoot)
  fs.rmSync(tmp, { recursive: true, force: true })
})

beforeEach(() => {
  gh.clearGhCache()
  events = []
})

/** A snapshot of a home with `orgs`, then the live home switched to `live`. */
async function snapshotThenSwitch(orgs: string[], live: string[]): Promise<string> {
  assert.ok((await homeStore.writeHome(home(orgs))).ok)
  const file = homeStore.saveHomeSnapshot()
  assert.ok((await homeStore.writeHome(home(live))).ok)
  return file
}

function assertLoadedBeforeRegenerated(list: string) {
  const loaded = events.indexOf(`fetch ${list}`)
  const regenerated = events.findIndex((e) => e.startsWith('revalidate '))
  assert.ok(loaded >= 0, `${list} was loaded (${events.join(', ')})`)
  assert.ok(regenerated > loaded, `before the pages regenerate (${events.join(', ')})`)
}

test('Admin → Versions: restoring a home version with another organization loads its list before the pages regenerate', async () => {
  const file = await snapshotThenSwitch(['example-org'], ['example-lab'])
  events = []
  const out = await call(versions, { method: 'POST', query: { type: 'home' }, body: { action: 'restore', filename: file } })
  assert.equal(out.statusCode, 200, JSON.stringify(out.body))
  assert.deepEqual(homeStore.readHome()?.openSource?.orgs, ['example-org'])
  assertLoadedBeforeRegenerated('/orgs/example-org/repos')
  assert.ok(!events.includes('fetch /orgs/example-lab/repos'), 'the organization no longer listed is not loaded')
})

test('Admin → Versions: a restore that leaves the GitHub sources as they are loads nothing', async () => {
  const file = await snapshotThenSwitch(['example-org'], ['EXAMPLE-ORG'])
  events = []
  const out = await call(versions, { method: 'POST', query: { type: 'home' }, body: { action: 'restore', filename: file } })
  assert.equal(out.statusCode, 200)
  assert.deepEqual(events.filter((e) => e.startsWith('fetch ')), [])
  assert.ok(events.some((e) => e.startsWith('revalidate ')))
})

test('the Home editor restore (POST /api/home) does the same', async () => {
  const file = await snapshotThenSwitch(['example-lab'], [])
  events = []
  const out = await call(homeApi, { method: 'POST', body: { action: 'restore', filename: file } })
  assert.equal(out.statusCode, 200, JSON.stringify(out.body))
  assertLoadedBeforeRegenerated('/orgs/example-lab/repos')
})

test('the MongoDB restore refreshes the GitHub data of a restored home before it regenerates the pages', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'pages/api/mongo.ts'), 'utf8')
  const before = src.indexOf('homeBefore = readHome()')
  const write = src.indexOf('note(await writeHome(doc.home))')
  const refresh = src.indexOf('await refreshGithubData(homeBefore, homeAfter)')
  const regenerate = src.indexOf('await revalidatePaths(res, [...STATIC_CONTENT_PATHS, ...restoredPaths])')
  assert.ok(before > 0 && before < write, 'the home document is read before the restore writes it')
  assert.ok(refresh > write && refresh < regenerate, 'its GitHub sources load before the pages regenerate')
})
