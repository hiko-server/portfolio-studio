/**
 * M1 — pages/api/mcp.ts on a real socket (tests/helpers/realRoute.ts), in the
 * order design §6.3 gives: method, switches, scheme, Host, Origin, the
 * failed-authentication budget, the bearer token, the grant's budget, the
 * body (cap, type, JSON, no batches), the scope of a tools/call, then the
 * SDK in both protocol eras. Tokens are minted through lib/ai/access on a
 * throw-away store; every client address is a documentation address
 * (198.51.100.0/24, 203.0.113.0/24) given through cf-connecting-ip, which the
 * route believes from loopback only.
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { editorialHarness } from './editorialHarness'
import type { RealRoute } from './helpers/realRoute'

const h = editorialHarness('ai-mcp-route', 'ai-mcp-route-secret-0123456789abcdef0123')
let route: RealRoute
let access: typeof import('../lib/ai/access')
let aiDb: typeof import('../lib/ai/db')
let authDb: typeof import('../lib/adminAuth/db')
let tokens: { read: string; draft: string; propose: string }
let client = 0
/** A fresh documentation address per call site, so budgets never leak between tests. */
const ip = () => `198.51.100.${(++client % 250) + 1}`

const LEGACY_ACCEPT = 'application/json, text/event-stream'
const MODERN = '2026-07-28'

before(async () => {
  await h.setup()
  const { startRealRoute } = await import('./helpers/realRoute')
  route = await startRealRoute(await import('../pages/api/mcp'))
  process.env.SITE_URL = route.origin
  delete process.env.NEXT_PUBLIC_SITE_HOST
  access = await import('../lib/ai/access')
  aiDb = await import('../lib/ai/db')
  authDb = await import('../lib/adminAuth/db')
  const mint = (scopes: string[], name: string) => {
    const out = access.createPersonalToken({ name, scopes, days: 30, resource: `${route.origin}/mcp`, session: { id: null, device: 'Test browser' } })
    if (!out.ok) throw new Error(JSON.stringify(out))
    return out.token
  }
  tokens = {
    read: mint(['content:read'], 'read token'),
    draft: mint(['content:read', 'content:draft'], 'draft token'),
    propose: mint(['content:read', 'content:draft', 'content:propose'], 'propose token'),
  }
})
after(async () => {
  await route.close()
  const { closeAuditDb } = await import('../lib/audit/db')
  closeAuditDb()
  delete process.env.SITE_URL
  h.teardown()
})
beforeEach(() => {
  delete process.env.AI_DISABLED
  process.env.SITE_URL = route.origin
  delete process.env.NEXT_PUBLIC_SITE_HOST
  authDb.getAuthDb().prepare('UPDATE ai_settings SET enabled = 1, mcp_enabled = 1 WHERE id = 1').run()
})

type Opts = { method?: string; token?: string | null; headers?: Record<string, string>; body?: unknown; raw?: string | Buffer; path?: string; from?: string }

async function call(opts: Opts = {}) {
  const headers: Record<string, string> = {
    host: new URL(route.origin).host,
    'content-type': 'application/json',
    accept: LEGACY_ACCEPT,
    'cf-connecting-ip': opts.from ?? ip(),
    ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    ...(opts.headers ?? {}),
  }
  for (const [k, v] of Object.entries(headers)) if (v === '') delete headers[k]
  const body = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body))
  const res = await route.raw({ method: opts.method ?? 'POST', path: opts.path ?? '/', headers, body })
  let json: any = null
  try {
    json = JSON.parse(res.body)
  } catch {
    json = null
  }
  return { ...res, json }
}

const rpc = (method: string, params: Record<string, unknown> = {}, id = 1) => ({ jsonrpc: '2.0', id, method, params })

/** A modern (2026-07-28) request: the envelope in `_meta` and the matching headers. */
function modern(method: string, params: Record<string, unknown> = {}, name?: string) {
  return {
    body: rpc(method, { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { name: 'route test', version: '1' } } }),
    headers: { 'mcp-protocol-version': MODERN, 'mcp-method': method, ...(name ? { 'mcp-name': name } : {}) },
  }
}

