/**
 * tests/helpers/fake-llm.mjs: the provider stand-in M4's adapters are tested
 * against. These tests drive it with what the adapters will use, the official
 * SDK for Claude and a spec-compliant SSE parser for the two OpenAI wires, so
 * a fake that drifted from the wire fails here, not in M4. Every documented
 * failure of design §12.2 and every row of PROVIDERS §11 has a case.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import Anthropic from '@anthropic-ai/sdk'
import { createParser } from 'eventsource-parser'
import { DIALECTS, INTERRUPTED_SENTINEL, MATRIX, SOURCES, hostileMarkdown, startFakeLlm } from './helpers/fake-llm.mjs'

type Fake = Awaited<ReturnType<typeof startFakeLlm>>

let fake: Fake

before(async () => {
  fake = await startFakeLlm()
})
after(async () => {
  await fake.close()
})
beforeEach(() => {
  fake.reset()
})

const claude = (opts: Record<string, unknown> = {}) => new Anthropic({ apiKey: 'test-key', baseURL: fake.origin, maxRetries: 0, logLevel: 'off', ...opts })
const CLAUDE_BASE = {
  model: 'claude-opus-5-5',
  max_tokens: 1024,
  betas: ['server-side-fallback-2026-07-01', 'thinking-display-updates-2026-08-18'],
  fallbacks: 'default',
  thinking: { type: 'adaptive', display: 'updates' },
  output_config: { effort: 'medium' },
  cache_control: { type: 'ephemeral' },
  system: [{ type: 'text', text: 'System text.', cache_control: { type: 'ephemeral' } }],
  tools: [{ name: 'get_content', description: 'Read', input_schema: { type: 'object', properties: {} }, eager_input_streaming: true }],
}
const claudeStream = (messages: unknown[], overrides: Record<string, unknown> = {}) => claude().beta.messages.stream({ ...CLAUDE_BASE, messages, ...overrides } as never)
const say = (text: string) => ({ role: 'user', content: text })

/** Reads an SSE response the way the chat and responses adapters will. */
async function readSse(res: Response) {
  const events: { event?: string; data: string }[] = []
  const comments: string[] = []
  const parser = createParser({
    onEvent: (e) => events.push({ event: e.event, data: e.data }),
    onComment: (c) => comments.push(c.trim()),
  })
  const decoder = new TextDecoder()
  const reader = res.body!.getReader()
  let chunks = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    chunks++
    parser.feed(decoder.decode(value, { stream: true }))
  }
  parser.feed(decoder.decode())
  return { events, comments, chunks }
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test-key', ...headers }, body: JSON.stringify(body) })

/** The generic chat delta reducer of PROVIDERS §4, in test form: it proves the frames can be rebuilt. */
function reduceChat(events: { data: string }[]) {
  const message: any = { content: '', tool_calls: [] }
  const reasoning: Record<string, string> = {}
  const list: unknown[] = []
  let finish: string | null = null
  let usage: any = null
  let done = false
  const errors: unknown[] = []
  const slots = new Map<string, any>()
  let arrival = 0
  for (const { data } of events) {
    if (data === '[DONE]') {
      done = true
      continue
    }
    const chunk = JSON.parse(data)
    if (chunk.error || (chunk.base_resp && chunk.base_resp.status_code !== 0)) errors.push(chunk.error ?? chunk.base_resp)
    if (chunk.usage) usage = chunk.usage
    if (chunk.x_groq?.usage) usage = chunk.x_groq.usage
    const choice = chunk.choices?.[0]
    if (!choice) continue
    if (choice.finish_reason) finish = choice.finish_reason
    const d = choice.delta ?? {}
    if (typeof d.content === 'string') message.content += d.content
    else if (Array.isArray(d.content)) list.push(...d.content)
    for (const k of ['reasoning_content', 'reasoning']) if (typeof d[k] === 'string') reasoning[k] = (reasoning[k] ?? '') + d[k]
    if (typeof d.refusal === 'string') message.refusal = (message.refusal ?? '') + d.refusal
    for (const tc of d.tool_calls ?? []) {
      const key = tc.index !== undefined ? `i${tc.index}` : tc.id ? `id${tc.id}` : `a${arrival}`
      let slot = slots.get(key)
      if (!slot) {
        slot = { id: '', name: '', args: '', extra: undefined }
        slots.set(key, slot)
        arrival++
      }
      if (tc.id) slot.id = tc.id
      if (tc.function?.name) slot.name = tc.function.name
      if (tc.function?.arguments) slot.args += tc.function.arguments
      if (tc.extra_content) slot.extra = tc.extra_content
    }
  }
  return { content: message.content, refusal: message.refusal, list, reasoning, finish, usage, done, errors, calls: [...slots.values()] }
}

const chatUrl = (dialect?: string) => `${fake.baseUrl(dialect)}/chat/completions`
const responsesUrl = (dialect?: string) => `${fake.baseUrl(dialect)}/responses`
const chatBody = (messages: unknown[], extra: Record<string, unknown> = {}) => ({ model: 'fake-model', stream: true, stream_options: { include_usage: true }, messages, ...extra })
const toolAnswered = (assistant: unknown, results: { id: string; text: string }[]) => [assistant, ...results.map((r) => ({ role: 'tool', tool_call_id: r.id, content: r.text }))]

