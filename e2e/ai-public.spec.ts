import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import Database from 'better-sqlite3'
import { expect, test } from './fixtures'

/**
 * The public AI addresses on the real standalone server (scripts/ai-e2e.sh;
 * design §5.2, §6.1, S23). While AI access is closed — the default — /mcp,
 * /api/mcp, /oauth/*, /api/oauth/*, /.well-known/oauth-* and /ai/review/*
 * answer exactly what an unknown path answers: the status, the body byte for
 * byte, and every response header with its name, value and position (only
 * Date's value may differ, and under an `rsc: 1` probe Next names the
 * request's own path below /__not_found — the same rule for both). Probed
 * with every method, an `rsc: 1` header, a forged routing header (with and
 * without `rsc: 1`, which makes Next name any rewrite it applied), a bearer
 * token and a cookie; in the canonical spelling and in other letter cases
 * (Next matches rewrite sources without regard to case), and as the Next data
 * requests its router reads as an AI address. Then AI access is switched on
 * in the server's auth.db: the same addresses are routed to their
 * implementation routes with the admin context's no-store and noindex;
 * switched off again, they are unknown again at once.
 */

const BASE = new URL(process.env.E2E_BASE_URL || 'http://127.0.0.1:3000')
const DATA_DIR = process.env.E2E_SERVER_DATA_DIR || ''

const AI_PATHS = [
  '/mcp',
  '/api/mcp',
  '/oauth/authorize?response_type=code&client_id=https%3A%2F%2Fclient.example%2Fmeta&state=s',
  '/oauth/token',
  '/oauth/register',
  '/oauth/revoke',
  '/api/oauth/token',
  '/api/oauth/metadata?doc=as',
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
  '/.well-known/oauth-authorization-server',
  '/ai/review/ch_abcdefghijklmnop',
  // Other letter cases: to Next's router these are the same addresses.
  '/MCP',
  '/Mcp',
  '/API/mcp',
  '/OAuth/token',
  '/API/OAuth/token',
  '/.Well-Known/oauth-authorization-server',
  '/.WELL-KNOWN/OAUTH-PROTECTED-RESOURCE/MCP',
  '/AI/review/ch_abcdefghijklmnop',
  '/ai/Review/ch_abcdefghijklmnop',
]
/** An unknown address of the same shape and letter case (no route, same Cross-Origin-Resource-Policy, same /api/ rule). */
const unknownLike = (p: string) => {
  const prefix = /^\/(\.well-known|api)\//i.exec(p)?.[0]
  return prefix ? `${prefix}zz-${p.slice(prefix.length)}` : `/zz-${p.slice(1)}`
}

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'] as const
const VARIANTS: Array<{ name: string; headers: Record<string, string> }> = [
  { name: 'plain', headers: {} },
  { name: 'rsc', headers: { rsc: '1', 'next-router-state-tree': '%5B%22%22%5D' } },
  { name: 'forged mark', headers: { 'x-ai-open': '1' } },
  { name: 'forged mark under rsc', headers: { 'x-ai-open': '1', rsc: '1', 'next-router-state-tree': '%5B%22%22%5D' } },
  { name: 'bearer from a hosted client', headers: { authorization: 'Bearer pst_exampleexampleexampleexampleexample', origin: 'https://claude.ai', 'mcp-protocol-version': '2026-07-28' } },
  { name: 'admin cookie', headers: { cookie: 'cv_admin_token=not-a-session' } },
]

type Raw = { status: number; headers: Array<[string, string]>; body: Buffer }

/** One raw HTTP/1.1 exchange: header names in their case and order, the body as bytes. */
function raw(method: string, pathAndQuery: string, headers: Record<string, string>): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const body = method === 'POST' || method === 'PUT' ? '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' : undefined
    const req = http.request(
      {
        host: BASE.hostname,
        port: BASE.port,
        method,
        path: pathAndQuery,
        agent: false,
        headers: { accept: 'application/json, text/event-stream', ...(body ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } : {}), ...headers },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const pairs: Array<[string, string]> = []
          for (let i = 0; i < res.rawHeaders.length; i += 2) pairs.push([res.rawHeaders[i], res.rawHeaders[i + 1]])
          resolve({ status: res.statusCode || 0, headers: pairs, body: Buffer.concat(chunks) })
        })
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}

