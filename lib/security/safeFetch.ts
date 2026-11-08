import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import type { LookupFunction, Socket } from 'node:net'
import { isLocalOnly } from '../env'
import { ipInCidr, parseCidrList, parseIp, type IpAddr } from './ip'
import { exactOrigin } from './origin'

/**
 * Server-side fetch for URLs that come from content or admins (remote image
 * sizing, "import image from URL", a model provider's base URL). It refuses
 * to reach anything that is not a public internet address, so it cannot be
 * used to probe the VPS, the Docker networks or other services on the host
 * (SSRF).
 *
 *   - http(s) only (http only when allowHttp), no credentials in the URL,
 *     only the default ports (or 443/80 explicitly)
 *   - the host is resolved once per request, every address is checked
 *     against the reserved ranges below, and a fresh connection (never a
 *     pooled one) is pinned to a vetted address (custom `lookup`), so DNS
 *     rebinding between check and connect is impossible. When connecting to
 *     one fails before a byte is sent, the next vetted address is tried (a
 *     host with an IPv6 answer an IPv4-only container cannot reach still
 *     works)
 *   - redirects are followed manually (bounded) and every hop is re-checked
 *   - hard timeout and a byte cap on the body
 *
 * A POST (a form or JSON body, e.g. an OAuth token exchange) is never
 * redirected: its 3xx answer comes back as it is, so a body (which may hold
 * a client secret) is only ever sent to the vetted URL the caller named. A
 * request that carries credentials in a header (Authorization, a cookie, an
 * API key or token header) is never redirected either: following would send
 * them to whatever host the answer names, so a 3xx is refused (REDIRECTS),
 * or returned as it is with `redirect: 'manual'`.
 *
 * safeFetchStream is the streaming sibling (model providers): same URL rules,
 * vetting, pinning and fallback; no redirect at all; a connect, idle and
 * total timeout; the byte cap counted as the body flows; an AbortSignal that
 * destroys the socket.
 *
 * `localOrigins` (a local model provider during a local trial, from
 * AI_LOCAL_PROVIDER_ORIGINS only) lets exact origins such as
 * http://127.0.0.1:11434 through on plain http and any port, and only while
 * the site is local-only (lib/env isLocalOnly: SITE_URL set, no public host).
 * Every address such an origin resolves to must be loopback: link-local,
 * metadata and private networks stay blocked whatever is listed. With a
 * public host configured the list is ignored.
 */

export type SafeFetchCode = 'BAD_URL' | 'BLOCKED_HOST' | 'DNS' | 'TIMEOUT' | 'IDLE' | 'TOO_LARGE' | 'REDIRECTS' | 'NETWORK' | 'ABORTED'

export class SafeFetchError extends Error {
  readonly code: SafeFetchCode
  constructor(code: SafeFetchCode, message: string) {
    super(message)
    this.name = 'SafeFetchError'
    this.code = code
  }
}

export type SafeFetchOptions = {
  method?: 'GET' | 'HEAD' | 'POST'
  headers?: Record<string, string>
  /** Request body (POST only; sent with its byte length as Content-Length). */
  body?: string
  /** Whole request budget (connect + headers + body), default 5000 ms. */
  timeoutMs?: number
  /** Body byte cap, default 10 MB; exceeded → TOO_LARGE. */
  maxBytes?: number
  /** Default 3. */
  maxRedirects?: number
  /**
   * 'manual': answer a 3xx as it is instead of following it, so the caller
   * sees every hop (the content health link checker tells a permanent move
   * from a temporary one). Each hop it then requests is vetted again.
   */
  redirect?: 'follow' | 'manual'
  /** Past maxBytes, stop reading and return what arrived (`truncated`) instead of failing with TOO_LARGE. */
  truncate?: boolean
  allowHttp?: boolean
  /** Exact loopback origins allowed while the site is local-only (see the module comment). */
  localOrigins?: readonly string[]
  /** Test seam: resolve a hostname to addresses (defaults to dns.lookup all). */
  resolve?: (host: string) => Promise<string[]>
}

