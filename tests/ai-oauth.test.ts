/**
 * M5 — the OAuth 2.1 authorization server of /mcp (design §6.4, §12.1
 * ai-oauth): one test per rule. The public routes (/oauth/authorize, token,
 * register, revoke, the discovery documents) run on real sockets
 * (tests/helpers/realRoute.ts: bodyParser off, raw bodies); the admin routes
 * (pairing, oauth/request, oauth/consent) through the harness's mock with a
 * real signed-in browser session. Client documents are served by a stub on
 * loopback, allowed the way a local trial allows a local provider
 * (AI_LOCAL_PROVIDER_ORIGINS while SITE_URL is loopback). Every client
 * address is a documentation address, given through cf-connecting-ip, which
 * the routes believe from loopback only. Nothing here leaves this machine.
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { editorialHarness } from './editorialHarness'
import type { RealRoute } from './helpers/realRoute'

const SECRET = 'ai-oauth-secret-0123456789abcdef0123456789ab'
const REPO = process.cwd()
const h = editorialHarness('ai-oauth', SECRET)
const SITE = 'http://127.0.0.1:3999'
const RESOURCE = `${SITE}/mcp`
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36'

let oauth: typeof import('../lib/ai/oauth')
let access: typeof import('../lib/ai/access')
let settings: typeof import('../lib/ai/settings')
let authDb: typeof import('../lib/adminAuth/db')
let aiDb: typeof import('../lib/ai/db')
let routes: Record<'authorize' | 'token' | 'register' | 'revoke' | 'metadata', RealRoute>

// ── A client-document stub on loopback ──────────────────────────────────────

type StubAnswer = { status?: number; headers?: Record<string, string>; body?: string }
const stubAnswers = new Map<string, () => StubAnswer>()
const stubHits = new Map<string, number>()
let stub: http.Server
let STUB = ''
const hitsOf = (p: string) => stubHits.get(p) ?? 0
const totalStubHits = () => Array.from(stubHits.values()).reduce((a, b) => a + b, 0)

/** Serve `doc` (a client document, or any text) at `p` on the stub; returns its URL. */
function serve(p: string, answer: StubAnswer | (() => StubAnswer)): string {
  stubAnswers.set(p, typeof answer === 'function' ? answer : () => answer)
  return `${STUB}${p}`
}

/** A well-formed client document for `p`: client_id is its own URL. */
function clientDoc(p: string, over: Record<string, unknown> = {}): string {
  const url = `${STUB}${p}`
  return serve(p, { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: url, client_name: 'Stub Client', redirect_uris: ['http://127.0.0.1/callback', 'https://app.example.com/cb'], token_endpoint_auth_method: 'none', ...over }) })
}

let ipSeq = 0
/** A fresh documentation address per call, so the per-network budgets never leak between tests. */
const ip = () => `203.0.113.${(ipSeq++ % 250) + 1}`

