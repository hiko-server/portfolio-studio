/**
 * Runs a real Pages Router API route on a real socket: Next's own resolver
 * behind a node:http server on loopback.
 *
 * tests/editorialHarness.ts drives routes with a mock req/res, which is enough
 * for most of them. It is not enough for a route that hands the response to
 * something that needs a real one (toNodeHandler from
 * @modelcontextprotocol/node writes through the ServerResponse and listens for
 * its `close`), or whose behaviour lives in the transport: `bodyParser: false`,
 * the real `Host` header, a body cap enforced before parsing, streaming, and a
 * client that hangs up. Here the route's own `export const config` applies, as
 * it does under `next start`.
 *
 * Revalidation cannot run: there is no Next router here to render the page. It
 * is recorded in `revalidated`, like the harness's mock response records it, so
 * the same assertions work. `import` the route inside a test, after the harness
 * moved the working directory; lib/db resolves data/ when it first loads.
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { PageConfig } from 'next'
// `.js` because Next has no exports map and this runs without a bundler.
import { apiResolver } from 'next/dist/server/api-utils/node/api-resolver.js'

/** Any route module: a default-exported handler and, usually, `export const config`. */
export type RouteModule = { default: (req: any, res: any) => unknown; config?: PageConfig }

export type RealRoute = {
  /** Origin of the server, `http://127.0.0.1:<port>`. */
  origin: string
  port: number
  /** `fetch` against the route; the path does not select anything, only the query string reaches the handler. */
  fetch: (pathAndQuery?: string, init?: RequestInit) => Promise<Response>
  /** Sends exact bytes and headers, including what `fetch` refuses to send (a forged `Host`, say). */
  raw: (opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer }) => Promise<RawResponse>
  /** Paths the handler asked to revalidate, in order. */
  revalidated: string[]
  /** Errors the route threw past its own handling, in order. */
  errors: unknown[]
  close: () => Promise<void>
}

export type RawResponse = { status: number; headers: http.IncomingHttpHeaders; body: string }

/** Preview secrets are required by the resolver's signature; no route under test uses draft mode through them. */
const API_CONTEXT = {
  previewModeId: 'real-route-preview-id',
  previewModeEncryptionKey: 'real-route-encryption-key',
  previewModeSigningKey: 'real-route-signing-key',
  dev: false,
}

export async function startRealRoute(route: RouteModule, opts: { page?: string } = {}): Promise<RealRoute> {
  const page = opts.page ?? '/api/test'
  const revalidated: string[] = []
  const errors: unknown[] = []
  const resolverModule = {
    config: route.config,
    default: (req: any, res: any) => {
      res.revalidate = async (urlPath: string) => {
        revalidated.push(urlPath)
      }
      return route.default(req, res)
    },
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const query: Record<string, string | string[]> = {}
    for (const key of new Set(url.searchParams.keys())) {
      const values = url.searchParams.getAll(key)
      query[key] = values.length > 1 ? values : values[0]
    }
    apiResolver(req, res, query, resolverModule, API_CONTEXT, true, false, page).catch((err: unknown) => {
      errors.push(err)
      if (!res.headersSent) res.statusCode = 500
      if (!res.writableEnded) res.end()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const { port } = server.address() as AddressInfo
  const origin = `http://127.0.0.1:${port}`

  return {
    origin,
    port,
    revalidated,
    errors,
    fetch: (pathAndQuery = '/', init) => fetch(new URL(pathAndQuery, origin), init),
    raw: ({ method = 'GET', path = '/', headers = {}, body }) =>
      new Promise<RawResponse>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method, path, headers, setHost: !('host' in lowerKeys(headers)) }, (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
          res.on('error', reject)
        })
        req.on('error', reject)
        req.end(body)
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
        server.closeAllConnections()
      }),
  }
}

function lowerKeys(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
}
