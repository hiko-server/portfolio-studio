/**
 * M4 — design §7.4's exact-value scrubbing where a provider fails INSIDE an
 * HTTP 200 stream and quotes the key back: OpenRouter's `error` and
 * MiniMax's `base_resp` on the chat wire, `response.failed` and the `error`
 * event on the Responses wire (tests/helpers/fake-llm.mjs sends each shape).
 * The key is in no Test answer, no stored Test (auth.db test_json, for a
 * saved key and for the typed key Save carries a Test for), no event of a
 * run (run_end's detail included), no log line and no plain byte of ai.db
 * or auth.db. The adapters' own errors are covered in ai-providers-chat and
 * ai-providers-responses.
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { assistantHarness, TEST_KEY } from './helpers/assistantHarness'
import { startRealRoute, type RealRoute } from './helpers/realRoute'

const A = assistantHarness('ai-provider-inband-key')
const TYPED_KEY = 'sk-test-typed-INBAND-0123456789'
let testRoute: RealRoute
let providers: RealRoute
let runs: typeof import('../lib/ai/runs')
let bus: typeof import('../lib/ai/bus')
let authDb: typeof import('../lib/adminAuth/db')
let fresh = ''
const lines: string[] = []
const saved = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug }

before(async () => {
  await A.setup()
  runs = await import('../lib/ai/runs')
  bus = await import('../lib/ai/bus')
  authDb = await import('../lib/adminAuth/db')
  testRoute = await startRealRoute(await import('../pages/api/admin/ai/providers/test'))
  providers = await startRealRoute(await import('../pages/api/admin/ai/providers/index'))
  const sessions = await import('../lib/adminAuth/sessions')
  const auth = await import('../lib/auth')
  const sid = sessions.createSession({ method: 'password', ttlMs: 3_600_000, verifiedAt: Date.now(), device: 'Chrome on macOS', ipPrefix: null, country: null }).id
  fresh = `cv_admin_token=${auth.signAdminToken('owner@example.test', { sid })}`
  // Everything the process prints from here on is checked for the keys at the end.
  for (const k of ['log', 'error', 'warn', 'info', 'debug'] as const) console[k] = (...args: unknown[]) => void lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
})
after(async () => {
  Object.assign(console, saved)
  for (const r of [testRoute, providers]) await r?.close()
  await A.teardown()
})
beforeEach(() => A.fake.reset())

const send = (route: RealRoute, body: unknown) => route.fetch('/', { method: 'POST', headers: { 'content-type': 'application/json', cookie: fresh }, body: JSON.stringify(body) })
const testJsonOf = (id: string) => (authDb.getAuthDb().prepare('SELECT test_json FROM ai_provider_keys WHERE id = ?').get(id) as { test_json: string | null }).test_json ?? ''

/** The two chat-wire shapes of an error at HTTP 200, each quoting `key`. */
const chatInBand = (key: string) => [
  { text: 'Partial.', inBandError: { afterFrames: 1, message: `Incorrect API key provided: ${key}` } },
  { text: 'Partial.', inBandError: { afterFrames: 1, message: `invalid api key ${key}`, code: 1004, shape: 'minimax' } },
]

test('Test on a saved key: a provider quoting the key mid-stream leaves it in neither the answer nor test_json', async () => {
  for (const turn of chatInBand(TEST_KEY)) {
    A.fake.reset()
    A.fake.enqueue(turn)
    const res = await send(testRoute, { providerId: A.providerId, model: 'fake-model' })
    assert.equal(res.status, 200)
    const text = await res.text()
    assert.ok(!text.includes(TEST_KEY), 'the Test answer')
    const { result } = JSON.parse(text)
    assert.equal(result.status, 'failed')
    assert.match(result.message, /\[secret\]/, 'the provider’s words are kept, the key masked')
    const stored = testJsonOf(A.providerId)
    assert.match(stored, /\[secret\]/)
    assert.ok(!stored.includes(TEST_KEY), 'auth.db test_json')
  }
})

test('Test on a typed key, then Save: the Test Save carries holds no key either', async () => {
  const target = { preset: 'custom', wire: 'chat', baseUrl: A.fake.baseUrl() }
  A.fake.enqueue(chatInBand(TYPED_KEY)[0])
  const res = await send(testRoute, { typedKey: TYPED_KEY, ...target, model: 'fake-model' })
  assert.equal(res.status, 200)
  const text = await res.text()
  assert.ok(!text.includes(TYPED_KEY), 'the Test answer')
  assert.equal(JSON.parse(text).result.status, 'failed')
  const made = await send(providers, { ...target, apiKey: TYPED_KEY, defaultModel: 'fake-model' })
  assert.equal(made.status, 201)
  const id = (await made.json()).provider.id as string
  const stored = testJsonOf(id)
  assert.equal(JSON.parse(stored)['fake-model'].status, 'failed', 'Save carried the Test this server ran')
  assert.ok(!stored.includes(TYPED_KEY), 'auth.db test_json')
})

test('a run whose provider fails mid-stream quoting the key: no event carries it, run_end’s detail included', async () => {
  const responsesId = await A.addFakeProvider('responses', { label: 'Responses wire' })
  const cases = [
    ...chatInBand(TEST_KEY).map((turn) => ({ providerId: A.providerId, turn })),
    { providerId: responsesId, turn: { text: 'Partial.', failed: { message: `Incorrect API key provided: ${TEST_KEY}` } } },
    { providerId: responsesId, turn: { text: 'Partial.', errorEvent: { message: `Incorrect API key provided: ${TEST_KEY}` } } },
  ]
  for (const c of cases) {
    A.fake.enqueue(c.turn)
    const started = await runs.startRun({ session: A.session(), providerId: c.providerId, message: 'Hello' })
    assert.ok(started.ok, JSON.stringify(started))
    const events: Array<{ type: string; data: Record<string, any> }> = []
    const sub = bus.subscribe(started.run.id, 0, (e) => void events.push(e as (typeof events)[number]))!
    events.push(...(sub.replay as typeof events))
    await started.run.done
    sub.stop()
    const end = events.find((e) => e.type === 'run_end')!
    assert.deepEqual([end.data.state, end.data.reason], ['failed', 'provider'], JSON.stringify(c.turn).slice(0, 80))
    assert.match(String(end.data.detail.providerMessage), /\[secret\]/)
    assert.ok(!JSON.stringify(events).includes(TEST_KEY), `events of ${JSON.stringify(c.turn).slice(0, 80)}`)
  }
})

test('no log line and no plain byte of ai.db or auth.db holds either key', async () => {
  const printed = lines.join('\n')
  for (const k of [TEST_KEY, TYPED_KEY]) assert.ok(!printed.includes(k), 'log lines')
  const { closeAiDb } = await import('../lib/ai/db')
  closeAiDb()
  const dir = path.join(A.h.tmp, 'data')
  const files = fs.readdirSync(dir).filter((n) => /^(ai|auth)\.db(-wal|-shm)?$/.test(n))
  assert.ok(files.includes('ai.db') && files.includes('auth.db'))
  for (const f of files) {
    const bytes = fs.readFileSync(path.join(dir, f))
    for (const k of [TEST_KEY, TYPED_KEY]) assert.equal(bytes.includes(Buffer.from(k)), false, `${f} holds a key in plain text`)
  }
})