/** What Next names to an rsc request for an /api/* path no route serves (lib/aiPublicRoutes.js): the path below /__not_found. */
const echoOf = (pathAndQuery: string) => {
  const pathname = new URL(pathAndQuery, BASE).pathname
  return /^\/api\//i.test(pathname) ? `/__not_found${pathname.slice(4)}` : null
}
const headerOf = (r: Raw, name: string) => r.headers.find(([k]) => k.toLowerCase() === name)?.[1] ?? null

/** The page a Next data request asks for (/_next/data/<build>/<page>.json → /<page>), or null. */
const dataPageOf = (pathAndQuery: string) => /^\/_next\/data\/[^/]+(\/.*)\.json$/.exec(new URL(pathAndQuery, BASE).pathname)?.[1] ?? null

/** Everything but Date's value (it only has to be there) and the path echoes (they have to follow the rule). */
function comparable(r: Raw, pathAndQuery: string) {
  const headers = r.headers.map(([k, v]): [string, string] => {
    const name = k.toLowerCase()
    if (name === 'date') return [k, '<date>']
    if (name === 'x-nextjs-rewritten-path' && v === echoOf(pathAndQuery)) return [k, '<own path below /__not_found>']
    if (name === 'x-nextjs-matched-path' && v === dataPageOf(pathAndQuery)) return [k, '<own page>']
    return [k, v]
  })
  return { status: r.status, headers, body: r.body.toString('base64') }
}

async function expectAllUnknown(label: string) {
  for (const p of AI_PATHS) {
    for (const method of METHODS) {
      for (const v of VARIANTS) {
        const [ai, unknown] = [await raw(method, p, v.headers), await raw(method, unknownLike(p), v.headers)]
        const what = `${label}: ${method} ${p} (${v.name})`
        expect(ai.status, what).toBe(404)
        expect(comparable(ai, p), what).toEqual(comparable(unknown, unknownLike(p)))
        // No rewrite at all of a public address (an rsc request would be told of one).
        if (echoOf(p) === null) expect(headerOf(ai, 'x-nextjs-rewritten-path'), what).toBeNull()
      }
    }
  }
  await expectDataRequestsUnknown(label)
}

/**
 * Next data requests, /_next/data/<build>/<page>.json, which its router
 * routes as <page>: /mcp, /MCP, and /mcp/ (the proxy leaves a data request's
 * trailing slash alone, and Next matches /mcp/ as /mcp). A forged mark must
 * route none of them: each answers what the data request for an unknown page
 * of the same shape answers. While closed, all of them; while open, the ones
 * the proxy does not read as an AI address (`unmarkedOnly`: the trailing
 * slash), which nothing may mark.
 */
async function expectDataRequestsUnknown(label: string, unmarkedOnly = false) {
  const home = await raw('GET', '/', {})
  const buildId = /"buildId":"([^"]+)"/.exec(home.body.toString('utf8'))?.[1] || ''
  expect(buildId, 'the build id, from the home page').toMatch(/^[\w-]+$/)
  const data = (page: string) => `/_next/data/${buildId}${page}.json`
  const pairs: Array<[string, string]> = [
    [data('/mcp'), data('/zz-mcp')],
    [data('/MCP'), data('/zz-MCP')],
    [data('/mcp/'), data('/zz-mcp/')],
    [data('/Mcp/'), data('/zz-Mcp/')],
    [data('/oauth/token'), data('/zz-oauth/token')],
    [data('/.Well-Known/oauth-authorization-server'), data('/.Well-Known/zz-oauth-authorization-server')],
    [data('/ai/review/ch_abcdefghijklmnop'), data('/zz-ai/review/ch_abcdefghijklmnop')],
  ]
  for (const [p, unknownPath] of pairs) {
    if (unmarkedOnly && !dataPageOf(p)?.endsWith('/')) continue
    for (const method of ['GET', 'POST'] as const) {
      for (const extra of [{}, { rsc: '1', 'next-router-state-tree': '%5B%22%22%5D' }] as Array<Record<string, string>>) {
        const headers: Record<string, string> = { 'x-ai-open': '1', ...extra }
        const [ai, unknown] = [await raw(method, p, headers), await raw(method, unknownPath, headers)]
        const what = `${label}: ${method} ${p} (${Object.keys(headers).join(', ')})`
        expect(comparable(ai, p), what).toEqual(comparable(unknown, unknownPath))
        expect(headerOf(ai, 'x-nextjs-rewritten-path'), what).toBeNull()
      }
    }
  }
}

