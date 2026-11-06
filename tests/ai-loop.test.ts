/**
 * M4 — the agent loop and runs (lib/ai/loop.ts, lib/ai/runs.ts, design §7.5,
 * §7.7, §12.1 ai-loop) on a throw-away store, the real read tools through
 * executeTool, and tests/helpers/fake-llm.mjs as an ordinary Custom
 * provider: budget clamp and stop; the reservation refunded on real usage;
 * estimates by bytes after a Stop, Chinese included; the step limit leaving a
 * valid history; Stop; the loop guard; one run at a time; the session ending
 * and the kill switch stopping a run; no partial turn ever persisted; the
 * re-issues the design allows; decisions reaching the next user turn.
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { MATRIX } from './helpers/fake-llm.mjs'
import { assistantHarness } from './helpers/assistantHarness'

const A = assistantHarness('ai-loop')
let runs: typeof import('../lib/ai/runs')
let conversations: typeof import('../lib/ai/conversations')
let bus: typeof import('../lib/ai/bus')
let budget: typeof import('../lib/ai/runBudget')
let settings: typeof import('../lib/ai/settings')
let aiDb: typeof import('../lib/ai/db')

before(async () => {
  await A.setup()
  runs = await import('../lib/ai/runs')
  conversations = await import('../lib/ai/conversations')
  bus = await import('../lib/ai/bus')
  budget = await import('../lib/ai/runBudget')
  settings = await import('../lib/ai/settings')
  aiDb = await import('../lib/ai/db')
})
after(async () => {
  await A.teardown()
})
beforeEach(() => {
  A.fake.reset()
  settings.writeAiSettings({ enabled: true, dailyTokenLimit: 2_000_000, keepConversationsDays: 90 }, { steppedUp: true })
  aiDb.getAiDb().exec("DELETE FROM ai_counters WHERE key = 'assistant-weighted|day'")
})

type Ev = { seq: number; type: string; data: Record<string, any> }

/** Start a run and collect every event until it ends. */
async function run(input: Partial<import('../lib/ai/runs').StartInput> = {}, opts: { onEvent?: (e: Ev, runId: string) => void } = {}) {
  const started = await runs.startRun({ session: A.session(), message: 'Hello', ...input })
  if (!started.ok) return { started, events: [] as Ev[], end: null as Ev | null }
  const events: Ev[] = []
  const sub = bus.subscribe(started.run.id, 0, (e) => {
    events.push(e as Ev)
    opts.onEvent?.(e as Ev, started.run.id)
  })
  for (const e of sub!.replay) {
    events.push(e as Ev)
    opts.onEvent?.(e as Ev, started.run.id)
  }
  await started.run.done
  sub!.stop()
  return { started, events, end: events.find((e) => e.type === 'run_end') ?? null }
}

const userTextOf = (native: unknown): string => {
  const m = (native as { messages: Array<{ content: string }> }).messages[0]
  return m.content
}

test('a text answer: frozen conversation, the owner’s message behind the server’s facts, one complete turn, usage settled', async () => {
  A.fake.enqueue({ text: '你好！', usage: { input: 1200, output: 30, cachedRead: 1000 } })
  const r = await run({ message: '你好' })
  assert.ok(r.started.ok, JSON.stringify(r.started))
  assert.equal(r.end?.data.state, 'finished')
  assert.equal(r.end?.data.reason, 'end')
  const conv = conversations.getConversation(r.started.conversation.id)!
  assert.equal(conv.title, '你好')
  assert.equal(conv.systemText.startsWith('You help the owner of this website'), true)
  assert.ok(conv.tools.length >= 11 && conv.tools.some((t) => t.name === 'get_site_overview'))
  const turns = conversations.loadTurns(conv.id)
  assert.deepEqual(turns.map((t) => t.role), ['user', 'assistant'])
  const sentText = userTextOf(turns[0].native)
  assert.match(sentText, /^<site_facts>\nToday \(UTC\): \d{4}-\d{2}-\d{2}\nSite: .+\nLanguages: en, zh\n<\/site_facts>\n\n你好$/)
  assert.deepEqual(turns[0].display, { kind: 'user', text: '你好', continued: false, attachments: [] }, 'the display holds what the owner wrote, never the facts')
  // The system text and tool list reached the provider exactly as frozen.
  const body = A.fake.requests[0].body as Record<string, any>
  assert.equal(body.messages[0].content, conv.systemText)
  assert.deepEqual(body.tools.map((t: any) => t.function.name), conv.tools.map((t) => t.name))
  // Reserved before the call, then replaced by what it cost: 1200 + 30 + 0.1 * 1000.
  assert.equal(budget.dayUsed(), 1330)
  assert.equal(conversations.getConversation(conv.id)!.tokensWeighted, 1330)
  const usage = aiDb.getAiDb().prepare('SELECT usage_in, cached_read, usage_out, weighted, estimated FROM ai_usage WHERE run_id = ?').get(r.started.run.id)
  assert.deepEqual({ ...(usage as object) }, { usage_in: 1200, cached_read: 1000, usage_out: 30, weighted: 1330, estimated: 0 })
  assert.equal(conversations.getRun(r.started.run.id)?.state, 'finished')
})

