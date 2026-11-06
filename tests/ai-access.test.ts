/**
 * M1 — connected apps' tokens and grants (lib/ai/access, design §5.4), the
 * owner alerts' daily cap (lib/ai/alerts), executeTool's re-check of the
 * grant on every call, and the routes (§12.1 ai-access): the token route's
 * 2-minute verification, the settings route's step-up rule (every loosening
 * asks, no tightening does, the ceiling holds), and how signing browsers out
 * and changing the password end apps — one other browser ends the apps it
 * created, the others with and without "Also end all AI apps", everywhere,
 * a password change with and without; this browser's own sign-out and a
 * session's natural end do not. Against a real auth.db, ai.db, audit.db and
 * admin.json in a temp directory.
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { editorialHarness } from './editorialHarness'

const SECRET = 'ai-access-secret-0123456789abcdef0123456789'
const h = editorialHarness('ai-access', SECRET)
const RESOURCE = 'http://127.0.0.1:3999/mcp'
let access: typeof import('../lib/ai/access')
let authDb: typeof import('../lib/adminAuth/db')
let aiDb: typeof import('../lib/ai/db')
let admin: typeof import('../lib/admin')

before(async () => {
  process.env.ADMIN_EMAIL = 'owner@example.test'
  process.env.ADMIN_PASS = 'ai-access test password, synthetic'
  await h.setup()
  access = await import('../lib/ai/access')
  authDb = await import('../lib/adminAuth/db')
  aiDb = await import('../lib/ai/db')
  admin = await import('../lib/admin')
  admin.ensureAdminFromEnv()
})
after(async () => {
  const { closeAuditDb } = await import('../lib/audit/db')
  closeAuditDb()
  delete process.env.ADMIN_EMAIL
  delete process.env.ADMIN_PASS
  h.teardown()
})
beforeEach(() => {
  process.env.JWT_SECRET = SECRET
})

function mint(scopes: string[] = ['content:read'], over: Partial<import('../lib/ai/access').CreatePersonalToken> = {}, now?: number) {
  const out = access.createPersonalToken({ name: 'laptop', scopes, days: 30, resource: RESOURCE, session: { id: null, device: 'Firefox on Linux' }, ...over }, { now })
  if (!out.ok) throw new Error(JSON.stringify(out))
  return out
}

test('a personal token: pst_ + 32 + 11 characters, shown once; the store keeps its SHA-256 and last four only', () => {
  const { token, grant } = mint(['content:read', 'content:draft'])
  assert.match(token, /^pst_[A-Za-z0-9_-]{43}$/)
  assert.equal(grant.kind, 'pat')
  assert.deepEqual(grant.scopes, ['content:read', 'content:draft'])
  assert.equal(grant.resource, RESOURCE)
  assert.equal(grant.createdDevice, 'Firefox on Linux')
  assert.ok(Math.abs(grant.expiresAt - grant.createdAt - 30 * 86_400_000) < 5)
  const row = authDb.getAuthDb().prepare('SELECT * FROM ai_tokens WHERE grant_id = ?').get(grant.id) as Record<string, unknown>
  assert.equal(row.token_hash, crypto.createHash('sha256').update(token).digest('hex'))
  assert.equal(row.hint, token.slice(-4))
  // Nowhere in auth.db (or its WAL) is the token or its secret part.
  authDb.getAuthDb().pragma('wal_checkpoint(TRUNCATE)')
  for (const f of ['auth.db', 'auth.db-wal']) {
    const file = path.join(h.tmp, 'data', f)
    if (!fs.existsSync(file)) continue
    const bytes = fs.readFileSync(file)
    assert.equal(bytes.includes(Buffer.from(token)), false, f)
    assert.equal(bytes.includes(Buffer.from(token.slice(4, 36))), false, f)
  }
})

test('only the three access levels, a listed lifetime, a name and an MCP resource; no secret, no token', () => {
  const base = { name: 'x', scopes: ['content:read'], days: 30, resource: RESOURCE, session: { id: null, device: null } }
  const refused = (over: Record<string, unknown>, field: string) => {
    assert.deepEqual(access.createPersonalToken({ ...base, ...over } as never), { ok: false, code: 'INVALID', field }, JSON.stringify(over))
  }
  refused({ name: '  ' }, 'name')
  refused({ name: 42 }, 'name')
  for (const scopes of [[], ['content:draft'], ['content:read', 'content:propose'], ['content:read', 'content:read'], ['admin'], 'content:read', ['content:read', 7]]) refused({ scopes }, 'scopes')
  for (const days of [0, 1, 89, 366, -1, '90', null, Infinity]) refused({ days }, 'days')
  for (const resource of ['', 'http://127.0.0.1:3999/mcp/', 'http://127.0.0.1:3999/api/mcp', 'javascript:alert(1)//mcp']) refused({ resource }, 'resource')
  for (const days of access.PAT_LIFETIME_DAYS) assert.equal(access.createPersonalToken({ ...base, days }).ok, true, String(days))
  for (const level of access.ACCESS_LEVELS) assert.equal(access.createPersonalToken({ ...base, scopes: [...level].reverse() }).ok, true, level.join(' '))
  delete process.env.JWT_SECRET
  assert.deepEqual(access.createPersonalToken(base), { ok: false, code: 'NO_SECRET' })
})

test('the tag is checked first: a guessed or mangled token never reads the store', () => {
  const { token } = mint()
  const db = authDb.getAuthDb()
  const patched = db as unknown as { prepare: unknown }
  const prepare = db.prepare.bind(db)
  let reads = 0
  patched.prepare = (sql: string) => {
    reads++
    return prepare(sql)
  }
  try {
    const flip = (s: string, at: number) => s.slice(0, at) + (s[at] === 'A' ? 'B' : 'A') + s.slice(at + 1)
    for (const bad of [flip(token, 10), flip(token, token.length - 1), `pso_${token.slice(4)}`, `pst_${'A'.repeat(43)}`, 'x', `${token}=`]) {
      const v = access.verifyBearerToken(bad, { resource: RESOURCE })
      assert.equal(v.ok, false)
      assert.ok(!v.ok && (v.reason === 'tag' || v.reason === 'malformed') && !v.validTag, bad.slice(0, 6))
    }
    assert.equal(reads, 0)
    assert.equal(access.verifyBearerToken(token, { resource: RESOURCE }).ok, true)
    assert.ok(reads > 0, 'sanity: a real check reads the store')
  } finally {
    patched.prepare = prepare
  }
})

test('verification: expiry, revocation, another resource, a refresh token as bearer — and rotating JWT_SECRET ends every token', () => {
  const now = Date.now()
  const { token, grant } = mint(['content:read'], { days: 7 }, now)
  assert.equal(access.verifyBearerToken(token, { resource: RESOURCE, now }).ok, true)
  const expired = access.verifyBearerToken(token, { resource: RESOURCE, now: now + 7 * 86_400_000 + 1 })
  assert.deepEqual(!expired.ok && [expired.reason, expired.validTag, expired.grant?.id], ['expired', true, grant.id])
  const other = access.verifyBearerToken(token, { resource: 'https://site.example/mcp', now })
  assert.equal(!other.ok && other.reason, 'resource')

  // A refresh token is never a bearer, even with a valid tag and a live grant.
  const key = access.tokenKey() as Buffer
  const refresh = access.mintToken('refresh', key)
  authDb.getAuthDb().prepare("INSERT INTO ai_tokens (token_hash, grant_id, kind, hint, created_at, expires_at) VALUES (?, ?, 'refresh', ?, ?, ?)").run(refresh.hash, grant.id, refresh.hint, now, now + 86_400_000)
  const r = access.verifyBearerToken(refresh.token, { resource: RESOURCE, now })
  assert.equal(!r.ok && r.reason, 'kind')

  process.env.JWT_SECRET = `${SECRET}-rotated`
  const rotated = access.verifyBearerToken(token, { resource: RESOURCE, now })
  assert.deepEqual(!rotated.ok && [rotated.reason, rotated.validTag], ['tag', false])
  process.env.JWT_SECRET = SECRET

  assert.equal(access.revokeGrant(grant.id, 'lost laptop', now), true)
  assert.equal(access.revokeGrant(grant.id, 'again', now), false)
  const revoked = access.verifyBearerToken(token, { resource: RESOURCE, now })
  assert.deepEqual(!revoked.ok && [revoked.reason, revoked.validTag], ['revoked', true])
  assert.equal(access.getGrant(grant.id)?.revokeReason, 'lost laptop')
})

test('session binding: "Sign out everywhere" (a version bump) ends every grant; an unreadable admin.json fails closed', () => {
  const { token, grant } = mint()
  assert.ok(access.liveGrant(grant.id))
  admin.bumpSessionVersion()
  const v = access.verifyBearerToken(token, { resource: RESOURCE })
  assert.equal(!v.ok && v.reason, 'session')
  assert.equal(access.liveGrant(grant.id), null)

  const fresh = mint()
  const file = path.join(h.tmp, 'data', 'admin.json')
  const saved = fs.readFileSync(file)
  fs.writeFileSync(file, '{ not json')
  try {
    const broken = access.verifyBearerToken(fresh.token, { resource: RESOURCE })
    assert.equal(!broken.ok && broken.reason, 'unavailable')
    assert.equal(access.liveGrant(fresh.grant.id), null)
  } finally {
    fs.writeFileSync(file, saved)
  }
  assert.equal(access.verifyBearerToken(fresh.token, { resource: RESOURCE }).ok, true)
})

test('an OAuth grant ends after 30 days unused; a personal token does not', () => {
  const now = Date.now()
  const key = access.tokenKey() as Buffer
  const id = `g${crypto.randomBytes(16).toString('base64url')}`
  const db = authDb.getAuthDb()
  db.prepare(
    `INSERT INTO ai_grants (id, kind, name, client_id, scopes, resource, session_version, created_at, expires_at, last_used_at)
     VALUES (?, 'oauth', 'claude.ai', 'https://claude.ai/oauth/client.json', 'content:read', ?, ?, ?, ?, ?)`,
  ).run(id, RESOURCE, admin.currentSessionVersion(), now - 40 * 86_400_000, now + 50 * 86_400_000, now - 31 * 86_400_000)
  const t = access.mintToken('access', key)
  db.prepare("INSERT INTO ai_tokens (token_hash, grant_id, kind, hint, created_at, expires_at) VALUES (?, ?, 'access', ?, ?, ?)").run(t.hash, id, t.hint, now, now + 3_600_000)
  const v = access.verifyBearerToken(t.token, { resource: RESOURCE, now })
  assert.equal(!v.ok && v.reason, 'idle')
  db.prepare('UPDATE ai_grants SET last_used_at = ? WHERE id = ?').run(now - 29 * 86_400_000, id)
  assert.equal(access.verifyBearerToken(t.token, { resource: RESOURCE, now }).ok, true)
  // A personal token unused for 60 days still works until its expiry.
  const pat = mint(['content:read'], { days: 90 }, now - 60 * 86_400_000)
  assert.equal(access.verifyBearerToken(pat.token, { resource: RESOURCE, now }).ok, true)
})

test('touchGrant: first use once, last use at most once a minute, a new country, the client’s self-reported name', () => {
  const events: import('../lib/ai/access').AccessEvent[] = []
  const onEvent = (e: import('../lib/ai/access').AccessEvent) => events.push(e)
  const t0 = Date.now()
  const { grant } = mint(['content:read'], { name: 'Cursor' }, t0)
  const g = () => access.getGrant(grant.id) as import('../lib/ai/access').Grant
  access.touchGrant(g(), { ipPrefix: '198.51.100.0/24', country: 'HK', clientReported: 'Cursor' }, { now: t0, onEvent })
  access.touchGrant(g(), { ipPrefix: '198.51.100.0/24', country: 'HK', clientReported: 'Cursor' }, { now: t0 + 1000, onEvent })
  assert.deepEqual(events, [{ type: 'first-use', grantId: grant.id, label: 'Cursor' }])
  assert.equal(g().firstUsedAt, t0)
  assert.equal(g().lastUsedAt, t0, 'not written again within a minute')
  access.touchGrant(g(), { ipPrefix: '203.0.113.0/24', country: 'HK', clientReported: 'Cursor' }, { now: t0 + 61_000, onEvent })
  assert.equal(g().lastUsedAt, t0 + 61_000)
  assert.equal(g().lastIpPrefix, '203.0.113.0/24')
  assert.equal(g().clientReported, 'Cursor')
  assert.equal(g().clientReportedChangedAt, null)

  // A country this grant was never seen from: one event; one it was seen from (the daily roll-up): none.
  access.touchGrant(g(), { ipPrefix: '203.0.113.0/24', country: 'DE', clientReported: 'Totally Cursor' }, { now: t0 + 62_000, onEvent })
  assert.deepEqual(events.at(-1), { type: 'new-country', grantId: grant.id, label: 'Cursor', country: 'DE' })
  assert.equal(g().lastCountry, 'DE')
  assert.equal(g().clientReported, 'Totally Cursor')
  assert.equal(g().clientReportedChangedAt, t0 + 62_000, 'a changed self-report is flagged')
  aiDb.getAiDb().prepare("INSERT INTO ai_grant_daily (grant_id, day, country, calls) VALUES (?, '2026-01-01', 'HK', 1)").run(grant.id)
  const before = events.length
  access.touchGrant(g(), { ipPrefix: null, country: 'HK', clientReported: null }, { now: t0 + 63_000, onEvent })
  assert.equal(events.length, before, 'seen from HK before')
  for (const country of ['XX', 'T1', 'de', 'DEU', ''])
    access.touchGrant(g(), { ipPrefix: null, country, clientReported: null }, { now: t0 + 64_000, onEvent })
  assert.equal(events.length, before, 'an unknown country is no country')
  assert.equal(g().lastCountry, 'HK')
})

test('pruning on write: tokens 7 days past expiry, grants 90 days after revocation or expiry (with their tokens), codes after an hour', () => {
  const now = Date.now()
  const db = authDb.getAuthDb()
  const old = mint(['content:read'], { days: 7 }, now - 200 * 86_400_000)
  const revoked = mint(['content:read'], { days: 365 }, now - 100 * 86_400_000)
  access.revokeGrant(revoked.grant.id, 'test', now - 95 * 86_400_000)
  const recent = mint(['content:read'], { days: 7 }, now - 10 * 86_400_000)
  db.prepare("INSERT INTO ai_oauth_codes (code_hash, client_id, redirect_uri, code_challenge, scopes, resource, session_version, expires_at) VALUES ('c1', 'x', 'http://127.0.0.1/cb', 'ch', 'content:read', ?, 0, ?)").run(
    RESOURCE,
    now - 2 * 3_600_000,
  )
  access.pruneAccess(now)
  const has = (sql: string, ...args: unknown[]) => !!db.prepare(sql).get(...args)
  assert.equal(has('SELECT 1 FROM ai_grants WHERE id = ?', old.grant.id), false, 'expired 190 days ago')
  assert.equal(has('SELECT 1 FROM ai_tokens WHERE grant_id = ?', old.grant.id), false)
  assert.equal(has('SELECT 1 FROM ai_grants WHERE id = ?', revoked.grant.id), false, 'revoked 95 days ago')
  assert.equal(has('SELECT 1 FROM ai_tokens WHERE grant_id = ?', revoked.grant.id), false)
  assert.equal(has('SELECT 1 FROM ai_grants WHERE id = ?', recent.grant.id), true, 'expired 3 days ago: kept for the owner to see')
  assert.equal(has("SELECT 1 FROM ai_oauth_codes WHERE code_hash = 'c1'"), false)
})

test('executeTool re-checks the grant on every call: revoked or signed out, the next call is refused', async () => {
  const { executeTool } = await import('../lib/ai/execute')
  authDb.getAuthDb().prepare('UPDATE ai_settings SET enabled = 1 WHERE id = 1').run()
  const { grant } = mint(['content:read'])
  const ctx = {
    actor: { kind: 'mcp' as const, grantId: grant.id, label: grant.name },
    scopes: new Set(grant.scopes),
    origin: { ipPrefix: null, country: null },
    era: 'modern' as const,
    requestId: null,
    signal: new AbortController().signal,
  }
  const first = await executeTool('get_authoring_guide', { topic: 'home' }, ctx)
  assert.equal(first.ok, true)
  access.revokeGrant(grant.id, 'test')
  const second = await executeTool('get_authoring_guide', { topic: 'home' }, ctx)
  assert.deepEqual([second.ok, second.code], [false, 'ACCESS_OFF'])
  const other = mint(['content:read'])
  const ctx2 = { ...ctx, actor: { kind: 'mcp' as const, grantId: other.grant.id, label: 'other' } }
  assert.equal((await executeTool('get_authoring_guide', { topic: 'home' }, ctx2)).ok, true)
  admin.bumpSessionVersion()
  assert.equal((await executeTool('get_authoring_guide', { topic: 'home' }, ctx2)).code, 'ACCESS_OFF')
  authDb.getAuthDb().prepare('UPDATE ai_settings SET enabled = 0 WHERE id = 1').run()
})

test('owner alerts: at most one mail per grant, kind and UTC day; the text carries no token', async () => {
  const { aiAlert, alertText } = await import('../lib/ai/alerts')
  process.env.NOTIFY_EMAIL = 'owner@example.test'
  for (const k of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS']) delete process.env[k]
  try {
    const day = Date.UTC(2026, 10, 6, 1)
    const rows = () => (aiDb.getAiDb().prepare("SELECT key, window_start FROM ai_counters WHERE key LIKE 'alert|%' ORDER BY key, window_start").all() as Array<{ key: string; window_start: number }>)
    aiAlert({ type: 'first-use', grantId: 'gA', label: 'laptop' }, day)
    aiAlert({ type: 'first-use', grantId: 'gA', label: 'laptop' }, day + 3_600_000)
    aiAlert({ type: 'new-country', grantId: 'gA', label: 'laptop', country: 'DE' }, day)
    aiAlert({ type: 'first-use', grantId: 'gB', label: 'other' }, day)
    aiAlert({ type: 'first-use', grantId: 'gA', label: 'laptop' }, day + 86_400_000)
    assert.deepEqual(
      rows().map((r) => `${r.key}@${new Date(r.window_start).toISOString().slice(0, 10)}`),
      ['alert|first-use|gA@2026-11-06', 'alert|first-use|gA@2026-11-07', 'alert|first-use|gB@2026-11-06', 'alert|new-country|gA@2026-11-06'],
    )
    const { token } = mint()
    for (const e of [
      { type: 'refused-token' as const, grantId: 'gC', label: 'laptop\nInjected: line', reason: 'revoked' },
      { type: 'grant-issued' as const, grantId: 'gC', label: 'laptop', kind: 'pat' as const },
    ]) {
      const text = alertText(e)
      assert.ok(!text.subject.includes(token) && !text.body.includes(token))
      assert.ok(!/[\r\n]/.test(text.subject), 'one-line subject whatever the label holds')
    }
  } finally {
    delete process.env.NOTIFY_EMAIL
  }
})

// ── The routes (stage M1b) ──────────────────────────────────────────────────

type Out = { statusCode: number; headers: Record<string, string | string[]>; body: any }
type Route = (req: any, res: any) => unknown
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36'
let ipSeq = 0
const SITE = 'http://127.0.0.1:3999'

async function routeOf(p: string): Promise<Route> {
  return (await import(p)).default as Route
}

/** A signed-in browser: its own session row, verified `verifiedAgoMs` ago. */
async function browser(verifiedAgoMs = 0, ttlMs = 3_600_000): Promise<{ sid: string; cookie: string }> {
  const sessions = await import('../lib/adminAuth/sessions')
  const auth = await import('../lib/auth')
  const now = Date.now()
  const sid = sessions.createSession({ method: 'password', ttlMs, verifiedAt: now - verifiedAgoMs, device: 'Chrome on macOS', ipPrefix: null, country: null }, now).id
  return { sid, cookie: `cv_admin_token=${auth.signAdminToken('owner@example.test', { sid })}` }
}

