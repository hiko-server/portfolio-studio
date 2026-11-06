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
/**
 * The same addresses in other letter cases: Next matches rewrite sources
 * without regard to case (experimental.caseSensitiveRoutes is off), so to
 * its router /MCP is /mcp.
 */
const AI_CASE_VARIANTS = [
  '/MCP',
  '/Mcp',
  '/API/mcp',
  '/Api/Mcp',
  '/OAuth/token',
  '/oauth/TOKEN',
  '/API/OAuth/token',
  '/.Well-Known/oauth-authorization-server',
  '/.WELL-KNOWN/OAUTH-PROTECTED-RESOURCE/MCP',
  '/AI/review/ch_abcdefghijklmnop',
  '/ai/Review/ch_abcdefghijklmnop',
]
/** An unknown address of the same shape and letter case (no route, same CORP, same depth, same /api/ rule). */
const unknownLike = (p: string) => {
  const wellKnown = /^\/\.well-known\//i.exec(p)
  if (wellKnown) return `${wellKnown[0]}zz-${p.slice(wellKnown[0].length)}`
  const api = /^\/api\//i.exec(p)
  if (api) return `${api[0]}zz-${p.slice(api[0].length)}`
  return `/zz-${p.slice(1)}`
}

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
  // In any letter case, as Next's router reads them.
  for (const p of AI_CASE_VARIANTS) {
    assert.equal(isAiPublicPath(p), true, p)
    assert.equal(isAiPublicPath(unknownLike(p)), false, `${unknownLike(p)} is unknown`)
  }
})

test('Next\'s own router matches an AI rewrite only on a path the proxy treats as an AI address', async () => {
  // The rewrites exactly as the running server compiles them (next/dist/server/lib/router-utils/filesystem.js), with this
  // config's case setting: whatever spelling one of them matches, the proxy must see an AI address in it, or that
  // request would skip the proxy's AI handling (its admin context while open).
  const { buildCustomRoute } = require('next/dist/server/lib/router-utils/filesystem.js') as {
    buildCustomRoute: (type: 'rewrite', item: object, basePath: string, caseSensitive?: boolean) => { source: string; match: (p: string) => false | object }
  }
  const { aiPublicRewrites, isAiPublicPath } = require('../lib/aiPublicRoutes.js') as typeof import('../lib/aiPublicRoutes.js')
  const cfg = require('../next.config.js') as { experimental?: { caseSensitiveRoutes?: boolean } }
  const routes = aiPublicRewrites().map((r) => buildCustomRoute('rewrite', r, '', cfg.experimental?.caseSensitiveRoutes))
  const spellings = [...AI_PATHS, ...AI_CASE_VARIANTS, ...AI_PATHS.map((p) => p.toUpperCase()), ...AI_PATHS.map(unknownLike), '/', '/blog', '/api/health']
  let matched = 0
  for (const p of spellings) {
    const hits = routes.filter((r) => r.match(p))
    if (hits.length) matched++
    assert.equal(isAiPublicPath(p), hits.length > 0, `${p}: Next's router ${hits.length ? `matches ${hits[0].source}` : 'matches no AI rewrite'}`)
  }
  assert.equal(matched, AI_PATHS.length * 2 + AI_CASE_VARIANTS.length, 'every AI spelling is matched by a rewrite')
  // A trailing slash is matched too. The proxy redirects /mcp/ before routing, but not the page of a Next data request
  // (/_next/data/<build>/mcp/.json reads as /mcp/), and nothing marks that one: the next test.
  assert.ok(routes.some((r) => r.match('/mcp/')))
})