test('a tool round: the real tool through executeTool, all results in one turn, the events in order', async () => {
  A.fake.enqueue({ toolCalls: [{ name: 'search_content', args: { query: 'field' } }, { name: 'get_authoring_guide', args: { topic: 'mdx' } }] }, { text: 'Found nothing much.' })
  const r = await run({ message: 'What is there?' })
  assert.equal(r.end?.data.state, 'finished')
  const types = r.events.map((e) => e.type)
  assert.equal(types[0], 'run')
  assert.deepEqual(types.filter((t) => t === 'tool_start' || t === 'tool_end'), ['tool_start', 'tool_end', 'tool_start', 'tool_end'])
  assert.ok(types.indexOf('tool_start') > types.indexOf('turn'))
  assert.deepEqual(r.events.map((e) => e.seq), r.events.map((_, i) => i + 1), 'seq is monotonic with no gap for a live viewer')
  const turns = conversations.loadTurns(r.started.ok ? r.started.conversation.id : '')
  assert.deepEqual(turns.map((t) => t.role), ['user', 'assistant', 'tool', 'assistant'])
  const toolMsgs = (turns[2].native as { messages: Array<{ role: string; tool_call_id: string; content: string }> }).messages
  assert.equal(toolMsgs.length, 2)
  assert.ok(toolMsgs.every((m) => m.role === 'tool'))
  assert.equal(JSON.parse(toolMsgs[1].content).topic !== undefined || typeof JSON.parse(toolMsgs[1].content) === 'object', true)
  const display = turns[2].display as { results: Array<{ name: string; title: string; ok: boolean }> }
  assert.deepEqual(display.results.map((x) => [x.name, x.ok]), [['search_content', true], ['get_authoring_guide', true]])
  assert.ok(display.results.every((x) => typeof x.title === 'string' && x.title.length > 0), 'catalogue titles, never model text')
  const calls = aiDb.getAiDb().prepare("SELECT tool, actor_kind, actor_id, actor_label FROM ai_tool_calls WHERE actor_id = ? ORDER BY id").all(r.started.ok ? r.started.run.id : '') as Array<Record<string, string>>
  assert.deepEqual(calls.map((c) => [c.tool, c.actor_kind]), [['search_content', 'assistant'], ['get_authoring_guide', 'assistant']])
  assert.equal(calls[0].actor_label, 'Test model (scripted) · fake-model')
})

test('the step limit: 16 model turns, then "Paused after 16 steps." with a valid history; Continue carries on', async () => {
  let n = 0
  for (let i = 0; i < 16; i++) A.fake.enqueue(() => ({ toolCalls: [{ name: 'search_content', args: { query: `step ${++n}` } }] }))
  const r = await run({ message: 'Keep searching.' })
  assert.equal(r.end?.data.state, 'limit')
  assert.equal(r.end?.data.reason, 'steps')
  assert.equal(r.end?.data.message, 'Paused after 16 steps.')
  const conv = r.started.ok ? r.started.conversation : null
  const last = conversations.loadTurns(conv!.id).at(-1)!
  assert.equal(last.role, 'tool', 'the history ends answered')
  A.fake.enqueue({ text: 'Done now.' })
  const more = await run({ conversationId: conv!.id, message: null, continue: true })
  assert.equal(more.end?.data.state, 'finished', JSON.stringify(more.end?.data))
  assert.equal(A.fake.requests.at(-1)!.status, 200, 'the provider accepted the history as it was')
})

test('the loop guard: the same call three times stops the run, answered', async () => {
  for (let i = 0; i < 3; i++) A.fake.enqueue({ toolCalls: [{ name: 'search_content', args: { query: 'same' } }] })
  const r = await run({ message: 'Loop.' })
  assert.equal(r.end?.data.state, 'limit')
  assert.equal(r.end?.data.reason, 'loop')
  const turns = conversations.loadTurns(r.started.ok ? r.started.conversation.id : '')
  assert.equal(turns.at(-1)!.role, 'tool')
  const lastResult = (turns.at(-1)!.native as { messages: Array<{ content: string }> }).messages[0].content
  assert.equal(JSON.parse(lastResult).error.code, 'LOOP_STOPPED')
})

