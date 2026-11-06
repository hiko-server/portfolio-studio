/**
 * M4 — Claude in the agent loop and in Test (design §7.2, §7.7), through the
 * real SDK against tests/helpers/fake-llm.mjs (strict preserved-thinking
 * history): the request profile frozen from the Models API and the probe's
 * accepted display; the turn cut inside a tool call retried once with the
 * model's whole cap; unparseable eager JSON re-issued; a refused thinking
 * block dropped once and logged as a bug; pause_turn re-sent; the context
 * window; the sentinel. And the sentinel-key sweep: the key is in no
 * answer, log line, ai.db byte or auth.db byte (§13 security check 18).
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { MATRIX } from './helpers/fake-llm.mjs'
import { assistantHarness, TEST_KEY } from './helpers/assistantHarness'

const A = assistantHarness('ai-loop-claude')
const CLAUDE_KEY = 'sk-ant-sentinel-SENTINELKEY-0123456789'
let runs: typeof import('../lib/ai/runs')
let conversations: typeof import('../lib/ai/conversations')
let keys: typeof import('../lib/ai/providers/keys')
let factory: typeof import('../lib/ai/providers/factory')
let bus: typeof import('../lib/ai/bus')
let claudeId = ''
const lines: string[] = []
const saved = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug }

before(async () => {
  await A.setup()
  runs = await import('../lib/ai/runs')
  conversations = await import('../lib/ai/conversations')
  keys = await import('../lib/ai/providers/keys')
  factory = await import('../lib/ai/providers/factory')
  bus = await import('../lib/ai/bus')
  const target = keys.resolveTarget({ preset: 'claude' })
  assert.ok(target.ok)
  const made = keys.addProvider({ target: target.target, label: 'Claude', apiKey: CLAUDE_KEY, defaultModel: 'claude-opus-5-5', effort: 'medium', ownerQuirks: {} })
  assert.ok(made.ok)
  claudeId = made.row.id
  // Everything the process prints from here on is checked for the key at the end.
  for (const k of ['log', 'error', 'warn', 'info', 'debug'] as const) console[k] = (...args: unknown[]) => void lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
})
after(async () => {
  Object.assign(console, saved)
  await A.teardown()
})
beforeEach(() => A.fake.reset())

/** The production factory, with the one parameter only tests set: Claude's base URL. */
const adapter = (spec: Parameters<typeof factory.createAdapter>[0]) => factory.createAdapter({ ...spec, anthropicBaseURL: A.fake.origin })

type Ev = { seq: number; type: string; data: Record<string, any> }
async function run(input: Partial<import('../lib/ai/runs').StartInput>) {
  const started = await runs.startRun({ session: A.session(), providerId: claudeId, message: 'Hello', ...input }, { adapter })
  assert.ok(started.ok, JSON.stringify(started))
  const events: Ev[] = []
  const sub = bus.subscribe(started.run.id, 0, (e) => void events.push(e as Ev))!
  events.push(...(sub.replay as Ev[]))
  await started.run.done
  sub.stop()
  return { started, events, end: events.find((e) => e.type === 'run_end')! }
}

