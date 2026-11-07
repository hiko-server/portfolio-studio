/**
 * AI budgets (design §5.5): request rates in their own in-memory limiter;
 * the failed-auth bucket read with peek and charged only on failure;
 * persisted counters in ai.db that survive a restart, charge all-or-nothing
 * and never over-issue across processes.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { NextApiRequest } from 'next'

const ROOT = path.resolve(import.meta.dirname, '..')
const prevCwd = process.cwd()
let tmp = ''

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-budgets-'))
  process.chdir(tmp)
})
after(async () => {
  const { closeAiDb } = await import('../lib/ai/db')
  closeAiDb()
  process.chdir(prevCwd)
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** A request from `ip` straight to the server (no proxy header is believed from a public peer). */
const reqFrom = (ip: string) => ({ headers: {}, socket: { remoteAddress: ip }, url: '/api/mcp' }) as unknown as NextApiRequest

test('the design numbers', async () => {
  const { MEMORY_BUDGETS, PERSISTED_BUDGETS, QUERY_BUDGETS } = await import('../lib/ai/budgets')
  const min = 60_000
  assert.deepEqual(MEMORY_BUDGETS.failedAuth, { limit: 60, windowMs: 10 * min })
  assert.deepEqual([MEMORY_BUDGETS.mcpPerGrantMinute, MEMORY_BUDGETS.mcpPerGrantHour], [{ limit: 60, windowMs: min }, { limit: 600, windowMs: 60 * min }])
  assert.deepEqual(MEMORY_BUDGETS.toolCallsPerGrant, { limit: 60, windowMs: min })
  assert.deepEqual(MEMORY_BUDGETS.expensiveReadsSite, { limit: 6, windowMs: min })
  assert.deepEqual(MEMORY_BUDGETS.aiWritesSite, { limit: 60, windowMs: 10 * min })
  assert.deepEqual(MEMORY_BUDGETS.oauthPerNetwork, { limit: 30, windowMs: 10 * min })
  assert.deepEqual(MEMORY_BUDGETS.registerPerNetwork, { limit: 5, windowMs: 60 * min })
  assert.deepEqual(MEMORY_BUDGETS.providerCheck, { limit: 10, windowMs: 10 * min })
  assert.deepEqual(PERSISTED_BUDGETS, {
    grantWritesHour: { limit: 30, windowMs: 60 * min },
    grantWritesDay: { limit: 200, windowMs: 24 * 60 * min },
    grantBytesDay: { limit: 20 * 1024 * 1024, windowMs: 24 * 60 * min },
    itemWritesHour: { limit: 30, windowMs: 60 * min },
    itemWritesDay: { limit: 100, windowMs: 24 * 60 * min },
  })
  assert.deepEqual({ ...QUERY_BUDGETS }, { aiDraftsPerGrant: 50, waitingPerGrant: 10, waitingSite: 20, waitingReservedForAssistant: 5 })
})

test('memory budgets: per subject, Retry-After from the window, and a separate limiter from the site', async () => {
  const { peekMemory, takeMemory } = await import('../lib/ai/budgets')
  const { sharedLimiter } = await import('../lib/security/rateLimitCore')
  const t0 = 5_000_000
  for (let i = 0; i < 6; i++) assert.deepEqual(takeMemory('expensiveReadsSite', 'site-test', t0 + i), { ok: true })
  assert.deepEqual(takeMemory('expensiveReadsSite', 'site-test', t0 + 10), { ok: false, budget: 'expensiveReadsSite', retryAfterS: 60 })
  assert.deepEqual(peekMemory('expensiveReadsSite', 'site-test', t0 + 30_000), { ok: false, budget: 'expensiveReadsSite', retryAfterS: 30 })
  assert.deepEqual(takeMemory('expensiveReadsSite', 'other-site', t0 + 10), { ok: true })
  assert.deepEqual(takeMemory('expensiveReadsSite', 'site-test', t0 + 60_000), { ok: true }, 'the window reset')
  // Not in the general limiter: AI traffic can never push the site's own windows out.
  assert.equal(sharedLimiter('api').peek('expensiveReadsSite|site-test', 6, t0).remaining, 6)
})