export type SafeFetchResult = {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: Buffer
  /** Final URL after redirects. */
  url: string
  /** The body was cut at maxBytes (only with `truncate`). */
  truncated?: boolean
}

// Everything that is not routable public unicast space.
const BLOCKED = parseCidrList(
  [
    // IPv4
    '0.0.0.0/8', // "this" network
    '10.0.0.0/8', // private
    '100.64.0.0/10', // carrier-grade NAT
    '127.0.0.0/8', // loopback
    '169.254.0.0/16', // link-local (cloud metadata lives here)
    '172.16.0.0/12', // private (Docker bridges)
    '192.0.0.0/24', // IETF protocol assignments
    '192.0.2.0/24', // TEST-NET-1
    '192.88.99.0/24', // 6to4 relay
    '192.168.0.0/16', // private
    '198.18.0.0/15', // benchmarking (also what a VPN or proxy in fake-IP mode answers)
    '198.51.100.0/24', // TEST-NET-2
    '203.0.113.0/24', // TEST-NET-3
    '224.0.0.0/4', // multicast
    '240.0.0.0/4', // reserved
    '255.255.255.255/32', // broadcast
    // IPv6
    '::/128', // unspecified
    '::1/128', // loopback
    '::/96', // IPv4-compatible (::a.b.c.d, e.g. ::7f00:1 is 127.0.0.1; deprecated, never public)
    // v4-mapped (::ffff:a.b.c.d) needs no entry: parseIp folds it to IPv4,
    // which is then checked against the IPv4 ranges above. (Listing the
    // v4-mapped prefix ::ffff:0:0/96 here would fold to 0.0.0.0/0 and block
    // everything.) IPv4-translated is a different prefix, ::ffff:0:a.b.c.d:
    '::ffff:0:0:0/96', // IPv4-translated (SIIT, RFC 2765)
    '64:ff9b::/96', // NAT64 (can reach internal v4)
    '64:ff9b:1::/48', // local-use NAT64
    '100::/64', // discard-only
    '2001::/23', // IETF protocol assignments (incl. Teredo 2001::/32)
    '2001:db8::/32', // documentation
    '2002::/16', // 6to4 (embeds arbitrary v4)
    '3fff::/20', // documentation (RFC 9637)
    '5f00::/16', // SRv6 SIDs (RFC 9602)
    'fc00::/7', // unique local
    'fe80::/10', // link-local
    'fec0::/10', // site-local (deprecated, still routed by some stacks)
    'ff00::/8', // multicast
  ].join(','),
)

const LOOPBACK = parseCidrList('127.0.0.0/8,::1/128')

export function isPublicAddress(raw: string): boolean {
  const addr: IpAddr | null = parseIp(raw)
  if (!addr) return false
  return !BLOCKED.some((cidr) => ipInCidr(addr, cidr))
}

function isLoopbackAddress(raw: string): boolean {
  const addr = parseIp(raw)
  return !!addr && LOOPBACK.some((cidr) => ipInCidr(addr, cidr))
}

export { exactOrigin }

/** The local origins honoured for this request: none unless the site is local-only. */
function honouredLocalOrigins(list: readonly string[] | undefined): ReadonlySet<string> {
  if (!list || !list.length || !isLocalOnly()) return new Set()
  const out = new Set<string>()
  for (const raw of list) {
    const origin = typeof raw === 'string' ? exactOrigin(raw) : null
    if (origin) out.add(origin)
  }
  return out
}

async function defaultResolve(host: string): Promise<string[]> {
  const rows = await dns.promises.lookup(host, { all: true, verbatim: true })
  return rows.map((r) => r.address)
}

type Target = { url: URL; local: boolean }

function checkUrl(raw: string, allowHttp: boolean, local: ReadonlySet<string>): Target {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new SafeFetchError('BAD_URL', 'Not a valid URL')
  }
  if (u.username || u.password) throw new SafeFetchError('BAD_URL', 'Credentials in URLs are not allowed')
  if (!u.hostname) throw new SafeFetchError('BAD_URL', 'Missing host')
  if (local.has(u.origin)) return { url: u, local: true }
  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) {
    throw new SafeFetchError('BAD_URL', `Protocol ${u.protocol} is not allowed`)
  }
  if (u.port && u.port !== '443' && u.port !== '80') throw new SafeFetchError('BAD_URL', `Port ${u.port} is not allowed`)
  return { url: u, local: false }
}