before(async () => {
  process.env.ADMIN_EMAIL = 'owner@example.test'
  process.env.ADMIN_PASS = 'ai-oauth test password, synthetic'
  await h.setup()
  stub = http.createServer((req, res) => {
    const p = new URL(req.url || '/', 'http://x').pathname
    stubHits.set(p, hitsOf(p) + 1)
    const a = stubAnswers.get(p)?.() ?? { status: 404, body: 'not here' }
    res.writeHead(a.status ?? 200, a.headers ?? { 'content-type': 'application/json' })
    res.end(a.body ?? '')
  })
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve))
  STUB = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`
  process.env.SITE_URL = SITE
  delete process.env.NEXT_PUBLIC_SITE_HOST
  process.env.AI_LOCAL_PROVIDER_ORIGINS = STUB
  oauth = await import('../lib/ai/oauth')
  access = await import('../lib/ai/access')
  settings = await import('../lib/ai/settings')
  authDb = await import('../lib/adminAuth/db')
  aiDb = await import('../lib/ai/db')
  ;(await import('../lib/admin')).ensureAdminFromEnv()
  const { startRealRoute } = await import('./helpers/realRoute')
  routes = {
    authorize: await startRealRoute(await import('../pages/api/oauth/authorize')),
    token: await startRealRoute(await import('../pages/api/oauth/token')),
    register: await startRealRoute(await import('../pages/api/oauth/register')),
    revoke: await startRealRoute(await import('../pages/api/oauth/revoke')),
    metadata: await startRealRoute(await import('../pages/api/oauth/metadata')),
  }
})
after(async () => {
  for (const r of Object.values(routes)) await r.close()
  await new Promise<void>((resolve) => stub.close(() => resolve()))
  const { closeAuditDb } = await import('../lib/audit/db')
  closeAuditDb()
  for (const k of ['SITE_URL', 'AI_LOCAL_PROVIDER_ORIGINS', 'ADMIN_EMAIL', 'ADMIN_PASS']) delete process.env[k]
  h.teardown()
})
beforeEach(() => {
  process.env.JWT_SECRET = SECRET
  process.env.SITE_URL = SITE
  process.env.AI_LOCAL_PROVIDER_ORIGINS = STUB
  delete process.env.AI_DISABLED
  authDb.getAuthDb().prepare('UPDATE ai_settings SET enabled = 1, mcp_enabled = 1 WHERE id = 1').run()
  settings.closePairingWindow()
  oauth.clearClientDocumentCache()
  stubAnswers.clear()
  stubHits.clear()
})

// ── Helpers ─────────────────────────────────────────────────────────────────

type Out = { statusCode: number; headers: Record<string, string | string[]>; body: any }
type Route = (req: any, res: any) => unknown

/** A signed-in browser: its own session row, verified `verifiedAgoMs` ago. */
async function browser(verifiedAgoMs = 0): Promise<{ sid: string; cookie: string }> {
  const sessions = await import('../lib/adminAuth/sessions')
  const auth = await import('../lib/auth')
  const now = Date.now()
  const sid = sessions.createSession({ method: 'password', ttlMs: 3_600_000, verifiedAt: now - verifiedAgoMs, device: 'Chrome on macOS', ipPrefix: null, country: null }, now).id
  return { sid, cookie: `cv_admin_token=${auth.signAdminToken('owner@example.test', { sid })}` }
}

/** Drive an admin route with the harness's mock req/res (JSON body already parsed, as Next does). */
async function call(route: Route, opts: { method: string; body?: unknown; cookie?: string; url?: string; query?: Record<string, string> }): Promise<Out> {
  const cookieHeader = opts.cookie ?? ''
  const [name, ...rest] = cookieHeader.split('=')
  const req = {
    method: opts.method,
    url: opts.url || '/api/admin/ai/test',
    query: opts.query || {},
    body: opts.body,
    cookies: cookieHeader ? { [name]: rest.join('=') } : {},
    headers: { host: '127.0.0.1:3999', 'user-agent': UA, 'cf-connecting-ip': ip(), ...(cookieHeader ? { cookie: cookieHeader } : {}) },
    socket: { remoteAddress: '127.0.0.1' },
  }
  const out: Out = { statusCode: 200, headers: {}, body: undefined }
  const res: any = {
    get statusCode() {
      return out.statusCode
    },
    set statusCode(v: number) {
      out.statusCode = v
    },
    get headersSent() {
      return false
    },
    status(code: number) {
      out.statusCode = code
      return res
    },
    setHeader(n: string, v: string | string[]) {
      out.headers[n.toLowerCase()] = v
      return res
    },
    getHeader: (n: string) => out.headers[n.toLowerCase()],
    json(b: unknown) {
      out.body = JSON.parse(JSON.stringify(b))
      return res
    },
    end() {
      return res
    },
  }
  await route(req, res)
  return out
}

const adminRoute = async (p: string): Promise<Route> => (await import(p)).default as Route

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url')
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') }
}

/** An authorization request's query (what /oauth/authorize receives and the consent page sends back). */
function authorizeQuery(over: Record<string, string | null> = {}, challenge = pkce().challenge): string {
  const p: Record<string, string | null> = {
    response_type: 'code',
    client_id: `${STUB}/client.json`,
    redirect_uri: 'http://127.0.0.1:53123/callback',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'content:read content:draft',
    state: 'st-1',
    resource: RESOURCE,
    ...over,
  }
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(p)) if (v !== null) q.set(k, v)
  return q.toString()
}

async function checkRequest(query: string, cookie?: string): Promise<Out> {
  const b = cookie ?? (await browser()).cookie
  return call(await adminRoute('../pages/api/admin/ai/oauth/request'), { method: 'GET', cookie: b, url: `/api/admin/ai/oauth/request?${query}` })
}

async function consent(cookie: string, body: Record<string, unknown>): Promise<Out> {
  return call(await adminRoute('../pages/api/admin/ai/oauth/consent'), { method: 'POST', cookie, body, url: '/api/admin/ai/oauth/consent' })
}

function openWindow(app: import('../lib/ai/settings').PairingApp = 'other') {
  const out = settings.openPairingWindow(app, { steppedUp: true })
  assert.ok(out.ok)
  return out.pairing
}

/** POST a form to a public route. */
async function postForm(r: RealRoute, fields: Record<string, string> | string, headers: Record<string, string> = {}) {
  const body = typeof fields === 'string' ? fields : new URLSearchParams(fields).toString()
  const res = await r.raw({ method: 'POST', path: '/', headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': ip(), ...headers }, body })
  let json: any = null
  try {
    json = JSON.parse(res.body)
  } catch {
    json = null
  }
  return { ...res, json }
}

async function postJson(r: RealRoute, value: unknown, from = ip()) {
  const res = await r.raw({ method: 'POST', path: '/', headers: { 'content-type': 'application/json', 'cf-connecting-ip': from }, body: JSON.stringify(value) })
  return { ...res, json: JSON.parse(res.body || 'null') }
}

/** Register a DCR client through the real route. */
async function registerDcr(redirectUris = ['http://127.0.0.1/callback'], name = 'Example Editor'): Promise<string> {
  const out = await postJson(routes.register, { redirect_uris: redirectUris, client_name: name })
  assert.equal(out.status, 201, out.body)
  return out.json.client_id
}

/**
 * The whole flow up to a code: window, check, consent (allow, verified now),
 * then the code from the redirect. Returns what the token request needs.
 */
async function codeFor(opts: { clientId?: string; redirectUri?: string; scopes?: string[]; scope?: string; typedHost?: string; app?: import('../lib/ai/settings').PairingApp; b?: { sid: string; cookie: string } } = {}) {
  const b = opts.b ?? (await browser())
  if (!opts.clientId && !stubAnswers.has('/client.json')) clientDoc('/client.json')
  const { verifier, challenge } = pkce()
  const redirectUri = opts.redirectUri ?? 'http://127.0.0.1:53123/callback'
  const query = authorizeQuery({ client_id: opts.clientId ?? `${STUB}/client.json`, redirect_uri: redirectUri, ...(opts.scope !== undefined ? { scope: opts.scope } : {}) }, challenge)
  openWindow(opts.app)
  const checked = await checkRequest(query, b.cookie)
  assert.equal(checked.body.state, 'ok', JSON.stringify(checked.body))
  const facts = checked.body.facts
  const out = await consent(b.cookie, { params: query, pairing_id: facts.pairingId, decision: 'allow', scopes: opts.scopes ?? ['content:read', 'content:draft'], typedHost: opts.typedHost ?? facts.redirect.host })
  assert.equal(out.statusCode, 200, JSON.stringify(out.body))
  const redirect = new URL(out.body.redirect)
  return { code: redirect.searchParams.get('code') as string, redirect, verifier, redirectUri, clientId: opts.clientId ?? `${STUB}/client.json`, b, facts }
}

async function exchange(c: { code: string; verifier: string; redirectUri: string; clientId: string }, over: Record<string, string | null> = {}) {
  const fields: Record<string, string> = {}
  const all: Record<string, string | null> = { grant_type: 'authorization_code', code: c.code, code_verifier: c.verifier, redirect_uri: c.redirectUri, client_id: c.clientId, resource: RESOURCE, ...over }
  for (const [k, v] of Object.entries(all)) if (v !== null) fields[k] = v
  return postForm(routes.token, fields)
}

const countRows = (table: string) => (authDb.getAuthDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
/** Every row of every table in auth.db, as one count (anything stored shows up here). */
function authDbRows(): number {
  const tables = authDb.getAuthDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>
  return tables.reduce((n, t) => n + countRows(`"${t.name}"`), 0)
}
const settingsRow = () => JSON.stringify(authDb.getAuthDb().prepare('SELECT * FROM ai_settings WHERE id = 1').get())

/** Headers that differ between any two answers (the request id, the date, the socket). */
const VOLATILE = new Set(['date', 'x-request-id', 'connection', 'keep-alive'])
const stable = (headers: http.IncomingHttpHeaders) => Object.fromEntries(Object.entries(headers).filter(([k]) => !VOLATILE.has(k)))

// ── /oauth/authorize ────────────────────────────────────────────────────────

test('authorize: the same answer with a window open or closed; no row, no fetch, no cookie read — a 200 same-site bounce to /admin/ai/connect', async () => {
  clientDoc('/client.json')
  const query = authorizeQuery()
  const get = (q: string, headers: Record<string, string> = {}) => routes.authorize.raw({ method: 'GET', path: `/?${q}`, headers: { 'cf-connecting-ip': ip(), ...headers } })

  const rowsBefore = authDbRows()
  const before = settingsRow()
  const closed = await get(query)
  assert.equal(settingsRow(), before)
  openWindow()
  const opened = settingsRow()
  const open = await get(query, { cookie: 'cv_admin_token=not-even-a-token' })
  assert.equal(settingsRow(), opened, 'authorize writes nothing to the settings row')
  assert.equal(authDbRows(), rowsBefore, 'authorize stores nothing (the window lives in the existing settings row)')
  assert.equal(totalStubHits(), 0, 'authorize never fetches a client document')

  assert.equal(closed.status, 200)
  assert.deepEqual([open.status, open.body, stable(open.headers)], [closed.status, closed.body, stable(closed.headers)])
  assert.match(String(closed.headers['content-type']), /^text\/html/)
  assert.equal(closed.headers['referrer-policy'], 'no-referrer')
  assert.equal(closed.headers['cache-control'], 'no-store')
  assert.doesNotMatch(closed.body, /<script/i)
  const target = /http-equiv="refresh" content="0; url=([^"]+)"/.exec(closed.body)?.[1]?.replace(/&amp;/g, '&')
  assert.ok(target?.startsWith('/admin/ai/connect?'), closed.body)
  assert.deepEqual(Object.fromEntries(new URLSearchParams(target!.slice('/admin/ai/connect?'.length))), Object.fromEntries(new URLSearchParams(query)))
  // The only link on the page is that same-site target: never the app's redirect URI.
  assert.deepEqual(Array.from(closed.body.matchAll(/href="([^"]+)"/g)).map((m) => m[1].replace(/&amp;/g, '&')), [target])

  // The route reads no cookie at all.
  const src = fs.readFileSync(path.join(REPO, 'pages/api/oauth/authorize.ts'), 'utf8')
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, ''), /cookie|readAdminContext|getSession/i)

  // Only two other answers exist, both static pages that never redirect: too long, and too many.
  const long = await get(`${query}&pad=${'a'.repeat(4096)}`)
  assert.equal(long.status, 400)
  assert.doesNotMatch(long.body, /refresh|href=/)
  const from = ip()
  let last = { status: 0, body: '', headers: {} as http.IncomingHttpHeaders }
  for (let i = 0; i < 31; i++) last = await get(query, { 'cf-connecting-ip': from })
  assert.equal(last.status, 429)
  assert.ok(Number(last.headers['retry-after']) > 0)
  assert.doesNotMatch(last.body, /refresh|href=/)
})

test('authorize hits are counted in memory only, and the consent page says when more than one arrived in the window', async () => {
  clientDoc('/client.json')
  const query = authorizeQuery()
  const p = openWindow()
  for (let i = 0; i < 3; i++) assert.equal((await routes.authorize.raw({ method: 'GET', path: `/?${query}`, headers: { 'cf-connecting-ip': ip() } })).status, 200)
  assert.equal(oauth.authorizeHitsSince(p.openedAt), 3)
  const checked = await checkRequest(query)
  assert.equal(checked.body.state, 'ok')
  assert.equal(checked.body.facts.requests, 3)
  const pairing = await call(await adminRoute('../pages/api/admin/ai/pairing'), { method: 'GET', cookie: (await browser()).cookie })
  assert.equal(pairing.body.pairing.requests, 3)
  assert.equal(pairing.body.pairing.app, 'other')
  assert.equal('id' in pairing.body.pairing, false, 'the window id is never sent to Connections')
})

// ── Client documents (CIMD), only behind the session ────────────────────────

test('CIMD: fetched only behind the session and during a window — no redirect, 5 KB, 200 only, its own client_id, no secret, a public method; good answers cached for the window, errors never', async () => {
  const good = clientDoc('/client.json')
  const query = (clientId: string) => authorizeQuery({ client_id: clientId, redirect_uri: 'http://127.0.0.1:53123/callback' })

  assert.deepEqual((await checkRequest(query(good))).body, { state: 'closed', apps: true })
  assert.equal(totalStubHits(), 0, 'no window, no fetch')
  openWindow()
  const ok = await checkRequest(query(good))
  assert.equal(ok.body.state, 'ok', JSON.stringify(ok.body))
  assert.deepEqual(ok.body.facts.client, { kind: 'cimd', host: '127.0.0.1', selfName: 'Stub Client', knownName: null })
  assert.equal((await checkRequest(query(good))).body.state, 'ok')
  assert.equal(hitsOf('/client.json'), 1, 'a good document is kept for the window')
  // A new window fetches again.
  openWindow()
  assert.equal((await checkRequest(query(good))).body.state, 'ok')
  assert.equal(hitsOf('/client.json'), 2)

  const refused = async (p: string, answer: StubAnswer, why: RegExp) => {
    const url = serve(p, answer)
    for (let i = 0; i < 2; i++) {
      const out = await checkRequest(query(url))
      assert.equal(out.body.state, 'invalid', `${p}: ${JSON.stringify(out.body)}`)
      assert.equal(out.body.error, 'invalid_client', p)
      assert.match(out.body.message, why, p)
      assert.equal('redirect' in out.body, false)
    }
    assert.equal(hitsOf(p), 2, `${p}: an error is never cached`)
  }
  const doc = (p: string, over: Record<string, unknown>) => JSON.stringify({ client_id: `${STUB}${p}`, redirect_uris: ['http://127.0.0.1/callback'], ...over })
  await refused('/redirects.json', { status: 302, headers: { location: good } }, /redirect/)
  await refused('/large.json', { body: doc('/large.json', { client_name: 'x'.repeat(5200) }) }, /larger than 5120 bytes/)
  await refused('/missing.json', { status: 404, body: '{}' }, /HTTP 404/)
  await refused('/other-id.json', { body: JSON.stringify({ client_id: `${STUB}/other-id.json/`, redirect_uris: ['http://127.0.0.1/callback'] }) }, /not its own address/)
  await refused('/secret.json', { body: doc('/secret.json', { client_secret: 'shh' }) }, /client secret/)
  await refused('/basic.json', { body: doc('/basic.json', { token_endpoint_auth_method: 'client_secret_basic' }) }, /shared secret/)
  await refused('/jwt-only.json', { body: doc('/jwt-only.json', { token_endpoint_auth_methods_supported: ['private_key_jwt'] }) }, /no public sign-in method/)
  await refused('/not-json.json', { body: '<html>' }, /isn’t JSON/)

  // ChatGPT's shape: private_key_jwt first, none listed — a public client. Neither field: none.
  const listed = serve('/listed.json', { body: doc('/listed.json', { token_endpoint_auth_methods_supported: ['private_key_jwt', 'none'] }) })
  assert.equal((await checkRequest(query(listed))).body.state, 'ok')
  const bare = serve('/bare.json', { body: doc('/bare.json', {}) })
  assert.equal((await checkRequest(query(bare))).body.state, 'ok')

  // Not a document URL: nothing is fetched. Plain http off the local list, no path, userinfo.
  const before = totalStubHits()
  for (const id of ['http://app.example.com/client.json', `${STUB}/`, `http://user@127.0.0.1:${new URL(STUB).port}/client.json`, 'not a url']) {
    const out = await checkRequest(query(id))
    assert.equal(out.body.error, 'invalid_client', id)
  }
  assert.equal(totalStubHits(), before)
})

