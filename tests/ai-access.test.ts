/**
 * M1 — connected apps' tokens and grants (lib/ai/access, design §5.4), the
 * owner alerts' daily cap (lib/ai/alerts), and executeTool's re-check of the
 * grant on every call. The routes that mint tokens, and the session and
 * password routes that end grants, are stage M1b's; here is everything they
 * build on, against a real auth.db and admin.json in a temp directory.
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
  const prepare = db.prepare.bind(db)
  let reads = 0
  ;(db as unknown as { prepare: unknown }).prepare = (sql: string) => {
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
    ;(db as unknown as { prepare: unknown }).prepare = prepare
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