type Pinned = { address: string; family: 4 | 6 }

/** Every address of `hostname`, each one vetted; the connection uses them in this order. */
async function vetHost(hostname: string, resolve: (h: string) => Promise<string[]>, loopbackOnly: boolean): Promise<Pinned[]> {
  const literal = hostname.replace(/^\[|\]$/g, '')
  let addresses: string[]
  if (parseIp(literal)) {
    addresses = [literal]
  } else {
    if (!loopbackOnly && /^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(hostname)) {
      throw new SafeFetchError('BLOCKED_HOST', 'Host is not public')
    }
    try {
      addresses = await resolve(hostname)
    } catch {
      throw new SafeFetchError('DNS', `Could not resolve ${hostname}`)
    }
  }
  if (!addresses.length) throw new SafeFetchError('DNS', `No address for ${hostname}`)
  // Every answer must pass — otherwise an attacker-controlled zone could mix
  // a public and a private record. A local origin must be loopback, nothing else.
  if (loopbackOnly) {
    if (!addresses.every(isLoopbackAddress)) throw new SafeFetchError('BLOCKED_HOST', 'A local origin must resolve to loopback only')
  } else if (!addresses.every(isPublicAddress)) {
    throw new SafeFetchError('BLOCKED_HOST', 'Host resolves to a non-public address')
  }
  const out: Pinned[] = []
  for (const address of addresses) {
    if (!out.some((p) => p.address === address)) out.push({ address, family: parseIp(address)!.v })
  }
  return out
}

/** Header names that carry credentials: never sent on to a host a redirect names. */
const CREDENTIAL_HEADER = /auth|cookie|api[-_]?key|token|secret|password|session/i

function carriesCredentials(headers: Record<string, string> | undefined): boolean {
  return !!headers && Object.keys(headers).some((k) => CREDENTIAL_HEADER.test(k))
}

type OpenOptions = {
  method: string
  headers: Record<string, string>
  body?: Buffer
  /** Absolute time by which the response headers must have arrived. */
  headersBy: number
  /** Absolute time after which the whole exchange is cut (socket timeout). */
  deadline: number
  signal?: AbortSignal
}

/** A connect attempt that failed before any byte went out: safe to repeat on the next address. */
class NotConnected extends Error {
  readonly cause: SafeFetchError
  constructor(cause: SafeFetchError) {
    super(cause.message)
    this.cause = cause
  }
}

/** Per-attempt connect budget while other vetted addresses remain. */
const CONNECT_ATTEMPT_MAX_MS = 10_000

/**
 * One request to `u` pinned to `pinned`, resolved when the response headers
 * arrive. Rejects with NotConnected when the TCP connection never came up
 * (refused, unreachable, or not within `connectMs`), which is safe to retry
 * elsewhere: not a byte of the request was sent.
 */
