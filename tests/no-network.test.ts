/**
 * The unit-test bootstrap (tests/register.mjs → tests/no-network.mjs)
 * refuses every connection and DNS lookup that leaves this machine and
 * fails the test file that made one; loopback keeps working. This file
 * makes refused attempts on purpose and then clears the record, so it
 * passes only while the guard is installed.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'

const refused = (globalThis as unknown as Record<symbol, string[] | undefined>)[Symbol.for('portfolio-studio.tests.refusedNetwork')]

after(() => {
  // Made on purpose: they must not fail this file.
  refused?.splice(0)
})

test('the guard is installed', () => {
  assert.ok(Array.isArray(refused), 'tests/register.mjs loads tests/no-network.mjs under node --test')
})

test('fetch, https.request and DNS lookups to a public host are refused before anything is sent', async () => {
  const before = refused!.length
  const viaFetch = await fetch('https://api.github.com/zen').then(
    () => null,
    (err: Error & { cause?: { code?: string } }) => err,
  )
  assert.equal(viaFetch?.cause?.code, 'ECONNREFUSED')
  const viaHttps = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
    https.get('https://example.com/', () => resolve(null)).on('error', resolve)
  })
  assert.equal(viaHttps?.code, 'ECONNREFUSED')
  await assert.rejects(dns.promises.lookup('example.com'), { code: 'ENOTFOUND' })
  const viaCallback = await new Promise<NodeJS.ErrnoException | null>((resolve) => dns.lookup('example.org', (err) => resolve(err)))
  assert.equal(viaCallback?.code, 'ENOTFOUND')
  assert.deepEqual(refused!.slice(before), ['connect api.github.com:443', 'connect example.com:443', 'dns example.com', 'dns example.org'])
})

test('a server on this machine is reachable (127.0.0.1 and localhost)', async () => {
  const server = http.createServer((_req, res) => res.end('ok'))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address() as { port: number }
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'ok')
    assert.equal(await (await fetch(`http://localhost:${port}/`)).text(), 'ok')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