test('Test on Claude: the whole catalogue with eager streaming, display "updates" accepted or not, recorded with the Models API capabilities', async () => {
  const { probeProvider } = await import('../lib/ai/providers/probe')
  const row = keys.getProvider(claudeId)!
  const a = adapter({ wire: 'anthropic', baseUrl: row.baseUrl, apiKey: CLAUDE_KEY, quirks: keys.quirksOf(row) })
  const ready = await probeProvider({ adapter: a, wire: 'anthropic', model: 'claude-opus-5-5', tools: runs.assistantTools(), effort: 'medium', maxOutputTokens: null, signal: AbortSignal.timeout(30_000), providerId: claudeId })
  assert.equal(ready.status, 'ready', JSON.stringify(ready))
  assert.equal(ready.display, 'updates')
  assert.deepEqual(ready.claude, { effort: true, adaptiveThinking: true, fallbacks: true, maxOutputTokens: 128000 })
  assert.equal(ready.observations.reasoningSeen, true)
  keys.recordTest(claudeId, 'claude-opus-5-5', ready)

  A.fake.reset()
  const noUpdates = await probeProvider({ adapter: a, wire: 'anthropic', model: 'fake-claude-no-updates', tools: runs.assistantTools(), effort: 'medium', maxOutputTokens: null, signal: AbortSignal.timeout(30_000), providerId: claudeId })
  assert.equal(noUpdates.status, 'ready')
  assert.equal(noUpdates.display, 'omitted', 'a 400 on updates falls back to omitted, recorded')
  assert.ok(noUpdates.steps.some((s) => s.step === 'display' && !s.ok))
  const notListed = await probeProvider({ adapter: a, wire: 'anthropic', model: 'claude-unlisted', tools: [], effort: null, maxOutputTokens: null, signal: AbortSignal.timeout(30_000), providerId: claudeId })
  assert.equal(notListed.status, 'failed')
})

test('a Claude run freezes what Test accepted: display updates, fallbacks, effort; a tool round replays the signed blocks unchanged', async () => {
  A.fake.enqueue({ toolCalls: [{ name: 'search_content', args: { query: 'notes' } }], reasoning: 'Searching first.' }, { text: 'Nothing found.', reasoning: 'Done.' })
  const r = await run({ message: 'Find notes.' })
  assert.equal(r.end.data.state, 'finished', JSON.stringify(r.end.data))
  const conv = conversations.getConversation(r.started.ok ? r.started.conversation.id : '')!
  assert.deepEqual(conv.request.claude, { adaptiveThinking: true, fallbacks: true })
  assert.equal(conv.request.display, 'updates')
  assert.equal(conv.request.maxOutputCap, 128000)
  assert.equal(conv.effort, 'medium')
  const second = A.fake.requests[1].body as Record<string, any>
  assert.deepEqual(second.thinking, { type: 'adaptive', display: 'updates' })
  assert.equal(second.max_tokens, 64000)
  assert.equal(second.messages.length, 3, 'user, assistant (with its thinking), tool results')
  assert.ok(r.events.some((e) => e.type === 'thinking' && e.data.kind === 'update'))
  assert.equal(A.fake.requests[1].status, 200, 'the strict history check passed')
  // Each thinking block is one progress note, however many deltas carried it.
  const notes = conversations.loadTurns(conv.id).filter((t) => t.role === 'assistant').map((t) => (t.display as { thinking: string[] }).thinking)
  assert.deepEqual(notes, [['Searching first.'], ['Done.']])
})

test('cut inside a tool call: never run; retried once with the model’s whole cap', async () => {
  A.fake.enqueue(MATRIX.truncatedEagerJson(), { text: 'All good.' })
  const r = await run({ message: 'Draft.' })
  assert.equal(r.end.data.state, 'finished')
  assert.equal(r.events.filter((e) => e.type === 'tool_start').length, 0)
  assert.equal((A.fake.requests[0].body as Record<string, number>).max_tokens, 64000)
  assert.equal((A.fake.requests[1].body as Record<string, number>).max_tokens, 128000)
})

test('unparseable eager JSON: the turn is re-issued (the SDK’s JSON error, never an API error)', async () => {
  A.fake.enqueue(MATRIX.malformedEagerJson(), { text: 'Second attempt.' })
  const r = await run({ message: 'Try.' })
  assert.equal(r.end.data.state, 'finished')
  assert.ok(r.events.some((e) => e.type === 'notice' && e.data.kind === 'reissue'))
  assert.equal(A.fake.requests.length, 2)
})

