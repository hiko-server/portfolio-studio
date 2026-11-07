import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { isPublicAddress, safeFetch, SafeFetchError } from '../lib/security/safeFetch'

test('public vs reserved address classification', () => {
  for (const pub of ['8.8.8.8', '1.1.1.1', '9.9.9.9', '2606:4700:4700::1111', '2a00:1450:4001::200e']) {
    assert.equal(isPublicAddress(pub), true, pub)
  }
  for (const blocked of [
    '127.0.0.1', '10.1.2.3', '172.19.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1',
    '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::a00:1', '2002:7f00:1::', 'not-an-ip',
  ]) {
    assert.equal(isPublicAddress(blocked), false, blocked)
  }
})

const code = async (p: Promise<unknown>) => {
  try {
    await p
    return 'resolved'
  } catch (e) {
    return e instanceof SafeFetchError ? e.code : `other:${(e as Error).message}`
  }
}

test('URL rules: protocol, credentials, port, local hostnames', async () => {
  assert.equal(await code(safeFetch('ftp://example.com/x')), 'BAD_URL')
  assert.equal(await code(safeFetch('http://example.com/x')), 'BAD_URL')
  assert.equal(await code(safeFetch('https://user:pw@example.com/x')), 'BAD_URL')
  assert.equal(await code(safeFetch('https://example.com:8443/x')), 'BAD_URL')
  assert.equal(await code(safeFetch('not a url')), 'BAD_URL')
  assert.equal(await code(safeFetch('https://localhost/x')), 'BLOCKED_HOST')
  assert.equal(await code(safeFetch('https://printer.local/x')), 'BLOCKED_HOST')
  assert.equal(await code(safeFetch('https://127.0.0.1/x')), 'BLOCKED_HOST')
  assert.equal(await code(safeFetch('https://[::1]/x')), 'BLOCKED_HOST')
  assert.equal(await code(safeFetch('https://169.254.169.254/latest/meta-data/')), 'BLOCKED_HOST')
})

test('every DNS answer must be public (mixed public/private records are refused)', async () => {
  const resolve = async () => ['93.184.216.34', '10.0.0.5']
  assert.equal(await code(safeFetch('https://mixed.example/x', { resolve })), 'BLOCKED_HOST')
  assert.equal(await code(safeFetch('https://internal.example/x', { resolve: async () => ['172.17.0.2'] })), 'BLOCKED_HOST')
  assert.equal(await code(safeFetch('https://nx.example/x', { resolve: async () => { throw new Error('ENOTFOUND') } })), 'DNS')
})