function requestPinned(u: URL, pinned: Pinned, opts: OpenOptions, connectMs: number): Promise<{ req: http.ClientRequest; res: http.IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const lookup: LookupFunction = (_host, options, cb) => {
      if (options && (options as dns.LookupOptions).all) {
        const cbAll = cb as unknown as (err: null, addrs: dns.LookupAddress[]) => void
        cbAll(null, [{ address: pinned.address, family: pinned.family }])
      } else {
        cb(null, pinned.address, pinned.family)
      }
    }
    const lib = u.protocol === 'https:' ? https : http
    const remaining = Math.max(1, opts.deadline - Date.now())
    let connected = false
    let settled = false
    const req = lib.request(
      u,
      {
        method: opts.method,
        headers: {
          'user-agent': 'portfolio-studio/safe-fetch',
          accept: '*/*',
          ...opts.headers,
          ...(opts.body ? { 'content-length': String(opts.body.length) } : {}),
        },
        lookup,
        // SNI and Host stay the original hostname; only the socket address is pinned.
        servername: u.protocol === 'https:' && !parseIp(u.hostname.replace(/^\[|\]$/g, '')) ? u.hostname : undefined,
        timeout: remaining,
        // A fresh socket every time, never one pooled by an earlier request:
        // the connection goes to exactly the address vetted for this request.
        agent: false,
      },
      (res) => {
        settled = true
        clearTimeout(headersTimer)
        clearTimeout(connectTimer)
        opts.signal?.removeEventListener('abort', onAbort)
        resolve({ req, res })
      },
    )
    const fail = (err: SafeFetchError) => {
      if (!settled) req.destroy(err)
    }
    const onAbort = () => fail(new SafeFetchError('ABORTED', 'The request was cancelled'))
    let connectTimer: ReturnType<typeof setTimeout> | undefined
    const headersTimer = setTimeout(() => fail(new SafeFetchError('TIMEOUT', 'Request timed out')), Math.max(1, Math.min(opts.headersBy, opts.deadline) - Date.now()))
    req.on('socket', (socket: Socket) => {
      if (!socket.connecting) {
        connected = true
        return
      }
      connectTimer = setTimeout(() => fail(new SafeFetchError('TIMEOUT', 'Could not connect in time')), Math.max(1, connectMs))
      socket.once('connect', () => {
        connected = true
        clearTimeout(connectTimer)
      })
    })
    req.on('timeout', () => fail(new SafeFetchError('TIMEOUT', 'Request timed out')))
    req.on('error', (err) => {
      settled = true
      clearTimeout(headersTimer)
      clearTimeout(connectTimer)
      opts.signal?.removeEventListener('abort', onAbort)
      const e = err instanceof SafeFetchError ? err : new SafeFetchError('NETWORK', err.message)
      reject(!connected && e.code !== 'ABORTED' ? new NotConnected(e) : e)
    })
    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort()
      } else {
        opts.signal.addEventListener('abort', onAbort, { once: true })
      }
    }
    req.end(opts.body)
  })
}

/**
 * The request on the first vetted address that accepts a connection: a
 * connect failure before any byte moves on to the next one, any later
 * failure is the answer. While other addresses remain, each attempt gets an
 * even share of the time left (at most CONNECT_ATTEMPT_MAX_MS).
 */
async function openPinned(u: URL, addresses: readonly Pinned[], opts: OpenOptions): Promise<{ req: http.ClientRequest; res: http.IncomingMessage }> {
  let last: SafeFetchError | null = null
  for (let i = 0; i < addresses.length; i++) {
    const left = addresses.length - i
    const remaining = Math.min(opts.headersBy, opts.deadline) - Date.now()
    if (remaining <= 0) throw last ?? new SafeFetchError('TIMEOUT', 'Request timed out')
    const connectMs = left > 1 ? Math.min(CONNECT_ATTEMPT_MAX_MS, Math.floor(remaining / left)) : remaining
    try {
      return await requestPinned(u, addresses[i], opts, connectMs)
    } catch (err) {
      if (!(err instanceof NotConnected)) throw err
      last = err.cause
    }
  }
  throw last ?? new SafeFetchError('NETWORK', 'No address to connect to')
}

function readBody(
  res: http.IncomingMessage,
  url: URL,
  opts: { method: string; maxBytes: number; truncate: boolean; deadline: number },
): Promise<SafeFetchResult> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const timer = setTimeout(() => res.destroy(new SafeFetchError('TIMEOUT', 'Request timed out')), Math.max(1, opts.deadline - Date.now()))
    const done = () => clearTimeout(timer)
    const declared = Number(res.headers['content-length'] || 0)
    if (opts.method !== 'HEAD' && declared > opts.maxBytes && !opts.truncate) {
      done()
      res.destroy()
      reject(new SafeFetchError('TOO_LARGE', `Response is ${declared} bytes (limit ${opts.maxBytes})`))
      return
    }
    let cut = false
    res.on('data', (chunk: Buffer) => {
      if (cut) return
      size += chunk.length
      if (size > opts.maxBytes) {
        done()
        res.destroy()
        if (opts.truncate) {
          cut = true
          chunks.push(chunk.subarray(0, chunk.length - (size - opts.maxBytes)))
          resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks), url: url.toString(), truncated: true })
          return
        }
        reject(new SafeFetchError('TOO_LARGE', `Response exceeded ${opts.maxBytes} bytes`))
        return
      }
      chunks.push(chunk)
    })
    res.on('end', () => {
      done()
      resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks), url: url.toString() })
    })
    res.on('error', (err) => {
      done()
      reject(err instanceof SafeFetchError ? err : new SafeFetchError('NETWORK', err.message))
    })
    // A connection that drops mid-body: never a silent short answer (a settled promise ignores this).
    res.on('close', () => {
      done()
      if (!res.complete && !cut) reject(new SafeFetchError('NETWORK', 'The connection closed before the response ended'))
    })
  })
}