test('caps per turn and invalid arguments: extras and bad JSON get error results; three bad calls in a row stop the run', async () => {
  const many = Array.from({ length: 17 }, (_, i) => ({ name: 'search_content', args: { query: `q${i}` } }))
  A.fake.enqueue({ toolCalls: many }, { text: 'ok' })
  const capped = await run({ message: 'Many.' })
  assert.equal(capped.end?.data.state, 'finished')
  const tools = conversations.loadTurns(capped.started.ok ? capped.started.conversation.id : '').find((t) => t.role === 'tool')!
  const msgs = (tools.native as { messages: Array<{ content: string }> }).messages
  assert.equal(msgs.length, 17)
  assert.equal(JSON.parse(msgs[16].content).error.code, 'BUDGET')

  for (let i = 0; i < 3; i++) A.fake.enqueue({ toolCalls: [{ name: 'search_content', argsText: `{"query": "unclosed ${i}` }] })
  const bad = await run({ message: 'Bad JSON.' })
  assert.equal(bad.end?.data.state, 'failed')
  assert.equal(bad.end?.data.reason, 'invalid-args')
  const answers = conversations.loadTurns(bad.started.ok ? bad.started.conversation.id : '').filter((t) => t.role === 'tool')
  const first = (answers[0].native as { messages: Array<{ content: string }> }).messages[0].content
  assert.deepEqual(JSON.parse(first), { INVALID_JSON: '{"query": "unclosed 0' }, 'built with JSON.stringify: the quotes survive')
})

test('Stop mid-answer: the partial text is kept for the owner only, the reservation stays charged, the estimate counts Chinese bytes', async () => {
  A.fake.enqueue({ text: '中文'.repeat(600), textFragmentSize: 4, delayMs: 3 })
  let stopped = false
  const r = await run({ message: 'Write a lot.' }, {
    onEvent: (e, id) => {
      if (e.type === 'text' && !stopped) {
        stopped = true
        setTimeout(() => runs.stopRun(id), 30)
      }
    },
  })
  assert.equal(r.end?.data.state, 'stopped')
  assert.equal(r.end?.data.reason, 'stopped')
  const turns = conversations.loadTurns(r.started.ok ? r.started.conversation.id : '')
  assert.deepEqual(turns.map((t) => [t.role, t.native === null]), [['user', false], ['assistant', true]], 'the partial turn is display-only')
  const partial = (turns[1].display as { text: string; stopped: boolean })
  assert.equal(partial.stopped, true)
  assert.ok(partial.text.length > 0 && partial.text.length < 1200)
  const row = aiDb.getAiDb().prepare('SELECT usage_out, weighted, estimated FROM ai_usage WHERE run_id = ?').get(r.started.ok ? r.started.run.id : '') as { usage_out: number; weighted: number; estimated: number }
  assert.equal(row.estimated, 1)
  assert.equal(row.usage_out, Math.ceil(Buffer.byteLength(partial.text, 'utf8') / 3), 'UTF-8 bytes / 3, not characters')
  assert.equal(row.weighted, budget.CAPS.defaultReservation, 'no usage arrived: the reservation stays')
  assert.equal(budget.dayUsed(), budget.CAPS.defaultReservation)
  await A.fake.settled()
  assert.equal(A.fake.requests[0].aborted, true, 'the stream to the provider was cut')
})

test('Stop between tools: the running tool finishes, its siblings are answered "cancelled by user", the history stays valid', async () => {
  A.fake.enqueue({ toolCalls: [{ name: 'search_content', args: { query: 'a' } }, { name: 'search_content', args: { query: 'b' } }, { name: 'search_content', args: { query: 'c' } }] })
  const r = await run({ message: 'Three.' }, { onEvent: (e, id) => e.type === 'tool_start' && runs.stopRun(id) })
  assert.equal(r.end?.data.state, 'stopped')
  const tools = conversations.loadTurns(r.started.ok ? r.started.conversation.id : '').at(-1)!
  const msgs = (tools.native as { messages: Array<{ content: string }> }).messages
  assert.equal(msgs.length, 3)
  assert.ok(!JSON.parse(msgs[0].content).error, 'the one already running finished')
  assert.deepEqual(msgs.slice(1).map((m) => JSON.parse(m.content).error), [{ code: 'CANCELLED', message: 'cancelled by user' }, { code: 'CANCELLED', message: 'cancelled by user' }])
})

