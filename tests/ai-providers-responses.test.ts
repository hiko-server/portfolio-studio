/**
 * M4 — the OpenAI Responses adapter (lib/ai/providers/responses.ts, design
 * §7.1, PROVIDERS §3) against tests/helpers/fake-llm.mjs: stateless
 * (`store: false`, no previous_response_id, instructions re-sent), output
 * replayed unchanged with its reasoning items, one function_call_output per
 * call, and the dialects of OpenAI, xAI, OpenRouter and Groq.
 */
import { test, before, after, afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { MATRIX, startFakeLlm } from './helpers/fake-llm.mjs'
import { NEVER_SENT, collect, deepKeys, snap, testQuirks } from './helpers/modelTurns'
import type { Quirks } from '../lib/ai/presets'
import type { ModelAdapter } from '../lib/ai/providers/types'

let fake: Awaited<ReturnType<typeof startFakeLlm>>
let responses: typeof import('../lib/ai/providers/responses')
let types: typeof import('../lib/ai/providers/types')
const sent: unknown[] = []

before(async () => {
  process.env.SITE_URL = 'http://127.0.0.1:3999'
  fake = await startFakeLlm()
  responses = await import('../lib/ai/providers/responses')
  types = await import('../lib/ai/providers/types')
})
after(async () => {
  await fake.close()
  delete process.env.SITE_URL
})
beforeEach(() => fake.reset())
afterEach(() => {
  for (const r of fake.requests) if (r.body !== undefined) sent.push(r.body)
})

function adapter(dialect: string | null = null, quirks: Partial<Quirks> = {}): ModelAdapter {
  return responses.createResponsesAdapter({
    baseUrl: dialect ? fake.baseUrl(dialect) : fake.baseUrl(),
    apiKey: 'sk-test-responses-0123456789',
    connectTimeoutMs: 5_000,
    idleTimeoutMs: 5_000,
    localOrigins: [fake.origin],
    quirks: testQuirks(quirks),
  })
}
const lastBody = () => fake.requests[fake.requests.length - 1].body as Record<string, any>
type PErr = InstanceType<typeof types.ProviderError>

async function toolRound(a: ModelAdapter, script: Record<string, unknown> = MATRIX.oneTool()) {
  fake.enqueue(script)
  const u = a.userTurn('x')
  const first = await collect(a, [u])
  assert.equal(first.error, null, String(first.error))
  const results = a.toolResultsTurn(first.turn!.toolCalls.map((c) => ({ id: c.id, name: c.name, text: '{"ok":true}', isError: false })))
  fake.enqueue(MATRIX.text())
  return { first, results, u, second: await collect(a, [u, first.turn!.native, results]) }
}

test('the request: store false, instructions re-sent, functions, effort and limit only when set, nothing never-sent', async () => {
  const a = adapter()
  fake.enqueue({ ...MATRIX.text(), usage: { input: 40, cachedRead: 15, output: 9, reasoning: 3, cost: 0.0042 } })
  const r = await collect(a, [a.userTurn('hi')], { conv: snap({ effort: 'low' }), maxOutput: 3000 })
  assert.equal(r.error, null)
  assert.equal(r.text, 'Hello from the test model.')
  const body = lastBody()
  assert.equal(body.store, false)
  assert.equal(body.instructions, 'System text for tests.')
  assert.ok(!('previous_response_id' in body))
  assert.deepEqual(body.reasoning, { effort: 'low' })
  assert.equal(body.max_output_tokens, 3000)
  assert.equal(body.tools[0].type, 'function')
  assert.equal(body.tools[0].name, 'get_content')
  assert.ok(!('strict' in body.tools[0]))
  assert.deepEqual(body.input, [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }])
  const usage = r.events.find((e) => e.type === 'usage')
  // The fake's `input` is the uncached part; it reports input_tokens = 40 + 15, and the adapter takes the 15 cached back out.
  assert.deepEqual(usage, { type: 'usage', usage: { input: 40, cachedRead: 15, cacheWrite: 0, output: 9, reasoning: 3, reportedMicroUsd: 4200 }, estimated: false })
  fake.enqueue(MATRIX.text())
  await collect(a, [a.userTurn('hi')])
  assert.ok(!('max_output_tokens' in lastBody()) && !('reasoning' in lastBody()))
})

const REASONED = () => ({ ...MATRIX.oneTool(), reasoning: 'Looking up the post first.' })

test('a tool round: output replayed unchanged (the reasoning item with it), the result as function_call_output', async () => {
  const r = await toolRound(adapter(), REASONED())
  assert.equal(r.second.error, null)
  const input = lastBody().input
  assert.equal(input[1].type, 'reasoning')
  assert.equal(typeof input[1].encrypted_content, 'string')
  assert.equal(input[2].type, 'function_call')
  assert.deepEqual(input[3], { type: 'function_call_output', call_id: r.first.turn!.toolCalls[0].id, output: '{"ok":true}' })
  assert.ok(r.first.thinking.length > 0, 'the reasoning summary streamed as thinking')
})