test('a refused thinking block is dropped once, the history rewritten, and it is logged as a bug', async () => {
  A.fake.enqueue({ text: 'First answer.', reasoning: 'A thought.' })
  const first = await run({ message: 'One.' })
  const convId = first.started.ok ? first.started.conversation.id : ''
  // Something changed a stored block (what the recovery exists for).
  const { getAiDb } = await import('../lib/ai/db')
  const row = getAiDb().prepare("SELECT seq, native_json FROM ai_turns WHERE conversation_id = ? AND role = 'assistant'").get(convId) as { seq: number; native_json: string }
  const native = JSON.parse(row.native_json)
  native.content[0].signature = 'tampered'
  getAiDb().prepare('UPDATE ai_turns SET native_json = ? WHERE conversation_id = ? AND seq = ?').run(JSON.stringify(native), convId, row.seq)
  lines.length = 0
  A.fake.enqueue({ text: 'Second answer.' })
  const second = await run({ conversationId: convId, message: 'Two.' })
  assert.equal(second.end.data.state, 'finished', JSON.stringify(second.end.data))
  const stored = conversations.loadNative(convId).map((t) => t.native as { content?: Array<{ type: string }> })
  assert.ok(stored.every((t) => !(t.content ?? []).some((b) => b.type === 'thinking' && (b as { signature?: string }).signature === 'tampered')))
  assert.ok(lines.some((l) => l.includes('Claude refused a replayed thinking block')))
})

test('pause_turn: the paused turn is kept and re-sent; the run goes on to the end', async () => {
  A.fake.enqueue(MATRIX.pauseTurn(), { text: 'Continued.' })
  const r = await run({ message: 'Pause.' })
  assert.equal(r.end.data.state, 'finished')
  const roles = conversations.loadTurns(r.started.ok ? r.started.conversation.id : '').map((t) => t.role)
  assert.deepEqual(roles, ['user', 'assistant', 'assistant'])
  assert.equal((A.fake.requests[1].body as { messages: Array<{ role: string }> }).messages.at(-1)!.role, 'assistant')
})

test('the context window, and a turn that stopped early (the sentinel)', async () => {
  A.fake.enqueue(MATRIX.contextWindow())
  const full = await run({ message: 'Too long.' })
  assert.deepEqual([full.end.data.state, full.end.data.reason], ['limit', 'context'])
  A.fake.enqueue(MATRIX.claudeSentinel())
  const early = await run({ message: 'Long text.' })
  assert.deepEqual([early.end.data.state, early.end.data.reason], ['finished', 'max_tokens'])
  const display = conversations.loadTurns(early.started.ok ? early.started.conversation.id : '').at(-1)!.display as { stoppedEarly: boolean }
  assert.equal(display.stoppedEarly, true)
})

test('the sentinel key appears in no answer, no log line, no ai.db byte and no plain auth.db byte', async () => {
  // A provider error that quotes the key, on both a Claude and a chat run.
  A.fake.enqueue({ status: 400, errorBody: { type: 'error', error: { type: 'invalid_request_error', message: `bad key ${CLAUDE_KEY}` } } })
  const failed = await run({ message: 'Fail.' })
  assert.equal(failed.end.data.state, 'failed')
  A.fake.enqueue({ status: 400, errorBody: { error: { message: `Incorrect API key provided: ${TEST_KEY}` } } })
  const chatFailed = await runs.startRun({ session: A.session(), message: 'Fail too.' })
  assert.ok(chatFailed.ok)
  const sub = bus.subscribe(chatFailed.run.id, 0, () => {})!
  await chatFailed.run.done
  const chatEvents = sub.replay
  sub.stop()

  const everything = [JSON.stringify(failed.events), JSON.stringify(chatEvents), ...lines].join('\n')
  for (const k of [CLAUDE_KEY, TEST_KEY]) assert.ok(!everything.includes(k), 'events and log lines')
  assert.match(JSON.stringify(failed.events), /\[secret\]/, 'the provider’s words are kept, with the key masked')
  const { closeAiDb } = await import('../lib/ai/db')
  closeAiDb()
  const dir = path.join(A.h.tmp, 'data')
  for (const f of fs.readdirSync(dir).filter((n) => /^(ai|auth)\.db(-wal|-shm)?$/.test(n))) {
    const bytes = fs.readFileSync(path.join(dir, f))
    for (const k of [CLAUDE_KEY, TEST_KEY]) assert.equal(bytes.includes(Buffer.from(k)), false, `${f} holds the key in plain text`)
  }
})