/** A token of its own, so one test's traffic never spends another's grant budget. */
function fresh(scopes: string[]): string {
  const out = access.createPersonalToken({ name: `fresh ${++client}`, scopes, days: 7, resource: `${route.origin}/mcp`, session: { id: null, device: null } })
  if (!out.ok) throw new Error(JSON.stringify(out))
  return out.token
}

const callCount = () => (aiDb.getAiDb().prepare('SELECT COUNT(*) AS n FROM ai_tool_calls').get() as { n: number }).n

test('1. anything but POST: 405 with Allow, before routing (no session, no stream)', async () => {
  for (const method of ['GET', 'DELETE', 'PUT', 'PATCH', 'OPTIONS']) {
    const res = await call({ method, token: tokens.read })
    assert.equal(res.status, 405, method)
    assert.equal(res.headers.allow, 'POST', method)
    assert.equal(res.headers['cache-control'], 'no-store', method)
    assert.equal(res.headers['mcp-session-id'], undefined)
    assert.equal(res.json.error.code, -32000)
  }
})

test('2. closed: a bare 404 whatever the request carries (off, connected apps off, no SITE_URL, AI_DISABLED)', async () => {
  const closers: Array<[string, () => void]> = [
    ['off', () => authDb.getAuthDb().prepare('UPDATE ai_settings SET enabled = 0 WHERE id = 1').run()],
    ['apps off', () => authDb.getAuthDb().prepare('UPDATE ai_settings SET mcp_enabled = 0 WHERE id = 1').run()],
    ['AI_DISABLED', () => void (process.env.AI_DISABLED = '1')],
    ['no SITE_URL', () => void delete process.env.SITE_URL],
  ]
  for (const [label, close] of closers) {
    close()
    const before = callCount()
    const res = await call({ token: tokens.propose, body: rpc('tools/list') })
    assert.equal(res.status, 404, label)
    assert.equal(res.body, '', `${label}: no body`)
    assert.equal(res.headers['www-authenticate'], undefined, label)
    assert.equal(callCount(), before, `${label}: nothing ran`)
    delete process.env.AI_DISABLED
    process.env.SITE_URL = route.origin
    authDb.getAuthDb().prepare('UPDATE ai_settings SET enabled = 1, mcp_enabled = 1 WHERE id = 1').run()
  }
})

test('3. plain http while the site has a public host: 403 (a POST is never redirected)', async () => {
  process.env.SITE_URL = 'https://site.example'
  for (const scheme of [{ 'x-forwarded-proto': 'http' }, { 'cf-visitor': '{"scheme":"http"}' }] as Array<Record<string, string>>) {
    const res = await call({ token: tokens.read, body: rpc('tools/list'), headers: { host: 'site.example', ...scheme } })
    assert.equal(res.status, 403, JSON.stringify(scheme))
    assert.match(res.json.error.message, /https/)
  }
})

test('4. Host must be exactly SITE_URL’s host and port; X-Forwarded-Host is ignored; rebinding refused; local-only names the URL', async () => {
  const port = new URL(route.origin).port
  const resource = `${route.origin}/mcp`
  for (const host of [`localhost:${port}`, `evil.example:${port}`, '127.0.0.1', `127.0.0.1:${Number(port) + 1}`, `rebind.example`]) {
    const res = await call({ token: tokens.read, body: rpc('tools/list'), headers: { host } })
    assert.equal(res.status, 403, host)
    assert.equal(res.json.error.message, `Wrong address for this server. Use ${resource}`, host)
  }
  const forwarded = await call({ token: tokens.read, body: rpc('tools/list'), headers: { host: 'evil.example', 'x-forwarded-host': new URL(route.origin).host } })
  assert.equal(forwarded.status, 403)
  // With a public host, the answer names nothing.
  process.env.SITE_URL = 'https://site.example'
  const pub = await call({ token: tokens.read, body: rpc('tools/list'), headers: { host: 'other.example', 'x-forwarded-proto': 'https' } })
  assert.equal(pub.status, 403)
  assert.equal(pub.json.error.message, 'Wrong address for this server.')
})

