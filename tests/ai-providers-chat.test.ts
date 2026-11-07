/**
 * M4 — the Chat Completions adapter (lib/ai/providers/chat.ts, design §7.1,
 * PROVIDERS §4) against tests/helpers/fake-llm.mjs, which enforces each
 * dialect's documented refusals: so every case here is a conformance check,
 * not a mock. Reached as a local custom provider (AI_LOCAL_PROVIDER_ORIGINS'
 * gate: SITE_URL on loopback), through safeFetchStream, like production.
 */
import { test, before, after, afterEach, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'
import { MATRIX, startFakeLlm } from './helpers/fake-llm.mjs'
import { CREATE_DRAFT, GET_CONTENT, NEVER_SENT, collect, deepKeys, snap, testQuirks } from './helpers/modelTurns'
import type { Quirks } from '../lib/ai/presets'
import type { ModelAdapter, NativeTurn } from '../lib/ai/providers/types'

let fake: Awaited<ReturnType<typeof startFakeLlm>>
let chat: typeof import('../lib/ai/providers/chat')
let types: typeof import('../lib/ai/providers/types')
const KEY = 'sk-test-chat-0123456789abcdef'

before(async () => {
  process.env.SITE_URL = 'http://127.0.0.1:3999'
  fake = await startFakeLlm()
  chat = await import('../lib/ai/providers/chat')
  types = await import('../lib/ai/providers/types')
})
after(async () => {
  await fake.close()
  delete process.env.SITE_URL
})
beforeEach(() => fake.reset())
/** Every request body this file sent, for the last test. */
const sent: unknown[] = []
afterEach(() => {
  for (const r of fake.requests) if (r.body !== undefined) sent.push(r.body)
})

function adapter(dialect: string | null = null, quirks: Partial<Quirks> = {}, opts: { apiKey?: string | null; local?: boolean } = {}): ModelAdapter {
  return chat.createChatAdapter({
    baseUrl: dialect ? fake.baseUrl(dialect) : fake.baseUrl(),
    apiKey: opts.apiKey === undefined ? KEY : opts.apiKey,
    connectTimeoutMs: 5_000,
    idleTimeoutMs: quirks.idleTimeoutMs ?? 5_000,
    localOrigins: opts.local === false ? [] : [fake.origin],
    quirks: testQuirks(quirks),
  })
}

const user = (a: ModelAdapter, text: string) => a.userTurn(text)
const lastBody = () => fake.requests[fake.requests.length - 1].body as Record<string, any>

describe('requests', () => {
  test('a text answer: system first, tools as functions, usage streamed, nothing it must never send', async () => {
    fake.enqueue({ ...MATRIX.textChinese(), usage: { input: 30, cachedRead: 10, output: 7 } })
    const a = adapter()
    const r = await collect(a, [user(a, 'hi')], { maxOutput: 900 })
    assert.equal(r.error, null)
    assert.equal(r.text, '你好，这是测试模型的回复。')
    assert.equal(r.turn?.stop, 'end')
    assert.equal(r.turn?.text, '你好，这是测试模型的回复。')
    const usage = r.events.find((e) => e.type === 'usage')
    assert.deepEqual(usage, { type: 'usage', usage: { input: 30, cachedRead: 10, cacheWrite: 0, output: 7, reasoning: 0, reportedMicroUsd: null }, estimated: false }, 'input is uncached: the cached part is subtracted')
    const body = lastBody()
    assert.deepEqual(body.messages[0], { role: 'system', content: 'System text for tests.' })
    assert.deepEqual(body.tools[0], { type: 'function', function: { name: 'get_content', description: 'Read one item.', parameters: GET_CONTENT.inputSchema } })
    assert.equal(body.stream, true)
    assert.deepEqual(body.stream_options, { include_usage: true })
    assert.equal(body.max_tokens, 900)
    for (const k of [...NEVER_SENT, 'n', 'stop', 'parallel_tool_calls', 'presence_penalty', 'frequency_penalty', 'logprobs']) assert.ok(!(k in body), k)
  })

  test('the output limit is omitted unless given; the owner field and effort go where the quirk says', async () => {
    fake.enqueue(MATRIX.text())
    const a = adapter(null, { maxTokensField: 'max_completion_tokens' })
    await collect(a, [user(a, 'x')], { conv: snap({ effort: 'high' }) })
    assert.ok(!('max_tokens' in lastBody()) && !('max_completion_tokens' in lastBody()))
    assert.equal(lastBody().reasoning_effort, 'high')
    fake.enqueue(MATRIX.text())
    await collect(a, [user(a, 'x')], { maxOutput: 2048 })
    assert.equal(lastBody().max_completion_tokens, 2048)
    assert.ok(!('max_tokens' in lastBody()))
  })

  test('a model with no tools sends no tools key', async () => {
    fake.enqueue(MATRIX.text())
    const a = adapter()
    await collect(a, [user(a, 'x')], { conv: snap({ tools: [] }) })
    assert.ok(!('tools' in lastBody()))
  })
})

describe('tool calls and replay', () => {
  test('one call, then its result in one turn: the fake checks the pairing', async () => {
    fake.enqueue(MATRIX.oneTool())
    const a = adapter()
    const u = user(a, 'read hello')
    const first = await collect(a, [u])
    assert.equal(first.turn?.stop, 'tool_calls')
    assert.equal(first.turn?.toolCalls.length, 1)
    const call = first.turn!.toolCalls[0]
    assert.deepEqual(JSON.parse(call.argsText), { collection: 'blog', slug: 'hello' })
    assert.ok(first.events.some((e) => e.type === 'tool_call_start' && e.name === 'get_content'))
    const results = a.toolResultsTurn([{ id: call.id, name: call.name, text: '{"ok":true}', isError: false }])
    fake.enqueue(MATRIX.text())
    const second = await collect(a, [u, first.turn!.native, results])
    assert.equal(second.error, null)
    assert.equal(second.turn?.stop, 'end')
    const msgs = lastBody().messages
    assert.equal(msgs[2].role, 'assistant')
    assert.deepEqual(msgs[3], { role: 'tool', tool_call_id: call.id, content: '{"ok":true}' })
  })

  test('parallel calls: both results in one turn; leaving one out is refused by the provider', async () => {
    fake.enqueue(MATRIX.parallelTools())
    const a = adapter()
    const u = user(a, 'x')
    const first = await collect(a, [u])
    const calls = first.turn!.toolCalls
    assert.equal(calls.length, 2)
    fake.enqueue(MATRIX.text())
    const both = a.toolResultsTurn(calls.map((c) => ({ id: c.id, name: c.name, text: '{}', isError: false })))
    assert.equal((await collect(a, [u, first.turn!.native, both])).error, null)
    const one = a.toolResultsTurn([{ id: calls[0].id, name: calls[0].name, text: '{}', isError: false }])
    const refused = await collect(a, [u, first.turn!.native, one])
    assert.ok(refused.error instanceof types.ProviderError)
    assert.equal((refused.error as InstanceType<typeof types.ProviderError>).kind, 'bad_request')
  })

  test('the transport matrix: every byte its own write (inside UTF-8), every UTF-16 unit, whole calls, no index, empty ids, empty arguments', async () => {
    const a = adapter()
    fake.enqueue(MATRIX.everyByte())
    const bytes = await collect(a, [user(a, 'x')])
    assert.equal(bytes.text, '逐字节流')
    assert.deepEqual(JSON.parse(bytes.turn!.toolCalls[0].argsText), { title: '标题 🎉 title' })

    fake.enqueue(MATRIX.everyArgUnit())
    const units = await collect(a, [user(a, 'x')])
    assert.deepEqual(JSON.parse(units.turn!.toolCalls[0].argsText), { title: 'emoji 🎉' })

    fake.enqueue(MATRIX.wholeCall())
    assert.deepEqual(JSON.parse((await collect(a, [user(a, 'x')])).turn!.toolCalls[0].argsText), { slug: 'whole' })

    fake.enqueue(MATRIX.missingIndex())
    const noIndex = await collect(a, [user(a, 'x')])
    assert.deepEqual(noIndex.turn!.toolCalls.map((c) => JSON.parse(c.argsText).slug), ['a', 'b'], 'two calls without index stay two (keyed by id)')

    fake.enqueue(MATRIX.emptyIdNullName())
    const frags = await collect(a, [user(a, 'x')])
    assert.equal(frags.turn!.toolCalls.length, 1)
    assert.equal(frags.turn!.toolCalls[0].name, 'get_content')
    assert.deepEqual(JSON.parse(frags.turn!.toolCalls[0].argsText), { slug: 'fragments' })

    fake.enqueue(MATRIX.emptyArguments())
    const empty = await collect(a, [user(a, 'x')])
    assert.equal(empty.turn!.toolCalls[0].argsText, '', 'raw: the loop reads "" as {}')
  })

  test('comments, CRLF, no [DONE], a usage chunk with no choices', async () => {
    const a = adapter()
    for (const t of [MATRIX.comments(), MATRIX.crlf(), MATRIX.noDone(), MATRIX.usageChunk()]) {
      fake.enqueue(t)
      const r = await collect(a, [user(a, 'x')])
      assert.equal(r.error, null)
      assert.equal(r.text, t.text)
      assert.equal(r.turn?.stop, 'end')
    }
  })

  test('content as a chunk list (Mistral): the list is rebuilt for replay, the text shown', async () => {
    fake.enqueue(MATRIX.contentAsList())
    const a = adapter('mistral', { toolMessageName: true })
    const r = await collect(a, [user(a, 'x')])
    assert.equal(r.text, 'Then plain text.')
    assert.equal(r.thinking, 'Thinking in a list.')
    const msg = (r.turn!.native as { messages: Array<Record<string, unknown>> }).messages[0]
    assert.deepEqual(msg.content, [{ type: 'thinking', thinking: [{ type: 'text', text: 'Thinking in a list.' }] }, { type: 'text', text: 'Then plain text.' }])
  })

  test('a leading <think> block is reasoning on screen and kept verbatim in history', async () => {
    fake.enqueue(MATRIX.leadingThink())
    const a = adapter()
    const r = await collect(a, [user(a, 'x')])
    assert.equal(r.text, 'The visible answer.')
    assert.equal(r.turn?.text, 'The visible answer.')
    assert.match(r.thinking, /Thinking inline\./)
    assert.equal((r.turn!.native as { messages: Array<Record<string, unknown>> }).messages[0].content, '<think>Thinking inline.</think>The visible answer.')
  })
})

describe('stops and failures', () => {
  test('max tokens with a tool call, content filter, refusal: stop kinds, and a refused turn carries no tool call to run', async () => {
    const a = adapter()
    fake.enqueue(MATRIX.lengthWithTool())
    const cut = await collect(a, [user(a, 'x')])
    assert.equal(cut.turn?.stop, 'max_tokens')
    assert.equal(cut.turn?.toolCalls.length, 1, 'kept so the loop knows a call was cut (and never runs it)')
    fake.enqueue(MATRIX.contentFilter())
    const filtered = await collect(a, [user(a, 'x')])
    assert.equal(filtered.turn?.stop, 'content_filter')
    fake.enqueue({ refusal: 'I cannot help with that.' })
    const refused = await collect(a, [user(a, 'x')])
    assert.equal(refused.turn?.stop, 'refusal')
    assert.equal(refused.turn?.refusal?.explanation, 'I cannot help with that.')
  })

  test('in-band errors at HTTP 200 (OpenRouter, MiniMax), a provider stop for lack of resources, EOF and a dead socket are errors, never a turn', async () => {
    const a = adapter()
    for (const t of [MATRIX.inBandError(), MATRIX.inBandErrorMinimax(), MATRIX.insufficientResources(), MATRIX.eof(), MATRIX.connectionLost()]) {
      fake.enqueue(t)
      const r = await collect(a, [user(a, 'x')])
      assert.ok(r.error instanceof types.ProviderError, JSON.stringify(t).slice(0, 60))
      assert.equal(r.turn, null)
    }
  })

  test('idle: silence past the idle limit fails the call', async () => {
    fake.enqueue(MATRIX.idle())
    const a = adapter(null, { idleTimeoutMs: 300 })
    const r = await collect(a, [user(a, 'x')])
    assert.equal((r.error as InstanceType<typeof types.ProviderError>).kind, 'timeout')
  })

  test('abort mid-answer: aborted, and the socket is closed', async () => {
    fake.enqueue(MATRIX.abortMidText())
    const a = adapter()
    const ac = new AbortController()
    let n = 0
    const r = { error: null as unknown }
    try {
      for await (const e of a.stream({ conv: snap(), native: [user(a, 'x')], maxOutput: undefined, signal: ac.signal })) {
        if (e.type === 'text' && ++n === 3) ac.abort()
      }
    } catch (err) {
      r.error = err
    }
    assert.equal((r.error as InstanceType<typeof types.ProviderError>).kind, 'aborted')
    await fake.settled()
    assert.equal(fake.requests[0].aborted, true)
  })

  test('429 with a short retry-after is retried; a long one is surfaced at once; 401 is the key', async () => {
    const a = adapter()
    fake.enqueue({ status: 429, headers: { 'retry-after': '0' }, errorMessage: 'Slow down.' }, MATRIX.text())
    const retried = await collect(a, [user(a, 'x')])
    assert.equal(retried.error, null)
    assert.equal(fake.requests.length, 2)
    fake.reset()
    fake.enqueue({ status: 429, headers: { 'retry-after': '60' }, errorMessage: 'Slow down.' })
    const long = await collect(a, [user(a, 'x')])
    const e = long.error as InstanceType<typeof types.ProviderError>
    assert.equal(e.kind, 'rate_limit')
    assert.equal(e.retryAfterMs, 60_000)
    assert.equal(fake.requests.length, 1, 'not waited for')
    fake.enqueue(MATRIX.unauthorized())
    assert.equal(((await collect(a, [user(a, 'x')])).error as InstanceType<typeof types.ProviderError>).kind, 'auth')
  })

  test('the key never appears in an error, even when the provider quotes it', async () => {
    const a = adapter()
    fake.enqueue({ status: 400, errorBody: { error: { message: `Incorrect API key provided: ${KEY}` } } })
    const r = await collect(a, [user(a, 'x')])
    const e = r.error as InstanceType<typeof types.ProviderError>
    assert.ok(!e.message.includes(KEY) && !e.providerMessage.includes(KEY))
    assert.match(e.providerMessage, /\[secret\]/)
  })

  test('nor in an error inside a 200 stream (OpenRouter `error`, MiniMax `base_resp`), nor half of it across the length cap', async () => {
    const a = adapter()
    // 585 characters, then the key: before the cap the key's first 14 characters would be kept.
    const long = `${'x'.repeat(585)}${KEY}`
    for (const t of [
      { text: 'Partial.', inBandError: { afterFrames: 1, message: `Incorrect API key provided: ${KEY}` } },
      { text: 'Partial.', inBandError: { afterFrames: 1, message: `Invalid key ${KEY}`, code: 1004, shape: 'minimax' } },
      { text: 'Partial.', inBandError: { afterFrames: 1, message: long } },
      { text: 'Partial.', inBandError: { afterFrames: 1, message: long, code: 1004, shape: 'minimax' } },
      { status: 401, errorBody: { error: { message: long } } },
    ]) {
      fake.enqueue(t)
      const e = (await collect(a, [user(a, 'x')])).error as InstanceType<typeof types.ProviderError>
      assert.ok(e instanceof types.ProviderError, JSON.stringify(t).slice(0, 80))
      const words = [e.message, e.providerMessage, e.stack ?? '', String(e.requestId)].join('\n')
      assert.ok(!words.includes(KEY.slice(0, 12)), `no part of the key: ${JSON.stringify(t).slice(0, 80)}`)
      assert.match(e.providerMessage, /\[secret\]/, 'the provider’s words are kept, the key masked')
    }
    // The model list (Check key, Test's first step) quotes it too.
    fake.enqueueModels({ status: 401, body: { error: { message: long } } })
    const listed = await a.listModels(AbortSignal.timeout(5_000)).then(
      () => null,
      (err: unknown) => err,
    )
    assert.ok(listed instanceof types.ProviderError)
    assert.ok(![listed.message, listed.providerMessage, listed.stack ?? ''].join('\n').includes(KEY.slice(0, 12)))
  })

  test('a 400 on an output limit says the limit was sent (the loop re-issues once without it)', async () => {
    fake.enqueue(MATRIX.text())
    const a = adapter()
    const r = await collect(a, [user(a, 'x')], { conv: snap({ model: 'fake-small-output' }), maxOutput: 64_000 })
    const e = r.error as InstanceType<typeof types.ProviderError>
    assert.equal(e.kind, 'bad_request')
    assert.equal(e.sentOutputLimit, true)
    fake.reset()
    fake.enqueue(MATRIX.text())
    assert.equal((await collect(a, [user(a, 'x')], { conv: snap({ model: 'fake-small-output' }) })).error, null)
  })

  test('a provider that refuses the tool schemas answers 400 (what Test reports as Schema refused)', async () => {
    const a = adapter()
    const r = await collect(a, [user(a, 'x')], { conv: snap({ model: 'fake-schema-refuser' }) })
    assert.equal((r.error as InstanceType<typeof types.ProviderError>).kind, 'bad_request')
    assert.match((r.error as InstanceType<typeof types.ProviderError>).providerMessage, /schema/)
  })
})

describe('dialects: what each provider demands on replay', () => {
  async function toolRound(a: ModelAdapter, turnScript: Record<string, unknown> = MATRIX.oneTool()) {
    fake.enqueue(turnScript)
    const u = user(a, 'x')
    const first = await collect(a, [u])
    assert.equal(first.error, null, String(first.error))
    const results = a.toolResultsTurn(first.turn!.toolCalls.map((c) => ({ id: c.id, name: c.name, text: '{}', isError: false })))
    fake.enqueue(MATRIX.text())
    return { first, second: await collect(a, [u, first.turn!.native as NativeTurn, results]) }
  }

  test('DeepSeek: reasoning_content goes back (400 when it does not), with the comment keep-alives', async () => {
    const ok = await toolRound(adapter('deepseek'))
    assert.equal(ok.second.error, null)
    assert.equal((ok.first.turn!.native as any).messages[0].reasoning_content, 'Thinking it through.')
    assert.ok(ok.first.thinking.length > 0)
    const off = await toolRound(adapter('deepseek', { echoReasoning: false }))
    assert.equal((off.second.error as InstanceType<typeof types.ProviderError>).kind, 'bad_request', 'the owner’s escape hatch really drops it')
  })

  test('Gemini: the thought signature on each call is echoed; calls without index stay apart', async () => {
    const r = await toolRound(adapter('gemini'), MATRIX.parallelTools())
    assert.equal(r.second.error, null)
    assert.equal(r.first.turn!.toolCalls.length, 2)
    const calls = (r.first.turn!.native as any).messages[0].tool_calls
    assert.ok(calls.every((c: any) => typeof c.extra_content?.google?.thought_signature === 'string'))
    assert.ok(calls.every((c: any) => !('index' in c)), 'streaming index is not replayed')
  })

  test('Groq: no name on tool messages (Mistral’s flag would be refused); usage under x_groq; failed_generation re-issues', async () => {
    const ok = await toolRound(adapter('groq'))
    assert.equal(ok.second.error, null)
    assert.equal(ok.first.events.find((e) => e.type === 'usage' && !e.estimated) !== undefined, true)
    const named = await toolRound(adapter('groq', { toolMessageName: true }))
    assert.equal((named.second.error as InstanceType<typeof types.ProviderError>).kind, 'bad_request')
    fake.reset() // the refused request left its scripted answer in the queue
    fake.enqueue(MATRIX.groqFailedGeneration())
    const a = adapter('groq', { reissueFailedGeneration: true })
    const failed = await collect(a, [user(a, 'x')])
    assert.equal((failed.error as InstanceType<typeof types.ProviderError>).reissue, true)
  })

  test('Alibaba: an assistant turn with no text replays content "" (null is refused)', async () => {
    const plain = await toolRound(adapter('alibaba'), { ...MATRIX.oneTool(), reasoning: null })
    assert.equal((plain.second.error as InstanceType<typeof types.ProviderError>).kind, 'bad_request')
    const quirk = await toolRound(adapter('alibaba', { emptyContent: 'empty-string' }), { ...MATRIX.oneTool(), reasoning: null })
    assert.equal(quirk.second.error, null)
  })

  test('Qwen: its GLM models get tool_stream from the preset (without it Alibaba returns no tool call); its other models do not', async () => {
    const presets = await import('../lib/ai/presets')
    const quirks = presets.quirksFor(presets.presetById('qwen')!)
    const a = adapter('alibaba', quirks)
    for (const model of ['glm-4.6', 'GLM-5.3']) {
      fake.reset()
      fake.enqueue(MATRIX.oneTool())
      const r = await collect(a, [user(a, 'x')], { conv: snap({ model }) })
      assert.equal(r.error, null, String(r.error))
      assert.equal(r.turn?.stop, 'tool_calls', model)
      assert.equal(lastBody().tool_stream, true, model)
    }
    fake.reset()
    fake.enqueue(MATRIX.oneTool())
    const qwen = await collect(a, [user(a, 'x')], { conv: snap({ model: 'qwen-plus' }) })
    assert.equal(qwen.turn?.stop, 'tool_calls')
    assert.equal('tool_stream' in lastBody(), false, 'only the GLM family')
    // What the rule exists for: the same GLM model without it is answered with text only (Test would say Chat only).
    fake.reset()
    fake.enqueue(MATRIX.oneTool())
    const without = await collect(adapter('alibaba', { ...quirks, extraBodyByModel: [] }), [user(a, 'x')], { conv: snap({ model: 'glm-4.6' }) })
    assert.deepEqual([without.turn?.stop, without.turn?.toolCalls.length], ['end', 0])
    // The Responses wire takes the same rule from the same quirks.
    assert.deepEqual(presets.extraBodyFor(quirks, 'glm-4.6'), { tool_stream: true })
    assert.deepEqual(presets.extraBodyFor(presets.quirksFor(presets.presetById('glm')!), 'glm-4.6'), { tool_stream: true })
    assert.deepEqual(presets.extraBodyFor(presets.quirksFor(presets.presetById('openrouter')!), 'glm-4.6'), { provider: { require_parameters: true } })
  })

  test('Kimi: max_completion_tokens, reasoning echoed; GLM: tool_stream from the preset body; MiniMax; Mistral list', async () => {
    const presets = await import('../lib/ai/presets')
    const kimi = adapter('kimi', presets.quirksFor(presets.presetById('kimi')!))
    const k = await toolRound(kimi)
    assert.equal(k.second.error, null)
    fake.enqueue(MATRIX.text())
    await collect(kimi, [user(kimi, 'x')], { maxOutput: 1000 })
    assert.equal(lastBody().max_completion_tokens, 1000)
    const glm = adapter('glm', presets.quirksFor(presets.presetById('glm')!))
    const g = await toolRound(glm)
    assert.equal(g.second.error, null)
    assert.equal(fake.requests.find((r) => r.body?.tool_stream === true) !== undefined, true)
    const mm = await toolRound(adapter('minimax', presets.quirksFor(presets.presetById('minimax')!)))
    assert.equal(mm.second.error, null)
    assert.equal(lastBody().reasoning_split, true)
    const mistral = await toolRound(adapter('mistral', presets.quirksFor(presets.presetById('mistral')!)))
    assert.equal(mistral.second.error, null)
  })

  test('Ollama and LM Studio: keyless, whole calls, missing usage estimated from bytes (marked)', async () => {
    const o = await toolRound(adapter('ollama', {}, { apiKey: null }))
    assert.equal(o.second.error, null)
    const usage = o.first.events.find((e) => e.type === 'usage')
    assert.equal(usage?.type === 'usage' && usage.estimated, true)
    assert.ok(!('authorization' in fake.requests[0].headers), 'no key, no Authorization header')
    const l = await toolRound(adapter('lmstudio', {}, { apiKey: null }))
    assert.equal(l.second.error, null)
  })
})

describe('model lists and addresses', () => {
  test('ids from GET /models; a 404 is tolerated where the preset says try; a redirect is a configuration error and the key never follows it', async () => {
    const a = adapter()
    const models = await a.listModels(new AbortController().signal)
    assert.ok(models.some((m) => m.id === 'fake-model'))
    assert.ok(models.every((m) => m.maxOutputTokens === null), 'no capability claims: none are reported')
    fake.enqueueModels({ status: 404, body: { error: { message: 'no list' } } })
    assert.deepEqual(await adapter(null, { listModels: 'try' }).listModels(new AbortController().signal), [])
    fake.enqueueModels({ status: 302 })
    await assert.rejects(() => a.listModels(new AbortController().signal), (err: any) => err.kind === 'config')
    assert.equal(fake.collected.length, 0, 'the redirect target was never fetched')
  })

  test('an http address that is not an allowed local origin is refused before any request', async () => {
    const a = adapter(null, {}, { local: false })
    const r = await collect(a, [user(a, 'x')])
    assert.equal((r.error as InstanceType<typeof types.ProviderError>).kind, 'config')
    assert.equal(fake.requests.length, 0)
  })
})

test('the reducer keeps unknown fields, merges by index, and never takes a prototype key', async () => {
  const { createChatReducer } = await import('../lib/ai/providers/reducer')
  const r = createChatReducer()
  r.add({ role: 'assistant', content: '', reasoning_details: [{ index: 0, type: 'reasoning.text', text: 'a' }] })
  r.add({ reasoning_details: [{ index: 0, text: 'b' }], vendor_field: { x: 1 } })
  r.add({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_content', arguments: '{"slug"' } }] })
  r.add({ tool_calls: [{ index: 0, function: { name: 'get_content', arguments: ':"a"}' } }] })
  r.add(JSON.parse('{"__proto__": {"polluted": true}, "constructor": "x"}'))
  const m = r.message()
  assert.deepEqual(m.reasoning_details, [{ index: 0, type: 'reasoning.text', text: 'ab' }])
  assert.deepEqual(m.vendor_field, { x: 1 })
  assert.deepEqual(r.toolCalls(), [{ id: 'call_1', name: 'get_content', argsText: '{"slug":"a"}' }], 'name: first non-empty wins')
  assert.equal(({} as Record<string, unknown>).polluted, undefined)
  assert.ok(!Object.prototype.hasOwnProperty.call(m, 'constructor'))
  assert.ok(!(CREATE_DRAFT.name in m))
})

test('no request of this whole matrix carried a never-sent parameter, at any depth', () => {
  assert.ok(sent.length >= 30, `${sent.length} requests checked`)
  for (const body of sent) {
    const keys = deepKeys(body)
    for (const k of NEVER_SENT) assert.ok(!keys.has(k), `${k} was sent`)
  }
})
