/**
 * The public AI paths while closed (design §5.2, §6.1; S23): /mcp, /api/mcp,
 * /oauth/*, /api/oauth/*, /.well-known/oauth-* and /ai/review/* answer
 * exactly what an unknown path answers. Here at the proxy and config level,
 * against a real auth.db: the proxy treats them like any unknown path while
 * closed (same response, same headers, no admin context, a client's routing
 * header removed), marks them only while open; the next.config.js rewrites
 * route them only on that mark, and a closed implementation route goes where
 * any unknown /api/* path goes. The full comparison through a real server
 * (status, body, every header) is e2e/ai-public.spec.ts, run by
 * scripts/ai-e2e.sh.
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire, register } from 'node:module'
import { scrubAiEnv } from './editorialHarness'

// `next` has no package "exports": map the extensionless `next/server` that proxy.ts imports.
register(
  'data:text/javascript,' +
    encodeURIComponent(`
      export async function resolve(specifier, context, next) {
        if (specifier === 'next/server') return next('next/server.js', context)
        return next(specifier, context)
      }
    `),
  import.meta.url,
)

const require = createRequire(import.meta.url)
const prevCwd = process.cwd()
const saved = { SITE_URL: process.env.SITE_URL, NEXT_PUBLIC_SITE_HOST: process.env.NEXT_PUBLIC_SITE_HOST }
let tmp = ''
let proxyMod: typeof import('../proxy')
let NextRequestCtor: typeof import('next/server').NextRequest
let authDb: typeof import('../lib/adminAuth/db')

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-closed-state-'))
  process.chdir(tmp)
  NextRequestCtor = (await import('next/server.js')).NextRequest as typeof NextRequestCtor
  proxyMod = await import('../proxy')
  authDb = await import('../lib/adminAuth/db')
})
after(() => {
  authDb.closeAuthDb()
  scrubAiEnv()
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  process.chdir(prevCwd)
  fs.rmSync(tmp, { recursive: true, force: true })
})
beforeEach(() => {
  scrubAiEnv()
  process.env.SITE_URL = 'http://127.0.0.1:3002'
  delete process.env.NEXT_PUBLIC_SITE_HOST
  authDb.getAuthDb().prepare('UPDATE ai_settings SET enabled = 0, mcp_enabled = 0 WHERE id = 1').run()
})

const open = () => authDb.getAuthDb().prepare('UPDATE ai_settings SET enabled = 1, mcp_enabled = 1 WHERE id = 1').run()

/** Every AI address, and an unknown one of the same shape (same CORP, same depth). */
const AI_PATHS = [
  '/mcp',
  '/api/mcp',
  '/oauth/authorize',
  '/oauth/token',
  '/oauth/register',
  '/oauth/revoke',
  '/api/oauth/token',
  '/api/oauth/metadata',
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
  '/.well-known/oauth-authorization-server',
  '/ai/review/ch_abcdefghijklmnop',
]
const unknownLike = (p: string) =>
  p.startsWith('/.well-known/') ? p.replace('/.well-known/', '/.well-known/zz-') : p.startsWith('/api/') ? p.replace('/api/', '/api/zz-') : `/zz-${p.slice(1)}`

function req(pathAndQuery: string, init: { method?: string; headers?: Record<string, string> } = {}) {
  const url = `http://127.0.0.1:3002${pathAndQuery}`
  return new NextRequestCtor(url, { method: init.method || 'GET', headers: { host: '127.0.0.1:3002', ...(init.headers || {}) } })
}
const headersOf = (res: Response) => [...res.headers.entries()].sort(([a], [b]) => a.localeCompare(b))

test('the AI addresses are exactly the design list', async () => {
  const { isAiPublicPath } = require('../lib/aiPublicRoutes.js') as typeof import('../lib/aiPublicRoutes.js')
  for (const p of AI_PATHS) assert.equal(isAiPublicPath(p), true, p)
  for (const p of ['/mcpx', '/mcp-docs', '/api/mcpx', '/oauth', '/api/oauth', '/.well-known/openid-configuration', '/.well-known/security.txt', '/ai', '/ai/reviews', '/admin/ai', '/api/admin/ai/settings', '/blog/mcp']) {
    assert.equal(isAiPublicPath(p), false, p)
  }
  for (const p of AI_PATHS) assert.equal(isAiPublicPath(unknownLike(p)), false, `${unknownLike(p)} is unknown`)
})