test('5. Origin: absent, the site’s own and known AI clients pass; anything else is 403 with a JSON-RPC error and no id', async () => {
  for (const origin of [undefined, route.origin, 'https://claude.ai', 'https://chatgpt.com', 'https://vscode.dev', 'http://localhost:6274', 'http://127.0.0.1:9']) {
    const res = await call({ token: tokens.read, body: rpc('tools/list'), headers: origin ? { origin } : {} })
    assert.equal(res.status, 200, String(origin))
  }
  for (const origin of ['https://evil.example', 'null', 'http://claude.ai', 'https://claude.ai:8443', 'https://claude.ai.evil.example', 'https://claude.ai/path', 'not a url']) {
    const res = await call({ token: tokens.read, body: rpc('tools/list', {}, 7), headers: { origin } })
    assert.equal(res.status, 403, origin)
    assert.deepEqual(res.json, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Origin not allowed.' } }, origin)
  }
  // Loopback origins only while the site is local-only.
  process.env.SITE_URL = 'https://site.example'
  const loop = await call({ token: tokens.read, body: rpc('tools/list'), headers: { host: 'site.example', 'x-forwarded-proto': 'https', origin: 'http://localhost:6274' } })
  assert.equal(loop.status, 403)
})

test('6/7. no token, a cookie, a query-string token: 401 with the resource metadata and scope; nothing charged', async () => {
  const metadata = `${route.origin}/.well-known/oauth-protected-resource/mcp`
  const from = ip()
  const variants: Opts[] = [
    { token: null },
    { token: null, headers: { cookie: 'cv_admin_token=anything' } },
    { token: null, path: `/?access_token=${tokens.read}` },
    { token: null, headers: { authorization: `Basic ${Buffer.from('a:b').toString('base64')}` } },
  ]
  for (const v of variants) {
    const res = await call({ ...v, from, body: rpc('tools/list') })
    assert.equal(res.status, 401, JSON.stringify(v))
    assert.equal(res.headers['www-authenticate'], `Bearer scope="content:read", resource_metadata="${metadata}"`)
    assert.equal(res.headers['cache-control'], 'no-store')
  }
  // A missing token never spends the failed-authentication budget: 70 of them, then a valid call.
  for (let i = 0; i < 70; i++) assert.equal((await call({ token: null, from, body: rpc('tools/list') })).status, 401)
  assert.equal((await call({ token: tokens.read, from, body: rpc('tools/list') })).status, 200)
})

test('7. an invalid, expired, revoked or foreign token: 401 invalid_token; one with our tag is recorded, a forged one is not', async () => {
  const metadata = `${route.origin}/.well-known/oauth-protected-resource/mcp`
  const challenge = `Bearer error="invalid_token", error_description="The token is invalid, expired or revoked.", resource_metadata="${metadata}"`
  const before = callCount()
  const forged = `pst_${'A'.repeat(43)}`
  for (const bad of [forged, 'not-a-token', `${tokens.read}x`, tokens.read.slice(0, -1) + (tokens.read.endsWith('A') ? 'B' : 'A')]) {
    const res = await call({ token: bad, body: rpc('tools/list') })
    assert.equal(res.status, 401, bad.slice(0, 8))
    assert.equal(res.headers['www-authenticate'], challenge)
  }
  assert.equal(callCount(), before, 'a token without our tag writes nothing')

  const revoked = access.createPersonalToken({ name: 'to revoke', scopes: ['content:read'], days: 7, resource: `${route.origin}/mcp`, session: { id: null, device: null } })
  assert.ok(revoked.ok)
  if (!revoked.ok) return
  assert.equal((await call({ token: revoked.token, body: rpc('tools/list') })).status, 200)
  assert.equal(access.revokeGrant(revoked.grant.id, 'test'), true)
  const res = await call({ token: revoked.token, body: rpc('tools/list') })
  assert.equal(res.status, 401)
  const row = aiDb.getAiDb().prepare("SELECT * FROM ai_tool_calls WHERE tool = '(http)' ORDER BY id DESC LIMIT 1").get() as Record<string, unknown>
  assert.equal(row.actor_id, revoked.grant.id)
  assert.equal(row.outcome, 'refused')
  assert.equal(row.code, 'revoked')

  // Another resource: a token minted for another address of this site.
  const other = access.createPersonalToken({ name: 'other resource', scopes: ['content:read'], days: 7, resource: 'https://elsewhere.example/mcp', session: { id: null, device: null } })
  assert.ok(other.ok)
  if (other.ok) assert.equal((await call({ token: other.token, body: rpc('tools/list') })).status, 401)
})

test('6. the failed-authentication budget: charged only on failure, then 429 with Retry-After before any verification', async () => {
  const from = ip()
  for (let i = 0; i < 60; i++) assert.equal((await call({ token: `pst_${'B'.repeat(43)}`, from, body: rpc('tools/list') })).status, 401)
  const blocked = await call({ token: tokens.read, from, body: rpc('tools/list') })
  assert.equal(blocked.status, 429)
  assert.ok(Number(blocked.headers['retry-after']) > 0)
  // Another client is not blocked, and valid traffic never spends the budget: 60 valid requests (a grant's minute),
  // then failures from that client still start from zero.
  const other = ip()
  const busy = fresh(['content:read'])
  for (let i = 0; i < 60; i++) assert.equal((await call({ token: busy, from: other, body: rpc('ping', {}, i) })).status, 200)
  for (let i = 0; i < 59; i++) assert.equal((await call({ token: `pst_${'C'.repeat(43)}`, from: other, body: rpc('ping') })).status, 401)
  assert.equal((await call({ token: fresh(['content:read']), from: other, body: rpc('ping') })).status, 200, 'the 60th failure has not happened yet')
})

test('9. the body: 512 KB cap before parsing (413), JSON only (415), bad JSON (400 -32700)', async () => {
  const big = Buffer.alloc(512 * 1024 + 1, 0x20)
  const over = await call({ token: tokens.read, raw: big })
  assert.equal(over.status, 413)
  const ping = Buffer.from(JSON.stringify(rpc('ping')))
  const at = await call({ token: tokens.read, raw: Buffer.concat([ping, Buffer.alloc(512 * 1024 - ping.length, 0x20)]) })
  assert.equal(at.status, 200, 'exactly under the cap is read')
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', '']) {
    const res = await call({ token: tokens.read, body: rpc('tools/list'), headers: { 'content-type': type } })
    assert.equal(res.status, 415, type)
  }
  const bad = await call({ token: tokens.read, raw: '{"jsonrpc":"2.0",' })
  assert.equal(bad.status, 400)
  assert.equal(bad.json.error.code, -32700)
})

