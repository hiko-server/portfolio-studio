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
 * with every method, an `rsc: 1` header, a forged routing header, a bearer
 * token and a cookie. Then AI access is switched on in the server's auth.db:
 * the same addresses are routed to their implementation routes with the
 * admin context's no-store and noindex; switched off again, they are unknown
 * again at once.
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
]
/** An unknown address of the same shape (no route, same Cross-Origin-Resource-Policy). */
const unknownLike = (p: string) =>
  p.startsWith('/.well-known/') ? p.replace('/.well-known/', '/.well-known/zz-') : p.startsWith('/api/') ? p.replace('/api/', '/api/zz-') : `/zz-${p.slice(1)}`

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'] as const
const VARIANTS: Array<{ name: string; headers: Record<string, string> }> = [
  { name: 'plain', headers: {} },
  { name: 'rsc', headers: { rsc: '1', 'next-router-state-tree': '%5B%22%22%5D' } },
  { name: 'forged mark', headers: { 'x-ai-open': '1' } },
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
  return pathname.startsWith('/api/') ? `/__not_found${pathname.slice(4)}` : null
}

/** Everything but Date's value (it only has to be there) and the path echo (it has to follow the rule). */
function comparable(r: Raw, pathAndQuery: string) {
  const headers = r.headers.map(([k, v]): [string, string] => {
    const name = k.toLowerCase()
    if (name === 'date') return [k, '<date>']
    if (name === 'x-nextjs-rewritten-path' && v === echoOf(pathAndQuery)) return [k, '<own path below /__not_found>']
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
    test.setTimeout(180_000)
    expect(BASE.hostname).toBe('127.0.0.1')
    await expectAllUnknown('closed')
  })

  test('open: the addresses reach their routes, with no-store and noindex; closed again, unknown again at once', async () => {
    test.setTimeout(240_000)
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
      ]
      for (const [from, to] of routed) {
        // Next names a config rewrite's target to an rsc request: proof the rewrite fired. Until the
        // stage that builds a route has run, its target is an /api/* path no route serves, and the
        // API fallback names it below /__not_found instead.
        const built = fs.existsSync(path.join(process.cwd(), 'pages', `${to}.ts`))
        const res = await raw('GET', from, { rsc: '1' })
        const header = (name: string) => res.headers.find(([k]) => k.toLowerCase() === name)?.[1] ?? null
        expect(header('x-nextjs-rewritten-path'), from).toBe(built ? to : echoOf(to))
        expect(header('x-robots-tag'), from).toMatch(/noindex/)
        expect(header('cache-control'), from).toMatch(/no-store/)
        if (!built) expect(res.status, from).toBe(404)
      }
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