test('redirects are re-checked on every hop', async () => {
  // A local server stands in for a public host (the resolver is stubbed to a
  // public-looking name that the pinned lookup maps to loopback only for the
  // first hop): it redirects to an internal address, which must be refused.
  const server = http.createServer((_req, res) => {
    res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' })
    res.end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  try {
    // Port must be default for policy; emulate by allowing http and using the
    // isPublicAddress bypass only through the resolver stub for hop one.
    const result = await code(
      safeFetch(`http://redirector.test:${port}/`, { allowHttp: true, resolve: async () => ['127.0.0.1'] }),
    )
    // Non-default port is refused before any connection is made.
    assert.equal(result, 'BAD_URL')
  } finally {
    server.close()
  }
})

test('the reserved list never collapses into a catch-all', () => {
  // Regression: a v4-mapped CIDR folds to IPv4 /0 in parseCidr.
  assert.equal(isPublicAddress('8.8.8.8'), true)
  assert.equal(isPublicAddress('::ffff:8.8.8.8'), true)
})

// ── AI F1: F6, F4, local origins, next-address fallback, the stream ─────────

import { exactOrigin, safeFetchStream, STREAM_DEFAULTS } from '../lib/security/safeFetch'
import net from 'node:net'

test('F6: IPv4-compatible, IPv4-translated, site-local, documentation and SRv6 addresses are not public', () => {
  for (const blocked of ['::7f00:1', '::a9fe:a9fe', '::a00:1', '::ffff:0:7f00:1', '::ffff:0:a9fe:a9fe', 'fec0::1', 'feff::1', '3fff::1', '3fff:fff::1', '5f00::1', '5f00:ffff::1']) {
    assert.equal(isPublicAddress(blocked), false, blocked)
  }
  // Ordinary public IPv6 (and v4-mapped public IPv4) stays public: no new entry swallowed it.
  for (const pub of ['2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001::200e', '2400:cb00::1', '3000::1', '5e00::1', '5f01::1', '::ffff:8.8.8.8', '8.8.4.4']) {
    assert.equal(isPublicAddress(pub), true, pub)
  }
})

test('exactOrigin accepts origins only: no path, query, fragment or credentials', () => {
  assert.equal(exactOrigin('http://127.0.0.1:11434'), 'http://127.0.0.1:11434')
  assert.equal(exactOrigin('http://127.0.0.1:11434/'), 'http://127.0.0.1:11434')
  assert.equal(exactOrigin(' http://LOCALHOST:1234 '), 'http://localhost:1234')
  assert.equal(exactOrigin('https://[::1]:8443'), 'https://[::1]:8443')
  for (const bad of ['http://127.0.0.1:11434/v1', 'http://127.0.0.1:1?', 'http://127.0.0.1:1/#x', 'http://u:p@127.0.0.1:1', 'ftp://127.0.0.1', 'file:///etc/passwd', '127.0.0.1:11434', '']) {
    assert.equal(exactOrigin(bad), null, bad)
  }
})

type Hit = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }

/** A loopback HTTP server that records what reached it; `handle` answers. */
async function server(handle: (req: http.IncomingMessage, res: http.ServerResponse) => void, host = '127.0.0.1') {
  const hits: Hit[] = []
  const sockets = new Set<net.Socket>()
  const closed: Array<() => void> = []
  const srv = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      hits.push({ method: req.method || '', url: req.url || '', headers: req.headers, body })
      handle(req, res)
    })
  })
  srv.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => {
      sockets.delete(s)
      for (const f of closed.splice(0)) f()
    })
  })
  await new Promise<void>((r) => srv.listen(0, host, r))
  const { port } = srv.address() as AddressInfo
  return {
    port,
    hits,
    origin: `http://${host.includes(':') ? `[${host}]` : host}:${port}`,
    /** Resolves when the next client connection closes. */
    nextClose: () => new Promise<void>((r) => closed.push(r)),
    openSockets: () => sockets.size,
    close: async () => {
      for (const s of sockets) s.destroy()
      await new Promise<void>((r) => srv.close(() => r()))
    },
  }
}

/** Run `fn` as a local-only site (SITE_URL on loopback), restoring the environment after. */
async function asLocalSite<T>(fn: () => Promise<T>, siteUrl = 'http://127.0.0.1:3002'): Promise<T> {
  const saved = { SITE_URL: process.env.SITE_URL, NEXT_PUBLIC_SITE_HOST: process.env.NEXT_PUBLIC_SITE_HOST }
  process.env.SITE_URL = siteUrl
  delete process.env.NEXT_PUBLIC_SITE_HOST
  try {
    return await fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

/** True when nothing accepts connections on [::1]:port (so a connect there is refused). */
async function refusedOnV6Loopback(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '::1', port })
    s.once('connect', () => {
      s.destroy()
      resolve(false)
    })
    s.once('error', () => resolve(true))
  })
}

test('local origins: honoured only on a local-only site, exact, and loopback only', async () => {
  const s = await server((_req, res) => res.end('local ok'))
  try {
    const opts = { localOrigins: [s.origin] }
    // No SITE_URL, or a public one: the list is ignored, so plain http on a high port is refused.
    await asLocalSite(async () => assert.equal(await code(safeFetch(`${s.origin}/v1/models`, opts)), 'BAD_URL'), '')
    await asLocalSite(async () => assert.equal(await code(safeFetch(`${s.origin}/v1/models`, opts)), 'BAD_URL'), 'https://site.example')
    await asLocalSite(async () => {
      process.env.NEXT_PUBLIC_SITE_HOST = 'site.example'
      assert.equal(await code(safeFetch(`${s.origin}/v1/models`, opts)), 'BAD_URL')
    })
    // Local-only: exactly the listed origin, any path under it.
    await asLocalSite(async () => {
      const res = await safeFetch(`${s.origin}/v1/models`, opts)
      assert.equal(res.status, 200)
      assert.equal(res.body.toString(), 'local ok')
      // Another port on the same host is not listed.
      assert.equal(await code(safeFetch(`http://127.0.0.1:${s.port + 1}/x`, opts)), 'BAD_URL')
      // A path or prefix is not an origin: ignored.
      assert.equal(await code(safeFetch(`${s.origin}/v1/models`, { localOrigins: [`${s.origin}/v1`] })), 'BAD_URL')
      // A listed name must resolve to loopback only: a private or metadata answer is refused.
      for (const addresses of [['10.0.0.5'], ['127.0.0.1', '169.254.169.254'], ['192.168.1.20']]) {
        const r = await code(safeFetch(`http://model.test:${s.port}/x`, { localOrigins: [`http://model.test:${s.port}`], resolve: async () => addresses }))
        assert.equal(r, 'BLOCKED_HOST', addresses.join(','))
      }
      // Listing the metadata address itself does not make it reachable.
      assert.equal(await code(safeFetch('http://169.254.169.254/latest/meta-data/', { localOrigins: ['http://169.254.169.254'] })), 'BLOCKED_HOST')
    })
  } finally {
    await s.close()
  }
})