test('closed: every AI address gets exactly what an unknown path gets from the proxy, for every method', async () => {
  for (const p of [...AI_PATHS, ...AI_CASE_VARIANTS]) {
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

type Probe = [string, Record<string, string>]
/**
 * Requests the proxy does not see as an AI address: a Next data request for
 * /mcp/ (/_next/data/<build>/mcp/.json; Next sets x-nextjs-data on it, and the
 * proxy leaves its trailing slash alone) that Next's router still matches as
 * /mcp; and any other path. The mark must never survive them.
 */
const NOT_AI: Probe[] = [
  ['/_next/data/build-id/mcp/.json', { 'x-nextjs-data': '1' }],
  ['/_next/data/build-id/MCP/.json', { 'x-nextjs-data': '1' }],
  ['/', {}],
  ['/blog', {}],
  ['/zz-mcp', {}],
  ['/api/health', {}],
]
/** Every request whose routing a forged mark could change: every AI spelling (a data path reads as its page), and NOT_AI. */
const FORGEABLE: Probe[] = [
  ...[...AI_PATHS, ...AI_CASE_VARIANTS].map((p): Probe => [p, {}]),
  ['/_next/data/build-id/mcp.json', { 'x-nextjs-data': '1' }],
  ['/_next/data/build-id/OAuth/token.json', { 'x-nextjs-data': '1' }],
  ...NOT_AI,
]

/** The forged mark is gone from what the proxy passes on, and only that header was touched. */
function assertMarkRemoved(res: Response, what: string) {
  assert.equal(res.headers.get('x-middleware-request-x-ai-open'), null, what)
  const override = res.headers.get('x-middleware-override-headers')
  assert.ok(override !== null, `${what}: the request headers are replaced`)
  assert.equal(override.split(',').includes('x-ai-open'), false, `${what}: the forged header is removed before routing`)
}

test('closed: a client cannot mark its own request open', async () => {
  for (const [p, extra] of FORGEABLE) {
    for (const mark of ['1', 'forged']) {
      const forged = await proxyMod.proxy(req(p, { headers: { ...extra, 'x-ai-open': mark } }))
      assertMarkRemoved(forged, `${p} ${JSON.stringify(extra)}`)
    }
  }
  // An rsc probe is passed on as for any unknown path (Next keeps flight headers whatever a proxy does).
  for (const p of [...AI_PATHS, ...AI_CASE_VARIANTS]) {
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
  for (const p of [...AI_PATHS, ...AI_CASE_VARIANTS]) {
    const res = await proxyMod.proxy(req(p, { method: 'POST', headers: { 'x-ai-open': 'forged' } }))
    assert.equal(res.headers.get('x-middleware-request-x-ai-open'), '1', p)
    assert.match(res.headers.get('cache-control') || '', /no-store/, p)
    assert.match(res.headers.get('x-robots-tag') || '', /noindex/, p)
    assert.ok(res.headers.get('content-security-policy'), p)
  }
  // A Next data request for one is too: the proxy reads /_next/data/<build>/mcp.json as /mcp, as Next's router does.
  const data = await proxyMod.proxy(req('/_next/data/build-id/mcp.json', { headers: { 'x-nextjs-data': '1', 'x-ai-open': 'forged' } }))
  assert.equal(data.headers.get('x-middleware-request-x-ai-open'), '1')
  assert.match(data.headers.get('x-robots-tag') || '', /noindex/)
  // Only an AI address is marked: anywhere else a client's mark is still removed, and no admin context appears.
  for (const [p, extra] of NOT_AI) {
    const res = await proxyMod.proxy(req(p, { headers: { ...extra, 'x-ai-open': '1' } }))
    assertMarkRemoved(res, `open: ${p} ${JSON.stringify(extra)}`)
    assert.equal(res.headers.get('x-robots-tag'), null, p)
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
    { source: '/api/:route(mcp)', missing: mark, destination: '/__not_found/:route' },
    { source: '/api/:area(oauth)/:path+', missing: mark, destination: '/__not_found/:area/:path+' },
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

test('closed: an implementation route is rewritten exactly where an unknown /api/* path of that spelling goes', async () => {
  // Next's own matcher and destination builder, as the server runs them: an rsc request is told the destination
  // (x-nextjs-rewritten-path), so a closed rule must give the API fallback's answer letter for letter, query included.
  const { buildCustomRoute } = require('next/dist/server/lib/router-utils/filesystem.js') as {
    buildCustomRoute: (type: 'rewrite', item: object, basePath: string, caseSensitive?: boolean) => { match: (p: string) => false | Record<string, string | string[]> }
  }
  const { prepareDestination } = require('next/dist/shared/lib/router/utils/prepare-destination.js') as {
    prepareDestination: (args: { appendParamsToQuery: boolean; destination: string; params: object; query: object }) => {
      parsedDestination: { pathname: string; query: Record<string, unknown> }
    }
  }
  const { aiPublicRewrites, apiFallbackRewrite } = require('../lib/aiPublicRoutes.js') as typeof import('../lib/aiPublicRoutes.js')
  const cfg = require('../next.config.js') as { experimental?: { caseSensitiveRoutes?: boolean } }
  const compile = (r: { source: string; destination: string }) => ({ r, route: buildCustomRoute('rewrite', r, '', cfg.experimental?.caseSensitiveRoutes) })
  const closed = aiPublicRewrites().filter((r) => 'missing' in r).map(compile)
  const fallback = compile(apiFallbackRewrite())
  const destination = ({ r, route }: ReturnType<typeof compile>, p: string) => {
    const params = route.match(p)
    if (!params) return null
    const { parsedDestination } = prepareDestination({ appendParamsToQuery: true, destination: r.destination, params, query: { q: '1' } })
    return { pathname: parsedDestination.pathname, query: parsedDestination.query }
  }
  const spellings = ['/api/mcp', '/API/MCP', '/Api/Mcp', '/api/mcp/', '/api/oauth/token', '/API/OAuth/token', '/api/OAUTH/metadata', '/Api/oauth/A/b/C']
  for (const p of spellings) {
    const hits = closed.filter((c) => c.route.match(p))
    assert.equal(hits.length, 1, `${p}: one closed rule`)
    const expected = destination(fallback, p)
    assert.ok(expected, p)
    assert.equal(expected.pathname, `/__not_found${p.replace(/\/$/, '').slice(4)}`, `${p}: the fallback keeps the spelling`)
    assert.deepEqual(destination(hits[0], p), expected, p)
  }
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

test('the AI admin routes stay behind the session gate and CSRF: a bearer token never passes /api/admin/ai/*', async () => {
  const { isCsrfProtectedPath } = await import('../lib/security/csrf')
  open()
  for (const p of ['/api/admin/ai/settings', '/api/admin/ai/changes/ch_abcdefghijklmnop/approve', '/api/admin/ai/runs']) {
    assert.equal(isCsrfProtectedPath(p), true, p)
    for (const method of ['GET', 'POST']) {
      const res = await proxyMod.proxy(req(p, { method, headers: { authorization: 'Bearer pst_exampleexampleexampleexample', 'content-type': 'application/json' } }))
      assert.equal(res.status, 401, `${method} ${p}`)
      assert.equal((await res.json()).code, 'NO_SESSION')
    }
  }
  // The admin pages too.
  const page = await proxyMod.proxy(req('/admin/ai'))
  assert.equal(page.status, 307)
  assert.match(page.headers.get('location') || '', /\/admin\/login\?next=%2Fadmin%2Fai/)
})