test('one run at a time: a second start answers RUN_ACTIVE with the running conversation', async () => {
  A.fake.enqueue(MATRIX.abortMidText())
  const first = await runs.startRun({ session: A.session(), message: 'Long.' })
  assert.ok(first.ok)
  const second = await runs.startRun({ session: A.session(), message: 'Me too.' })
  assert.equal(second.ok, false)
  assert.deepEqual(second.ok ? null : [second.status, second.code, second.runId, second.conversationId], [409, 'RUN_ACTIVE', first.run.id, first.conversation.id])
  // The status strip's Assistant tile reads the same thing.
  const { aiSummary } = await import('../lib/ai/summary')
  const tile = aiSummary().assistant!
  assert.deepEqual(tile.running, { runId: first.run.id, conversationId: first.conversation.id })
  assert.deepEqual([tile.defaultModel?.label, tile.defaultModel?.model, tile.canStoreKeys], ['Test model (scripted)', 'fake-model', true])
  runs.stopRun(first.run.id)
  await first.run.done
  assert.equal(runs.activeRun(), null)
  assert.equal(aiSummary().assistant!.running, null)
})

test('the kill switch stops a run (the watchdog reads AI access every second), and so does the session ending', async () => {
  A.fake.enqueue({ text: 'x'.repeat(4000), textFragmentSize: 8, delayMs: 10 })
  const off = await run({ message: 'Long.' }, { onEvent: (e) => e.type === 'text' && settings.writeAiSettings({ enabled: false }, { steppedUp: false }) })
  assert.equal(off.end?.data.state, 'stopped')
  assert.equal(off.end?.data.reason, 'access-off')
  settings.writeAiSettings({ enabled: true }, { steppedUp: true })

  const refused = await runs.startRun({ session: A.session(), message: 'x' })
  assert.ok(refused.ok)
  await refused.run.done

  const { createSession, revokeSession } = await import('../lib/adminAuth/sessions')
  const browser = createSession({ method: 'password', ttlMs: 3_600_000, device: null, ipPrefix: null, country: null }).id
  A.fake.enqueue({ text: 'x'.repeat(4000), textFragmentSize: 8, delayMs: 10 })
  let once = false
  const ended = await run({ message: 'Long.', session: { id: browser, ipPrefix: null, country: null } }, {
    onEvent: (e) => {
      if (e.type === 'text' && !once) {
        once = true
        revokeSession(browser, 'signed out from another browser')
      }
    },
  })
  assert.equal(ended.end?.data.state, 'stopped')
  assert.equal(ended.end?.data.reason, 'session-ended')
})

test('AI access off: no run starts', async () => {
  settings.writeAiSettings({ enabled: false }, { steppedUp: false })
  const r = await runs.startRun({ session: A.session(), message: 'x' })
  assert.deepEqual(r.ok ? null : [r.status, r.code], [409, 'ACCESS_OFF'])
  assert.equal(A.fake.requests.length, 0)
})

test('budgets: today’s limit stops a run before any call; what is left clamps the output limit sent', async () => {
  settings.writeAiSettings({ dailyTokenLimit: 20_000 }, { steppedUp: false })
  const r = await run({ message: 'x' })
  assert.equal(r.end?.data.state, 'limit')
  assert.equal(r.end?.data.reason, 'budget-day')
  assert.equal(A.fake.requests.length, 0, 'below the reasoning floor nothing is sent')
  assert.ok(r.end?.data.detail?.retryAt > Date.now())

  settings.writeAiSettings({ dailyTokenLimit: 40_000 }, { steppedUp: true })
  A.fake.enqueue({ text: 'ok', usage: { input: 100, output: 10 } })
  const clamped = await run({ message: 'x' })
  assert.equal(clamped.end?.data.state, 'finished')
  assert.equal((A.fake.requests[0].body as Record<string, number>).max_tokens, 40_000, 'less than 64,000 left: the limit is sent, and it is what is left')
  assert.equal(budget.dayUsed(), 110, 'the 40,000 reserved were refunded down to the real cost')
})

test('a stream that dies before any output is re-issued once; one that dies after output fails, with nothing of it in the history', async () => {
  A.fake.enqueue({ text: '', reasoning: null, destroyAfter: 0 }, { text: 'Second time lucky.' })
  const retried = await run({ message: 'x' })
  assert.equal(retried.end?.data.state, 'finished')
  assert.ok(retried.events.some((e) => e.type === 'notice' && e.data.kind === 'retry'))

  A.fake.enqueue(MATRIX.eof())
  const failed = await run({ message: 'y' })
  assert.equal(failed.end?.data.state, 'failed')
  assert.equal(failed.end?.data.reason, 'provider')
  const turns = conversations.loadTurns(failed.started.ok ? failed.started.conversation.id : '')
  assert.ok(turns.filter((t) => t.role === 'assistant').every((t) => t.native === null), 'no partial assistant turn is ever stored')
})