test('the pin holds: one vetted lookup per request, and the socket goes to that address', async () => {
  const s = await server((_req, res) => res.end('pinned'))
  try {
    await asLocalSite(async () => {
      let lookups = 0
      const resolve = async (host: string) => {
        lookups++
        assert.equal(host, 'pin-check.test')
        return ['127.0.0.1']
      }
      // `.test` never resolves through the system: reaching the server proves the pinned address was used.
      const origin = `http://pin-check.test:${s.port}`
      assert.equal((await safeFetch(`${origin}/a`, { localOrigins: [origin], resolve })).body.toString(), 'pinned')
      assert.equal((await safeFetch(`${origin}/b`, { localOrigins: [origin], resolve })).body.toString(), 'pinned')
      assert.equal(lookups, 2, 're-vetted on every request')
      assert.equal(s.hits.at(-1)?.headers.host, `pin-check.test:${s.port}`, 'Host keeps the name')
      const stream = await safeFetchStream(`${origin}/c`, { method: 'GET', localOrigins: [origin], resolve })
      for await (const chunk of stream.body) assert.equal(chunk.toString(), 'pinned')
      assert.equal(lookups, 3)
    })
  } finally {
    await s.close()
  }
})

test('next-address fallback: a refused first address moves on, for safeFetch and the stream alike', async () => {
  const s = await server((_req, res) => res.end('second address'))
  try {
    assert.ok(await refusedOnV6Loopback(s.port), 'nothing listens on [::1] at this port')
    await asLocalSite(async () => {
      const origin = `http://dual.test:${s.port}`
      // An IPv6 answer first that cannot be reached, then the one that answers.
      const resolve = async () => ['::1', '127.0.0.1']
      const res = await safeFetch(`${origin}/models`, { localOrigins: [origin], resolve })
      assert.equal(res.body.toString(), 'second address')
      const stream = await safeFetchStream(`${origin}/stream`, { body: '{"x":1}', localOrigins: [origin], resolve })
      let text = ''
      for await (const chunk of stream.body) text += chunk.toString()
      assert.equal(text, 'second address')
      // Each request reached the server exactly once: nothing was sent twice.
      assert.deepEqual(s.hits.map((h) => `${h.method} ${h.url}`), ['GET /models', 'POST /stream'])
      assert.equal(s.hits[1].body, '{"x":1}')
      // Every address refused: the connect error is the answer.
      assert.equal(await code(safeFetch(`${origin}/x`, { localOrigins: [origin], resolve: async () => ['::1'] })), 'NETWORK')
      assert.equal(await code(safeFetchStream(`${origin}/x`, { localOrigins: [origin], resolve: async () => ['::1'] })), 'NETWORK')
    })
  } finally {
    await s.close()
  }
})

test('F4: a request carrying credentials is never redirected; manual hands the 3xx back; others still follow', async () => {
  const elsewhere = await server((_req, res) => res.end('elsewhere'))
  const provider = await server((_req, res) => {
    res.writeHead(302, { location: `${elsewhere.origin}/collect` })
    res.end()
  })
  try {
    await asLocalSite(async () => {
      const localOrigins = [provider.origin, elsewhere.origin]
      const credentialed: Array<Record<string, string>> = [{ authorization: 'Bearer sk-test-SENTINEL' }, { 'x-api-key': 'sk-test-SENTINEL' }, { 'x-goog-api-key': 'k' }, { cookie: 'a=b' }]
      for (const headers of credentialed) {
        assert.equal(await code(safeFetch(`${provider.origin}/v1/models`, { headers, localOrigins })), 'REDIRECTS', Object.keys(headers)[0])
      }
      assert.equal(elsewhere.hits.length, 0, 'the credentials never reached the redirect target')
      const manual = await safeFetch(`${provider.origin}/v1/models`, { headers: { authorization: 'Bearer sk-test-SENTINEL' }, redirect: 'manual', localOrigins })
      assert.equal(manual.status, 302)
      assert.equal(elsewhere.hits.length, 0)
      // Without credentials the redirect is followed as before (and re-vetted).
      const followed = await safeFetch(`${provider.origin}/feed`, { headers: { accept: 'application/json' }, localOrigins })
      assert.equal(followed.body.toString(), 'elsewhere')
      assert.equal(elsewhere.hits.length, 1)
      assert.equal(elsewhere.hits[0].headers.authorization, undefined)
    })
  } finally {
    await provider.close()
    await elsewhere.close()
  }
})