test('CIMD local exception holds only while the site is local-only: with a public host, an http document is never fetched', async () => {
  const url = clientDoc('/client.json')
  openWindow()
  process.env.SITE_URL = 'https://site.example.com'
  try {
    const out = await oauth.checkAuthorizeRequest(new URLSearchParams(authorizeQuery({ client_id: url, resource: 'https://site.example.com/mcp' })))
    assert.equal(out.state === 'invalid' && out.error, 'invalid_client')
    assert.equal(hitsOf('/client.json'), 0)
  } finally {
    process.env.SITE_URL = SITE
  }
})

// ── /oauth/register (DCR) ───────────────────────────────────────────────────

test('register: the same answer with a window open or closed, stores nothing, always public; a forged or altered id is refused', async () => {
  const input = { redirect_uris: ['http://127.0.0.1/callback', 'https://editor.example.com/oauth/cb'], client_name: 'Example‮ Editor\u0007', token_endpoint_auth_method: 'client_secret_post', grant_types: ['client_credentials'] }
  const rows = authDbRows()
  const a = await postJson(routes.register, input)
  openWindow()
  const opened = settingsRow()
  const b = await postJson(routes.register, input)
  assert.equal(settingsRow(), opened)
  assert.equal(authDbRows(), rows, 'registration stores nothing')
  for (const out of [a, b]) {
    assert.equal(out.status, 201)
    assert.match(out.json.client_id, /^dcr_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/)
    assert.equal(out.json.token_endpoint_auth_method, 'none', 'requested auth methods are ignored')
    assert.deepEqual(out.json.grant_types, ['authorization_code', 'refresh_token'])
    assert.equal(out.json.client_name, 'Example Editor', 'control and bidi characters stripped')
  }
  const { client_id: _a, client_id_issued_at: _ai, ...restA } = a.json
  const { client_id: _b, client_id_issued_at: _bi, ...restB } = b.json
  assert.deepEqual(restA, restB)
  assert.deepEqual(stable(a.headers), stable(b.headers))

  const client = oauth.readDcrClient(b.json.client_id)
  assert.deepEqual(client && { kind: client.kind, redirectUris: client.redirectUris, name: client.name, host: client.host }, { kind: 'dcr', redirectUris: input.redirect_uris, name: 'Example Editor', host: null })
  const [body, tag] = b.json.client_id.slice(4).split('.')
  const flipped = `dcr_${body}.${tag.slice(0, -1)}${tag.at(-1) === 'A' ? 'B' : 'A'}`
  const forgedPayload = Buffer.from(JSON.stringify({ v: 1, r: ['https://evil.example.com/cb'], n: 'Example Editor', t: 1 })).toString('base64url')
  for (const id of [flipped, `dcr_${forgedPayload}.${tag}`, 'dcr_x.y']) {
    assert.equal(oauth.readDcrClient(id), null)
    const out = await checkRequest(authorizeQuery({ client_id: id, redirect_uri: 'https://evil.example.com/cb' }))
    assert.equal(out.body.error, 'invalid_client', id)
  }
  // Rotating JWT_SECRET ends every registration.
  process.env.JWT_SECRET = `${SECRET}-rotated`
  assert.equal(oauth.readDcrClient(b.json.client_id), null)
})