test('a 400 on the output limit is re-issued once without it; a model cut off inside a tool call is never run, and is retried with more room', async () => {
  const small = await A.addFakeProvider('chat', { defaultModel: 'fake-small-output', ownerQuirks: { maxOutputTokens: 64_000 }, label: 'Small' })
  A.fake.enqueue({ text: 'Fine without a limit.' })
  const r = await run({ message: 'x', providerId: small })
  assert.equal(r.end?.data.state, 'finished', JSON.stringify(r.end?.data))
  assert.ok(r.events.some((e) => e.type === 'notice' && e.data.kind === 'output_limit'))
  assert.equal('max_tokens' in (A.fake.requests.at(-1)!.body as object), false)

  A.fake.enqueue(MATRIX.lengthWithTool(), { text: 'Done.' })
  const cut = await run({ message: 'x' })
  assert.equal(cut.end?.data.state, 'finished')
  assert.equal(cut.events.filter((e) => e.type === 'tool_start').length, 0, 'the cut call never ran')
})

test('a model that declines at once: nothing of the turn is kept and the message leaves the history', async () => {
  A.fake.enqueue({ refusal: 'I cannot help with that.' })
  const r = await run({ message: 'Something declined.' })
  assert.equal(r.end?.data.state, 'finished')
  assert.equal(r.end?.data.reason, 'refusal')
  const id = r.started.ok ? r.started.conversation.id : ''
  assert.deepEqual(conversations.loadTurns(id).map((t) => [t.role, t.native === null]), [['user', true], ['assistant', true]])
  assert.equal(conversations.loadNative(id).length, 0)
  A.fake.enqueue({ text: 'Hi.' })
  await run({ conversationId: id, message: 'Hello instead.' })
  const msgs = (A.fake.requests.at(-1)!.body as { messages: Array<{ role: string; content: string }> }).messages
  assert.deepEqual(msgs.map((m) => m.role), ['system', 'user'])
  assert.ok(!msgs[1].content.includes('Something declined.'))
})

test('a change decided since the last turn reaches the model as one server-written line', async () => {
  A.fake.enqueue({ text: 'Proposed.' })
  const first = await run({ message: 'Publish it.' })
  const conv = first.started.ok ? first.started.conversation : null
  const now = Date.now() + 5
  aiDb
    .getAiDb()
    .prepare(
      `INSERT INTO ai_changes (id, state, risk, tool, kind, actor_kind, actor_id, actor_label, issuer_version, target_kind, target_ref, title, args_sha256, preview_sha256, reject_note, created_at, decided_at)
       VALUES (?, 'rejected', 'live', 'propose_publish', 'item.publish', 'assistant', ?, 'x', 0, 'blog', 'example-field-notes', 'Publish post example-field-notes', 'a', 'b', 'Not yet: wait for Monday.', ?, ?)`,
    )
    .run('ch_abcdefghijklmnop', first.started.ok ? first.started.run.id : '', now, now)
  A.fake.enqueue({ text: 'Understood.' })
  await new Promise((r) => setTimeout(r, 10))
  await run({ conversationId: conv!.id, message: 'Why not?' })
  const msgs = (A.fake.requests.at(-1)!.body as { messages: Array<{ role: string; content: string }> }).messages
  const last = msgs.at(-1)!.content
  assert.match(last, /Change ch_abcdefghijklmnop \(Publish post example-field-notes\) was rejected\. The owner’s note: Not yet: wait for Monday\./)
  assert.equal(msgs.filter((m) => m.content.includes('ch_abcdefghijklmnop')).length, 1, 'once, in the turn after the decision')
})

test('retention: "Don’t keep" removes the other conversations when the next run starts', async () => {
  const before = conversations.listConversations(500).length
  assert.ok(before > 1)
  settings.writeAiSettings({ keepConversationsDays: 0 }, { steppedUp: false })
  A.fake.enqueue({ text: 'Fresh.' })
  const r = await run({ message: 'New.' })
  assert.deepEqual(conversations.listConversations(500).map((c) => c.id), [r.started.ok ? r.started.conversation.id : ''])
})

test('a running row no process drives reads interrupted', async () => {
  const conv = conversations.listConversations(1)[0]
  conversations.insertRun({ id: 'r_orphanorphanorphan01', conversationId: conv.id, sessionId: A.sessionId })
  const view = runs.runView('r_orphanorphanorphan01')
  assert.equal(view?.state, 'interrupted')
  assert.equal(view?.live, false)
})