export async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const method = options.method || 'GET'
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024
  const maxRedirects = options.maxRedirects ?? 3
  const resolve = options.resolve || defaultResolve
  const deadline = Date.now() + (options.timeoutMs ?? 5000)
  const local = honouredLocalOrigins(options.localOrigins)
  const headers = options.headers || {}
  let target = checkUrl(rawUrl, !!options.allowHttp, local)
  if (options.body !== undefined && method !== 'POST') throw new SafeFetchError('BAD_URL', `A ${method} request cannot carry a body`)
  const body = method === 'POST' ? Buffer.from(options.body ?? '', 'utf8') : undefined

  for (let hop = 0; ; hop++) {
    const addresses = await vetHost(target.url.hostname, resolve, target.local)
    if (Date.now() >= deadline) throw new SafeFetchError('TIMEOUT', 'Request timed out')
    const { res } = await openPinned(target.url, addresses, { method, headers, body, headersBy: deadline, deadline })
    const status = res.statusCode || 0
    const location = res.headers.location
    // A POST is never redirected (see the module comment): its 3xx is the answer.
    if (method !== 'POST' && options.redirect !== 'manual' && status >= 300 && status < 400 && typeof location === 'string') {
      res.destroy()
      // Credentials go to the vetted URL the caller named, never to wherever an answer points.
      if (carriesCredentials(headers)) throw new SafeFetchError('REDIRECTS', `Refused to follow a ${status} redirect with credentials`)
      if (hop >= maxRedirects) throw new SafeFetchError('REDIRECTS', 'Too many redirects')
      target = checkUrl(new URL(location, target.url).toString(), !!options.allowHttp, local)
      continue
    }
    return readBody(res, target.url, { method, maxBytes, truncate: !!options.truncate, deadline })
  }
}

// ── Streaming (model providers) ───────────────────────────────────────────

export type SafeStreamOptions = {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  /** Request body (POST only). */
  body?: string
  /** Until the response headers arrive, default 60 s. */
  connectTimeoutMs?: number
  /** Longest silence between two body chunks, default 300 s. */
  idleTimeoutMs?: number
  /** The whole exchange, default 15 min. */
  totalTimeoutMs?: number
  /** Body bytes, counted as they arrive; default 8 MB. */
  maxBytes?: number
  /** Aborting destroys the socket (ABORTED). */
  signal?: AbortSignal
  /** Exact loopback origins allowed while the site is local-only (AI_LOCAL_PROVIDER_ORIGINS only). */
  localOrigins?: readonly string[]
  /** Test seam: resolve a hostname to addresses (defaults to dns.lookup all). */
  resolve?: (host: string) => Promise<string[]>
}

export type SafeStream = {
  status: number
  headers: Record<string, string | string[] | undefined>
  /** The body as it arrives. Fails with IDLE, TIMEOUT, TOO_LARGE, ABORTED or NETWORK. */
  body: AsyncIterable<Buffer>
  url: string
  /** Stop reading and close the connection (idempotent). */
  close(): void
}

export const STREAM_DEFAULTS = {
  connectTimeoutMs: 60_000,
  idleTimeoutMs: 300_000,
  totalTimeoutMs: 15 * 60_000,
  maxBytes: 8 * 1024 * 1024,
} as const

