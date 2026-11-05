/**
 * tests/helpers/realRoute.ts and the editorial harness's AI extension: the
 * real socket the MCP route's tests depend on, and the clean environment every
 * store test starts from.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { editorialHarness, loadStoreCloser, scrubAiEnv } from './editorialHarness'
import { startRealRoute } from './helpers/realRoute'

test('a route runs on a real socket with Next helpers, cookies, query and a parsed JSON body', async () => {
  const route = await startRealRoute({
    default: (req, res) => {
      res.setHeader('x-real', typeof req.socket.remotePort)
      res.status(201).json({ method: req.method, body: req.body, query: req.query, cookie: req.cookies.session, host: req.headers.host })
    },
  })
  try {
    const res = await route.fetch('/?a=1&b=2&b=3', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'session=abc' },
      body: JSON.stringify({ hello: '世界' }),
    })
    assert.equal(res.status, 201)
    assert.equal(res.headers.get('x-real'), 'number')
    assert.deepEqual(await res.json(), {
      method: 'POST',
      body: { hello: '世界' },
      query: { a: '1', b: ['2', '3'] },
      cookie: 'abc',
      host: `127.0.0.1:${route.port}`,
    })
  } finally {
    await route.close()
  }
})

test('the route config applies: bodyParser false leaves the raw stream unread', async () => {
  const route = await startRealRoute({
    config: { api: { bodyParser: false } },
    default: async (req, res) => {
      assert.equal(req.body, undefined)
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      res.status(200).send(Buffer.concat(chunks).toString('utf8').toUpperCase())
    },
  })
  try {
    const res = await route.fetch('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"not":"parsed"}' })
    assert.equal(await res.text(), '{"NOT":"PARSED"}')
  } finally {
    await route.close()
  }
})

test('a configured body limit answers 413 from the resolver, before the handler runs', async () => {
  let ran = false
  const route = await startRealRoute({
    config: { api: { bodyParser: { sizeLimit: 10 } } },
    default: (_req, res) => {
      ran = true
      res.status(200).end()
    },
  })
  try {
    const res = await route.fetch('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x: 'y'.repeat(100) }) })
    assert.equal(res.status, 413)
    assert.equal(ran, false)
  } finally {
    await route.close()
  }
})

test('raw() sends what fetch refuses: a forged Host reaches the handler as sent', async () => {
  const route = await startRealRoute({
    default: (req, res) => res.status(200).json({ host: req.headers.host, forwarded: req.headers['x-forwarded-host'] ?? null }),
  })
  try {
    const res = await route.raw({ headers: { Host: 'evil.example', 'X-Forwarded-Host': 'example.com' } })
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.body), { host: 'evil.example', forwarded: 'example.com' })
  } finally {
    await route.close()
  }
})

test('revalidate is recorded and a thrown error is captured instead of crashing the server', async (t) => {
  t.mock.method(console, 'error', () => {}) // Next's resolver reports the error it rethrows
  const route = await startRealRoute({
    default: async (req, res) => {
      if (req.query.fail) throw new Error('route failed')
      await res.revalidate('/blog')
      await res.revalidate('/')
      res.status(200).end()
    },
  })
  try {
    assert.equal((await route.fetch('/')).status, 200)
    assert.deepEqual(route.revalidated, ['/blog', '/'])
    assert.equal((await route.fetch('/?fail=1')).status, 500)
    assert.equal(route.errors.length, 1)
    assert.equal((await route.fetch('/')).status, 200)
  } finally {
    await route.close()
  }
})

test('toNodeHandler works on the real response, and sees the client hang up', async () => {
  let aborted: Promise<void> = Promise.resolve()
  const node = toNodeHandler({
    fetch: async (request: Request) => {
      aborted = new Promise<void>((resolve) => request.signal.addEventListener('abort', () => resolve()))
      if (new URL(request.url).searchParams.has('hang')) {
        const stream = new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('first'))
          },
        })
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/plain' } })
      }
      return Response.json({ method: request.method, body: await request.json() })
    },
  })
  const route = await startRealRoute({
    config: { api: { bodyParser: false, responseLimit: false, externalResolver: true } },
    default: (req, res) => node(req, res),
  })
  try {
    const res = await route.fetch('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0"}' })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { method: 'POST', body: { jsonrpc: '2.0' } })

    const abort = new AbortController()
    const hanging = await route.fetch('/?hang=1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: abort.signal })
    const reader = hanging.body!.getReader()
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'first')
    abort.abort()
    await aborted
    assert.deepEqual(route.errors, [])
  } finally {
    await route.close()
  }
})

test('close() ends the server with a connection still open', async () => {
  const route = await startRealRoute({
    config: { api: { externalResolver: true } },
    default: (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.write('open')
    },
  })
  const res = await route.fetch('/')
  const reader = res.body!.getReader()
  await reader.read()
  await route.close()
  await assert.rejects(reader.read().then((r) => (r.done ? Promise.reject(new Error('ended')) : r)))
  await assert.rejects(route.fetch('/'))
})

test('the harness removes AI_* and ANTHROPIC_* and nothing else', () => {
  const env = { AI_KEYS_SECRET: 'x', AI_LOCAL_PROVIDER_ORIGINS: 'y', ANTHROPIC_LOG: 'debug', ANTHROPIC_CUSTOM_HEADERS: 'a: b', ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'o', MAIL_AI_X: 'kept', PATH: '/bin' } as unknown as NodeJS.ProcessEnv
  scrubAiEnv(env)
  assert.deepEqual(env, { OPENAI_API_KEY: 'o', MAIL_AI_X: 'kept', PATH: '/bin' })
})

test('importing the harness scrubbed this process, and teardown scrubs what a test set', async () => {
  assert.equal(Object.keys(process.env).some((k) => k.startsWith('AI_') || k.startsWith('ANTHROPIC_')), false)
  const h = editorialHarness('real-route-helper')
  await h.setup()
  process.env.AI_KEYS_SECRET = 'set-by-a-test'
  process.env.ANTHROPIC_LOG = 'debug'
  h.teardown()
  assert.equal(process.env.AI_KEYS_SECRET, undefined)
  assert.equal(process.env.ANTHROPIC_LOG, undefined)
  assert.equal(fs.existsSync(h.tmp), false)
  delete process.env.JWT_SECRET
})

test('loadStoreCloser: absent module is null, a module without the function throws, a close function is returned', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-closer-'))
  try {
    assert.equal(await loadStoreCloser(new URL(`file://${dir}/absent.mjs`), 'closeAiDb'), null)
    fs.writeFileSync(path.join(dir, 'wrong.mjs'), 'export const other = 1\n')
    await assert.rejects(loadStoreCloser(new URL(`file://${dir}/wrong.mjs`), 'closeAiDb'), /must export closeAiDb/)
    fs.writeFileSync(path.join(dir, 'right.mjs'), 'export function closeAiDb() { globalThis.__storeClosed = true }\n')
    const close = await loadStoreCloser(new URL(`file://${dir}/right.mjs`), 'closeAiDb')
    close?.()
    assert.equal((globalThis as { __storeClosed?: boolean }).__storeClosed, true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