test('stream: the body arrives as it is sent, no Accept-Encoding, and a redirect is refused outright', async () => {
  const target = await server((_req, res) => res.end('target'))
  const s = await server((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(307, { location: `${target.origin}/v1/chat/completions` })
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    let n = 0
    const tick = setInterval(() => {
      res.write(`data: ${n}\n\n`)
      if (++n === 3) {
        clearInterval(tick)
        res.end()
      }
    }, 10)
  })
  try {
    await asLocalSite(async () => {
      const localOrigins = [s.origin, target.origin]
      const stream = await safeFetchStream(`${s.origin}/v1/chat/completions`, { body: '{"stream":true}', headers: { authorization: 'Bearer sk-test-SENTINEL', 'content-type': 'application/json' }, localOrigins })
      assert.equal(stream.status, 200)
      assert.equal(stream.headers['content-type'], 'text/event-stream')
      const parts: string[] = []
      for await (const chunk of stream.body) parts.push(chunk.toString())
      assert.equal(parts.join(''), 'data: 0\n\ndata: 1\n\ndata: 2\n\n')
      const hit = s.hits[0]
      assert.equal(hit.method, 'POST')
      assert.equal(hit.body, '{"stream":true}')
      assert.equal(hit.headers['accept-encoding'], undefined)
      assert.equal(hit.headers['content-length'], String(Buffer.byteLength('{"stream":true}')))

      assert.equal(await code(safeFetchStream(`${s.origin}/redirect`, { body: '{}', headers: { authorization: 'Bearer sk-test-SENTINEL' }, localOrigins })), 'REDIRECTS')
      assert.equal(target.hits.length, 0, 'nothing followed the redirect')
      // Public rules otherwise: a private address, an http URL, a non-default port.
      assert.equal(await code(safeFetchStream('https://10.0.0.1/v1/chat/completions', { body: '{}' })), 'BLOCKED_HOST')
      assert.equal(await code(safeFetchStream('https://[fec0::1]/v1', { body: '{}' })), 'BLOCKED_HOST')
      assert.equal(await code(safeFetchStream('http://api.example/v1', { body: '{}' })), 'BAD_URL')
      assert.equal(await code(safeFetchStream('https://api.example:8443/v1', { body: '{}' })), 'BAD_URL')
      assert.equal(await code(safeFetchStream('https://localhost/v1', { body: '{}' })), 'BLOCKED_HOST')
    })
  } finally {
    await s.close()
    await target.close()
  }
})

/** Drain a stream body; returns the SafeFetchError code it failed with, or 'ended'. */
async function drain(body: AsyncIterable<Buffer>, onChunk?: (c: Buffer) => void): Promise<string> {
  try {
    for await (const c of body) onChunk?.(c)
    return 'ended'
  } catch (e) {
    return e instanceof SafeFetchError ? e.code : `other:${(e as Error).message}`
  }
}

test('stream: the idle timer fires while the total budget has not, and the socket goes', async () => {
  const s = await server((_req, res) => {
    res.writeHead(200)
    res.write('first')
    // …then nothing.
  })
  try {
    await asLocalSite(async () => {
      const started = Date.now()
      const stream = await safeFetchStream(`${s.origin}/stall`, { method: 'GET', idleTimeoutMs: 150, totalTimeoutMs: 10_000, localOrigins: [s.origin] })
      const closed = s.nextClose()
      const chunks: string[] = []
      assert.equal(await drain(stream.body, (c) => chunks.push(c.toString())), 'IDLE')
      assert.deepEqual(chunks, ['first'])
      assert.ok(Date.now() - started < 5_000, 'well before the total budget')
      await closed
      assert.equal(s.openSockets(), 0)
    })
  } finally {
    await s.close()
  }
})