test('failed auth: peeking never spends it; only failures do, per client and per IPv6 /48', async () => {
  const { chargeFailedAuth, failedAuthBlocked } = await import('../lib/ai/budgets')
  const t0 = 9_000_000
  const client = reqFrom('198.51.100.23')
  // Valid traffic peeks on every request and is never throttled by it.
  for (let i = 0; i < 1000; i++) assert.deepEqual(failedAuthBlocked(client, t0 + i), { ok: true })
  for (let i = 0; i < 59; i++) chargeFailedAuth(client, t0 + i)
  assert.deepEqual(failedAuthBlocked(client, t0 + 100), { ok: true })
  chargeFailedAuth(client, t0 + 100)
  assert.deepEqual(failedAuthBlocked(client, t0 + 1000), { ok: false, budget: 'failedAuth', retryAfterS: 599 })
  assert.deepEqual(failedAuthBlocked(reqFrom('198.51.100.24'), t0 + 1000), { ok: true }, 'another client')
  assert.deepEqual(failedAuthBlocked(client, t0 + 600_000), { ok: true }, 'ten minutes later')

  // IPv6: a client rotating through /64s inside one /48 is stopped by the network bucket.
  for (let i = 0; i < 60; i++) chargeFailedAuth(reqFrom(`2001:db8:aaaa:${(i + 1).toString(16)}::1`), t0 + i)
  const fresh = reqFrom('2001:db8:aaaa:ffff::1')
  assert.deepEqual(failedAuthBlocked(fresh, t0 + 100), { ok: false, budget: 'failedAuthNetwork', retryAfterS: 600 })
  assert.deepEqual(failedAuthBlocked(reqFrom('2001:db8:bbbb::1'), t0 + 100), { ok: true }, 'another /48')
})

test('persisted budgets: all or nothing, UTC-aligned windows, usage, and they survive a restart', async () => {
  const { persistedUsage, prunePersistedCounters, takePersisted } = await import('../lib/ai/budgets')
  const { closeAiDb, getAiDb } = await import('../lib/ai/db')
  const hour = 3_600_000
  const day = 24 * hour
  const t0 = Date.UTC(2026, 10, 6, 10, 15)
  for (let i = 0; i < 29; i++) assert.deepEqual(takePersisted([{ budget: 'grantWritesHour', subject: 'g1' }, { budget: 'itemWritesHour', subject: 'blog/example' }], t0), { ok: true })
  // The item has room for one more, the grant too: one charge of 2 for the item fails and charges NOTHING.
  assert.deepEqual(
    takePersisted([{ budget: 'grantWritesHour', subject: 'g1' }, { budget: 'itemWritesHour', subject: 'blog/example', amount: 2 }], t0),
    { ok: false, budget: 'itemWritesHour', retryAfterS: 45 * 60 },
  )
  assert.equal(persistedUsage('grantWritesHour', 'g1', t0).used, 29)
  assert.deepEqual(takePersisted([{ budget: 'grantWritesHour', subject: 'g1' }], t0), { ok: true })
  assert.deepEqual(persistedUsage('grantWritesHour', 'g1', t0), { used: 30, limit: 30, resetAt: Date.UTC(2026, 10, 6, 11) })
  assert.equal(takePersisted([{ budget: 'grantWritesHour', subject: 'g1' }], t0).ok, false)
  // Bytes: counted in amounts; a day window starts at UTC midnight.
  assert.deepEqual(takePersisted([{ budget: 'grantBytesDay', subject: 'g1', amount: 20 * 1024 * 1024 - 10 }], t0), { ok: true })
  assert.deepEqual(takePersisted([{ budget: 'grantBytesDay', subject: 'g1', amount: 11 }], t0), { ok: false, budget: 'grantBytesDay', retryAfterS: Math.ceil((Date.UTC(2026, 10, 7) - t0) / 1000) })
  assert.equal(persistedUsage('grantBytesDay', 'g1', t0).resetAt, Date.UTC(2026, 10, 7))
  // A restart keeps them.
  closeAiDb()
  assert.equal(persistedUsage('grantWritesHour', 'g1', t0).used, 30)
  assert.equal(takePersisted([{ budget: 'grantWritesHour', subject: 'g1' }], t0 + hour).ok, true, 'the next UTC hour')
  // Pruning drops windows that ended, keeps the live ones.
  const before = (getAiDb().prepare('SELECT count(*) AS n FROM ai_counters').get() as { n: number }).n
  assert.equal(prunePersistedCounters(t0 + 2 * day), before)
  assert.equal((getAiDb().prepare('SELECT count(*) AS n FROM ai_counters').get() as { n: number }).n, 0)
})

test('persisted budgets never over-issue: three processes race for one 30-unit window', async () => {
  const script = `
    const { takePersisted } = await import(${JSON.stringify(path.join(ROOT, 'lib/ai/budgets.ts'))})
    let ok = 0
    for (let i = 0; i < 20; i++) if (takePersisted([{ budget: 'grantWritesHour', subject: 'race' }], ${Date.UTC(2026, 10, 6, 12, 5)}).ok) ok++
    process.stdout.write(String(ok))
  `
  const run = () =>
    new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', path.join(ROOT, 'tests/register.mjs'), '--input-type=module', '-e', script], { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      child.stdout.on('data', (c) => (out += c))
      child.stderr.on('data', (c) => (err += c))
      child.on('close', (code) => (code === 0 ? resolve(Number(out)) : reject(new Error(err))))
    })
  const counts = await Promise.all([run(), run(), run()])
  assert.equal(counts.reduce((a, b) => a + b, 0), 30, counts.join(' + '))
})