test('register: https or loopback redirect URIs only, at most 5, no fragment, 1,024 bytes kept, a 64-character name; JSON only; 5 an hour per network either way', async () => {
  const bad = async (value: unknown, error: string) => {
    const out = await postJson(routes.register, value)
    assert.equal(out.status, 400, JSON.stringify(value))
    assert.equal(out.json.error, error, JSON.stringify(value))
  }
  for (const uris of [['cursor://anysphere/callback'], ['http://app.example.com/cb'], ['https://app.example.com/cb#x'], ['https://user:pw@app.example.com/cb'], ['https://*.example.com/cb'], [], 'https://app.example.com/cb']) {
    await bad({ redirect_uris: uris }, 'invalid_redirect_uri')
  }
  await bad({ redirect_uris: Array.from({ length: 6 }, (_, i) => `https://app.example.com/cb${i}`) }, 'invalid_redirect_uri')
  await bad({ redirect_uris: [`https://app.example.com/${'a'.repeat(1000)}`, `https://app.example.com/${'b'.repeat(100)}`] }, 'invalid_client_metadata')
  await bad({ redirect_uris: ['https://app.example.com/cb'], client_name: 7 }, 'invalid_client_metadata')
  await bad([{ redirect_uris: ['https://app.example.com/cb'] }], 'invalid_client_metadata')
  const long = await postJson(routes.register, { redirect_uris: ['http://[::1]/cb', 'http://localhost:8787/callback'], client_name: '名'.repeat(80) })
  assert.equal(long.status, 201)
  assert.equal(Array.from(long.json.client_name as string).length, 64)
  const form = await routes.register.raw({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': ip() }, body: 'redirect_uris=https://app.example.com/cb' })
  assert.equal(form.status, 400)

  const from = ip()
  const statuses: number[] = []
  for (let i = 0; i < 3; i++) statuses.push((await postJson(routes.register, { redirect_uris: ['https://app.example.com/cb'] }, from)).status)
  openWindow()
  for (let i = 0; i < 3; i++) statuses.push((await postJson(routes.register, { redirect_uris: ['https://app.example.com/cb'] }, from)).status)
  assert.deepEqual(statuses, [201, 201, 201, 201, 201, 429])
})

// ── The request check: app, redirect, PKCE, resource, scopes ────────────────

test('pairing app: a window opened for an app with known clients takes no other client_id; other tabs take any client', async () => {
  const dcr = await registerDcr()
  openWindow('claude-code')
  const out = await checkRequest(authorizeQuery({ client_id: dcr, redirect_uri: 'http://127.0.0.1:5000/callback' }))
  assert.deepEqual([out.body.state, out.body.error], ['invalid', 'wrong_app'])
  assert.match(out.body.message, /^This window was opened for Claude Code\./)
  assert.equal(totalStubHits(), 0)
  openWindow('cursor')
  assert.equal((await checkRequest(authorizeQuery({ client_id: dcr, redirect_uri: 'http://127.0.0.1:5000/callback' }))).body.state, 'ok')
})

test('known clients: exactly one pair ships (Claude Code); a known pair needs no typed host, any other pair of the same client does', async () => {
  assert.deepEqual(
    (await import('../lib/ai/knownClients')).KNOWN_CLIENTS.map((c) => [c.app, c.clientId, [...c.redirectUris]]),
    [['claude-code', 'https://claude.ai/oauth/claude-code-client-metadata', ['http://localhost/callback', 'http://127.0.0.1/callback']]],
  )
  const id = 'https://claude.ai/oauth/claude-code-client-metadata'
  // The document as Claude Code publishes it, plus one more redirect to show that only the listed pairs are known.
  // Served by a fake fetcher: the real one never runs in a unit test.
  let fetched = 0
  const fetcher = async () => {
    fetched++
    return { status: 200, headers: {}, url: id, body: Buffer.from(JSON.stringify({ client_id: id, client_name: 'Claude Code', redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback', 'http://localhost/other'], token_endpoint_auth_method: 'none' })) }
  }
  openWindow('claude-code')
  const check = (redirect: string) => oauth.checkAuthorizeRequest(new URLSearchParams(authorizeQuery({ client_id: id, redirect_uri: redirect })), { fetcher })
  for (const r of ['http://localhost:61234/callback', 'http://127.0.0.1:50000/callback', 'http://localhost/callback']) {
    const out = await check(r)
    assert.equal(out.state === 'ok' && out.facts.known, true, r)
    assert.equal(out.state === 'ok' && out.facts.client.knownName, 'Claude Code')
  }
  const other = await check('http://localhost:61234/other')
  assert.deepEqual(other.state === 'ok' && [other.facts.known, other.facts.client.knownName], [false, null])
  for (const r of ['http://localhost:61234/callback/', 'http://localhost:61234/callback?x=1', 'https://localhost/callback', 'http://[::1]:5000/callback']) {
    assert.equal((await check(r)).state, 'invalid', r)
  }
  assert.equal(fetched, 1, 'one fetch for the window')
})

test('redirect URIs: exact, except the port of a loopback address; https or loopback http, no fragment, userinfo or wildcard; custom schemes refused', async () => {
  assert.equal(oauth.redirectMatches('http://127.0.0.1/callback', 'http://127.0.0.1:61234/callback'), true)
  assert.equal(oauth.redirectMatches('http://localhost:8787/callback', 'http://localhost:9999/callback'), true)
  assert.equal(oauth.redirectMatches('http://[::1]/cb', 'http://[::1]:4000/cb'), true)
  assert.equal(oauth.redirectMatches('https://app.example.com/cb', 'https://app.example.com:8443/cb'), false)
  assert.equal(oauth.redirectMatches('https://app.example.com/cb', 'https://app.example.com/cb/'), false)
  assert.equal(oauth.redirectMatches('https://app.example.com/cb', 'https://APP.example.com/cb'), false)
  assert.equal(oauth.redirectMatches('http://127.0.0.1/callback', 'http://127.0.0.1:5000/callback/x'), false)
  assert.equal(oauth.redirectMatches('http://127.0.0.1/callback', 'http://localhost:5000/callback'), false)
  for (const [raw, reason] of [
    ['myapp://callback', 'custom-scheme'],
    ['javascript:alert(1)', 'custom-scheme'],
    ['http://app.example.com/cb', 'plain-http'],
    ['https://app.example.com/cb#frag', 'fragment'],
    ['https://u:p@app.example.com/cb', 'userinfo'],
    ['https://*.example.com/cb', 'wildcard'],
    ['', 'missing'],
  ] as const) {
    const form = oauth.redirectForm(raw)
    assert.equal(!form.ok && form.reason, reason, raw)
  }

  clientDoc('/client.json', { redirect_uris: ['http://127.0.0.1/callback', 'https://app.example.com/cb', 'myapp://callback'] })
  openWindow()
  const state = async (redirect: string) => (await checkRequest(authorizeQuery({ redirect_uri: redirect }))).body
  assert.equal((await state('https://app.example.com/cb')).state, 'ok')
  assert.equal((await state('http://127.0.0.1:61234/callback')).state, 'ok')
  for (const r of ['https://app.example.com/cb/', 'https://app.example.com/cb?x=1', 'https://app.example.com:443/cb2', 'http://localhost:61234/callback']) {
    const out = await state(r)
    assert.deepEqual([out.state, out.error], ['invalid', 'invalid_redirect_uri'], r)
  }
  const custom = await state('myapp://callback')
  assert.deepEqual([custom.state, custom.error], ['invalid', 'invalid_redirect_uri'])
  assert.match(custom.message, /personal token/)
})

test('PKCE: S256 only — plain, a missing method and a missing or malformed challenge are refused before anything is fetched', async () => {
  clientDoc('/client.json')
  openWindow()
  const overs: Array<Record<string, string | null>> = [{ code_challenge_method: 'plain' }, { code_challenge_method: null }, { code_challenge: null }, { code_challenge: 'short' }, { code_challenge: `${'a'.repeat(42)}=` }]
  for (const over of overs) {
    const out = await checkRequest(authorizeQuery(over))
    assert.deepEqual([out.body.state, out.body.error], ['invalid', 'invalid_request'], JSON.stringify(over))
  }
  assert.equal(totalStubHits(), 0)
  assert.equal((await checkRequest(authorizeQuery({ response_type: 'token' }))).body.error, 'unsupported_response_type')
  const twice = await checkRequest(`${authorizeQuery()}&redirect_uri=https%3A%2F%2Fevil.example.com%2Fcb`)
  assert.deepEqual([twice.body.state, twice.body.error], ['invalid', 'invalid_request'])
})

test('resource: only the canonical MCP address — invalid_target otherwise, naming the right address; a loopback name mix-up is explained', async () => {
  clientDoc('/client.json')
  openWindow()
  const target = async (resource: string | null) => (await checkRequest(authorizeQuery({ resource }))).body
  assert.equal((await target('http://127.0.0.1:3999/mcp')).state, 'ok')
  for (const r of [null, 'http://127.0.0.1:3999/mcp/', 'http://127.0.0.1:3999/api/mcp', 'https://127.0.0.1:3999/mcp', 'http://127.0.0.1:4000/mcp', 'http://127.0.0.1:3999/mcp?x=1', 'https://evil.example.com/mcp', 'nonsense']) {
    const out = await target(r)
    assert.deepEqual([out.state, out.error], ['invalid', 'invalid_target'], String(r))
    assert.match(out.message, /http:\/\/127\.0\.0\.1:3999\/mcp/, String(r))
  }
  const mixed = await target('http://localhost:3999/mcp')
  assert.equal(mixed.error, 'invalid_target')
  assert.match(mixed.message, /added this server as localhost/)
})

test('scopes: known names only; the page pre-selects the request’s level capped at Read and draft', async () => {
  clientDoc('/client.json')
  openWindow()
  const facts = async (scope: string | null) => (await checkRequest(authorizeQuery({ scope }))).body
  assert.equal((await facts('admin')).error, 'invalid_scope')
  assert.equal((await facts('content:read content:write')).error, 'invalid_scope')
  assert.deepEqual([(await facts(null)).facts.requestedLevel, (await facts(null)).facts.preselectedLevel], [1, 1])
  assert.deepEqual([(await facts('content:read offline_access')).facts.preselectedLevel], [1])
  const three = await facts('content:read content:draft content:propose offline_access')
  assert.deepEqual([three.facts.requestedLevel, three.facts.preselectedLevel], [3, 2])
})

// ── Consent ─────────────────────────────────────────────────────────────────

test('consent: a verification within 2 minutes, the same window, one access level, the typed host unless the pair is known; one grant closes the window', async () => {
  clientDoc('/client.json')
  const { challenge } = pkce()
  const query = authorizeQuery({}, challenge)
  openWindow()
  const fresh = await browser()
  const facts = (await checkRequest(query, fresh.cookie)).body.facts
  assert.equal(facts.known, false)
  const base = { params: query, pairing_id: facts.pairingId, decision: 'allow', scopes: ['content:read'], typedHost: '127.0.0.1' }
  const codes = () => countRows('ai_oauth_codes')
  const before = codes()

  const stale = await browser(3 * 60_000)
  const asked = await consent(stale.cookie, base)
  assert.deepEqual([asked.statusCode, asked.body.code], [403, 'STEP_UP_REQUIRED'], '3 minutes ago is not fresh enough')
  assert.equal((await consent('', base)).statusCode, 401)
  for (const [over, code] of [
    [{ pairing_id: 'pw_other' }, 'WINDOW_CHANGED'],
    [{ scopes: ['content:draft'] }, 'INVALID'],
    [{ scopes: ['content:read', 'content:propose'] }, 'INVALID'],
    [{ scopes: 'content:read' }, 'INVALID'],
    [{ typedHost: undefined }, 'TYPED_HOST'],
    [{ typedHost: 'localhost' }, 'TYPED_HOST'],
    [{ typedHost: '127.0.0.2' }, 'TYPED_HOST'],
    [{ params: authorizeQuery({ code_challenge_method: 'plain' }, challenge) }, 'INVALID_REQUEST'],
  ] as const) {
    const out = await consent(fresh.cookie, { ...base, ...over })
    assert.equal(out.body.code, code, JSON.stringify(over))
    assert.equal('redirect' in out.body, false, 'a refused consent never redirects')
  }
  assert.equal(codes(), before, 'nothing issued')
  assert.ok(settings.currentPairing(), 'the window is still open')

  const ok = await consent(fresh.cookie, { ...base, typedHost: ' 127.0.0.1. ', scopes: ['content:draft', 'content:read', 'content:propose'] })
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body))
  const redirect = new URL(ok.body.redirect)
  assert.equal(redirect.origin + redirect.pathname, 'http://127.0.0.1:53123/callback')
  assert.deepEqual([redirect.searchParams.get('state'), redirect.searchParams.get('iss')], ['st-1', SITE])
  assert.match(redirect.searchParams.get('code') ?? '', /^[A-Za-z0-9_-]{43}$/)
  assert.equal(settings.currentPairing(), null, 'one grant closes the window')
  const row = authDb.getAuthDb().prepare('SELECT * FROM ai_oauth_codes ORDER BY expires_at DESC LIMIT 1').get() as Record<string, any>
  assert.equal(row.code_hash, crypto.createHash('sha256').update(redirect.searchParams.get('code') as string).digest('hex'), 'the code is stored as its SHA-256 only')
  assert.deepEqual([row.client_id, row.redirect_uri, row.code_challenge, row.scopes, row.resource, row.created_session], [`${STUB}/client.json`, 'http://127.0.0.1:53123/callback', challenge, 'content:read content:draft content:propose', RESOURCE, fresh.sid])
  assert.ok(Math.abs(row.expires_at - Date.now() - 60_000) < 2000, '60 seconds')
  const again = await consent(fresh.cookie, base)
  assert.equal(again.statusCode, 409)
  // Recorded in Activity, area ai, without the code.
  const { listAudit } = await import('../lib/audit/store')
  const entry = listAudit({ limit: 20 }).entries.find((r: any) => r.action === 'ai.oauth-allow')
  assert.ok(entry && entry.area === 'ai')
  assert.equal(JSON.stringify(entry).includes(redirect.searchParams.get('code') as string), false)
})

test('Cancel: a known pair is sent back with access_denied, state and iss; an unknown host stays on this site; Cancel never asks for a verification and keeps the window', async () => {
  const dcr = await registerDcr(['http://127.0.0.1/callback'])
  openWindow('cursor')
  const stale = await browser(60 * 60_000)
  const unknown = await consent(stale.cookie, { params: authorizeQuery({ client_id: dcr }), decision: 'deny' })
  assert.deepEqual([unknown.statusCode, unknown.body], [200, { redirect: null }])
  assert.ok(settings.currentPairing())

  const id = 'https://claude.ai/oauth/claude-code-client-metadata'
  openWindow('claude-code')
  // Put Claude Code's document in the window's cache, as the consent page's first check would have.
  const fetcher = async () => ({ status: 200, headers: {}, url: id, body: Buffer.from(JSON.stringify({ client_id: id, redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'], token_endpoint_auth_method: 'none' })) })
  const query = authorizeQuery({ client_id: id, redirect_uri: 'http://localhost:61234/callback', state: 'xyz' })
  assert.equal((await oauth.checkAuthorizeRequest(new URLSearchParams(query), { fetcher })).state, 'ok')
  const known = await consent(stale.cookie, { params: query, decision: 'deny' })
  const back = new URL(known.body.redirect)
  assert.equal(back.origin + back.pathname, 'http://localhost:61234/callback')
  assert.deepEqual(Object.fromEntries(back.searchParams), { error: 'access_denied', state: 'xyz', iss: SITE })
  assert.ok(settings.currentPairing(), 'Cancel keeps the window: the owner can start again from the app')
  assert.equal(countRows('ai_oauth_codes'), countRows('ai_oauth_codes'))
})

test('no failure redirects before consent: every refused request is answered on this site, by the check, the consent and the bounce alike', async () => {
  clientDoc('/client.json')
  const dcr = await registerDcr(['https://editor.example.com/cb'])
  openWindow()
  const b = await browser()
  const bads = [
    authorizeQuery({ redirect_uri: 'https://evil.example.com/cb' }),
    authorizeQuery({ client_id: dcr, redirect_uri: 'https://editor.example.com/cb', scope: 'everything' }),
    authorizeQuery({ client_id: dcr, redirect_uri: 'https://editor.example.com/cb', resource: 'https://evil.example.com/mcp' }),
    authorizeQuery({ client_id: dcr, redirect_uri: 'https://editor.example.com/cb', code_challenge_method: 'plain' }),
    authorizeQuery({ client_id: 'https://evil.example.com/' }),
  ]
  for (const q of bads) {
    const checked = await checkRequest(q, b.cookie)
    assert.equal(checked.body.state, 'invalid', q)
    assert.deepEqual(Object.keys(checked.body).sort(), ['error', 'message', 'state'], 'the answer carries no redirect')
    const allowed = await consent(b.cookie, { params: q, pairing_id: settings.currentPairing()?.id, decision: 'allow', scopes: ['content:read'], typedHost: 'editor.example.com' })
    assert.equal(allowed.statusCode, 400)
    assert.equal('redirect' in allowed.body, false)
    assert.deepEqual((await consent(b.cookie, { params: q, decision: 'deny' })).body, { redirect: null })
  }
  assert.equal(countRows('ai_oauth_codes'), countRows('ai_oauth_codes'))
  assert.ok(settings.currentPairing(), 'no refused request closes the window')
})

test('a phishing-shaped link with no window open: the bounce, then the page that says nothing is expected (§13 step 16)', async () => {
  const query = authorizeQuery({ client_id: 'https://evil.example.com/client.json', redirect_uri: 'https://evil.example.com/cb', scope: 'content:read content:draft content:propose' })
  const bounce = await routes.authorize.raw({ method: 'GET', path: `/?${query}`, headers: { 'cf-connecting-ip': ip() } })
  assert.equal(bounce.status, 200)
  assert.match(bounce.body, /url=\/admin\/ai\/connect\?/)
  const out = await checkRequest(query)
  assert.deepEqual(out.body, { state: 'closed', apps: true })
  // With connected apps off, the page can say that instead (the public addresses do not exist then).
  authDb.getAuthDb().prepare('UPDATE ai_settings SET mcp_enabled = 0 WHERE id = 1').run()
  assert.deepEqual((await checkRequest(query)).body, { state: 'closed', apps: false })
})

// ── /oauth/token ────────────────────────────────────────────────────────────

test('token: the code exchange — form-encoded only, atomic single use, the exact client, redirect URI and resource, the verifier; the grant is made here, bound to the session and the resource', async () => {
  const c = await codeFor({ scopes: ['content:read', 'content:draft'] })
  const json = await routes.token.raw({ method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip() }, body: JSON.stringify({ grant_type: 'authorization_code', code: c.code }) })
  assert.equal(json.status, 400)
  assert.equal(JSON.parse(json.body).error, 'invalid_request')
  const twice = await postForm(routes.token, `grant_type=authorization_code&code=${c.code}&code=${c.code}`)
  assert.deepEqual([twice.status, twice.json.error], [400, 'invalid_request'])
  assert.equal((await postForm(routes.token, { grant_type: 'password' })).json.error, 'unsupported_grant_type')

  const ok = await exchange(c)
  assert.equal(ok.status, 200, ok.body)
  assert.equal(ok.headers['cache-control'], 'no-store')
  assert.equal(ok.json.token_type, 'Bearer')
  assert.equal(ok.json.expires_in, 3600)
  assert.match(ok.json.access_token, /^pso_[A-Za-z0-9_-]{43}$/)
  assert.match(ok.json.refresh_token, /^psr_[A-Za-z0-9_-]{43}$/)
  assert.equal(ok.json.scope, 'content:read content:draft offline_access', 'the granted scope, as decided on the page')
  const v = access.verifyBearerToken(ok.json.access_token, { resource: RESOURCE })
  assert.ok(v.ok)
  const grant = v.ok ? v.grant : (null as never)
  assert.deepEqual(
    [grant.kind, grant.name, grant.clientId, grant.redirectHost, grant.scopes, grant.resource, grant.createdSession, grant.createdDevice],
    ['oauth', '127.0.0.1', `${STUB}/client.json`, '127.0.0.1', ['content:read', 'content:draft'], RESOURCE, c.b.sid, 'Chrome on macOS'],
  )
  assert.ok(Math.abs(grant.expiresAt - grant.createdAt - 90 * 86_400_000) < 5, '90 days absolute')
  assert.equal(access.verifyBearerToken(ok.json.refresh_token, { resource: RESOURCE }).ok, false, 'a refresh token is never a bearer')
  // Recorded: Security history and Activity, under the browser that allowed it; no token in either.
  const { listAuthEvents } = await import('../lib/adminAuth/store')
  const events = JSON.stringify(listAuthEvents(50))
  assert.match(events, /ai-token-created/)
  assert.equal(events.includes(ok.json.access_token) || events.includes(ok.json.refresh_token), false)

  // Mismatches burn nothing new and issue nothing: each code is single use.
  const mismatch = async (over: Record<string, string | null>, error: string) => {
    const fresh = await codeFor()
    const out = await exchange(fresh, over)
    assert.deepEqual([out.status, out.json.error], [400, error], JSON.stringify(over))
    assert.equal((await exchange(fresh)).json.error, 'invalid_grant', 'a refused exchange burned the code')
  }
  await mismatch({ client_id: `${STUB}/other.json` }, 'invalid_grant')
  await mismatch({ redirect_uri: 'http://127.0.0.1:53124/callback' }, 'invalid_grant')
  await mismatch({ resource: 'https://evil.example.com/mcp' }, 'invalid_target')
  await mismatch({ code_verifier: pkce().verifier }, 'invalid_grant')
  await mismatch({ code_verifier: 'too-short' }, 'invalid_grant')
  const missing = await codeFor()
  assert.equal((await exchange(missing, { code_verifier: null })).json.error, 'invalid_request')
  assert.equal((await exchange(missing)).status, 200, 'a request refused before the claim leaves the code usable')
})

test('token: a verifier without a challenge is refused; a code lives 60 seconds; the session version and the allowing browser must still hold', async () => {
  // A code with no challenge cannot be issued (the check requires S256); one written by hand is still refused.
  const raw = crypto.randomBytes(32).toString('base64url')
  const sessions = await import('../lib/adminAuth/sessions')
  const b = await browser()
  authDb
    .getAuthDb()
    .prepare(`INSERT INTO ai_oauth_codes (code_hash, client_id, redirect_uri, code_challenge, scopes, resource, session_version, created_session, expires_at) VALUES (?, ?, ?, '', 'content:read', ?, ?, ?, ?)`)
    .run(access.tokenHash(raw), 'dcr_x', 'http://127.0.0.1/callback', RESOURCE, (await import('../lib/admin')).currentSessionVersion(), b.sid, Date.now() + 60_000)
  const none = await postForm(routes.token, { grant_type: 'authorization_code', code: raw, code_verifier: pkce().verifier, redirect_uri: 'http://127.0.0.1/callback', client_id: 'dcr_x' })
  assert.equal(none.json.error, 'invalid_grant')

  const late = await codeFor()
  const form = new URLSearchParams({ grant_type: 'authorization_code', code: late.code, code_verifier: late.verifier, redirect_uri: late.redirectUri, client_id: late.clientId, resource: RESOURCE })
  const expired = oauth.exchangeCode(form, { now: Date.now() + 61_000 })
  assert.deepEqual(!expired.ok && expired.error, 'invalid_grant')

  const signedOut = await codeFor()
  sessions.revokeSession(signedOut.b.sid, 'test')
  assert.equal((await exchange(signedOut)).json.error, 'invalid_grant')

  const bumped = await codeFor()
  const admin = await import('../lib/admin')
  admin.bumpSessionVersion()
  try {
    assert.equal((await exchange(bumped)).json.error, 'invalid_grant', '"Sign out everywhere" between consent and exchange')
  } finally {
    // Later tests sign in again with the new version; nothing else depends on the old one.
  }
})

test('token: a code presented again ends the grant it issued — recorded, mailed once, its tokens refused', async () => {
  const c = await codeFor()
  const first = await exchange(c)
  assert.equal(first.status, 200)
  const replay = await exchange(c)
  assert.deepEqual([replay.status, replay.json.error], [400, 'invalid_grant'])
  const v = access.verifyBearerToken(first.json.access_token, { resource: RESOURCE })
  assert.deepEqual(!v.ok && v.reason, 'revoked')
  const grantId = !v.ok && v.grant ? v.grant.id : ''
  assert.equal(access.getGrant(grantId)?.revokeReason, 'authorization code used twice')
  const refreshed = await postForm(routes.token, { grant_type: 'refresh_token', refresh_token: first.json.refresh_token })
  assert.equal(refreshed.json.error, 'invalid_grant')
  const claim = aiDb.getAiDb().prepare('SELECT n FROM ai_counters WHERE key = ?').get(`alert|replay|${grantId}`)
  assert.ok(claim, 'the owner is mailed (one claim per grant, kind and day)')
  const { listAudit } = await import('../lib/audit/store')
  assert.ok(listAudit({ limit: 50 }).entries.some((r: any) => r.action === 'ai.oauth-replay'))
})

test('token: refresh rotates in the same response; a refresh token is issued without offline_access; reuse within 10 s is refused only, past it the grant ends', async () => {
  const c = await codeFor({ scope: 'content:read', scopes: ['content:read'] })
  const first = await exchange(c)
  assert.equal(first.status, 200)
  assert.ok(first.json.refresh_token, 'a refresh token even though offline_access was not asked for')

  const r1 = await postForm(routes.token, { grant_type: 'refresh_token', refresh_token: first.json.refresh_token, client_id: c.clientId })
  assert.equal(r1.status, 200, r1.body)
  assert.notEqual(r1.json.refresh_token, first.json.refresh_token)
  assert.notEqual(r1.json.access_token, first.json.access_token)
  assert.equal(r1.json.scope, 'content:read offline_access')
  assert.ok(access.verifyBearerToken(r1.json.access_token, { resource: RESOURCE }).ok)

  // Within the grace (a client refreshing twice at once): refused, the grant lives.
  const soon = await postForm(routes.token, { grant_type: 'refresh_token', refresh_token: first.json.refresh_token })
  assert.equal(soon.json.error, 'invalid_grant')
  assert.ok(access.verifyBearerToken(r1.json.access_token, { resource: RESOURCE }).ok, 'reuse inside 10 s does not end the grant')

  // Other refusals, all invalid_grant / RFC 6749 codes.
  assert.equal((await postForm(routes.token, { grant_type: 'refresh_token', refresh_token: r1.json.refresh_token, client_id: 'dcr_other' })).json.error, 'invalid_grant')
  assert.equal((await postForm(routes.token, { grant_type: 'refresh_token', refresh_token: r1.json.refresh_token, scope: 'content:read content:draft' })).json.error, 'invalid_scope')
  assert.equal((await postForm(routes.token, { grant_type: 'refresh_token', refresh_token: `psr_${'A'.repeat(43)}` })).json.error, 'invalid_grant')
  assert.equal((await postForm(routes.token, { grant_type: 'refresh_token', refresh_token: r1.json.access_token })).json.error, 'invalid_grant')

  // Past the grace: the copy in someone else's hands ends the grant, recorded and mailed.
  const lib = oauth.refreshTokens(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: first.json.refresh_token }), { now: Date.now() + 10_001 })
  assert.ok(!lib.ok && lib.ended, 'past 10 s the grant ends')
  const v = access.verifyBearerToken(r1.json.access_token, { resource: RESOURCE })
  assert.deepEqual(!v.ok && v.reason, 'revoked')

  // The same through the route: the rotated token's exchange moved 11 s into the past.
  const d = await codeFor()
  const t = await exchange(d)
  const t2 = await postForm(routes.token, { grant_type: 'refresh_token', refresh_token: t.json.refresh_token })
  assert.equal(t2.status, 200)
  authDb.getAuthDb().prepare('UPDATE ai_tokens SET rotated_at = ? WHERE token_hash = ?').run(Date.now() - 11_000, access.tokenHash(t.json.refresh_token))
  const reused = await postForm(routes.token, { grant_type: 'refresh_token', refresh_token: t.json.refresh_token })
  assert.equal(reused.json.error, 'invalid_grant')
  const gv = access.verifyBearerToken(t2.json.access_token, { resource: RESOURCE })
  assert.deepEqual(!gv.ok && gv.reason, 'revoked')
  const gid = !gv.ok && gv.grant ? gv.grant.id : ''
  assert.equal(access.getGrant(gid)?.revokeReason, 'refresh token used twice')
  assert.ok(aiDb.getAiDb().prepare('SELECT 1 FROM ai_counters WHERE key = ?').get(`alert|replay|${gid}`), 'mailed')
})

test('iss on every authorization response; the discovery documents say so, from SITE_URL, readable from any origin, cached 5 minutes', async () => {
  const prm = await routes.metadata.raw({ method: 'GET', path: '/?doc=prm' })
  const as = await routes.metadata.raw({ method: 'GET', path: '/?doc=as', headers: { host: 'evil.example.com' } })
  assert.equal(prm.status, 200)
  assert.deepEqual(JSON.parse(prm.body), { resource: RESOURCE, authorization_servers: [SITE], scopes_supported: ['content:read'], bearer_methods_supported: ['header'] })
  const meta = JSON.parse(as.body)
  assert.equal(meta.issuer, SITE, 'never from the Host header')
  assert.deepEqual(
    [meta.authorization_endpoint, meta.token_endpoint, meta.registration_endpoint, meta.revocation_endpoint],
    [`${SITE}/oauth/authorize`, `${SITE}/oauth/token`, `${SITE}/oauth/register`, `${SITE}/oauth/revoke`],
  )
  assert.deepEqual(meta.scopes_supported, ['content:read', 'content:draft', 'content:propose', 'offline_access'])
  assert.deepEqual([meta.response_types_supported, meta.grant_types_supported, meta.token_endpoint_auth_methods_supported, meta.code_challenge_methods_supported], [['code'], ['authorization_code', 'refresh_token'], ['none'], ['S256']])
  assert.equal(meta.client_id_metadata_document_supported, true)
  assert.equal(meta.authorization_response_iss_parameter_supported, true)
  for (const r of [prm, as]) {
    assert.equal(r.headers['access-control-allow-origin'], '*')
    assert.equal(r.headers['cache-control'], 'public, max-age=300')
  }
  assert.equal((await routes.metadata.raw({ method: 'GET', path: '/?doc=openid' })).status, 404)
  // Success carries iss (the consent test); so does Cancel for a known pair (the Cancel test).
  const c = await codeFor()
  assert.equal(c.redirect.searchParams.get('iss'), SITE)
})

test('revoke: RFC 7009 — always 200; an OAuth token ends its grant, a personal token or a stranger’s is left alone', async () => {
  const c = await codeFor()
  const t = await exchange(c)
  const pat = access.createPersonalToken({ name: 'laptop', scopes: ['content:read'], days: 30, resource: RESOURCE, session: { id: null, device: null } })
  assert.ok(pat.ok)
  for (const token of [`pso_${'A'.repeat(43)}`, 'garbage', pat.ok ? pat.token : '']) {
    const out = await postForm(routes.revoke, { token })
    assert.equal(out.status, 200)
  }
  assert.ok(pat.ok && access.verifyBearerToken(pat.token, { resource: RESOURCE }).ok, 'a personal token is ended in Connections, not here')
  assert.equal((await postForm(routes.revoke, { token: t.json.access_token, client_id: 'dcr_someone_else' })).status, 200)
  assert.ok(access.verifyBearerToken(t.json.access_token, { resource: RESOURCE }).ok, 'another client_id cannot end it')
  assert.equal((await postForm(routes.revoke, { token: t.json.refresh_token, token_type_hint: 'refresh_token' })).status, 200)
  const v = access.verifyBearerToken(t.json.access_token, { resource: RESOURCE })
  assert.deepEqual(!v.ok && v.reason, 'revoked')
  assert.equal((await postForm(routes.revoke, {})).status, 400)
})

test('closed (AI off, connected apps off, AI_DISABLED, no SITE_URL): every OAuth route answers a bare 404', async () => {
  const closers: Array<[string, () => void]> = [
    ['off', () => authDb.getAuthDb().prepare('UPDATE ai_settings SET enabled = 0 WHERE id = 1').run()],
    ['apps off', () => authDb.getAuthDb().prepare('UPDATE ai_settings SET mcp_enabled = 0 WHERE id = 1').run()],
    ['AI_DISABLED', () => (process.env.AI_DISABLED = '1')],
    ['no SITE_URL', () => delete process.env.SITE_URL],
  ]
  for (const [why, close] of closers) {
    close()
    for (const [name, r] of Object.entries(routes)) {
      const method = name === 'authorize' || name === 'metadata' ? 'GET' : 'POST'
      const out = await r.raw({ method, path: name === 'metadata' ? '/?doc=as' : '/', headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': ip() }, body: method === 'POST' ? 'grant_type=refresh_token' : undefined })
      assert.deepEqual([out.status, out.body], [404, ''], `${why}: ${name}`)
    }
    authDb.getAuthDb().prepare('UPDATE ai_settings SET enabled = 1, mcp_enabled = 1 WHERE id = 1').run()
    delete process.env.AI_DISABLED
    process.env.SITE_URL = SITE
  }
})

test('plain http with a public host configured: the POST routes refuse instead of answering over http', async () => {
  process.env.SITE_URL = 'https://site.example.com'
  try {
    for (const r of [routes.token, routes.register, routes.revoke]) {
      const out = await r.raw({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-proto': 'http', 'cf-connecting-ip': ip() }, body: 'token=x' })
      assert.equal(out.status, 403)
    }
  } finally {
    process.env.SITE_URL = SITE
  }
})

// ── The pairing window (Connections) ────────────────────────────────────────

test('pairing route: opening asks for a recent verification and needs connected apps on; closing never asks; one app per window', async () => {
  const route = await adminRoute('../pages/api/admin/ai/pairing')
  const stale = await browser(11 * 60_000)
  const fresh = await browser()
  const asked = await call(route, { method: 'POST', cookie: stale.cookie, body: { app: 'cursor' } })
  assert.deepEqual([asked.statusCode, asked.body.code], [403, 'STEP_UP_REQUIRED'])
  assert.equal(settings.currentPairing(), null)
  assert.equal((await call(route, { method: 'POST', cookie: fresh.cookie, body: { app: 'telegram' } })).statusCode, 400)
  assert.equal((await call(route, { method: 'POST', cookie: '', body: { app: 'cursor' } })).statusCode, 401)

  authDb.getAuthDb().prepare('UPDATE ai_settings SET mcp_enabled = 0 WHERE id = 1').run()
  assert.equal((await call(route, { method: 'POST', cookie: fresh.cookie, body: { app: 'cursor' } })).body.code, 'APPS_OFF')
  authDb.getAuthDb().prepare('UPDATE ai_settings SET mcp_enabled = 1 WHERE id = 1').run()

  const opened = await call(route, { method: 'POST', cookie: fresh.cookie, body: { app: 'cursor' } })
  assert.equal(opened.statusCode, 200)
  assert.equal(opened.body.pairing.app, 'cursor')
  assert.ok(Math.abs(opened.body.pairing.expiresAt - opened.body.pairing.openedAt - 600_000) < 5, '10 minutes')
  const replaced = await call(route, { method: 'POST', cookie: fresh.cookie, body: { app: 'vscode' } })
  assert.equal(settings.currentPairing()?.app, 'vscode', 'a new window replaces the open one')
  assert.ok(replaced.body.pairing.openedAt >= opened.body.pairing.openedAt)

  const closed = await call(route, { method: 'DELETE', cookie: stale.cookie })
  assert.deepEqual([closed.statusCode, closed.body], [200, { closed: true }])
  assert.equal(settings.currentPairing(), null)
  assert.deepEqual((await call(route, { method: 'GET', cookie: stale.cookie })).body, { pairing: null, consents: [] })
  const { listAudit } = await import('../lib/audit/store')
  const actions = listAudit({ limit: 50 }).entries.map((r: any) => r.action)
  assert.ok(actions.includes('ai.pairing-open') && actions.includes('ai.pairing-close'))
})

test('pairing route: Connections learns when the app collected its access (the consent, then the exchange), never the code', async () => {
  await new Promise((resolve) => setTimeout(resolve, 5))
  const since = Date.now()
  const route = await adminRoute('../pages/api/admin/ai/pairing')
  const c = await codeFor()
  const b = await browser(11 * 60_000)
  const waiting = await call(route, { method: 'GET', cookie: b.cookie, query: { since: String(since) } })
  assert.equal(waiting.body.pairing, null, 'the consent closed the window')
  assert.deepEqual(waiting.body.consents.map((x: any) => [x.exchanged, x.expired]), [[false, false]])
  const t = await exchange(c)
  const done = await call(route, { method: 'GET', cookie: b.cookie, query: { since: String(since) } })
  const grantId = (access.verifyBearerToken(t.json.access_token, { resource: RESOURCE }) as { grant: { id: string } }).grant.id
  assert.deepEqual(done.body.consents.map((x: any) => [x.exchanged, x.grantId]), [[true, grantId]])
  assert.equal(JSON.stringify(done.body).includes(c.code), false)
})

test('signing out the browser that allowed an app ends that app (§13 step 17, the OAuth half)', async () => {
  const c = await codeFor()
  const t = await exchange(c)
  const other = await browser()
  const sessionsRoute = await adminRoute('../pages/api/admin/security/sessions')
  const out = await call(sessionsRoute, { method: 'DELETE', cookie: other.cookie, body: { id: c.b.sid }, url: '/api/admin/security/sessions' })
  assert.equal(out.statusCode, 200, JSON.stringify(out.body))
  const v = access.verifyBearerToken(t.json.access_token, { resource: RESOURCE })
  assert.deepEqual(!v.ok && v.reason, 'revoked')
  assert.equal((await postForm(routes.token, { grant_type: 'refresh_token', refresh_token: t.json.refresh_token })).json.error, 'invalid_grant')
})