describe('Claude through the official SDK', () => {
  test('text, thinking and usage: the SDK rebuilds the final message', async () => {
    fake.enqueue({ reasoning: 'Working on it.', text: '你好，世界', usage: { input: 11, output: 7, cachedRead: 3, cacheWrite: 2 } })
    const final = await claudeStream([say('hi')]).finalMessage()
    assert.equal(final.stop_reason, 'end_turn')
    assert.deepEqual(
      final.content.map((b: any) => b.type),
      ['thinking', 'text'],
    )
    assert.equal((final.content[0] as any).thinking, 'Working on it.')
    assert.ok((final.content[0] as any).signature)
    assert.equal((final.content[1] as any).text, '你好，世界')
    assert.equal(final.usage.input_tokens, 11)
    assert.equal(final.usage.output_tokens, 7)
    assert.equal(final.usage.cache_read_input_tokens, 3)
    assert.equal(final.usage.cache_creation_input_tokens, 2)
    const seen = fake.requests[0]
    assert.equal(seen.headers['anthropic-version'], '2026-10-21')
    assert.equal(seen.headers.authorization, 'Bearer test-key')
    assert.match(seen.path, /^\/v1\/messages/)
  })

  test('display omitted leaves thinking empty, updates makes it a status line', async () => {
    fake.enqueue({ reasoning: 'A note.', text: 'x' })
    const omitted = await claudeStream([say('hi')], { thinking: { type: 'adaptive' } }).finalMessage()
    assert.equal((omitted.content[0] as any).thinking, '')
    assert.ok((omitted.content[0] as any).signature)
  })

  test('one tool, parallel tools and a chained turn replay with preserved thinking', async () => {
    fake.enqueue(MATRIX.oneTool())
    const history: any[] = [say('read it')]
    const first = await claudeStream(history).finalMessage()
    assert.equal(first.stop_reason, 'tool_use')
    const tool = first.content.find((b: any) => b.type === 'tool_use') as any
    assert.deepEqual(tool.input, { collection: 'blog', slug: 'hello' })

    history.push({ role: 'assistant', content: first.content })
    history.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: tool.id, content: 'the post' }] })
    fake.enqueue(MATRIX.parallelTools())
    const second = await claudeStream(history).finalMessage()
    const calls = second.content.filter((b: any) => b.type === 'tool_use') as any[]
    assert.equal(calls.length, 2)

    history.push({ role: 'assistant', content: second.content })
    history.push({ role: 'user', content: calls.map((c) => ({ type: 'tool_result', tool_use_id: c.id, content: 'ok' })) })
    fake.enqueue({ text: 'Done.' })
    const third = await claudeStream(history).finalMessage()
    assert.equal(third.stop_reason, 'end_turn')
    assert.equal(fake.requests.every((r: any) => r.status === 200), true)
  })

  const refused = async (messages: unknown[], overrides: Record<string, unknown>, rule: string, cls: unknown = Anthropic.BadRequestError) => {
    await assert.rejects(
      () => claudeStream(messages, overrides).finalMessage(),
      (err: any) => {
        assert.ok(err instanceof (cls as any), `expected ${String((cls as any).name)}, got ${err?.constructor?.name}`)
        return true
      },
    )
    assert.equal(fake.requests.at(-1)?.rule, rule)
  }

  test('400 on temperature, top_p, top_k, budget_tokens, disabled thinking, tool_choice and prefill', async () => {
    await refused([say('x')], { temperature: 0.5 }, 'claude.sampling')
    await refused([say('x')], { top_p: 0.5 }, 'claude.sampling')
    await refused([say('x')], { top_k: 5 }, 'claude.sampling')
    await refused([say('x')], { thinking: { type: 'enabled', budget_tokens: 2000 } }, 'claude.budget_tokens')
    await refused([say('x')], { thinking: { type: 'disabled' } }, 'claude.thinking_disabled')
    await refused([say('x')], { tool_choice: { type: 'any' } }, 'claude.tool_choice')
    await refused([say('x'), { role: 'assistant', content: 'Sure, ' }], {}, 'claude.prefill')
  })

  test('400 on an unanswered tool call and on results split across messages', async () => {
    fake.enqueue(MATRIX.parallelTools())
    const first = await claudeStream([say('x')]).finalMessage()
    const [a, b] = first.content.filter((c: any) => c.type === 'tool_use') as any[]
    const assistant = { role: 'assistant', content: first.content }
    await refused([say('x'), assistant, say('and now?')], {}, 'claude.tool_unanswered')
    await refused(
      [
        say('x'),
        assistant,
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: a.id, content: 'one' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: b.id, content: 'two' }] },
      ],
      {},
      'claude.tool_unanswered',
    )
    await refused([say('x'), { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_unknown', content: 'x' }] }], {}, 'claude.tool_result_orphan')
  })

  async function conversation() {
    const history: any[] = [say('first')]
    fake.enqueue({ reasoning: 'Note one.', toolCalls: [{ id: 'toolu_a', name: 'get_content', args: { slug: 'a' } }] })
    const first = await claudeStream(history).finalMessage()
    history.push({ role: 'assistant', content: first.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'body' }] })
    return history
  }

  test('preserved thinking: any change to system, tools, an earlier message or the block is the documented 400', async () => {
    for (const [name, mutate] of [
      ['thinking text', (h: any[]) => (h[1].content[0].thinking = 'Edited.')],
      ['signature', (h: any[]) => (h[1].content[0].signature = 'forged')],
      ['earlier message', (h: any[]) => (h[0].content = 'first, edited')],
      ['same turn text', (h: any[]) => h[1].content.push({ type: 'text', text: 'added later' })],
    ] as [string, (h: any[]) => void][]) {
      const history = await conversation()
      mutate(history)
      await assert.rejects(() => claudeStream(history).finalMessage(), Anthropic.BadRequestError, name)
      assert.match(String(fake.requests.at(-1)?.rule), /^claude\.thinking_/, name)
    }
    let history = await conversation()
    await refused(history, { system: [{ type: 'text', text: 'Changed system.' }] }, 'claude.thinking_prefix')
    history = await conversation()
    await refused(history, { tools: [] }, 'claude.thinking_prefix')
    // Recovery of §7.2: strip the block and later thinking, and the turn goes through.
    history = await conversation()
    history[1].content = history[1].content.filter((b: any) => b.type !== 'thinking')
    fake.enqueue({ text: 'Recovered.' })
    assert.equal((await claudeStream(history).finalMessage()).stop_reason, 'end_turn')
  })

  test('a turn replayed unchanged passes, including a redacted thinking block', async () => {
    const history = await conversation()
    fake.enqueue(MATRIX.redactedThinking())
    const second = await claudeStream(history).finalMessage()
    assert.equal(second.content[0].type, 'redacted_thinking')
    history.push({ role: 'assistant', content: second.content }, say('again'))
    fake.enqueue({ text: 'Third.' })
    assert.equal((await claudeStream(history).finalMessage()).stop_reason, 'end_turn')
  })

  test('a model with a low output cap, a model refusing display updates, one refusing the tool schema, one without fallbacks', async () => {
    await refused([say('x')], { model: 'fake-claude-small', fallbacks: undefined, max_tokens: 64000 }, 'model.output_cap')
    await refused([say('x')], { model: 'fake-claude-no-updates', fallbacks: undefined }, 'claude.display_updates')
    await refused([say('x')], { model: 'claude-opus-5', fallbacks: 'default' }, 'claude.fallback_unsupported')
    await refused([say('x')], { betas: ['thinking-display-updates-2026-08-18'] }, 'claude.fallback_beta')
    await refused([say('x')], { betas: ['server-side-fallback-2026-07-01'] }, 'claude.display_beta')
    const refuser = await startFakeLlm({ models: [{ id: 'picky', refuseToolSchema: true }] })
    try {
      const client = new Anthropic({ apiKey: 'k', baseURL: refuser.origin, maxRetries: 0, logLevel: 'off' })
      await assert.rejects(() => client.beta.messages.stream({ ...CLAUDE_BASE, model: 'picky', fallbacks: undefined, messages: [say('x')] } as never).finalMessage(), Anthropic.BadRequestError)
      assert.equal(refuser.requests[0].rule, 'model.tool_schema')
    } finally {
      await refuser.close()
    }
  })

  test('fallback before output: message_start names the fallback model and iterations carry the attempts', async () => {
    fake.enqueue(MATRIX.claudeFallbackBefore())
    const final = await claudeStream([say('x')]).finalMessage()
    assert.equal(final.model, 'claude-opus-5')
    assert.equal(final.content[0].type, 'fallback')
    assert.deepEqual((final.content[0] as any).to, { model: 'claude-opus-5' })
    assert.equal((final.usage.iterations as any[]).at(-1).type, 'fallback_message')
  })

  test('fallback mid-output: only the documented edit is accepted on replay', async () => {
    fake.enqueue(MATRIX.claudeFallbackMid())
    const final = await claudeStream([say('x')]).finalMessage()
    const types = final.content.map((b: any) => b.type)
    assert.deepEqual(types, ['thinking', 'text', 'fallback', 'thinking', 'text'])
    // Echoed as produced: thinking before the boundary was not removed.
    const unchanged = [say('x'), { role: 'assistant', content: final.content }, say('next')]
    await refused(unchanged, {}, 'claude.thinking_block_changed')
    // The pure function's job: drop thinking before the final fallback block, echo the rest.
    const boundary = types.lastIndexOf('fallback')
    const edited = final.content.filter((b: any, i: number) => !(i < boundary && ['thinking', 'redacted_thinking', 'tool_use'].includes(b.type)))
    fake.enqueue({ text: 'Next turn.' })
    const next = await claudeStream([say('x'), { role: 'assistant', content: edited }, say('next')]).finalMessage()
    assert.equal(next.stop_reason, 'end_turn')
  })

  test('sentinel, pause_turn, model_context_window_exceeded, stop_sequence, max_tokens with a tool', async () => {
    fake.enqueue(MATRIX.claudeSentinel())
    const sentinel = await claudeStream([say('x')]).finalMessage()
    assert.equal((sentinel.content.at(-1) as any).text, INTERRUPTED_SENTINEL)
    assert.equal(sentinel.stop_reason, 'max_tokens')
    for (const [preset, stop] of [
      ['pauseTurn', 'pause_turn'],
      ['contextWindow', 'model_context_window_exceeded'],
      ['stopSequence', 'stop_sequence'],
    ]) {
      fake.enqueue({ preset })
      assert.equal((await claudeStream([say('x')]).finalMessage()).stop_reason, stop)
    }
    fake.enqueue(MATRIX.lengthWithTool())
    const cut = await claudeStream([say('x')]).finalMessage()
    assert.equal(cut.stop_reason, 'max_tokens')
    assert.equal(cut.content.at(-1)?.type, 'tool_use')
  })

  test('refusal is a 200: before output, and after output has started', async () => {
    fake.enqueue(MATRIX.refusalBeforeOutput())
    const before = await claudeStream([say('x')]).finalMessage()
    assert.equal(before.stop_reason, 'refusal')
    assert.deepEqual(before.content, [])
    assert.equal((before.stop_details as any).category, 'cyber')
    fake.enqueue(MATRIX.refusalMidStream())
    const mid = await claudeStream([say('x')]).finalMessage()
    assert.equal(mid.stop_reason, 'refusal')
    assert.equal((mid.content[0] as any).text, 'Started to answer ')
    assert.equal((mid.stop_details as any).category, null)
  })

  test('eager input: malformed JSON surfaces as the SDK error, truncated input as a tool_use with max_tokens', async () => {
    fake.enqueue(MATRIX.malformedEagerJson())
    await assert.rejects(
      async () => {
        const final = await claudeStream([say('x')]).finalMessage()
        return (final.content[0] as any).input // SDK 1.1.0 parses tool input lazily
      },
      (err: any) => {
        assert.equal(err instanceof Anthropic.APIError, false)
        return true
      },
    )
    fake.enqueue(MATRIX.truncatedEagerJson())
    const cut = await claudeStream([say('x')]).finalMessage()
    assert.equal(cut.stop_reason, 'max_tokens')
    assert.equal(cut.content[0].type, 'tool_use')
    assert.deepEqual((cut.content[0] as any).input, {}, 'the tolerant parser silently drops the cut field, as the design warns')
  })

  test('errors map to the typed classes the adapter catches, with Retry-After intact', async () => {
    fake.enqueue(MATRIX.rateLimited())
    await assert.rejects(
      () => claudeStream([say('x')]).finalMessage(),
      (err: any) => {
        assert.ok(err instanceof Anthropic.RateLimitError)
        assert.equal(err.headers.get('retry-after'), '7')
        return true
      },
    )
    fake.enqueue(MATRIX.unauthorized())
    await assert.rejects(() => claudeStream([say('x')]).finalMessage(), Anthropic.AuthenticationError)
    fake.enqueue(MATRIX.billing())
    await assert.rejects(() => claudeStream([say('x')]).finalMessage(), (err: any) => err.status === 402)
    fake.enqueue(MATRIX.overloaded())
    await assert.rejects(() => claudeStream([say('x')]).finalMessage(), (err: any) => err.status === 529)
  })

  test('abort reaches the server, and a stream that ends with no terminal event fails', async () => {
    fake.enqueue(MATRIX.abortMidText())
    const abort = new AbortController()
    const stream = claude().beta.messages.stream({ ...CLAUDE_BASE, messages: [say('x')] } as never, { signal: abort.signal })
    await new Promise<void>((resolve) => stream.once('text', () => resolve()))
    abort.abort()
    await assert.rejects(stream.finalMessage())
    await fake.settled()
    assert.equal(fake.requests.at(-1)?.aborted, true)

    fake.enqueue(MATRIX.eof())
    await assert.rejects(() => claudeStream([say('x')]).finalMessage())
  })

  test('the models list carries what §7.2 builds parameters from', async () => {
    const seen: any[] = []
    for await (const m of claude().beta.models.list()) seen.push(m)
    const opus = seen.find((m) => m.id === 'claude-opus-5-5')
    assert.equal(opus.max_tokens, 128000)
    assert.deepEqual(opus.allowed_fallback_models, ['claude-opus-5'])
    assert.equal(opus.capabilities.effort.supported, true)
    assert.equal(opus.capabilities.thinking.types.adaptive.supported, true)
    assert.deepEqual(seen.find((m) => m.id === 'fake-claude-no-updates').allowed_fallback_models, [])
    assert.equal(seen.some((m) => m.id === 'fake-model'), false)
  })
})