test('closed: every AI address gets exactly what an unknown path gets from the proxy, for every method', async () => {
  for (const p of AI_PATHS) {
    for (const method of ['GET', 'POST', 'DELETE', 'OPTIONS', 'HEAD']) {
      const headers = { 'content-type': 'application/json', authorization: 'Bearer pst_example' }
      const ai = await proxyMod.proxy(req(p, { method, headers }))
      const unknown = await proxyMod.proxy(req(unknownLike(p), { method, headers }))
      assert.equal(ai.status, unknown.status, `${method} ${p}`)
      assert.deepEqual(headersOf(ai), headersOf(unknown), `${method} ${p}`)
      // No admin context, no rewrite: nothing a client could read the state from.
      assert.equal(ai.headers.get('x-robots-tag'), null, p)
      assert.equal(ai.headers.get('cache-control'), null, p)
      assert.equal(ai.headers.get('x-middleware-rewrite'), null, p)
      assert.equal(ai.headers.get('x-middleware-next'), '1', p)
    }
  }
})

test('closed: a client cannot mark its own request open', async () => {
  for (const p of AI_PATHS) {
    const forged = await proxyMod.proxy(req(p, { headers: { 'x-ai-open': '1' } }))
    assert.equal(forged.headers.get('x-middleware-request-x-ai-open'), null, p)
    const override = forged.headers.get('x-middleware-override-headers')
    assert.ok(override !== null, `${p}: the request headers are replaced`)
    assert.deepEqual(override.split(','), ['host'], `${p}: the forged header is removed before routing`)
  }
  // An rsc probe is passed on as for any unknown path (Next keeps flight headers whatever a proxy does).
  for (const p of AI_PATHS) {
    const a = await proxyMod.proxy(req(p, { headers: { rsc: '1' } }))
    const u = await proxyMod.proxy(req(unknownLike(p), { headers: { rsc: '1' } }))
    assert.deepEqual(headersOf(a), headersOf(u), p)
  }
  // Elsewhere nothing changes: no override for an ordinary request.
  const plain = await proxyMod.proxy(req('/api/health'))
  assert.equal(plain.headers.get('x-middleware-override-headers'), null)
})

test('open: marked for the rewrites, with no-store and noindex; every switch closes it again', async () => {
  open()
  for (const p of AI_PATHS) {
    const res = await proxyMod.proxy(req(p, { method: 'POST', headers: { 'x-ai-open': 'forged' } }))
    assert.equal(res.headers.get('x-middleware-request-x-ai-open'), '1', p)
    assert.match(res.headers.get('cache-control') || '', /no-store/, p)
    assert.match(res.headers.get('x-robots-tag') || '', /noindex/, p)
    assert.ok(res.headers.get('content-security-policy'), p)
  }
  // The trailing-slash form is redirected first, open or closed, like any path (clients register /mcp exactly).
  const slash = await proxyMod.proxy(req('/mcp/', { method: 'POST' }))
  assert.equal(slash.status, 308)
  assert.equal(new URL(slash.headers.get('location') || '', 'http://x').pathname, '/mcp')

  process.env.AI_DISABLED = '1'
  assert.equal((await proxyMod.proxy(req('/mcp'))).headers.get('x-middleware-request-x-ai-open'), null, 'AI_DISABLED')
  delete process.env.AI_DISABLED
  delete process.env.SITE_URL
  assert.equal((await proxyMod.proxy(req('/mcp'))).headers.get('x-middleware-request-x-ai-open'), null, 'no SITE_URL')
  process.env.SITE_URL = 'http://127.0.0.1:3002'
  authDb.getAuthDb().prepare('UPDATE ai_settings SET mcp_enabled = 0 WHERE id = 1').run()
  const appsOff = await proxyMod.proxy(req('/mcp'))
  assert.equal(appsOff.headers.get('x-middleware-request-x-ai-open'), null, 'connected apps off')
  assert.deepEqual(headersOf(appsOff), headersOf(await proxyMod.proxy(req('/zz-mcp'))))
  // The cookie is never consulted for these paths: a session cookie changes nothing.
  open()
  const withCookie = await proxyMod.proxy(req('/mcp', { headers: { cookie: 'cv_admin_token=not-even-a-jwt' } }))
  assert.equal(withCookie.status, 200)
  assert.equal(withCookie.headers.get('x-middleware-request-x-ai-open'), '1')
})