const setAi = (on: boolean) => {
  const db = new Database(path.join(DATA_DIR, 'auth.db'), { fileMustExist: true, timeout: 5000 })
  try {
    db.prepare('UPDATE ai_settings SET enabled = ?, mcp_enabled = ? WHERE id = 1').run(on ? 1 : 0, on ? 1 : 0)
  } finally {
    db.close()
  }
}

test.describe.serial('@ai public AI addresses', () => {
  test.afterAll(() => {
    if (DATA_DIR) setAi(false)
  })

  test('closed by default: every AI address answers exactly what an unknown path answers', async () => {
    test.setTimeout(300_000)
    expect(BASE.hostname).toBe('127.0.0.1')
    await expectAllUnknown('closed')
  })

  test('open: the addresses reach their routes, with no-store and noindex; closed again, unknown again at once', async () => {
    test.setTimeout(420_000)
    expect(DATA_DIR, 'E2E_SERVER_DATA_DIR (scripts/ai-e2e.sh)').toBeTruthy()
    setAi(true)
    try {
      const routed: Array<[string, string]> = [
        ['/mcp', '/api/mcp'],
        ['/oauth/token', '/api/oauth/token'],
        ['/oauth/authorize?x=1', '/api/oauth/authorize'],
        ['/.well-known/oauth-protected-resource/mcp', '/api/oauth/metadata'],
        ['/.well-known/oauth-authorization-server', '/api/oauth/metadata'],
        ['/ai/review/ch_abcdefghijklmnop', '/api/oauth/open'],
        // In another letter case Next routes them too, and the proxy gives them the same admin context.
        ['/MCP', '/api/mcp'],
        ['/OAuth/token', '/api/oauth/token'],
        ['/.Well-Known/oauth-authorization-server', '/api/oauth/metadata'],
        ['/AI/review/ch_abcdefghijklmnop', '/api/oauth/open'],
      ]
      for (const [from, to] of routed) {
        // Next names a config rewrite's target to an rsc request: proof the rewrite fired. Until the
        // stage that builds a route has run, its target is an /api/* path no route serves, and the
        // API fallback names it below /__not_found instead.
        const built = fs.existsSync(path.join(process.cwd(), 'pages', `${to}.ts`))
        const res = await raw('GET', from, { rsc: '1' })
        expect(headerOf(res, 'x-nextjs-rewritten-path'), from).toBe(built ? to : echoOf(to))
        expect(headerOf(res, 'x-robots-tag'), from).toMatch(/noindex/)
        expect(headerOf(res, 'cache-control'), from).toMatch(/no-store/)
        if (!built) expect(res.status, from).toBe(404)
      }
      // A spelling the proxy does not read as an AI address stays unrouted while open too, forged mark or not.
      await expectDataRequestsUnknown('open', true)
      for (const direct of ['/api/mcp', '/api/oauth/token']) {
        const res = await raw('POST', direct, {})
        expect(res.headers.some(([k, v]) => k.toLowerCase() === 'x-robots-tag' && /noindex/.test(v)), direct).toBe(true)
      }
      // An unknown path stays as it was: no admin context leaks onto it.
      const unknown = await raw('GET', '/zz-mcp', {})
      expect(unknown.headers.some(([k]) => k.toLowerCase() === 'x-robots-tag')).toBe(false)
    } finally {
      setAi(false)
    }
    // Off takes effect on the very next request.
    await expectAllUnknown('closed again')
  })
})