async function call(route: Route, opts: { method: string; body?: unknown; cookie?: string; query?: Record<string, string>; url?: string }): Promise<Out> {
  const cookieHeader = opts.cookie ?? ''
  const [name, ...rest] = cookieHeader.split('=')
  const req = {
    method: opts.method,
    url: opts.url || '/api/admin/ai/test',
    query: opts.query || {},
    body: opts.body,
    cookies: cookieHeader ? { [name]: rest.join('=') } : {},
    headers: { host: '127.0.0.1:3999', 'user-agent': UA, 'cf-connecting-ip': `192.0.2.${(ipSeq++ % 250) + 1}`, ...(cookieHeader ? { cookie: cookieHeader } : {}) },
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

async function settingsOn(mcp = true) {
  const settings = await import('../lib/ai/settings')
  const out = settings.writeAiSettings({ enabled: true, mcpEnabled: mcp }, { steppedUp: true })
  assert.ok(out.ok)
}

async function settingsOff() {
  const settings = await import('../lib/ai/settings')
  settings.writeAiSettings({ enabled: false, mcpEnabled: false }, { steppedUp: false })
}

/** A waiting proposal of `grantId` in ai.db (what M3 writes; here only its state matters). */
function waitingChange(grantId: string, state = 'waiting'): string {
  const id = `ch_${crypto.randomBytes(10).toString('hex').slice(0, 16)}`
  aiDb
    .getAiDb()
    .prepare(
      `INSERT INTO ai_changes (id, state, risk, tool, kind, actor_kind, actor_id, actor_label, issuer_version, target_kind, target_ref, title, args_sha256, preview_sha256, created_at, expires_at)
       VALUES (?, ?, 'live', 'propose_publishing', 'item.publish', 'mcp', ?, 'laptop', 0, 'blog', 'example-post', 'Publish post example-post', ?, ?, ?, ?)`,
    )
    .run(id, state, grantId, 'a'.repeat(64), 'b'.repeat(64), Date.now(), Date.now() + 7 * 86_400_000)
  return id
}
const changeState = (id: string) => (aiDb.getAiDb().prepare('SELECT state, error_code FROM ai_changes WHERE id = ?').get(id) as { state: string; error_code: string | null })

/** The admin password now: the password-route tests change it, one after another. */
let livePassword = ''

/** POST /api/admin/security/password with the current password; remembers the new one when it took. */
async function changePasswordThrough(cookie: string, body: Record<string, unknown>): Promise<Out> {
  const route = await routeOf('../pages/api/admin/security/password')
  const currentPassword = livePassword || (process.env.ADMIN_PASS as string)
  const out = await call(route, { method: 'POST', body: { currentPassword, ...body }, cookie, url: '/api/admin/security/password' })
  if (out.statusCode === 200) livePassword = String(body.newPassword)
  return out
}

/** Make every revoke of a connected app fail in auth.db (what a broken store does), until the returned undo runs. */
function failRevokes(): () => void {
  const db = authDb.getAuthDb()
  db.exec("CREATE TRIGGER test_revoke_fails BEFORE UPDATE OF revoked_at ON ai_grants BEGIN SELECT RAISE(ABORT, 'synthetic store failure'); END")
  return () => db.exec('DROP TRIGGER IF EXISTS test_revoke_fails')
}

/** Grants made through the route by `b` (verified now). */
async function mintThrough(b: { cookie: string }, body: Record<string, unknown> = { name: 'laptop', level: 1, days: 30 }): Promise<Out> {
  return call(await routeOf('../pages/api/admin/ai/tokens'), { method: 'POST', body, cookie: b.cookie })
}

test('tokens route: minting needs a verification within 2 minutes (3 minutes ago is not enough inside the 10-minute window); the token comes out once', async () => {
  process.env.SITE_URL = SITE
  await settingsOn()
  try {
    const stale = await browser(3 * 60_000)
    const before = access.listGrants().length
    const refused = await mintThrough(stale)
    assert.equal(refused.statusCode, 403)
    assert.equal(refused.body.code, 'STEP_UP_REQUIRED')
    assert.equal(access.listGrants().length, before, 'nothing made')
    // The recent check the browser asks first: 3 minutes is recent, but not for a token.
    const recent = await routeOf('../pages/api/admin/security/recent')
    assert.equal((await call(recent, { method: 'GET', cookie: stale.cookie })).body.recent, true)
    assert.equal((await call(recent, { method: 'GET', cookie: stale.cookie, query: { within: '120000' } })).body.recent, false)
    for (const within of ['12', 'abc', '-5', '99999999', ''])
      assert.equal((await call(recent, { method: 'GET', cookie: stale.cookie, query: { within } })).body.recent, true, `within=${within} is ignored`)

    const fresh = await browser(30_000)
    assert.equal((await call(recent, { method: 'GET', cookie: fresh.cookie, query: { within: '120000' } })).body.recent, true)
    const made = await mintThrough(fresh, { name: 'laptop', level: 2, days: 30 })
    assert.equal(made.statusCode, 201, JSON.stringify(made.body))
    assert.match(made.body.token, /^pst_[A-Za-z0-9_-]{43}$/)
    assert.equal(made.headers['cache-control'], 'no-store')
    const { app } = made.body
    assert.deepEqual([app.name, app.level, app.scopes, app.kind, app.createdHere, app.createdDevice, app.hint], ['laptop', 2, ['content:read', 'content:draft'], 'pat', true, 'Chrome on macOS', made.body.token.slice(-4)])
    const grant = access.getGrant(app.id) as import('../lib/ai/access').Grant
    assert.equal(grant.createdSession, fresh.sid)
    assert.equal(grant.resource, `${SITE}/mcp`, 'the audience is SITE_URL’s, never the Host header’s')
    assert.ok(access.verifyBearerToken(made.body.token, { resource: `${SITE}/mcp` }).ok)
    // Listed without the token; only its last four characters.
    const tokens = await routeOf('../pages/api/admin/ai/tokens')
    const list = await call(tokens, { method: 'GET', cookie: fresh.cookie })
    assert.ok(list.body.apps.some((a: { id: string }) => a.id === app.id))
    assert.equal(JSON.stringify(list.body).includes(made.body.token.slice(4, 36)), false)
    assert.deepEqual([list.body.lifetimes, list.body.defaultDays], [[7, 30, 90, 365], 90])
    // Recorded, in Activity (area ai) and the sign-in history.
    const { listAudit } = await import('../lib/audit/store')
    assert.ok(listAudit({ area: 'ai' }).entries.some((e) => e.action === 'ai.token-create' && e.summary === 'Created a personal token for a connected app'))
    const { listAuthEvents } = await import('../lib/adminAuth/store')
    const event = listAuthEvents(10).find((e) => e.type === 'ai-token-created')
    assert.ok(event && event.detail?.includes('laptop') && !event.detail.includes(made.body.token.slice(4, 12)))
    // A token from before sessions (no session row) never counts as fresh.
    const auth = await import('../lib/auth')
    const legacy = await mintThrough({ cookie: `cv_admin_token=${auth.signAdminToken('owner@example.test')}` })
    assert.equal(legacy.statusCode, 403)
  } finally {
    delete process.env.SITE_URL
    await settingsOff()
  }
})

test('tokens route: refused while AI access or connected apps are off, without SITE_URL, and for anything but a listed level, lifetime and name', async () => {
  const b = await browser()
  process.env.SITE_URL = SITE
  try {
    await settingsOff()
    assert.equal((await mintThrough(b)).body.code, 'APPS_OFF')
    await settingsOn(false)
    assert.equal((await mintThrough(b)).body.code, 'APPS_OFF', 'connected apps not allowed')
    await settingsOn(true)
    process.env.AI_DISABLED = '1'
    assert.equal((await mintThrough(b)).body.code, 'APPS_OFF', 'AI_DISABLED beats the switches')
    delete process.env.AI_DISABLED
    for (const [body, field] of [
      [{ name: 'x', level: 0, days: 30 }, 'level'],
      [{ name: 'x', level: 4, days: 30 }, 'level'],
      [{ name: 'x', level: '1', days: 30 }, 'level'],
      [{ name: 'x', level: 1, days: 31 }, 'days'],
      [{ name: 'x', level: 1, days: '90' }, 'days'],
      [{ name: '  ', level: 1, days: 90 }, 'name'],
      [{ level: 1, days: 90 }, 'name'],
    ] as const) {
      const out = await mintThrough(b, body as Record<string, unknown>)
      assert.deepEqual([out.statusCode, out.body.field], [400, field], JSON.stringify(body))
    }
    delete process.env.SITE_URL
    assert.equal((await mintThrough(b)).body.code, 'NO_SITE_URL')
  } finally {
    delete process.env.SITE_URL
    delete process.env.AI_DISABLED
    await settingsOff()
  }
})

test('tokens route: renaming and revoking need no step-up; a revoked token fails on its next request and its waiting changes are withdrawn', async () => {
  process.env.SITE_URL = SITE
  await settingsOn()
  try {
    const owner = await browser()
    const a = (await mintThrough(owner, { name: 'laptop', level: 1, days: 30 })).body
    const c = (await mintThrough(owner, { name: 'cursor', level: 1, days: 7 })).body
    const later = await browser(30 * 60_000) // long past the recent window: tightening asks nothing
    const tokens = await routeOf('../pages/api/admin/ai/tokens')
    const renamed = await call(tokens, { method: 'PATCH', body: { id: a.app.id, name: 'Work laptop\n' }, cookie: later.cookie })
    assert.deepEqual([renamed.statusCode, renamed.body.app.name], [200, 'Work laptop'])
    assert.equal((await call(tokens, { method: 'PATCH', body: { id: a.app.id, name: ' ' }, cookie: later.cookie })).statusCode, 400)

    const waiting = waitingChange(a.app.id)
    const editor = waitingChange(a.app.id, 'in_editor')
    const others = waitingChange(c.app.id)
    const revoked = await call(tokens, { method: 'DELETE', body: { id: a.app.id }, cookie: later.cookie })
    assert.deepEqual([revoked.statusCode, revoked.body.ended], [200, 1])
    const v = access.verifyBearerToken(a.token, { resource: `${SITE}/mcp` })
    assert.equal(!v.ok && v.reason, 'revoked')
    assert.deepEqual(changeState(waiting), { state: 'voided', error_code: 'ISSUER_ENDED' })
    assert.deepEqual(changeState(editor), { state: 'voided', error_code: 'ISSUER_ENDED' })
    assert.equal(changeState(others).state, 'waiting', 'another app’s proposal stays')
    assert.equal((await call(tokens, { method: 'DELETE', body: { id: a.app.id }, cookie: later.cookie })).statusCode, 404, 'already revoked')
    assert.equal((await call(tokens, { method: 'PATCH', body: { id: a.app.id, name: 'again' }, cookie: later.cookie })).statusCode, 404)

    const all = await call(tokens, { method: 'DELETE', body: { all: true }, cookie: later.cookie })
    assert.equal(all.statusCode, 200)
    assert.ok(all.body.ended >= 1)
    assert.equal(access.liveGrants().length, 0)
    assert.equal(changeState(others).state, 'voided')
    // Without a session: nothing.
    assert.equal((await call(tokens, { method: 'GET' })).statusCode, 401)
    assert.equal((await call(tokens, { method: 'POST', body: {} })).statusCode, 401)
  } finally {
    delete process.env.SITE_URL
    await settingsOff()
  }
})

test('sessions route: signing out another browser ends the apps it created; this browser’s own sign-out and a session’s natural end do not', async () => {
  process.env.SITE_URL = SITE
  await settingsOn()
  try {
    const sessionsRoute = await routeOf('../pages/api/admin/security/sessions')
    const me = await browser()
    const thief = await browser()
    const mine = (await mintThrough(me)).body
    const stolen = (await mintThrough(thief, { name: 'not mine', level: 3, days: 365 })).body
    const stolenChange = waitingChange(stolen.app.id)
    const out = await call(sessionsRoute, { method: 'DELETE', body: { id: thief.sid }, cookie: me.cookie })
    assert.deepEqual([out.statusCode, out.body.aiAppsEnded], [200, 1])
    assert.equal(access.liveGrant(stolen.app.id), null)
    assert.equal(access.getGrant(stolen.app.id)?.revokeReason, 'created from a browser that was signed out')
    assert.deepEqual(changeState(stolenChange), { state: 'voided', error_code: 'ISSUER_ENDED' })
    assert.ok(access.liveGrant(mine.app.id), 'this browser’s app stays')

    // A session that ends on its own: its apps stay.
    const shortLived = await browser(0, 60_000)
    const kept = (await mintThrough(shortLived)).body
    const sessions = await import('../lib/adminAuth/sessions')
    sessions.pruneSessions(Date.now() + 2 * 3_600_000)
    assert.ok(access.liveGrant(kept.app.id), 'a natural end is no compromise')

    // Signing out this browser itself: its apps stay.
    const own = await call(sessionsRoute, { method: 'DELETE', body: { id: me.sid }, cookie: me.cookie })
    assert.deepEqual([own.statusCode, own.body.aiAppsEnded], [200, 0])
    assert.ok(access.liveGrant(mine.app.id))
    // endAiApps only goes with { others: true }.
    const other = await browser()
    assert.equal((await call(sessionsRoute, { method: 'DELETE', body: { id: thief.sid, endAiApps: true }, cookie: other.cookie })).statusCode, 400)
    assert.equal((await call(sessionsRoute, { method: 'DELETE', body: { others: true, endAiApps: 'yes' }, cookie: other.cookie })).statusCode, 400)
  } finally {
    delete process.env.SITE_URL
    access.revokeGrants({ all: true }, 'test clean-up')
    await settingsOff()
  }
})

test('sessions route: "Sign out other browsers" ends every app when ticked (the default); unticked, only the apps those browsers created', async () => {
  process.env.SITE_URL = SITE
  await settingsOn()
  try {
    const sessionsRoute = await routeOf('../pages/api/admin/security/sessions')
    const me = await browser()
    const phone = await browser()
    const mine = (await mintThrough(me)).body
    const phones = (await mintThrough(phone)).body
    const unticked = await call(sessionsRoute, { method: 'DELETE', body: { others: true, endAiApps: false }, cookie: me.cookie })
    assert.equal(unticked.statusCode, 200)
    assert.ok(unticked.body.revoked >= 1)
    assert.equal(unticked.body.aiAppsEnded, 1)
    assert.equal(access.liveGrant(phones.app.id), null, 'created by a browser just signed out')
    assert.ok(access.liveGrant(mine.app.id), 'unticked: this browser’s app stays')

    const tablet = await browser()
    const tablets = (await mintThrough(tablet)).body
    const ticked = await call(sessionsRoute, { method: 'DELETE', body: { others: true }, cookie: me.cookie })
    assert.deepEqual([ticked.statusCode, ticked.body.aiAppsEnded], [200, 2])
    assert.equal(access.liveGrant(mine.app.id), null)
    assert.equal(access.liveGrant(tablets.app.id), null)
    assert.equal(access.liveGrants().length, 0)
    const { listAuthEvents } = await import('../lib/adminAuth/store')
    assert.ok(listAuthEvents(10).some((e) => e.type === 'ai-apps-ended' && e.detail === '2 ended with the other browsers'))
  } finally {
    delete process.env.SITE_URL
    await settingsOff()
  }
})

test('sessions route: "Sign out everywhere" ends every app — the session version moves and each is revoked', async () => {
  process.env.SITE_URL = SITE
  await settingsOn()
  try {
    const sessionsRoute = await routeOf('../pages/api/admin/security/sessions')
    const me = await browser()
    const app = (await mintThrough(me)).body
    const change = waitingChange(app.app.id)
    const out = await call(sessionsRoute, { method: 'DELETE', body: { all: true }, cookie: me.cookie })
    assert.deepEqual([out.statusCode, out.body.aiAppsEnded], [200, 1])
    assert.equal(access.getGrant(app.app.id)?.revokeReason, 'ended by signing out everywhere')
    const v = access.verifyBearerToken(app.token, { resource: `${SITE}/mcp` })
    assert.equal(v.ok, false)
    assert.equal(changeState(change).state, 'voided')
  } finally {
    delete process.env.SITE_URL
    await settingsOff()
  }
})

test('password route: signing the others out ends every app; keeping them ends every app unless endAiApps is false, which keeps them tied to the renewed session', async () => {
  process.env.SITE_URL = SITE
  await settingsOn()
  const change = changePasswordThrough
  try {
    // Keeping the other browsers, "Also end all AI apps" unticked: kept, and they follow this browser's new session.
    const me = await browser()
    const app = (await mintThrough(me)).body
    const kept = await change(me.cookie, { newPassword: 'a quiet harbour at dawn 41', signOutOthers: false, endAiApps: false })
    assert.equal(kept.statusCode, 200, JSON.stringify(kept.body))
    assert.equal(kept.body.aiAppsEnded, 0)
    assert.equal('renewed' in kept.body, false, 'the session hand-over is not sent to the browser')
    assert.ok(access.liveGrant(app.app.id))
    const renewedSid = (access.getGrant(app.app.id) as import('../lib/ai/access').Grant).createdSession
    assert.ok(renewedSid && renewedSid !== me.sid, 'tied to the re-issued session')
    const setCookie = ([] as string[]).concat(kept.headers['set-cookie'] || []).find((c) => c.startsWith('cv_admin_token=') && !/Max-Age=0/.test(c))
    const renewedCookie = (setCookie || '').split(';')[0]
    assert.ok(renewedCookie)

    // Signing that browser out from another one later still ends its app.
    const other = await browser()
    const sessionsRoute = await routeOf('../pages/api/admin/security/sessions')
    const signedOut = await call(sessionsRoute, { method: 'DELETE', body: { id: renewedSid }, cookie: other.cookie })
    assert.deepEqual([signedOut.statusCode, signedOut.body.aiAppsEnded], [200, 1])
    assert.equal(access.liveGrant(app.app.id), null)

    // Keeping the others, ticked (the default): every app ends.
    const me2 = await browser()
    const app2 = (await mintThrough(me2)).body
    const ticked = await change(me2.cookie, { newPassword: 'a quiet harbour at dawn 42', signOutOthers: false })
    assert.deepEqual([ticked.statusCode, ticked.body.aiAppsEnded], [200, 1])
    assert.equal(access.getGrant(app2.app.id)?.revokeReason, 'ended by a password change')

    // Signing the others out: every app ends whatever endAiApps says.
    const me3 = await browser()
    const app3 = (await mintThrough(me3)).body
    const everywhere = await change(me3.cookie, { newPassword: 'a quiet harbour at dawn 43', signOutOthers: true, endAiApps: false })
    assert.deepEqual([everywhere.statusCode, everywhere.body.aiAppsEnded], [200, 1])
    assert.equal(access.verifyBearerToken(app3.token, { resource: `${SITE}/mcp` }).ok, false)
    // A bad endAiApps is refused like any other unknown shape.
    const me4 = await browser()
    assert.equal((await change(me4.cookie, { newPassword: 'a quiet harbour at dawn 44', endAiApps: 'no' })).statusCode, 400)
  } finally {
    delete process.env.SITE_URL
    await settingsOff()
  }
})

test('settings route: every loosening asks for a recent verification, no tightening does, the ceiling holds; turning on mails and is recorded', async () => {
  const settingsRoute = await routeOf('../pages/api/admin/ai/settings')
  const settings = await import('../lib/ai/settings')
  const stale = await browser(30 * 60_000)
  const fresh = await browser()
  const patch = (b: { cookie: string }, body: unknown) => call(settingsRoute, { method: 'PATCH', body, cookie: b.cookie, url: '/api/admin/ai/settings' })
  await settingsOff()
  settings.writeAiSettings({ autoApplyDrafts: false, keepConversationsDays: 30, dailyTokenLimit: 1_000_000 }, { steppedUp: false })
  const loosening: Array<Record<string, unknown>> = [
    { enabled: true },
    { mcpEnabled: true },
    { autoApplyDrafts: true },
    { keepConversationsDays: 90 },
    { keepConversationsDays: -1 },
    { dailyTokenLimit: 2_000_000 },
  ]
  for (const body of loosening) {
    const out = await patch(stale, body)
    assert.deepEqual([out.statusCode, out.body.code], [403, 'STEP_UP_REQUIRED'], JSON.stringify(body))
  }
  const unchanged = settings.readAiSettings()
  assert.deepEqual([unchanged.enabled, unchanged.mcpEnabled, unchanged.autoApplyDrafts, unchanged.keepConversationsDays, unchanged.dailyTokenLimit], [false, false, false, 30, 1_000_000])
  // Tightening never asks.
  for (const body of [{ enabled: false }, { mcpEnabled: false }, { autoApplyDrafts: false }, { keepConversationsDays: 7 }, { keepConversationsDays: 0 }, { dailyTokenLimit: 10 }]) {
    assert.equal((await patch(stale, body)).statusCode, 200, JSON.stringify(body))
  }
  // The ceiling and the shape hold even for a fresh verification.
  for (const body of [{ dailyTokenLimit: 20_000_001 }, { keepConversationsDays: 3651 }, { enabled: 'yes' }, { pairingId: 'x' }, [], { endApps: true }]) {
    assert.equal((await patch(fresh, body)).statusCode, 400, JSON.stringify(body))
  }
  assert.equal((await patch(fresh, { dailyTokenLimit: 20_000_000 })).statusCode, 200)

  // Turning on: verified, recorded, one mail claim per kind per day for the site.
  process.env.NOTIFY_EMAIL = 'owner@example.test'
  try {
    aiDb.getAiDb().prepare("DELETE FROM ai_counters WHERE key LIKE 'alert|enabled|%' OR key LIKE 'alert|apps-allowed|%'").run()
    const on = await patch(fresh, { enabled: true, mcpEnabled: true })
    assert.equal(on.statusCode, 200, JSON.stringify(on.body))
    assert.deepEqual([on.body.settings.enabled, on.body.settings.mcpEnabled, on.body.access.enabled], [true, true, true])
    const claims = aiDb.getAiDb().prepare("SELECT key FROM ai_counters WHERE key LIKE 'alert|enabled|%' OR key LIKE 'alert|apps-allowed|%' ORDER BY key").all() as Array<{ key: string }>
    assert.deepEqual(claims.map((r) => r.key), ['alert|apps-allowed|site', 'alert|enabled|site'])
    const { listAudit } = await import('../lib/audit/store')
    const actions = listAudit({ area: 'ai' }).entries.map((e) => e.action)
    assert.ok(actions.includes('ai.enable') && actions.includes('ai.apps-allow'))
  } finally {
    delete process.env.NOTIFY_EMAIL
  }

  // Turning off: instant, withdraws every open change; endApps also revokes every app.
  process.env.SITE_URL = SITE
  try {
    const app = (await mintThrough(fresh)).body
    const w = waitingChange('g-assistant-run-or-any')
    const appChange = waitingChange(app.app.id)
    const off = await patch(stale, { enabled: false })
    assert.deepEqual([off.statusCode, off.body.endedApps], [200, 0])
    assert.deepEqual(changeState(w), { state: 'voided', error_code: 'ACCESS_OFF' })
    assert.equal(changeState(appChange).state, 'voided')
    assert.ok(access.liveGrant(app.app.id), 'off pauses: the app resumes when AI access is back')
    assert.equal((await patch(fresh, { enabled: true })).statusCode, 200)
    const ended = await patch(stale, { enabled: false, endApps: true })
    assert.deepEqual([ended.statusCode, ended.body.endedApps], [200, 1])
    assert.equal(access.liveGrant(app.app.id), null)
    const { listAudit } = await import('../lib/audit/store')
    assert.equal(listAudit({ area: 'ai' }).entries[0].summary, 'Turned off AI access and ended the connected app')
    // GET reads the state without a step-up, and only for the admin.
    assert.equal((await call(settingsRoute, { method: 'GET', cookie: stale.cookie })).body.settings.enabled, false)
    assert.equal((await call(settingsRoute, { method: 'GET' })).statusCode, 401)
  } finally {
    delete process.env.SITE_URL
    await settingsOff()
  }
})

test('when revoking the apps fails, each route says so: the sign-out and the password stand, aiAppsError is set where an app may still act, and the switch answers 200 with its stored state', async () => {
  process.env.SITE_URL = SITE
  await settingsOn()
  const sessionsRoute = await routeOf('../pages/api/admin/security/sessions')
  const settingsRoute = await routeOf('../pages/api/admin/ai/settings')
  const sessions = await import('../lib/adminAuth/sessions')
  const undo = failRevokes()
  try {
    // One other browser: signed out all the same; its app is still live, and the answer says so.
    const me = await browser()
    const thief = await browser()
    const stolen = (await mintThrough(thief, { name: 'not mine', level: 1, days: 7 })).body
    const one = await call(sessionsRoute, { method: 'DELETE', body: { id: thief.sid }, cookie: me.cookie })
    assert.deepEqual([one.statusCode, one.body.ok, one.body.aiAppsEnded, one.body.aiAppsError], [200, true, 0, true])
    assert.ok(sessions.getSession(thief.sid)?.revokedAt, 'the browser is signed out whatever happened to its apps')
    assert.ok(access.liveGrant(stolen.app.id), 'the failure is real: the app is still live')

    // Every other browser, ticked or unticked: the same.
    for (const body of [{ others: true }, { others: true, endAiApps: false }]) {
      const phone = await browser()
      await mintThrough(phone)
      const out = await call(sessionsRoute, { method: 'DELETE', body, cookie: me.cookie })
      assert.deepEqual([out.statusCode, out.body.aiAppsEnded, out.body.aiAppsError], [200, 0, true], JSON.stringify(body))
      assert.ok(sessions.getSession(phone.sid)?.revokedAt, JSON.stringify(body))
    }

    // A password change keeping the others, with "Also end all AI apps": changed, and the apps may still act.
    const kept = await changePasswordThrough(me.cookie, { newPassword: 'a quiet harbour at dawn 51', signOutOthers: false })
    assert.deepEqual([kept.statusCode, kept.body.ok, kept.body.aiAppsEnded, kept.body.aiAppsError], [200, true, 0, true])
    assert.ok(access.liveGrant(stolen.app.id))

    // Switching connected apps off with endApps: 200 with the stored state (not a 500 after the switch moved).
    const owner = await browser() // the password change re-issued me's session
    const off = await call(settingsRoute, { method: 'PATCH', body: { mcpEnabled: false, endApps: true }, cookie: owner.cookie, url: '/api/admin/ai/settings' })
    assert.equal(off.statusCode, 200, JSON.stringify(off.body))
    assert.deepEqual([off.body.settings.mcpEnabled, off.body.access.mcpEnabled, off.body.endedApps, off.body.endAppsError], [false, false, 0, true])
    const settings = await import('../lib/ai/settings')
    assert.equal(settings.readAiSettings().mcpEnabled, false)
    const { listAudit } = await import('../lib/audit/store')
    assert.equal(listAudit({ area: 'ai' }).entries[0].summary, 'Stopped connected apps; revoking the connected apps failed')
    // And with AI access itself.
    const masterOff = await call(settingsRoute, { method: 'PATCH', body: { enabled: false, endApps: true }, cookie: owner.cookie, url: '/api/admin/ai/settings' })
    assert.deepEqual([masterOff.statusCode, masterOff.body.settings.enabled, masterOff.body.endAppsError], [200, false, true])
    assert.equal(listAudit({ area: 'ai' }).entries[0].summary, 'Turned off AI access; revoking the connected apps failed')
    assert.ok(access.liveGrant(stolen.app.id), 'refused while off, still not revoked: hence the warning')

    // Where the session version moves, no app can act whether or not the revoke went through: no error flag.
    const signedOut = await changePasswordThrough((await browser()).cookie, { newPassword: 'a quiet harbour at dawn 52', signOutOthers: true })
    assert.deepEqual([signedOut.statusCode, signedOut.body.aiAppsError], [200, false])
    assert.equal(access.liveGrant(stolen.app.id), null, 'the version moved')
    await settingsOn()
    const last = await browser()
    const app = (await mintThrough(last)).body
    const everywhere = await call(sessionsRoute, { method: 'DELETE', body: { all: true }, cookie: last.cookie })
    assert.deepEqual([everywhere.statusCode, everywhere.body.aiAppsError], [200, false])
    assert.equal(access.verifyBearerToken(app.token, { resource: `${SITE}/mcp` }).ok, false)
  } finally {
    undo()
    delete process.env.SITE_URL
    access.revokeGrants({ all: true }, 'test clean-up')
    await settingsOff()
  }
  // Without the failure the flags are false again.
  process.env.SITE_URL = SITE
  await settingsOn()
  try {
    const me = await browser()
    const other = await browser()
    await mintThrough(other)
    const out = await call(sessionsRoute, { method: 'DELETE', body: { id: other.sid }, cookie: me.cookie })
    assert.deepEqual([out.statusCode, out.body.aiAppsEnded, out.body.aiAppsError], [200, 1, false])
    const off = await call(settingsRoute, { method: 'PATCH', body: { enabled: false, endApps: true }, cookie: me.cookie, url: '/api/admin/ai/settings' })
    assert.deepEqual([off.statusCode, off.body.endAppsError], [200, false])
  } finally {
    delete process.env.SITE_URL
    access.revokeGrants({ all: true }, 'test clean-up')
    await settingsOff()
  }
})

test('catalogue and summary routes, and the Security page’s count of AI apps per browser', async () => {
  process.env.SITE_URL = SITE
  await settingsOn()
  try {
    const me = await browser()
    const other = await browser()
    await mintThrough(me)
    await mintThrough(me, { name: 'cursor', level: 2, days: 7 })
    await mintThrough(other)
    const { catalogueView } = await import('../lib/ai/registry')
    const catalogue = await call(await routeOf('../pages/api/admin/ai/catalogue'), { method: 'GET', cookie: me.cookie })
    assert.deepEqual(catalogue.body.tools, JSON.parse(JSON.stringify(catalogueView())))
    assert.ok(catalogue.body.tools.every((t: Record<string, unknown>) => !('inputSchema' in t) && !('wire' in t)), 'never a schema')
    assert.deepEqual(catalogue.body.levels.map((l: { scopes: string[] }) => l.scopes.length), [1, 2, 3])

    const summary = await call(await routeOf('../pages/api/admin/ai/summary'), { method: 'GET', cookie: me.cookie })
    assert.equal(summary.body.apps.connected, 3)
    assert.equal(summary.body.waiting, 0)
    assert.deepEqual([summary.body.access.enabled, summary.body.access.mcpEnabled, summary.body.access.open, summary.body.access.server], [true, true, true, `${SITE}/mcp`])

    const security = await call(await routeOf('../pages/api/admin/security/index'), { method: 'GET', cookie: me.cookie })
    assert.equal(security.statusCode, 200)
    assert.deepEqual(security.body.ai, { apps: 3, reachable: true, bySession: { [me.sid]: 2, [other.sid]: 1 } })
    await settingsOff()
    const closed = await call(await routeOf('../pages/api/admin/security/index'), { method: 'GET', cookie: me.cookie })
    assert.equal(closed.body.ai.reachable, false)
    for (const r of ['../pages/api/admin/ai/catalogue', '../pages/api/admin/ai/summary']) assert.equal((await call(await routeOf(r), { method: 'GET' })).statusCode, 401)
  } finally {
    delete process.env.SITE_URL
    access.revokeGrants({ all: true }, 'test clean-up')
    await settingsOff()
  }
})