test('10. batches: an array of one, of 100 and a nested array are 400 -32600, and no tool runs', async () => {
  const before = callCount()
  const one = [rpc('tools/call', { name: 'get_authoring_guide', arguments: { topic: 'mdx' } })]
  const hundred = Array.from({ length: 100 }, (_, i) => rpc('tools/call', { name: 'get_authoring_guide', arguments: { topic: 'mdx' } }, i))
  for (const body of [one, hundred, [one], [], [rpc('tools/call', { name: 'list_versions', arguments: { collection: 'cv' } })]]) {
    const res = await call({ token: tokens.read, body })
    assert.equal(res.status, 400)
    assert.equal(res.json.error.code, -32600)
  }
  assert.equal(callCount(), before)
})

test('11. a tools/call beyond the grant’s scope: 403 insufficient_scope with held and required scopes, decided from the body', async () => {
  const metadata = `${route.origin}/.well-known/oauth-protected-resource/mcp`
  const before = callCount()
  const res = await call({ token: tokens.read, body: rpc('tools/call', { name: 'list_versions', arguments: { collection: 'cv' } }), headers: { 'mcp-name': 'get_authoring_guide' } })
  assert.equal(res.status, 403)
  assert.equal(
    res.headers['www-authenticate'],
    `Bearer error="insufficient_scope", error_description="list_versions needs content:draft.", scope="content:read content:draft", resource_metadata="${metadata}"`,
  )
  assert.equal(res.json.error, 'insufficient_scope')
  assert.equal(res.json.scope, 'content:read content:draft')
  assert.equal(callCount(), before, 'nothing ran')
  // The header can't talk its way in either: the body names an allowed tool, the header another.
  const allowed = await call({ token: tokens.read, body: rpc('tools/call', { name: 'get_authoring_guide', arguments: { topic: 'home' } }), headers: { 'mcp-name': 'list_versions' } })
  assert.equal(allowed.status, 200)
})