test('a replay without the reasoning item, or with it changed, is refused by the provider', async () => {
  const a = adapter()
  const r = await toolRound(a, REASONED())
  const items = (r.first.turn!.native as { items: Array<Record<string, unknown>> }).items
  fake.enqueue(MATRIX.text())
  const dropped = await collect(a, [r.u, { items: items.filter((i) => i.type !== 'reasoning') }, r.results])
  assert.equal((dropped.error as PErr).kind, 'bad_request')
  fake.reset()
  fake.enqueue(MATRIX.text())
  const changed = await collect(a, [r.u, { items: items.map((i) => (i.type === 'reasoning' ? { ...i, encrypted_content: 'edited' } : i)) }, r.results])
  assert.equal((changed.error as PErr).kind, 'bad_request')
})

test('xAI: encrypted reasoning only when asked for (the preset asks); whole arguments with no deltas; cost in ticks', async () => {
  const presets = await import('../lib/ai/presets')
  const xai = adapter('xai', presets.quirksFor(presets.presetById('xai')!))
  const r = await toolRound(xai, { ...MATRIX.oneTool(), usage: { costTicks: 25_000_000 } })
  assert.equal(r.second.error, null)
  assert.deepEqual(lastBody().include, ['reasoning.encrypted_content'])
  assert.deepEqual(JSON.parse(r.first.turn!.toolCalls[0].argsText), { collection: 'blog', slug: 'hello' })
  assert.equal(r.first.events.filter((e) => e.type === 'tool_call_delta').length, 0)
  const usage = r.first.events.find((e) => e.type === 'usage')
  assert.equal(usage?.type === 'usage' && usage.usage.reportedMicroUsd, 2500)
})

test('OpenRouter: comments between events, require_parameters from the preset, tools-only model list', async () => {
  const presets = await import('../lib/ai/presets')
  const or = adapter('openrouter', presets.quirksFor(presets.presetById('openrouter')!))
  const r = await toolRound(or)
  assert.equal(r.second.error, null)
  assert.deepEqual(lastBody().provider, { require_parameters: true })
  const models = await or.listModels(new AbortController().signal)
  assert.ok(models.some((m) => m.id === 'fake-model'))
  assert.ok(!models.some((m) => m.id === 'fake-no-tools'), 'supported_parameters=tools')
})

test('Groq on Responses: no store, no include (it refuses them)', async () => {
  const a = adapter('groq-responses', { responsesStore: false })
  const r = await toolRound(a)
  assert.equal(r.second.error, null)
  assert.ok(!('store' in lastBody()))
  fake.reset()
  fake.enqueue(MATRIX.text())
  const refused = await collect(adapter('groq-responses'), [a.userTurn('x')])
  assert.equal((refused.error as PErr).kind, 'bad_request', 'store: false is what it refuses')
})

test('refusal, incomplete (limit or filter), failed, error event: stop kinds or errors, never a tool call to run', async () => {
  const a = adapter()
  fake.enqueue(MATRIX.responsesRefusal())
  const refused = await collect(a, [a.userTurn('x')])
  assert.equal(refused.turn?.stop, 'refusal')
  assert.equal(refused.turn?.refusal?.explanation, 'I cannot help with that.')
  fake.enqueue(MATRIX.responsesIncomplete())
  assert.equal((await collect(a, [a.userTurn('x')])).turn?.stop, 'max_tokens')
  fake.enqueue({ text: 'Partial.', incomplete: 'content_filter' })
  assert.equal((await collect(a, [a.userTurn('x')])).turn?.stop, 'content_filter')
  for (const t of [MATRIX.responsesFailed(), MATRIX.responsesErrorEvent(), { text: 'Cut.', truncateAfter: 4 }]) {
    fake.enqueue(t)
    const r = await collect(a, [a.userTurn('x')])
    assert.ok(r.error instanceof types.ProviderError)
    assert.equal(r.turn, null)
  }
})

test('a failure inside the stream (response.failed, the error event) never carries the key, nor half of it across the cap', async () => {
  const key = 'sk-test-responses-0123456789'
  const a = adapter()
  const long = `${'x'.repeat(585)}${key}`
  for (const t of [
    { text: 'Partial.', failed: { message: `Incorrect API key provided: ${key}` } },
    { text: 'Partial.', failed: { message: long } },
    { text: 'Partial.', errorEvent: { message: `Incorrect API key provided: ${key}` } },
    { text: 'Partial.', errorEvent: { message: long } },
  ]) {
    fake.enqueue(t)
    const e = (await collect(a, [a.userTurn('x')])).error as PErr
    assert.ok(e instanceof types.ProviderError, JSON.stringify(t).slice(0, 80))
    const words = [e.message, e.providerMessage, e.stack ?? '', String(e.requestId)].join('\n')
    assert.ok(!words.includes(key.slice(0, 12)), `no part of the key: ${JSON.stringify(t).slice(0, 80)}`)
    assert.match(e.providerMessage, /\[secret\]/)
  }
})

test('the never-sent parameters left no request of this file', () => {
  assert.ok(sent.length >= 12)
  for (const body of sent) for (const k of NEVER_SENT) assert.ok(!deepKeys(body).has(k), k)
})