test('next.config.js routes the AI addresses only on the proxy\'s mark, and traces the worker chunks for /api/mcp', async () => {
  const cfg = require('../next.config.js') as {
    rewrites: () => Promise<{ beforeFiles: Array<Record<string, unknown>>; fallback: Array<Record<string, unknown>> }>
    outputFileTracingIncludes: Record<string, string[]>
  }
  const { beforeFiles, fallback } = await cfg.rewrites()
  const mark = [{ type: 'header', key: 'x-ai-open', value: '1' }]
  const ai = beforeFiles.filter((r) => JSON.stringify(r).includes('x-ai-open'))
  assert.deepEqual(ai, [
    { source: '/api/mcp', missing: mark, destination: '/__not_found/mcp' },
    { source: '/api/oauth/:path+', missing: mark, destination: '/__not_found/oauth/:path+' },
    { source: '/mcp', has: mark, destination: '/api/mcp' },
    { source: '/.well-known/oauth-protected-resource/mcp', has: mark, destination: '/api/oauth/metadata?doc=prm' },
    { source: '/.well-known/oauth-protected-resource', has: mark, destination: '/api/oauth/metadata?doc=prm' },
    { source: '/.well-known/oauth-authorization-server', has: mark, destination: '/api/oauth/metadata?doc=as' },
    { source: '/oauth/:endpoint(authorize|token|register|revoke)', has: mark, destination: '/api/oauth/:endpoint' },
    { source: '/ai/review/:id', has: mark, destination: '/api/oauth/open?id=:id' },
  ])
  // Every rewrite of an AI address carries the mark (no unconditional route to an AI handler).
  for (const r of beforeFiles) {
    const touchesAi = /mcp|oauth|\/ai\//.test(String(r.source)) || /mcp|oauth/.test(String(r.destination))
    if (touchesAi) assert.ok(r.has || r.missing, JSON.stringify(r))
  }
  // An /api/* path no route serves goes the same way a closed AI route does: /api/<rest> → /__not_found/<rest>.
  assert.deepEqual(fallback, [{ source: '/api/:path*', destination: '/__not_found/:path*' }])
  assert.deepEqual(cfg.outputFileTracingIncludes['/api/mcp'], ['./.next/server/chunks/**/*.js'])
})

test('never CSRF-protected (bearer tokens, no cookies), and never cached at the Cloudflare edge', async () => {
  const { isCsrfProtectedPath } = await import('../lib/security/csrf')
  for (const p of AI_PATHS) assert.equal(isCsrfProtectedPath(p), false, p)
  const { BYPASS_PREFIXES, desiredRules } = await import('../scripts/cloudflare-config.mjs')
  for (const prefix of ['/mcp', '/api/mcp', '/oauth/', '/api/oauth/', '/.well-known/oauth-', '/ai/review/']) {
    assert.ok(BYPASS_PREFIXES.includes(prefix), prefix)
  }
  for (const p of AI_PATHS) assert.ok(BYPASS_PREFIXES.some((prefix: string) => p.startsWith(prefix)), p)
  const bypass = desiredRules('site.example').http_request_cache_settings.at(-1)!
  assert.match(bypass.expression, /starts_with\(http\.request\.uri\.path, "\/mcp"\)/)
  assert.match(bypass.expression, /starts_with\(http\.request\.uri\.path, "\/\.well-known\/oauth-"\)/)
})
