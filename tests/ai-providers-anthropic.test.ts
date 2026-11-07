/**
 * M4 — Claude through the official SDK (lib/ai/providers/anthropic.ts,
 * design §7.2, the binding rules from the Claude API skill) against
 * tests/helpers/fake-llm.mjs, which refuses what API 2026-10-21 refuses
 * (sampling parameters, budget_tokens, tool_choice, prefill, an edited
 * earlier message or thinking block, betas missing for fallbacks and
 * progress updates). The factory's `baseURL` is the one parameter only tests
 * set. Also: the environment rules (ANTHROPIC_CUSTOM_HEADERS refused,
 * ANTHROPIC_LOG ignored, the key scrubbed from everything).
 */
import { test, before, after, afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { INTERRUPTED_SENTINEL, MATRIX, startFakeLlm } from './helpers/fake-llm.mjs'
import { NEVER_SENT, collect, deepKeys, snap } from './helpers/modelTurns'
import type { ConversationSnapshot, ModelAdapter, NativeTurn } from '../lib/ai/providers/types'

// System health (lib/ai/health, checked below) reads the AI switches from data/auth.db and the stored changes'
// size from data/ai.db under process.cwd(), and opening either creates and migrates it. So this file works in a
// temp directory, entered before any lib module loads: run from a checkout, it never creates or migrates that
// checkout's stores (in the main checkout, the live ones), and the trial's store check never takes what a unit
// run left for a server's store (scripts/ai-trial.mjs classifyStore: an auth.db means a server ran there).
const originalCwd = process.cwd()
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-providers-anthropic-'))
process.chdir(tmp)

let fake: Awaited<ReturnType<typeof startFakeLlm>>
let claude: typeof import('../lib/ai/providers/anthropic')
let types: typeof import('../lib/ai/providers/types')
const KEY = 'sk-ant-test-0123456789abcdefghij'
const sent: unknown[] = []
type PErr = InstanceType<typeof types.ProviderError>

before(async () => {
  for (const k of Object.keys(process.env)) if (k.startsWith('ANTHROPIC_')) delete process.env[k]
  fake = await startFakeLlm()
  claude = await import('../lib/ai/providers/anthropic')
  types = await import('../lib/ai/providers/types')
})
after(async () => {
  await fake.close()
  ;(await import('../lib/adminAuth/db')).closeAuthDb()
  ;(await import('../lib/ai/db')).closeAiDb()
  process.chdir(originalCwd)
  fs.rmSync(tmp, { recursive: true, force: true })
})
beforeEach(() => fake.reset())
afterEach(() => {
  for (const r of fake.requests) if (r.body !== undefined) sent.push(r.body)
  for (const k of Object.keys(process.env)) if (k.startsWith('ANTHROPIC_')) delete process.env[k]
})

const adapter = (idleTimeoutMs?: number): ModelAdapter => claude.createAnthropicAdapter({ apiKey: KEY, baseURL: fake.origin, idleTimeoutMs })
const OPUS: Partial<ConversationSnapshot> = { model: 'claude-opus-5-5', claude: { adaptiveThinking: true, fallbacks: true }, display: 'updates', effort: 'medium' }
const conv = (over: Partial<ConversationSnapshot> = {}) => snap({ ...OPUS, ...over })
const lastReq = () => fake.requests[fake.requests.length - 1]
const tmpData = path.join(fs.realpathSync(tmp), 'data')

test('the stores this file can open are the temp directory’s, never the checkout’s', async () => {
  const { authDbPath } = await import('../lib/adminAuth/db')
  const { aiDbPath } = await import('../lib/ai/db')
  assert.equal(path.dirname(authDbPath()), tmpData)
  assert.equal(path.dirname(aiDbPath()), tmpData)
})

test('the request: the skill’s shape exactly, and nothing API 2026-10-21 refuses', async () => {
  fake.enqueue({ text: 'Hello.', reasoning: 'Planning a short answer.' })
  const a = adapter()
  const r = await collect(a, [a.userTurn('hi')], { conv: conv(), maxOutput: 64_000 })
  assert.equal(r.error, null, String(r.error))
  assert.equal(r.text, 'Hello.')
  assert.equal(r.thinking, 'Planning a short answer.', 'display updates: a non-empty thinking block is a progress note')
  assert.ok(r.events.some((e) => e.type === 'thinking' && e.kind === 'update'))
  const { body, headers } = lastReq() as { body: Record<string, any>; headers: Record<string, string> }
  assert.equal(body.model, 'claude-opus-5-5')
  assert.equal(body.max_tokens, 64_000)
  assert.equal(body.fallbacks, 'default')
  assert.deepEqual(body.thinking, { type: 'adaptive', display: 'updates' })
  assert.deepEqual(body.output_config, { effort: 'medium' })
  assert.deepEqual(body.cache_control, { type: 'ephemeral' })
  assert.deepEqual(body.system, [{ type: 'text', text: 'System text for tests.', cache_control: { type: 'ephemeral' } }])
  assert.ok(body.tools.every((t: Record<string, unknown>) => t.eager_input_streaming === true && t.input_schema && !('strict' in t)))
  assert.deepEqual(String(headers['anthropic-beta']).split(',').map((s) => s.trim()).sort(), ['server-side-fallback-2026-07-01', 'thinking-display-updates-2026-08-18'])
  assert.equal(headers['anthropic-version'], '2026-10-21')
  for (const k of NEVER_SENT) assert.ok(!deepKeys(body).has(k), k)
})

test('optional parameters follow the frozen capabilities: no fallbacks, no thinking, no effort when the model takes none', async () => {
  fake.enqueue(MATRIX.text())
  const a = adapter()
  const r = await collect(a, [a.userTurn('hi')], { conv: conv({ model: 'fake-claude-small', claude: { adaptiveThinking: false, fallbacks: false }, effort: null, display: 'omitted' }), maxOutput: 8192 })
  assert.equal(r.error, null, String(r.error))
  const body = lastReq().body as Record<string, any>
  assert.ok(!('fallbacks' in body) && !('thinking' in body) && !('output_config' in body))
  assert.ok(!String(lastReq().headers['anthropic-beta'] ?? '').includes('server-side-fallback'))
})

test('a tool round with preserved thinking: the turn and its signed blocks replay byte-identical, results in one message', async () => {
  const a = adapter()
  const u = a.userTurn('read hello')
  fake.enqueue({ ...MATRIX.oneTool(), reasoning: 'I should read the post first.' })
  const first = await collect(a, [u], { conv: conv(), maxOutput: 64_000 })
  assert.equal(first.turn?.stop, 'tool_calls')
  const call = first.turn!.toolCalls[0]
  assert.deepEqual(JSON.parse(call.argsText), { collection: 'blog', slug: 'hello' })
  assert.ok(first.events.some((e) => e.type === 'tool_call_start' && e.id === call.id))
  const native = first.turn!.native as { content: Array<{ type: string }> }
  assert.deepEqual(native.content.map((b) => b.type), ['thinking', 'tool_use'])
  const results = a.toolResultsTurn([{ id: call.id, name: call.name, text: '{"ok":true}', isError: false }])
  fake.enqueue({ text: 'Read it.', reasoning: 'Done reading.' })
  const second = await collect(a, [u, first.turn!.native, results], { conv: conv(), maxOutput: 64_000 })
  assert.equal(second.error, null, String(second.error))
  fake.enqueue(MATRIX.text())
  const third = await collect(a, [u, first.turn!.native, results, second.turn!.native, a.userTurn('and now?')], { conv: conv(), maxOutput: 64_000 })
  assert.equal(third.error, null, 'every earlier block still validates against its prefix')
  const err = a.toolResultsTurn([{ id: 'toolu_x', name: 'get_content', text: '{"error":{}}', isError: true }]) as { content: Array<Record<string, unknown>> }
  assert.equal(err.content[0].is_error, true)
})

test('a changed system text, tool list or earlier block is refused: why the prefix is frozen', async () => {
  const a = adapter()
  const u = a.userTurn('x')
  fake.enqueue({ ...MATRIX.oneTool(), reasoning: 'Thinking.' })
  const first = await collect(a, [u], { conv: conv(), maxOutput: 64_000 })
  const results = a.toolResultsTurn(first.turn!.toolCalls.map((c) => ({ id: c.id, name: c.name, text: '{}', isError: false })))
  fake.enqueue(MATRIX.text())
  const changed = await collect(a, [u, first.turn!.native, results], { conv: conv({ systemText: 'Another system text.' }), maxOutput: 64_000 })
  const e = changed.error as PErr
  assert.equal(e.kind, 'bad_request')
  assert.ok(e.badThinkingBlock, 'the refused block is located, for the once-only recovery')
  const [m, b] = e.badThinkingBlock!
  const stripped = claude.withoutThinkingFrom([u, first.turn!.native, results], m, b)
  fake.reset()
  fake.enqueue(MATRIX.text())
  const recovered = await collect(a, stripped as NativeTurn[], { conv: conv({ systemText: 'Another system text.' }), maxOutput: 64_000 })
  assert.equal(recovered.error, null, 'with the block and later thinking dropped, the turn goes through')
})

test('fallback before output: a notice, usage summed over iterations, and the next turn accepts the echo', async () => {
  const a = adapter()
  const u = a.userTurn('x')
  fake.enqueue(MATRIX.claudeFallbackBefore())
  const r = await collect(a, [u], { conv: conv(), maxOutput: 64_000 })
  assert.deepEqual(r.events.find((e) => e.type === 'notice'), { type: 'notice', kind: 'fallback', from: 'claude-opus-5-5', to: 'claude-opus-5' })
  const usage = r.events.find((e) => e.type === 'usage')
  assert.equal(usage?.type === 'usage' && usage.usage.input, 20, 'both attempts counted')
  assert.equal(usage?.type === 'usage' && usage.usage.output, 5)
  fake.enqueue(MATRIX.text())
  assert.equal((await collect(a, [u, r.turn!.native, a.userTurn('next')], { conv: conv(), maxOutput: 64_000 })).error, null)
})

test('fallback mid-output: the one permitted edit (blocks before the last fallback lose thinking and tool use) is what replays', async () => {
  const a = adapter()
  const u = a.userTurn('x')
  fake.enqueue(MATRIX.claudeFallbackMid())
  const r = await collect(a, [u], { conv: conv(), maxOutput: 64_000 })
  const types = (r.turn!.native as { content: Array<{ type: string }> }).content.map((b) => b.type)
  assert.deepEqual(types, ['text', 'fallback', 'thinking', 'text'])
  fake.enqueue(MATRIX.text())
  assert.equal((await collect(a, [u, r.turn!.native, a.userTurn('next')], { conv: conv(), maxOutput: 64_000 })).error, null)
  // The pure function on its own: only text survives before the final boundary.
  const content = [{ type: 'thinking' }, { type: 'tool_use' }, { type: 'text' }, { type: 'redacted_thinking' }, { type: 'server_tool_use' }, { type: 'fallback' }, { type: 'thinking' }, { type: 'fallback' }, { type: 'tool_use' }]
  assert.deepEqual(claude.fallbackTurnContent(content).map((b) => b.type), ['text', 'fallback', 'tool_use'])
  assert.deepEqual(claude.fallbackTurnContent([{ type: 'thinking' }, { type: 'text' }]).map((b) => b.type), ['thinking', 'text'], 'no fallback: unchanged')
})

test('stop reasons: sentinel, pause_turn (append and re-send), context window, stop sequence, refusals', async () => {
  const a = adapter()
  fake.enqueue(MATRIX.claudeSentinel())
  const sentinel = await collect(a, [a.userTurn('x')], { conv: conv(), maxOutput: 64_000 })
  assert.equal(sentinel.turn?.stop, 'max_tokens')
  assert.ok(sentinel.turn!.text.endsWith(INTERRUPTED_SENTINEL))

  const u = a.userTurn('x')
  fake.enqueue(MATRIX.pauseTurn())
  const paused = await collect(a, [u], { conv: conv(), maxOutput: 64_000 })
  assert.equal(paused.turn?.stop, 'paused')
  fake.enqueue(MATRIX.text())
  assert.equal((await collect(a, [u, paused.turn!.native], { conv: conv(), maxOutput: 64_000 })).error, null, 'the paused turn is continued as it was')

  fake.enqueue(MATRIX.contextWindow())
  assert.equal((await collect(a, [a.userTurn('x')], { conv: conv(), maxOutput: 64_000 })).turn?.stop, 'context_overflow')
  fake.enqueue(MATRIX.stopSequence())
  assert.equal((await collect(a, [a.userTurn('x')], { conv: conv(), maxOutput: 64_000 })).turn?.stop, 'end')
  fake.enqueue(MATRIX.refusalBeforeOutput())
  const before = await collect(a, [a.userTurn('x')], { conv: conv(), maxOutput: 64_000 })
  assert.equal(before.turn?.stop, 'refusal')
  assert.deepEqual(before.turn?.refusal, { category: 'cyber', explanation: 'Declined before any output.' })
  fake.enqueue(MATRIX.refusalMidStream())
  const mid = await collect(a, [a.userTurn('x')], { conv: conv(), maxOutput: 64_000 })
  assert.equal(mid.turn?.stop, 'refusal')
  assert.deepEqual(mid.turn?.refusal, { category: null, explanation: null })
  assert.equal(mid.turn?.toolCalls.length, 0)
})

test('eager input: a cut call comes back raw with max_tokens (never parsed as whole); unparseable JSON is a re-issue, not an API error', async () => {
  const a = adapter()
  fake.enqueue(MATRIX.truncatedEagerJson())
  const cut = await collect(a, [a.userTurn('x')], { conv: conv(), maxOutput: 64_000 })
  assert.equal(cut.turn?.stop, 'max_tokens')
  assert.equal(cut.turn?.toolCalls[0].argsText, '{"title":"cut', 'the raw text, which strict parsing refuses')
  fake.enqueue(MATRIX.malformedEagerJson())
  const bad = await collect(a, [a.userTurn('x')], { conv: conv(), maxOutput: 64_000 })
  const e = bad.error as PErr
  assert.ok(e instanceof types.ProviderError)
  assert.equal(e.reissue, true)
})

test('a stream that breaks or ends inside a tool input is a network failure after output, never the model’s bad JSON', async () => {
  const a = adapter()
  const call = { reasoning: null, toolCalls: [{ name: 'create_draft', argsText: '{"title":"abcdefghijklmnop","body":"x"}', argFragments: ['{"title":', '"abcdefgh', 'ijklmnop",', '"body":"x"}'] }] }
  // destroyAfter: the socket dies (the SDK wraps the transport error with its cause); truncateAfter: the stream just ends.
  for (const cut of [{ destroyAfter: 4 }, { destroyAfter: 5 }, { destroyAfter: 6 }, { truncateAfter: 4 }, { truncateAfter: 6 }]) {
    fake.enqueue({ ...call, ...cut })
    const r = await collect(a, [a.userTurn('x')], { conv: conv(), maxOutput: 64_000 })
    const e = r.error as PErr
    assert.ok(e instanceof types.ProviderError, JSON.stringify(cut))
    assert.deepEqual([e.kind, e.reissue, e.retryable], ['network', false, true], JSON.stringify(cut))
    assert.ok(r.events.some((x) => x.type === 'tool_call_delta'), `it broke after output: ${JSON.stringify(cut)}`)
    assert.equal(r.turn, null)
  }
  // The SDK's own refusal of unparseable JSON is still the one re-issue.
  fake.enqueue(MATRIX.malformedEagerJson())
  assert.equal(((await collect(a, [a.userTurn('x')], { conv: conv(), maxOutput: 64_000 })).error as PErr).reissue, true)
})

test('errors by class: 401 key, 402 billing, 429 after the SDK’s own retries, 529 overloaded; abort; idle', async () => {
  const a = adapter()
  fake.enqueue(MATRIX.unauthorized())
  assert.equal(((await collect(a, [a.userTurn('x')], { conv: conv(), maxOutput: 1000 })).error as PErr).kind, 'auth')
  fake.enqueue(MATRIX.billing())
  assert.equal(((await collect(a, [a.userTurn('x')], { conv: conv(), maxOutput: 1000 })).error as PErr).kind, 'billing')
  fake.reset()
  const limited = { status: 429, headers: { 'retry-after': '0' }, errorMessage: 'Rate limited.', errorType: 'rate_limit_error' }
  fake.enqueue(limited, limited, limited)
  assert.equal(((await collect(a, [a.userTurn('x')], { conv: conv(), maxOutput: 1000 })).error as PErr).kind, 'rate_limit')
  assert.equal(fake.requests.length, 3, 'two SDK retries, then the error')
  fake.reset()
  const over = { status: 529, headers: { 'retry-after': '0' }, errorMessage: 'Overloaded.', errorType: 'overloaded_error' }
  fake.enqueue(over, over, over)
  assert.equal(((await collect(a, [a.userTurn('x')], { conv: conv(), maxOutput: 1000 })).error as PErr).kind, 'overloaded')

  fake.reset()
  fake.enqueue(MATRIX.abortMidText())
  const ac = new AbortController()
  let n = 0
  let caught: unknown = null
  try {
    for await (const e of a.stream({ conv: conv(), native: [a.userTurn('x')], maxOutput: 1000, signal: ac.signal })) if (e.type === 'text' && ++n === 2) ac.abort()
  } catch (err) {
    caught = err
  }
  assert.equal((caught as PErr).kind, 'aborted')

  fake.enqueue(MATRIX.idle())
  const idle = await collect(adapter(300), [a.userTurn('x')], { conv: conv(), maxOutput: 1000 })
  assert.equal((idle.error as PErr).kind, 'timeout')
})

test('the Models API: ids with live capabilities (never a table in code)', async () => {
  const models = await adapter().listModels(new AbortController().signal)
  const opus = models.find((m) => m.id === 'claude-opus-5-5')
  assert.deepEqual(opus?.claude, { effort: true, adaptiveThinking: true, fallbacks: true })
  assert.equal(opus?.maxOutputTokens, 128000)
  assert.equal(models.find((m) => m.id === 'claude-opus-5')?.claude?.fallbacks, false)
  assert.ok(!models.some((m) => m.id === 'fake-model'), 'Claude lists its own models only')
})

test('ANTHROPIC_CUSTOM_HEADERS: no client is built (nothing leaves) and System health says why', async () => {
  process.env.ANTHROPIC_CUSTOM_HEADERS = 'x-injected: 1'
  const a = adapter()
  const r = await collect(a, [a.userTurn('x')], { conv: conv(), maxOutput: 1000 })
  assert.equal((r.error as PErr).kind, 'config')
  await assert.rejects(() => a.listModels(new AbortController().signal), (err: PErr) => err.kind === 'config')
  assert.equal(fake.requests.length, 0)
  const { aiHealthWarnings } = await import('../lib/ai/health')
  const { ANTHROPIC_CUSTOM_HEADERS_PROBLEM } = await import('../lib/ai/providers/env')
  assert.ok(aiHealthWarnings().includes(ANTHROPIC_CUSTOM_HEADERS_PROBLEM))
  delete process.env.ANTHROPIC_CUSTOM_HEADERS
  assert.ok(!aiHealthWarnings().includes(ANTHROPIC_CUSTOM_HEADERS_PROBLEM))
  // The stores System health opened (the switches, the stored changes) are this file's temp ones.
  const { getAuthDb } = await import('../lib/adminAuth/db')
  const { getAiDb } = await import('../lib/ai/db')
  assert.equal(path.dirname(getAuthDb().name), tmpData)
  assert.equal(path.dirname(getAiDb().name), tmpData)
})

test('ANTHROPIC_LOG=debug changes nothing: no console line from the SDK, and the key is scrubbed from every error', async () => {
  process.env.ANTHROPIC_LOG = 'debug'
  process.env.ANTHROPIC_API_KEY = 'sk-ant-from-the-environment-never-used'
  process.env.ANTHROPIC_BASE_URL = 'http://192.0.2.1:9'
  const lines: string[] = []
  const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug }
  for (const k of ['log', 'info', 'warn', 'error', 'debug'] as const) console[k] = (...args: unknown[]) => void lines.push(args.map(String).join(' '))
  try {
    fake.enqueue({ status: 400, errorBody: { type: 'error', error: { type: 'invalid_request_error', message: `bad key ${KEY}` } } })
    const a = adapter()
    const r = await collect(a, [a.userTurn('x')], { conv: conv(), maxOutput: 1000 })
    const e = r.error as PErr
    assert.ok(!e.message.includes(KEY) && !e.providerMessage.includes(KEY) && !String(e.stack).includes(KEY))
    assert.match(e.providerMessage, /\[secret\]/)
    fake.enqueue(MATRIX.text())
    assert.equal((await collect(a, [a.userTurn('x')], { conv: conv(), maxOutput: 1000 })).error, null, 'the explicit baseURL and key win over the environment')
    assert.equal(String(lastReq().headers['x-api-key'] ?? lastReq().headers.authorization ?? '').includes('from-the-environment'), false)
  } finally {
    Object.assign(console, saved)
  }
  assert.deepEqual(lines.filter((l) => /anthropic|request|response|sk-ant/i.test(l)), [])
})

test('the never-sent parameters left no Claude request of this file', () => {
  assert.ok(sent.length >= 20)
  for (const body of sent) for (const k of NEVER_SENT) assert.ok(!deepKeys(body).has(k), k)
})