describe('Chat Completions wire', () => {
  const run = async (turn: any, dialect?: string, extra: Record<string, unknown> = {}, messages: unknown[] = [say('hi')]) => {
    fake.enqueue(turn)
    const res = await post(chatUrl(dialect), chatBody(messages, extra))
    assert.equal(res.status, 200)
    const sse = await readSse(res)
    return { ...sse, reduced: reduceChat(sse.events) }
  }

  test('text, usage in a chunk with no choices, and [DONE]', async () => {
    const { events, reduced } = await run(MATRIX.textChinese())
    assert.equal(reduced.content, '你好，这是测试模型的回复。')
    assert.equal(reduced.finish, 'stop')
    assert.equal(reduced.done, true)
    const usageChunk = events.map((e) => (e.data === '[DONE]' ? null : JSON.parse(e.data))).find((c) => c?.usage)
    assert.deepEqual(usageChunk.choices, [])
    assert.equal(reduced.usage.prompt_tokens > 0, true)
  })

  test('no usage unless asked for', async () => {
    fake.enqueue(MATRIX.text())
    const res = await post(chatUrl(), chatBody([say('hi')], { stream_options: undefined }))
    assert.equal(reduceChat((await readSse(res)).events).usage, null)
  })

  test('tool calls: fragments, parallel, whole call in one chunk, missing index, id "" and name null, arguments ""', async () => {
    const one = (await run(MATRIX.oneTool())).reduced
    assert.equal(one.finish, 'tool_calls')
    assert.deepEqual(JSON.parse(one.calls[0].args), { collection: 'blog', slug: 'hello' })
    assert.equal((await run(MATRIX.parallelTools())).reduced.calls.length, 2)

    const whole = await run(MATRIX.wholeCall())
    const frames = whole.events.filter((e) => e.data.includes('tool_calls') && e.data.includes('function'))
    assert.equal(frames.length, 1)
    assert.deepEqual(JSON.parse(whole.reduced.calls[0].args), { slug: 'whole' })

    const missing = (await run(MATRIX.missingIndex())).reduced
    assert.deepEqual(
      missing.calls.map((c) => JSON.parse(c.args).slug),
      ['a', 'b'],
    )

    const fragmentsRaw = await run(MATRIX.emptyIdNullName())
    assert.ok(fragmentsRaw.events.some((e) => e.data.includes('"id":""') && e.data.includes('"name":null')))
    assert.deepEqual(JSON.parse(fragmentsRaw.reduced.calls[0].args), { slug: 'fragments' })
    assert.ok(fragmentsRaw.reduced.calls[0].id.startsWith('call_'))

    assert.equal((await run(MATRIX.emptyArguments())).reduced.calls[0].args, '')
  })

  test('split at every byte, including inside UTF-8, and at every UTF-16 code unit in a delta', async () => {
    const bytes = await run(MATRIX.everyByte())
    assert.ok(bytes.chunks > 50, `${bytes.chunks} reads`)
    assert.equal(bytes.reduced.content, '逐字节流')
    assert.deepEqual(JSON.parse(bytes.reduced.calls[0].args), { title: '标题 🎉 title' })

    const units = await run(MATRIX.everyArgUnit())
    assert.deepEqual(JSON.parse(units.reduced.calls[0].args), { title: 'emoji 🎉' })
  })

  test('a cut at any chosen byte reaches the client as sent', async () => {
    fake.enqueue(MATRIX.textChinese())
    const res = await post(chatUrl(), chatBody([say('hi')]))
    const whole = Buffer.from(await res.arrayBuffer())
    const cut = whole.indexOf(Buffer.from('你')) + 1
    fake.enqueue({ ...MATRIX.textChinese(), chunking: { cutAt: [cut] } })
    const again = await readSse(await post(chatUrl(), chatBody([say('hi')])))
    assert.equal(reduceChat(again.events).content, '你好，这是测试模型的回复。')
  })

  test('comments, CRLF, no [DONE], list content and a leading <think>', async () => {
    const comments = await run(MATRIX.comments())
    assert.ok(comments.comments.includes('keep-alive'))
    assert.ok(comments.comments.includes('OPENROUTER PROCESSING'))
    assert.equal(comments.reduced.content, 'After comments.')

    assert.equal((await run(MATRIX.crlf())).reduced.content, 'Lines end in CRLF.')

    const noDone = (await run(MATRIX.noDone())).reduced
    assert.equal(noDone.done, false)
    assert.equal(noDone.finish, 'stop')

    const list = (await run(MATRIX.contentAsList())).reduced
    assert.equal((list.list[0] as any).type, 'thinking')
    assert.equal(list.content, 'Then plain text.')

    assert.equal((await run(MATRIX.leadingThink())).reduced.content, '<think>Thinking inline.</think>The visible answer.')
  })

  test('errors inside a 200, finish reasons, and a body cut off with no terminal event', async () => {
    const inBand = (await run(MATRIX.inBandError())).reduced
    assert.equal((inBand.errors[0] as any).message, 'Upstream provider failed.')
    assert.equal(inBand.finish, 'error')
    assert.equal((await run(MATRIX.inBandErrorMinimax())).reduced.errors.length, 1)

    const length = (await run(MATRIX.lengthWithTool())).reduced
    assert.equal(length.finish, 'length')
    assert.equal(length.calls.length, 1)
    assert.equal((await run(MATRIX.insufficientResources())).reduced.finish, 'insufficient_system_resource')
    assert.equal((await run(MATRIX.contentFilter())).reduced.finish, 'content_filter')

    const eof = (await run(MATRIX.eof())).reduced
    assert.equal(eof.finish, null)
    assert.equal(eof.done, false)
  })

  test('failures: 429 with Retry-After, 401, a provider-side 400 with failed_generation', async () => {
    fake.enqueue(MATRIX.rateLimited())
    const limited = await post(chatUrl(), chatBody([say('x')]))
    assert.equal(limited.status, 429)
    assert.equal(limited.headers.get('retry-after'), '7')

    const noKey = await fetch(chatUrl(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(chatBody([say('x')])) })
    assert.equal(noKey.status, 401)

    fake.enqueue(MATRIX.groqFailedGeneration())
    const failed = await post(chatUrl('groq'), chatBody([say('x')]))
    assert.equal(failed.status, 400)
    assert.equal((await failed.json()).error.code, 'tool_use_failed')
  })

  test('idle: bytes stop and the socket stays open until the client gives up; a lost connection errors', async () => {
    fake.enqueue(MATRIX.idle())
    const abort = new AbortController()
    const res = await fetch(chatUrl(), { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer k' }, body: JSON.stringify(chatBody([say('x')])), signal: abort.signal })
    const reader = res.body!.getReader()
    await reader.read()
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(fake.requests.at(-1)?.completed, false)
    abort.abort()
    await assert.rejects(reader.read())
    await fake.settled()
    assert.equal(fake.requests.at(-1)?.aborted, true)

    fake.enqueue(MATRIX.connectionLost())
    const lost = await post(chatUrl(), chatBody([say('x')]))
    await assert.rejects(readSse(lost))
  })

  test('abort mid-text and mid-tool reach the server', async () => {
    for (const preset of ['abortMidText', 'abortMidTool']) {
      fake.enqueue({ preset })
      const abort = new AbortController()
      const res = await fetch(chatUrl(), { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer k' }, body: JSON.stringify(chatBody([say('x')])), signal: abort.signal })
      const reader = res.body!.getReader()
      await reader.read()
      abort.abort()
      await assert.rejects(reader.read())
      await fake.settled()
      assert.equal(fake.requests.at(-1)?.aborted, true, preset)
    }
  })

  const refused = async (dialect: string | undefined, body: any, rule: string, status = 400) => {
    const res = await post(chatUrl(dialect), body)
    assert.equal(res.status, status, `${rule}: ${res.status}`)
    assert.equal(res.headers.get('x-fake-rule'), rule)
  }
  const tools = [{ type: 'function', function: { name: 'get_content', description: 'Read', parameters: { type: 'object', properties: {} } } }]

  test('any wire: an unanswered tool call, a result split from its call, an orphan result', async () => {
    const assistant = { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }, { id: 'c2', type: 'function', function: { name: 'y', arguments: '{}' } }] }
    await refused(undefined, chatBody([say('a'), assistant]), 'chat.tool_unanswered')
    await refused(undefined, chatBody([say('a'), assistant, { role: 'tool', tool_call_id: 'c1', content: 'one' }, say('b'), { role: 'tool', tool_call_id: 'c2', content: 'two' }]), 'chat.tool_unanswered')
    await refused(undefined, chatBody([say('a'), { role: 'tool', tool_call_id: 'zz', content: 'x' }]), 'chat.tool_result_orphan')
    const ok = await post(chatUrl(), chatBody([say('a'), ...toolAnswered(assistant, [{ id: 'c1', text: 'one' }, { id: 'c2', text: 'two' }])]))
    assert.equal(ok.status, 200)
    await readSse(ok)
  })

  test('a low output cap answers 400 on a larger max_tokens, and a provider refuses a tool schema', async () => {
    await refused(undefined, chatBody([say('a')], { model: 'fake-small-output', max_tokens: 64000 }), 'model.output_cap')
    await refused(undefined, chatBody([say('a')], { model: 'fake-small-output', max_completion_tokens: 64000 }), 'model.output_cap')
    const fine = await post(chatUrl(), chatBody([say('a')], { model: 'fake-small-output', max_tokens: 8000 }))
    assert.equal(fine.status, 200)
    await readSse(fine)
    await refused(undefined, chatBody([say('a')], { model: 'fake-schema-refuser', tools }), 'model.tool_schema')
  })

  test('DeepSeek: reasoning_content must come back, on every assistant turn, while tools are offered', async () => {
    const body = (messages: unknown[]) => chatBody(messages, { tools })
    const first = await run({ toolCalls: [{ id: 'c1', name: 'get_content', args: {} }] }, 'deepseek', { tools })
    const reasoning = first.reduced.reasoning.reasoning_content
    assert.ok(reasoning)
    assert.ok(first.comments.includes('keep-alive'))
    const call = { id: 'c1', type: 'function', function: { name: 'get_content', arguments: '{}' } }
    await refused('deepseek', body([say('a'), { role: 'assistant', content: null, tool_calls: [call] }, { role: 'tool', tool_call_id: 'c1', content: 'x' }]), 'deepseek.reasoning_content')
    const good = await post(chatUrl('deepseek'), body([say('a'), { role: 'assistant', content: null, reasoning_content: reasoning, tool_calls: [call] }, { role: 'tool', tool_call_id: 'c1', content: 'x' }]))
    assert.equal(good.status, 200)
    await readSse(good)
    await refused('deepseek', chatBody([say('a')], { tool_choice: 'required' }), 'deepseek.tool_choice')
    await refused('deepseek', { model: 'm', messages: [say('a')], stream_options: { include_usage: true } }, 'deepseek.stream_options')
  })

  test('Gemini: the thought signature must come back; index is absent and the call whole', async () => {
    const first = await run({ toolCalls: [{ id: 'c1', name: 'get_content', args: { slug: 's' } }] }, 'gemini', { tools })
    const slot = first.reduced.calls[0]
    assert.ok(slot.extra.google.thought_signature)
    const raw = first.events.map((e) => e.data).find((d) => d.includes('tool_calls'))!
    assert.equal(JSON.parse(raw).choices[0].delta.tool_calls[0].index, undefined)

    const call = (extra: unknown) => ({ id: 'c1', type: 'function', function: { name: 'get_content', arguments: slot.args }, ...(extra ? { extra_content: extra } : {}) })
    const messages = (c: unknown) => [say('a'), { role: 'assistant', content: null, tool_calls: [c] }, { role: 'tool', tool_call_id: 'c1', content: 'x' }]
    await refused('gemini', chatBody(messages(call(null)), { tools }), 'gemini.thought_signature')
    await refused('gemini', chatBody(messages(call({ google: { thought_signature: 'forged' } })), { tools }), 'gemini.thought_signature')
    const good = await post(chatUrl('gemini'), chatBody(messages(call(slot.extra)), { tools }))
    assert.equal(good.status, 200)
    await readSse(good)
  })

  test('Groq, Kimi, GLM, MiniMax, Mistral, Alibaba refuse what their documents say they refuse', async () => {
    await refused('groq', chatBody([say('a'), { role: 'assistant', content: 'b' }, { role: 'user', name: 'someone', content: 'c' }]), 'groq.messages.name')
    await refused('groq', chatBody([say('a')], { logprobs: true }), 'groq.param')
    await refused('groq', chatBody([say('a')], { n: 2 }), 'groq.n')
    await refused('groq', chatBody([say('a')], { reasoning_format: 'raw', tools }), 'groq.reasoning_format')
    await refused('kimi', chatBody([say('a')], { temperature: 0.2 }), 'kimi.fixed_param')
    await refused('glm', chatBody([say('a')], { tool_choice: 'required' }), 'tool_choice.auto_only')
    await refused('minimax', chatBody([say('a')], { tool_choice: { type: 'function', function: { name: 'x' } } }), 'tool_choice.auto_only')
    await refused('mistral', chatBody([say('a')], { tool_choice: 'required' }), 'mistral.tool_choice')
    await refused('alibaba', chatBody([say('a'), { role: 'system', content: 'late' }]), 'alibaba.system')
    await refused('alibaba', chatBody([say('a'), { role: 'assistant', content: null }, say('b')]), 'alibaba.null_content')
  })

  test('dialect shapes: Groq usage under x_groq, Ollama whole with reasoning and no usage and no key, GLM whole without tool_stream', async () => {
    assert.equal((await run(MATRIX.text(), 'groq')).reduced.usage.completion_tokens > 0, true)

    fake.enqueue({ reasoning: 'Local thought.', toolCalls: [{ name: 'get_content', args: { slug: 'o' } }] })
    const noKey = await fetch(chatUrl('ollama'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(chatBody([say('a')])) })
    assert.equal(noKey.status, 200)
    const ollama = await readSse(noKey)
    const reduced = reduceChat(ollama.events)
    assert.equal(reduced.reasoning.reasoning, 'Local thought.')
    assert.equal(reduced.usage, null)
    assert.equal(ollama.events.filter((e) => e.data.includes('tool_calls') && e.data.includes('function')).length, 1)

    const glmWhole = await run({ toolCalls: [{ name: 'get_content', args: { slug: 'g' } }] }, 'glm')
    assert.equal(glmWhole.events.filter((e) => e.data.includes('tool_calls') && e.data.includes('function')).length, 1)
    const glmStream = await run({ toolCalls: [{ name: 'get_content', args: { slug: 'g' } }] }, 'glm', { tool_stream: true })
    assert.ok(glmStream.events.filter((e) => e.data.includes('tool_calls') && e.data.includes('function')).length > 1)
  })

  test('without stream the wire answers one JSON document', async () => {
    fake.enqueue(MATRIX.oneTool())
    const res = await post(chatUrl(), { model: 'fake-model', messages: [say('a')] })
    const body = await res.json()
    assert.equal(body.object, 'chat.completion')
    assert.equal(body.choices[0].finish_reason, 'tool_calls')
    assert.equal(body.choices[0].message.tool_calls[0].function.name, 'get_content')
  })
})

describe('Responses wire', () => {
  const body = (input: unknown, extra: Record<string, unknown> = {}) => ({ model: 'fake-model', stream: true, store: false, instructions: 'System.', input, ...extra })
  const run = async (turn: any, dialect?: string, extra: Record<string, unknown> = {}, input: unknown = [say('hi')]) => {
    fake.enqueue(turn)
    const res = await post(responsesUrl(dialect), body(input, extra))
    assert.equal(res.status, 200)
    const sse = await readSse(res)
    const parsed = sse.events.map((e) => ({ type: e.event, ...JSON.parse(e.data) }))
    return { ...sse, parsed, types: parsed.map((p) => p.type), last: parsed.at(-1) }
  }

  test('text: every event in order, sequence numbers rising, a completed response with usage', async () => {
    const { types, parsed, last } = await run({ reasoning: null, text: '你好', usage: { input: 9, output: 3, cachedRead: 2 } })
    assert.deepEqual(types.slice(0, 4), ['response.created', 'response.in_progress', 'response.output_item.added', 'response.content_part.added'])
    assert.ok(types.includes('response.output_text.delta'))
    assert.equal(last.type, 'response.completed')
    assert.deepEqual(
      parsed.map((p) => p.sequence_number),
      parsed.map((_, i) => i),
    )
    assert.equal(last.response.usage.input_tokens, 11)
    assert.equal(last.response.usage.input_tokens_details.cached_tokens, 2)
    assert.equal(last.response.output[0].content[0].text, '你好')
  })

  test('function calls: deltas keyed by output_index, done authoritative; xAI and OpenRouter deliver args only at done', async () => {
    const { parsed } = await run({ reasoning: null, ...MATRIX.parallelTools() })
    const deltas = parsed.filter((p) => p.type === 'response.function_call_arguments.delta')
    assert.ok(deltas.length > 1)
    const added = parsed.filter((p) => p.type === 'response.output_item.added')
    assert.equal(added.length, 2)
    assert.ok(added[0].item.call_id)
    const done = parsed.filter((p) => p.type === 'response.output_item.done')
    assert.deepEqual(JSON.parse(done[0].item.arguments), { slug: 'a' })

    for (const dialect of ['xai', 'openrouter']) {
      const r = await run({ reasoning: null, ...MATRIX.oneTool() }, dialect)
      assert.equal(r.types.includes('response.function_call_arguments.delta'), false, dialect)
      assert.deepEqual(JSON.parse(r.parsed.find((p) => p.type === 'response.output_item.done').item.arguments), { collection: 'blog', slug: 'hello' })
    }
    assert.ok((await run(MATRIX.text(), 'openrouter')).comments.includes('OPENROUTER PROCESSING'))
  })

  test('replay: reasoning must precede its call with the same encrypted content; unanswered calls refuse', async () => {
    const first = await run({ reasoning: 'Thought.', toolCalls: [{ id: 'c1', name: 'get_content', args: {} }] })
    const output = first.last.response.output
    const reasoningItem = output.find((i: any) => i.type === 'reasoning')
    assert.ok(reasoningItem.encrypted_content)
    const call = output.find((i: any) => i.type === 'function_call')
    const result = { type: 'function_call_output', call_id: 'c1', output: 'x' }

    const send = (input: unknown) => post(responsesUrl(), body(input))
    let res = await send([say('hi'), call, result])
    assert.equal(res.status, 400)
    assert.equal(res.headers.get('x-fake-rule'), 'responses.reasoning_missing')

    res = await send([say('hi'), { ...reasoningItem, encrypted_content: 'changed' }, call, result])
    assert.equal(res.headers.get('x-fake-rule'), 'responses.reasoning_changed')

    res = await send([say('hi'), ...output])
    assert.equal(res.headers.get('x-fake-rule'), 'responses.tool_unanswered')

    res = await send([say('hi'), ...output, say('next'), result])
    assert.equal(res.headers.get('x-fake-rule'), 'responses.tool_unanswered')

    res = await send([say('hi'), { type: 'function_call_output', call_id: 'zz', output: 'x' }])
    assert.equal(res.headers.get('x-fake-rule'), 'responses.output_orphan')

    res = await post(responsesUrl(), body([say('hi')], { previous_response_id: 'resp_1' }))
    assert.equal(res.headers.get('x-fake-rule'), 'responses.previous_response_id')

    fake.enqueue({ reasoning: null, text: 'Replayed.' })
    res = await send([say('hi'), ...output, result])
    assert.equal(res.status, 200)
    await readSse(res)
  })

  test('terminal events: incomplete, failed and error at HTTP 200, refusal', async () => {
    const incomplete = await run({ reasoning: null, ...MATRIX.responsesIncomplete() })
    assert.equal(incomplete.last.type, 'response.incomplete')
    assert.equal(incomplete.last.response.incomplete_details.reason, 'max_output_tokens')

    const failed = await run({ reasoning: null, ...MATRIX.responsesFailed() }, 'openrouter')
    assert.equal(failed.last.type, 'response.failed')
    assert.equal(failed.last.response.error.message, 'The model failed.')

    const errored = await run({ reasoning: null, ...MATRIX.responsesErrorEvent() }, 'openrouter')
    assert.equal(errored.last.type, 'error')

    const refusal = await run({ reasoning: null, ...MATRIX.responsesRefusal() })
    assert.ok(refusal.types.includes('response.refusal.delta'))
    assert.equal(refusal.last.response.output[0].content[0].refusal, 'I cannot help with that.')

    const eof = await run({ reasoning: null, ...MATRIX.eof() })
    assert.notEqual(eof.last.type, 'response.completed')
  })

  test('xAI encrypts only on request and reports cost in ticks; Groq refuses store and include', async () => {
    const without = await run({ reasoning: 'T.', text: 'x' }, 'xai')
    assert.equal(without.last.response.output[0].encrypted_content, undefined)
    const withIt = await run({ reasoning: 'T.', text: 'x', usage: { costTicks: 1234 } }, 'xai', { include: ['reasoning.encrypted_content'] })
    assert.ok(withIt.last.response.output[0].encrypted_content)
    assert.equal(withIt.last.response.usage.cost_in_usd_ticks, 1234)

    let res = await post(responsesUrl('groq-responses'), body([say('a')]))
    assert.equal(res.headers.get('x-fake-rule'), 'groq.responses_param')
    res = await post(responsesUrl('xai'), body([say('a')], { stop: ['x'] }))
    assert.equal(res.headers.get('x-fake-rule'), 'xai.param')
    res = await post(responsesUrl(), body([say('a')], { reasoning: { effort: 'high' }, temperature: 0.1 }))
    assert.equal(res.headers.get('x-fake-rule'), 'openai.sampling')
    assert.equal(res.headers.get('x-fake-source'), SOURCES.openaiReasoning.url, 'a refusal names where it is documented')
    res = await post(responsesUrl(), body([say('a')], { model: 'fake-small-output', max_output_tokens: 64000 }))
    assert.equal(res.headers.get('x-fake-rule'), 'model.output_cap')
    res = await post(responsesUrl(), body([say('a')], { model: 'fake-schema-refuser', tools: [{ type: 'function', name: 'get_content', parameters: { type: 'object' } }] }))
    assert.equal(res.headers.get('x-fake-rule'), 'model.tool_schema')
  })
})

describe('model list', () => {
  const list = async (dialect?: string, query = '') => {
    const res = await fetch(`${fake.baseUrl(dialect)}/models${query}`, { headers: { authorization: 'Bearer k' } })
    return { res, body: res.status === 200 ? await res.json() : null }
  }

  test('OpenAI shape, no capabilities, no Claude models; OpenRouter filters by tool support', async () => {
    const { body } = await list()
    assert.equal(body.object, 'list')
    assert.deepEqual(Object.keys(body.data[0]).sort(), ['created', 'id', 'object', 'owned_by'])
    assert.equal(body.data.some((m: any) => m.id.startsWith('claude')), false)
    assert.ok(body.data.some((m: any) => m.id === 'fake-no-tools'))

    const filtered = (await list('openrouter', '?supported_parameters=tools')).body
    assert.equal(filtered.data.some((m: any) => m.id === 'fake-no-tools'), false)
  })

  test('a scripted 404 is tolerated by a caller, and a 302 is a redirect an auth header must not follow', async () => {
    fake.enqueueModels({ status: 404, body: { error: { message: 'Not here.' } } })
    assert.equal((await list()).res.status, 404)

    fake.enqueueModels({ status: 302 })
    const res = await fetch(`${fake.baseUrl()}/models`, { headers: { authorization: 'Bearer k' }, redirect: 'manual' })
    assert.equal(res.status, 302)
    assert.equal(fake.collected.length, 0)
    await fetch(res.headers.get('location')!)
    assert.equal(fake.collected[0].hadAuthorization, false)
  })
})

describe('scripted replies, what --fake-model answers', () => {
  const chat = async (text: string, tools: string[] = []) => {
    const res = await post(chatUrl(), chatBody([say(text)], { tools: tools.map((name) => ({ type: 'function', function: { name, parameters: { type: 'object' } } })) }))
    return reduceChat((await readSse(res)).events)
  }

  test('says it is scripted, and no model ran', async () => {
    const reply = await chat('Draft me a post')
    assert.match(reply.content, /^Test model \(scripted\): no model ran/)
  })

  test('/say answers in any language, /tool calls tools, probe_echo answers like Test expects', async () => {
    assert.equal((await chat('<site_facts>x</site_facts>\n/say 用中文回复')).content, '用中文回复')

    const tools = await chat('/tool get_content {"slug":"a"}\n/tool list_content {"collection":"work"}')
    assert.deepEqual(
      tools.calls.map((c) => [c.name, JSON.parse(c.args)]),
      [
        ['get_content', { slug: 'a' }],
        ['list_content', { collection: 'work' }],
      ],
    )

    const probe = await chat('Call probe_echo with {"value":"ok"}', ['probe_echo', 'get_content'])
    assert.equal(probe.calls[0].name, 'probe_echo')
    assert.deepEqual(JSON.parse(probe.calls[0].args), { value: 'ok' })
    assert.match((await chat('Call probe_echo with {"value":"ok"}')).content, /no model ran/)
  })

  test('the turn after a tool result ends the run, on all three wires', async () => {
    const assistant = { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }] }
    const chatRes = await post(chatUrl(), chatBody([say('a'), assistant, { role: 'tool', tool_call_id: 'c1', content: 'r' }]))
    assert.match(reduceChat((await readSse(chatRes)).events).content, /the tool call finished/)

    const responses = await post(responsesUrl(), { model: 'm', stream: true, input: [say('/tool x {}')] })
    const parsed = (await readSse(responses)).events.map((e) => JSON.parse(e.data))
    const output = parsed.at(-1).response.output
    const again = await post(responsesUrl(), { model: 'm', stream: true, input: [say('/tool x {}'), ...output, { type: 'function_call_output', call_id: output.at(-1).call_id, output: 'r' }] })
    assert.equal(again.status, 200)
    assert.match(JSON.stringify((await readSse(again)).events.at(-1)), /the tool call finished/)

    const first = await claudeStream([say('/tool get_content {"slug":"z"}')]).finalMessage()
    const use = first.content.find((b: any) => b.type === 'tool_use') as any
    assert.deepEqual(use.input, { slug: 'z' })
    const next = await claudeStream([say('/tool get_content {"slug":"z"}'), { role: 'assistant', content: first.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: use.id, content: 'r' }] }]).finalMessage()
    assert.match((next.content.at(-1) as any).text, /the tool call finished/)
  })

  test('/hostile points at the collector, which records whoever fetches', async () => {
    const reply = await chat('/hostile')
    assert.equal(reply.content, hostileMarkdown(fake.origin))
    assert.match(reply.content, /!\[pixel\]/)
    assert.match(reply.content, /<img src=/)
    assert.equal(fake.collected.length, 0)
    await fetch(`${fake.origin}/__fake/collect/inline.png?d=secret`)
    assert.equal(fake.collected.length, 1)
    assert.match(fake.collected[0].path, /inline\.png/)
  })

  test('/slow streams slowly enough to press Stop', async () => {
    const res = await post(chatUrl(), chatBody([say('/slow one two')]))
    const reader = res.body!.getReader()
    const start = Date.now()
    await reader.read()
    await reader.read()
    await reader.read()
    assert.ok(Date.now() - start >= 100, 'at least one delay between frames')
    await reader.cancel()
    await fake.settled()
    assert.equal(fake.requests.at(-1)?.aborted, true)
  })
})