/**
 * A request whose answer is read as a stream. Never follows a redirect: any
 * 3xx fails with REDIRECTS (a provider that redirects is misconfigured, and
 * following would carry the key to another host). Sends no Accept-Encoding
 * (the body is read as it is).
 */
export async function safeFetchStream(rawUrl: string, options: SafeStreamOptions = {}): Promise<SafeStream> {
  const started = Date.now()
  const method = options.method || 'POST'
  const connectTimeoutMs = options.connectTimeoutMs ?? STREAM_DEFAULTS.connectTimeoutMs
  const idleTimeoutMs = options.idleTimeoutMs ?? STREAM_DEFAULTS.idleTimeoutMs
  const deadline = started + (options.totalTimeoutMs ?? STREAM_DEFAULTS.totalTimeoutMs)
  const maxBytes = options.maxBytes ?? STREAM_DEFAULTS.maxBytes
  const signal = options.signal
  if (signal?.aborted) throw new SafeFetchError('ABORTED', 'The request was cancelled')
  const target = checkUrl(rawUrl, false, honouredLocalOrigins(options.localOrigins))
  if (options.body !== undefined && method !== 'POST') throw new SafeFetchError('BAD_URL', `A ${method} request cannot carry a body`)
  const body = method === 'POST' ? Buffer.from(options.body ?? '', 'utf8') : undefined
  const addresses = await vetHost(target.url.hostname, options.resolve || defaultResolve, target.local)
  if (signal?.aborted) throw new SafeFetchError('ABORTED', 'The request was cancelled')
  const { req, res } = await openPinned(target.url, addresses, {
    method,
    headers: options.headers || {},
    body,
    headersBy: started + connectTimeoutMs,
    deadline,
    signal,
  })
  const status = res.statusCode || 0
  if (status >= 300 && status < 400) {
    res.destroy()
    req.destroy()
    throw new SafeFetchError('REDIRECTS', `The server answered ${status}: a redirect is not followed`)
  }

  const stop = (err: SafeFetchError) => {
    if (!res.destroyed) res.destroy(err)
    req.destroy()
  }
  // Before the caller starts reading too, the total budget and the signal apply.
  const onAbort = () => stop(new SafeFetchError('ABORTED', 'The request was cancelled'))
  signal?.addEventListener('abort', onAbort, { once: true })
  const totalTimer = setTimeout(() => stop(new SafeFetchError('TIMEOUT', 'The response took too long')), Math.max(1, deadline - Date.now()))
  // Socket inactivity is the idle timer's job from here on.
  req.setTimeout(0)
  let closed = false
  const close = () => {
    clearTimeout(totalTimer)
    signal?.removeEventListener('abort', onAbort)
    if (closed) return
    closed = true
    res.destroy()
    req.destroy()
  }

  async function* chunks(): AsyncGenerator<Buffer> {
    let size = 0
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const armIdle = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => stop(new SafeFetchError('IDLE', `No data for ${Math.round(idleTimeoutMs / 1000)} s`)), Math.max(1, idleTimeoutMs))
    }
    try {
      armIdle()
      for await (const chunk of res as AsyncIterable<Buffer>) {
        size += chunk.length
        if (size > maxBytes) {
          const err = new SafeFetchError('TOO_LARGE', `Response exceeded ${maxBytes} bytes`)
          stop(err)
          throw err
        }
        armIdle()
        yield chunk
      }
      if (closed) return
      // A destroyed stream can end the loop without an error: report why it stopped.
      const reason = res.errored
      if (reason) throw reason instanceof SafeFetchError ? reason : new SafeFetchError('NETWORK', reason.message)
      if (!res.complete) throw new SafeFetchError('NETWORK', 'The connection closed before the response ended')
    } catch (err) {
      if (err instanceof SafeFetchError) throw err
      const reason = res.errored
      if (reason instanceof SafeFetchError) throw reason
      throw new SafeFetchError('NETWORK', err instanceof Error ? err.message : String(err))
    } finally {
      clearTimeout(idleTimer)
      close()
    }
  }

  return { status, headers: res.headers, body: chunks(), url: target.url.toString(), close }
}
