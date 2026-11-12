/**
 * M4 — the model providers' routes (design §7.3, §7.4, §7.6, §7.7, §12.1
 * ai-secretbox's route half) on a real socket, with
 * tests/helpers/fake-llm.mjs as the provider: a key is never returned;
 * adding or replacing one needs a recent verification and mails the owner,
 * the rest does not; addresses follow §7.6; Check key and Test take exactly
 * two shapes, a Custom URL with a typed key needs step-up, and a stored key
 * never reaches a request-supplied URL; the key is sealed to its URL (a
 * database edit reads "re-enter"); a Test this server ran is what Save
 * carries; both are rate-limited.
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { startFakeLlm } from './helpers/fake-llm.mjs'
import { assistantHarness, TEST_KEY } from './helpers/assistantHarness'
import { startRealRoute, type RealRoute } from './helpers/realRoute'

const A = assistantHarness('ai-providers-routes')
let providers: RealRoute
let testRoute: RealRoute
let modelsRoute: RealRoute
let keys: typeof import('../lib/ai/providers/keys')
let attacker: Awaited<ReturnType<typeof startFakeLlm>>
let fresh = ''
let stale = ''

async function browser(verifiedAgoMs: number): Promise<string> {
  const sessions = await import('../lib/adminAuth/sessions')
  const auth = await import('../lib/auth')
  const sid = sessions.createSession({ method: 'password', ttlMs: 3_600_000, verifiedAt: Date.now() - verifiedAgoMs, device: 'Chrome on macOS', ipPrefix: null, country: null }).id
  return `cv_admin_token=${auth.signAdminToken('owner@example.test', { sid })}`
}

before(async () => {
  await A.setup()
  attacker = await startFakeLlm()
  keys = await import('../lib/ai/providers/keys')
  providers = await startRealRoute(await import('../pages/api/admin/ai/providers/index'))
  testRoute = await startRealRoute(await import('../pages/api/admin/ai/providers/test'))
  modelsRoute = await startRealRoute(await import('../pages/api/admin/ai/providers/models'))
  fresh = await browser(0)
  stale = await browser(30 * 60_000)
})
after(async () => {
  for (const r of [providers, testRoute, modelsRoute]) await r?.close()
  await attacker?.close()
  await A.teardown()
})
beforeEach(() => {
  A.fake.reset()
  attacker.reset()
})

const send = (route: RealRoute, method: string, body: unknown, cookie: string) =>
  route.fetch('/', { method, headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) })
const custom = (over: Record<string, unknown> = {}) => ({ preset: 'custom', wire: 'chat', baseUrl: A.fake.baseUrl(), ...over })

test('GET: presets as data, saved providers as views — the key never, its last four only', async () => {
  const res = await providers.fetch('/', { headers: { cookie: stale } })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('cache-control'), 'no-store')
  const text = await res.text()
  assert.ok(!text.includes(TEST_KEY), 'no key in the answer')
  const body = JSON.parse(text)
  assert.deepEqual(body.presets.map((p: { id: string }) => p.id), ['claude', 'openai', 'xai', 'openrouter', 'deepseek', 'gemini', 'qwen', 'kimi', 'glm', 'minimax', 'mistral', 'groq', 'ollama', 'lmstudio', 'custom'])
  assert.ok(body.presets.every((p: Record<string, unknown>) => !('models' in p)), 'no model ids in code')
  const mine = body.providers.find((p: { id: string }) => p.id === A.providerId)
  assert.equal(mine.keyHint, TEST_KEY.slice(-4))
  assert.equal(mine.keyState, 'ok')
  assert.equal(mine.hasKey, true)
  assert.equal(mine.status, 'untested', 'nothing claims to work before a Test')
  assert.equal(mine.isDefault, true)
  assert.equal(body.keys.canStore, true)
  assert.deepEqual(body.localOrigins, [A.fake.origin])
})

test('adding a key: a stale session is asked to verify and nothing is stored; a fresh one stores it and mails the owner', async () => {
  const before = keys.listProviders().length
  const refused = await send(providers, 'POST', { ...custom(), apiKey: 'sk-test-new-key-000000000001', defaultModel: 'fake-model' }, stale)
  assert.equal(refused.status, 403)
  assert.equal((await refused.json()).code, 'STEP_UP_REQUIRED')
  assert.equal(keys.listProviders().length, before)
  const made = await send(providers, 'POST', { ...custom(), apiKey: 'sk-test-new-key-000000000001', defaultModel: 'fake-model', label: 'Second' }, fresh)
  assert.equal(made.status, 201)
  const view = (await made.json()).provider
  assert.equal(view.label, 'Second')
  assert.equal(view.keyHint, '0001')
  assert.equal(view.isDefault, false)
  const { getAiDb } = await import('../lib/ai/db')
  const claim = getAiDb().prepare("SELECT COUNT(*) AS n FROM ai_counters WHERE key = 'alert|key-added|site'").get() as { n: number }
  assert.equal(claim.n, 1, 'the owner was mailed (once a day)')
  const { listAudit } = await import('../lib/audit/store')
  assert.ok(listAudit({}).entries.some((e: { action: string }) => e.action === 'ai.provider-add'))
})

test('addresses follow §7.6: Custom is https, port 443, a host name, no userinfo/query/fragment; presets only their own hosts; local only when allowed', async () => {
  const bad = [
    { baseUrl: 'https://203.0.113.5/v1' },
    { baseUrl: 'https://[2001:db8::1]/v1' },
    { baseUrl: 'http://api.example.com/v1' },
    { baseUrl: 'https://api.example.com:8443/v1' },
    { baseUrl: 'https://user:pw@api.example.com/v1' },
    { baseUrl: 'https://api.example.com/v1?x=1' },
    { baseUrl: 'https://api.example.com/v1#frag' },
    { baseUrl: 'https://localhost/v1' },
  ]
  for (const b of bad) {
    const res = await send(providers, 'POST', { ...custom(b), apiKey: 'sk-test-xxxxxxxxxxxxxxxx' }, fresh)
    assert.equal(res.status, 400, JSON.stringify(b))
  }
  const local = await send(providers, 'POST', { ...custom({ baseUrl: 'http://127.0.0.1:1/v1' }), apiKey: 'sk-test-xxxxxxxxxxxxxxxx' }, fresh)
  assert.deepEqual([local.status, (await local.json()).code], [409, 'LOCAL_NOT_ALLOWED'])
  const foreign = await send(providers, 'POST', { preset: 'deepseek', baseUrl: 'https://deepseek.example.com', apiKey: 'sk-test-xxxxxxxxxxxxxxxx' }, fresh)
  assert.equal(foreign.status, 400, 'a preset goes only to its own hosts')
  const qwen = await send(providers, 'POST', { preset: 'qwen', workspaceId: 'ws_1', region: 'cn-beijing', apiKey: 'sk-test-xxxxxxxxxxxxxxxx' }, fresh)
  assert.equal(qwen.status, 400, 'Qwen fields are [a-z0-9-] only')
  const ok = await send(providers, 'POST', { preset: 'qwen', workspaceId: 'ws-1', region: 'cn-beijing', apiKey: 'sk-test-xxxxxxxxxxxxxxxx' }, fresh)
  assert.equal(ok.status, 201)
  assert.equal((await ok.json()).provider.baseUrlHost, 'ws-1.cn-beijing.maas.aliyuncs.com')
})

test('without AI_KEYS_SECRET no key is stored (and none is opened)', async () => {
  const saved = process.env.AI_KEYS_SECRET
  delete process.env.AI_KEYS_SECRET
  try {
    const res = await send(providers, 'POST', { ...custom(), apiKey: 'sk-test-xxxxxxxxxxxxxxxx' }, fresh)
    assert.deepEqual([res.status, (await res.json()).code], [409, 'NO_SECRET'])
    const t = await send(testRoute, 'POST', { providerId: A.providerId, model: 'fake-model' }, fresh)
    assert.deepEqual([t.status, (await t.json()).code], [409, 'NO_SECRET'])
  } finally {
    process.env.AI_KEYS_SECRET = saved
  }
})

test('settings that cannot send a key elsewhere need no step-up; replacing the key (or its address) does', async () => {
  const id = (await (await send(providers, 'POST', { ...custom(), apiKey: 'sk-test-edit-0000000000000', label: 'Edit me' }, fresh)).json()).provider.id
  const edited = await send(providers, 'PATCH', { id, label: 'Edited', defaultModel: 'fake-small-output', effort: 'low', quirks: { maxOutputTokens: 8000, echoReasoning: false } }, stale)
  assert.equal(edited.status, 200)
  const v = (await edited.json()).provider
  assert.deepEqual([v.label, v.defaultModel, v.effort, v.quirks.maxOutputTokens, v.quirks.echoReasoning], ['Edited', 'fake-small-output', 'low', 8000, false])
  for (const body of [{ id, apiKey: 'sk-test-edit-1111111111111' }, { id, apiKey: 'sk-test-edit-1111111111111', baseUrl: attacker.baseUrl() }]) {
    const r = await send(providers, 'PATCH', body, stale)
    assert.deepEqual([r.status, (await r.json()).code], [403, 'STEP_UP_REQUIRED'])
  }
  const moveWithoutKey = await send(providers, 'PATCH', { id, baseUrl: A.fake.baseUrl('deepseek') }, fresh)
  assert.deepEqual([moveWithoutKey.status, (await moveWithoutKey.json()).code], [400, 'KEY_REQUIRED'], 'a new address needs the key typed again')
  assert.equal(keys.getProvider(id)!.baseUrl, A.fake.baseUrl())
  const replaced = await send(providers, 'PATCH', { id, apiKey: 'sk-test-edit-2222222222222' }, fresh)
  assert.equal(replaced.status, 200)
  assert.equal((await replaced.json()).provider.keyHint, '2222')
  const removed = await send(providers, 'DELETE', { id }, stale)
  assert.deepEqual(await removed.json(), { removed: true, revokeAt: 'Custom' })
  assert.equal(keys.getProvider(id), null)
})

test('the key is sealed to its URL: pointing the row elsewhere in the database makes it "re-enter", and nothing is sent', async () => {
  const id = (await (await send(providers, 'POST', { ...custom(), apiKey: 'sk-test-sealed-000000000000', defaultModel: 'fake-model' }, fresh)).json()).provider.id
  const { getAuthDb } = await import('../lib/adminAuth/db')
  getAuthDb().prepare('UPDATE ai_provider_keys SET base_url = ? WHERE id = ?').run(attacker.baseUrl(), id)
  const view = (await (await providers.fetch('/', { headers: { cookie: fresh } })).json()).providers.find((p: { id: string }) => p.id === id)
  assert.equal(view.keyState, 'reenter')
  const t = await send(testRoute, 'POST', { providerId: id, model: 'fake-model' }, fresh)
  assert.deepEqual([t.status, (await t.json()).code], [409, 'KEY_REENTER'])
  const runs = await import('../lib/ai/runs')
  const started = await runs.startRun({ session: A.session(), providerId: id, message: 'x' })
  assert.deepEqual(started.ok ? null : started.code, 'KEY_REENTER')
  assert.equal(attacker.requests.length, 0, 'the key never left for the edited address')
})

test('Check key and Test take exactly two shapes: a stored key goes only to its own stored URL', async () => {
  for (const body of [
    { providerId: A.providerId, baseUrl: attacker.baseUrl() },
    { providerId: A.providerId, preset: 'custom', wire: 'chat', baseUrl: attacker.baseUrl() },
    { providerId: A.providerId, typedKey: 'sk-x' },
  ]) {
    for (const route of [testRoute, modelsRoute]) {
      const res = await send(route, 'POST', body, fresh)
      assert.equal(res.status, 400, JSON.stringify(body))
    }
  }
  assert.equal(attacker.requests.length, 0)
  const listed = await send(modelsRoute, 'POST', { providerId: A.providerId }, stale)
  assert.equal(listed.status, 200)
  assert.ok((await listed.json()).models.some((m: { id: string }) => m.id === 'fake-model'))
  assert.equal(A.fake.requests.length, 1)
  assert.equal(A.fake.requests[0].headers.authorization, `Bearer ${TEST_KEY}`)
})

test('a typed key: a Custom URL needs a recent verification first; a local preset’s allowed origin does not', async () => {
  const typed = { typedKey: 'sk-test-typed-0000000000000', ...custom(), model: 'fake-model' }
  for (const route of [testRoute, modelsRoute]) {
    const res = await send(route, 'POST', typed, stale)
    assert.deepEqual([res.status, (await res.json()).code], [403, 'STEP_UP_REQUIRED'])
  }
  assert.equal(A.fake.requests.length, 0, 'nothing was sent before the verification')
  const local = await send(modelsRoute, 'POST', { typedKey: '', preset: 'ollama', baseUrl: A.fake.baseUrl('ollama') }, stale)
  assert.equal(local.status, 200)
  const typedTo = await send(modelsRoute, 'POST', { ...typed, baseUrl: attacker.baseUrl() }, fresh)
  assert.equal(typedTo.status, 409, 'the other loopback port is not an allowed local origin')
  assert.equal(attacker.requests.length, 0)
})

test('Test on a saved key: the real probe (whole catalogue + probe_echo, then the replay), stored per model', async () => {
  const res = await send(testRoute, 'POST', { providerId: A.providerId, model: 'fake-model' }, stale)
  assert.equal(res.status, 200)
  const { result } = await res.json()
  assert.equal(result.status, 'ready')
  // Then the files step: the fake model never names the square's colour or the PDF's word, so it is recorded as not
  // taking images or PDFs; a silent WAV it accepts counts as audio (the Chat wire's input_audio).
  assert.deepEqual(result.steps.map((s: { step: string; ok: boolean }) => [s.step, s.ok]), [['models', true], ['tools', true], ['replay', true], ['image', false], ['pdf', false], ['audio', true]])
  assert.deepEqual([result.observations.imageInput, result.observations.pdfInput, result.observations.audioInput], [false, false, true])
  assert.equal(result.observations.toolsWork, true)
  assert.equal(result.observations.argsExact, true)
  const tools = (A.fake.requests[1].body as { tools: Array<{ function: { name: string } }> }).tools.map((t) => t.function.name)
  assert.ok(tools.includes('probe_echo') && tools.includes('get_site_overview') && tools.length >= 12, 'the full frozen catalogue went with it')
  const view = (await (await providers.fetch('/', { headers: { cookie: stale } })).json()).providers.find((p: { id: string }) => p.id === A.providerId)
  assert.equal(view.status, 'ready')
  assert.ok(!JSON.stringify(view).includes(TEST_KEY))
})

test('Test statuses: a model with no tool call is Chat only; a refused schema is Schema refused with the provider’s words; a refused key is Key refused', async () => {
  const chatOnly = await (await send(testRoute, 'POST', { providerId: A.providerId, model: 'fake-no-tools' }, fresh)).json()
  assert.equal(chatOnly.result.status, 'chat-only')
  const schema = await (await send(testRoute, 'POST', { providerId: A.providerId, model: 'fake-schema-refuser' }, fresh)).json()
  assert.equal(schema.result.status, 'schema-refused')
  assert.match(schema.result.message, /schema/)
  A.fake.enqueueModels({ status: 401, body: { error: { message: 'Invalid API key.' } } })
  const key = await (await send(testRoute, 'POST', { providerId: A.providerId, model: 'fake-model' }, fresh)).json()
  assert.equal(key.result.status, 'key-refused')
})

test('a Test this server ran on a typed key is what Save carries (never a result the browser sends)', async () => {
  const typed = { typedKey: 'sk-test-carried-00000000000', ...custom(), model: 'fake-model' }
  const t = await (await send(testRoute, 'POST', typed, fresh)).json()
  assert.equal(t.result.status, 'ready')
  const requestsAfterTest = A.fake.requests.length
  const saved = await send(providers, 'POST', { ...custom(), apiKey: typed.typedKey, defaultModel: 'fake-model', test: { status: 'ready' } }, fresh)
  assert.equal(saved.status, 201)
  assert.equal((await saved.json()).provider.status, 'ready')
  assert.equal(A.fake.requests.length, requestsAfterTest, 'no second probe')
  const other = await send(providers, 'POST', { ...custom(), apiKey: 'sk-test-different-key-0000', defaultModel: 'fake-model' }, fresh)
  assert.equal((await other.json()).provider.status, 'untested', 'another key carries nothing')
})

test('Check key and Test share one budget: 10 per 10 minutes, then 429 with Retry-After', async () => {
  let status = 200
  for (let i = 0; i < 12 && status !== 429; i++) status = (await send(modelsRoute, 'POST', { providerId: A.providerId }, fresh)).status
  assert.equal(status, 429)
  const res = await send(testRoute, 'POST', { providerId: A.providerId, model: 'fake-model' }, fresh)
  assert.equal(res.status, 429)
  assert.ok(Number(res.headers.get('retry-after')) > 0)
})