describe('the server itself', () => {
  test('binds to loopback only and refuses a foreign Host header, so a page cannot reach it through DNS rebinding', async () => {
    assert.match(fake.origin, /^http:\/\/127\.0\.0\.1:\d+$/)
    const res = await new Promise<number>((resolve, reject) => {
      import('node:http').then(({ default: http }) => {
        http
          .request({ host: '127.0.0.1', port: fake.port, path: '/v1/models', headers: { host: 'evil.example', authorization: 'Bearer k' } }, (r) => {
            r.resume()
            resolve(r.statusCode ?? 0)
          })
          .on('error', reject)
          .end()
      })
    })
    assert.equal(res, 403)
  })

  test('a fixed key: the right one passes, a wrong one answers 401 in the wire shape', async () => {
    const strict = await startFakeLlm({ apiKey: 'exact-key' })
    try {
      const wrong = await fetch(`${strict.baseUrl()}/models`, { headers: { authorization: 'Bearer nope' } })
      assert.equal(wrong.status, 401)
      assert.ok((await wrong.json()).error.message)
      const client = new Anthropic({ apiKey: 'nope', baseURL: strict.origin, maxRetries: 0, logLevel: 'off' })
      await assert.rejects(() => client.beta.models.list(), Anthropic.AuthenticationError)
      const right = await fetch(`${strict.baseUrl()}/models`, { headers: { authorization: 'Bearer exact-key' } })
      assert.equal(right.status, 200)
    } finally {
      await strict.close()
    }
  })

  test('strict models refuses an unknown id; by default free text works', async () => {
    const strict = await startFakeLlm({ strictModels: true })
    try {
      const res = await fetch(`${strict.baseUrl()}/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer k', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'nobody', messages: [say('a')] }) })
      assert.equal(res.status, 404)
    } finally {
      await strict.close()
    }
    const res = await post(chatUrl(), { model: 'nobody', messages: [say('a')] })
    assert.equal(res.status, 200)
  })

  test('another process scripts it through /__fake: enqueue by preset, read requests, reset', async () => {
    const control = (p: string, body: unknown) => fetch(`${fake.origin}/__fake${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    assert.equal((await control('/enqueue', { turns: [{ preset: 'textChinese' }, { text: 'Second.' }] })).status, 200)
    assert.equal((await control('/enqueue', { turns: [{ preset: 'nonsense' }] })).status, 400)
    const first = reduceChat((await readSse(await post(chatUrl(), chatBody([say('a')])))).events)
    assert.equal(first.content, '你好，这是测试模型的回复。')
    const second = reduceChat((await readSse(await post(chatUrl(), chatBody([say('a')])))).events)
    assert.equal(second.content, 'Second.')

    await control('/models', { status: 404, body: { error: { message: 'gone' } } })
    assert.equal((await fetch(`${fake.baseUrl()}/models`, { headers: { authorization: 'Bearer k' } })).status, 404)

    const log = await (await fetch(`${fake.origin}/__fake/requests`)).json()
    assert.equal(log.requests.length, 3)
    await control('/reset', {})
    assert.equal(((await (await fetch(`${fake.origin}/__fake/requests`)).json()) as any).requests.length, 0)
    assert.equal(((await (await fetch(`${fake.origin}/__fake/health`)).json()) as any).ok, true)
  })

  /** A raw request, so Origin and Content-Type are exactly what a browser page would send. */
  async function raw(method: string, pathAndQuery: string, headers: Record<string, string>, body = '') {
    const { default: http } = await import('node:http')
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: fake.port, method, path: pathAndQuery, headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) } }, (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (text += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }))
      })
      req.on('error', reject)
      req.end(body)
    })
  }

  test('a page in a browser cannot script the next turn: a foreign Origin or a non-JSON control POST is refused', async () => {
    const turn = JSON.stringify({ turns: [{ toolCalls: [{ name: 'delete_item', args: { id: 'x' } }] }] })
    // What a page on another origin can send without a preflight: text/plain, its own Origin.
    for (const origin of ['https://evil.example', 'null', `http://127.0.0.1:${fake.port + 1}`, `https://127.0.0.1:${fake.port}`]) {
      for (const type of ['text/plain', 'application/json']) {
        for (const action of ['/enqueue', '/models', '/reset']) {
          const res = await raw('POST', `/__fake${action}`, { origin, 'content-type': type }, turn)
          assert.equal(res.status, 403, `${action} ${origin} ${type}`)
        }
      }
      for (const action of ['/requests', '/collected', '/health']) assert.equal((await raw('GET', `/__fake${action}`, { origin })).status, 403, `${action} ${origin}`)
    }
    // No Origin but not JSON (a form or a bare curl -d): refused too.
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      assert.equal((await raw('POST', '/__fake/enqueue', { 'content-type': type }, turn)).status, 415, type)
    }
    assert.equal((await raw('POST', '/__fake/reset', {})).status, 415, 'no content type')
    assert.equal(fake.pending(), 0, 'nothing was queued')

    // So the next completion is the scripted one, not the tool call.
    const reply = await (await post(chatUrl(), { model: 'fake-model', messages: [say('a')] })).json()
    assert.equal(reply.choices[0].message.tool_calls, undefined)
    assert.match(reply.choices[0].message.content, /Test model \(scripted\)/)
  })

  test('its own origin and a local process still script it, and the collector stays open to anyone', async () => {
    for (const origin of [`http://127.0.0.1:${fake.port}`, `http://localhost:${fake.port}`, undefined]) {
      const res = await raw('POST', '/__fake/enqueue', { 'content-type': 'application/json; charset=utf-8', ...(origin ? { origin } : {}) }, JSON.stringify({ turns: [{ text: 'Queued.' }] }))
      assert.equal(res.status, 200, String(origin))
    }
    assert.equal(fake.pending(), 3)

    const image = await raw('GET', '/__fake/collect/pixel.png?d=1', { origin: 'https://evil.example' })
    assert.equal(image.status, 200)
    assert.equal(fake.collected.length, 1)
    // The log of what was collected answers as JSON, not as one more collected image.
    const collected = await raw('GET', '/__fake/collected', {})
    assert.equal(collected.status, 200)
    assert.equal(JSON.parse(collected.body).collected.length, 1)
    assert.equal(fake.collected.length, 1)
  })

  test('runs from the command line, prints only its address, stops on SIGTERM', async () => {
    const script = path.join(process.cwd(), 'tests', 'helpers', 'fake-llm.mjs')
    const child = spawn(process.execPath, [script, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const ready = new Promise<string>((resolve, reject) => {
      child.stdout.on('data', (d) => {
        out += d
        const m = out.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/)
        if (m) resolve(m[1])
      })
      child.once('exit', () => reject(new Error(`exited early: ${out}`)))
    })
    const origin = await ready
    const res = await fetch(`${origin}/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer SENTINEL-KEY', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'fake-model', messages: [say('SENTINEL-PROMPT')] }) })
    assert.equal(res.status, 200)
    const exit = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))
    child.kill('SIGTERM')
    assert.equal(await exit, 0)
    assert.doesNotMatch(out, /SENTINEL/, 'it logs no prompt and no key')
  })

  test('it cannot ship: nothing in the product imports it, and tests/ is outside the image', () => {
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name)
        if (e.name === 'node_modules' || e.name.startsWith('.')) return []
        return e.isDirectory() ? walk(p) : /\.(ts|tsx|js|mjs)$/.test(e.name) ? [p] : []
      })
    const root = process.cwd()
    for (const dir of ['lib', 'pages', 'components', 'layout', 'theme']) {
      for (const file of walk(path.join(root, dir))) {
        assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /fake-llm|helpers\/realRoute/, path.relative(root, file))
      }
    }
    for (const file of ['proxy.ts', 'instrumentation.ts', 'next.config.js']) {
      assert.doesNotMatch(fs.readFileSync(path.join(root, file), 'utf8'), /fake-llm/, file)
    }
    const dockerignore = fs.readFileSync(path.join(root, '.dockerignore'), 'utf8')
    assert.match(dockerignore, /^tests\/\*$/m)
    assert.match(dockerignore, /^!tests\/register\.mjs$/m)
  })

  test('every dialect names a source for what it refuses; the source table is complete', () => {
    for (const source of Object.values(SOURCES) as { url: string; date: string }[]) {
      assert.ok(source.url)
      assert.match(source.date, /^\d{4}-\d{2}-\d{2}$/)
    }
    assert.deepEqual(Object.keys(DIALECTS).sort(), ['alibaba', 'deepseek', 'gemini', 'glm', 'groq', 'groq-responses', 'kimi', 'lmstudio', 'minimax', 'mistral', 'ollama', 'openai', 'openrouter', 'xai'])
  })

  test('close() ends a hanging stream', async () => {
    const own = await startFakeLlm()
    own.enqueue(MATRIX.idle())
    const res = await fetch(`${own.baseUrl()}/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer k', 'content-type': 'application/json' }, body: JSON.stringify(chatBody([say('x')])) })
    await res.body!.getReader().read()
    await own.close()
    await assert.rejects(fetch(`${own.baseUrl()}/models`))
  })
})