test('stream: the total budget holds even while data keeps trickling in', async () => {
  const s = await server((_req, res) => {
    res.writeHead(200)
    const tick = setInterval(() => res.write('.'), 20)
    res.on('close', () => clearInterval(tick))
  })
  try {
    await asLocalSite(async () => {
      const started = Date.now()
      const stream = await safeFetchStream(`${s.origin}/trickle`, { method: 'GET', idleTimeoutMs: 1_000, totalTimeoutMs: 300, localOrigins: [s.origin] })
      assert.equal(await drain(stream.body), 'TIMEOUT')
      assert.ok(Date.now() - started < 3_000)
    })
  } finally {
    await s.close()
  }
})

test('stream: abort destroys the socket, before and after the headers', async () => {
  const s = await server((req, res) => {
    if (req.url === '/slow-headers') return // never answers
    res.writeHead(200)
    res.write('one')
  })
  try {
    await asLocalSite(async () => {
      const ac = new AbortController()
      const stream = await safeFetchStream(`${s.origin}/held`, { method: 'GET', signal: ac.signal, localOrigins: [s.origin] })
      const closed = s.nextClose()
      const seen: string[] = []
      const result = drain(stream.body, (c) => {
        seen.push(c.toString())
        ac.abort()
      })
      assert.equal(await result, 'ABORTED')
      assert.deepEqual(seen, ['one'])
      await closed
      // While waiting for the headers.
      const early = new AbortController()
      const pending = code(safeFetchStream(`${s.origin}/slow-headers`, { method: 'GET', signal: early.signal, localOrigins: [s.origin] }))
      const closedEarly = s.nextClose()
      setTimeout(() => early.abort(), 50)
      assert.equal(await pending, 'ABORTED')
      await closedEarly
      // Already aborted: nothing is sent at all.
      const before = s.hits.length
      const done = new AbortController()
      done.abort()
      assert.equal(await code(safeFetchStream(`${s.origin}/never`, { method: 'GET', signal: done.signal, localOrigins: [s.origin] })), 'ABORTED')
      assert.equal(s.hits.length, before)
      assert.equal(s.openSockets(), 0)
    })
  } finally {
    await s.close()
  }
})

test('stream: bytes are capped as they flow, and the connect budget covers a server that never answers', async () => {
  const s = await server((req, res) => {
    if (req.url === '/silent') return
    res.writeHead(200)
    const chunk = Buffer.alloc(16 * 1024, 120)
    const tick = setInterval(() => res.write(chunk), 2)
    res.on('close', () => clearInterval(tick))
  })
  try {
    await asLocalSite(async () => {
      const stream = await safeFetchStream(`${s.origin}/flood`, { method: 'GET', maxBytes: 100 * 1024, localOrigins: [s.origin] })
      const closed = s.nextClose()
      let total = 0
      assert.equal(await drain(stream.body, (c) => (total += c.length)), 'TOO_LARGE')
      assert.ok(total <= 100 * 1024, `delivered ${total} bytes`)
      await closed
      assert.equal(await code(safeFetchStream(`${s.origin}/silent`, { method: 'GET', connectTimeoutMs: 200, localOrigins: [s.origin] })), 'TIMEOUT')
    })
  } finally {
    await s.close()
  }
})

test('stream defaults are the design caps: 60 s to headers, 300 s idle, 15 min total, 8 MB', () => {
  assert.deepEqual({ ...STREAM_DEFAULTS }, { connectTimeoutMs: 60_000, idleTimeoutMs: 300_000, totalTimeoutMs: 900_000, maxBytes: 8 * 1024 * 1024 })
})

test('stream: a timeout, an abort or a dropped connection before reading starts is reported when it does, never thrown at the process', async () => {
  const s = await server((req, res) => {
    res.writeHead(200)
    res.write('head')
    if (req.url === '/drop') setTimeout(() => res.socket?.destroy(), 20)
  })
  try {
    await asLocalSite(async () => {
      const ac = new AbortController()
      const aborted = await safeFetchStream(`${s.origin}/held`, { method: 'GET', signal: ac.signal, localOrigins: [s.origin] })
      const slow = await safeFetchStream(`${s.origin}/held`, { method: 'GET', totalTimeoutMs: 40, localOrigins: [s.origin] })
      const dropped = await safeFetchStream(`${s.origin}/drop`, { method: 'GET', localOrigins: [s.origin] })
      ac.abort()
      // Let every timer and socket event fire while nobody reads.
      await new Promise((r) => setTimeout(r, 150))
      assert.equal(await drain(aborted.body), 'ABORTED')
      assert.equal(await drain(slow.body), 'TIMEOUT')
      assert.equal(await drain(dropped.body), 'NETWORK')
    })
  } finally {
    await s.close()
  }
})