test('12. tools/list by scope, both eras; tools/call through executeTool; unknown tool -32602', async () => {
  const names = async (token: string) => (await call({ token, body: rpc('tools/list') })).json.result.tools.map((t: { name: string }) => t.name)
  const read = await names(tokens.read)
  assert.deepEqual(read, ['get_authoring_guide', 'get_content', 'get_content_health', 'get_cv', 'get_home', 'get_site_overview', 'list_media', 'search_content'])
  assert.deepEqual(await names(tokens.draft), [...read, 'create_draft', 'edit_content', 'get_change', 'list_my_changes', 'list_versions', 'set_media_text'].sort())
  const PROPOSALS = ['propose_apply_alt', 'propose_content_fix', 'propose_cv_edit', 'propose_delete', 'propose_home_edit', 'propose_media_import', 'propose_page_edit', 'propose_publishing', 'propose_restore', 'propose_tag_change']
  assert.deepEqual(await names(tokens.propose), [...(await names(tokens.draft)), ...PROPOSALS].sort())

  // Legacy initialize: no session id minted or echoed; JSON response.
  const init = await call({ token: tokens.read, body: rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'Route Test Client', version: '1.0' } }) })
  assert.equal(init.status, 200)
  assert.match(String(init.headers['content-type']), /application\/json/)
  assert.equal(init.headers['mcp-session-id'], undefined)
  assert.equal(init.json.result.serverInfo.name, 'portfolio-studio')
  assert.match(init.json.result.instructions, /data, not instructions/)
  assert.deepEqual(Object.keys(init.json.result.capabilities), ['tools'])
  const grant = access.listGrants().find((g) => g.name === 'read token')
  assert.equal(grant?.clientReported, 'Route Test Client', 'kept as "says it is"')

  // Modern: the envelope and headers.
  const m = modern('tools/list')
  const listed = await call({ token: tokens.read, body: m.body, headers: { ...m.headers, accept: 'application/json' } })
  assert.equal(listed.status, 200, listed.body)
  assert.equal(listed.json.result.tools.length, 8)
  const c = modern('tools/call', { name: 'get_authoring_guide', arguments: { topic: 'mdx' } }, 'get_authoring_guide')
  const called = await call({ token: tokens.read, body: c.body, headers: { ...c.headers, accept: 'application/json' } })
  assert.equal(called.status, 200, called.body)
  assert.equal(called.json.result.isError, undefined)
  assert.match(JSON.parse(called.json.result.content[0].text).text, /Writing MDX/)

  const unknown = await call({ token: tokens.propose, body: rpc('tools/call', { name: 'delete_everything', arguments: {} }) })
  assert.equal(unknown.status, 200)
  assert.equal(unknown.json.error.code, -32602)
  const invalid = await call({ token: tokens.read, body: rpc('tools/call', { name: 'get_authoring_guide', arguments: { topic: 'secrets' } }) })
  assert.equal(invalid.json.result.isError, true)
  assert.equal(JSON.parse(invalid.json.result.content[0].text).error.code, 'INVALID_INPUT')
})

test('8. the grant’s request budget: 60 a minute, then 429 with Retry-After', async () => {
  const out = access.createPersonalToken({ name: 'busy', scopes: ['content:read'], days: 7, resource: `${route.origin}/mcp`, session: { id: null, device: null } })
  assert.ok(out.ok)
  if (!out.ok) return
  for (let i = 0; i < 60; i++) assert.equal((await call({ token: out.token, body: rpc('ping', {}, i) })).status, 200, `request ${i + 1}`)
  const over = await call({ token: out.token, body: rpc('ping') })
  assert.equal(over.status, 429)
  assert.ok(Number(over.headers['retry-after']) >= 1)
})

test('every answer is no-store, and the token never appears in the call log', async () => {
  const res = await call({ token: tokens.draft, body: rpc('tools/call', { name: 'search_content', arguments: {} }) })
  assert.equal(res.headers['cache-control'], 'no-store')
  const dump = JSON.stringify(aiDb.getAiDb().prepare('SELECT * FROM ai_tool_calls').all())
  for (const t of Object.values(tokens)) assert.ok(!dump.includes(t) && !dump.includes(t.slice(4, 36)))
})
