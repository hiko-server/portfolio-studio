/**
 * M4 — the assistant's routes on a real socket (tests/helpers/realRoute.ts,
 * Next's own resolver): POST /api/admin/ai/runs answers a live
 * text/event-stream; closing it does not cancel the run; GET
 * runs/[id]/events?after= picks up exactly what was missed; Stop; one run at
 * a time; turning AI access off through the settings route stops a run at
 * once; the conversations and usage views. Design §7.5, §7.7, §12.1.
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createParser } from 'eventsource-parser'
import { assistantHarness } from './helpers/assistantHarness'
import { startRealRoute, type RealRoute } from './helpers/realRoute'

const A = assistantHarness('ai-runs-route')
let runs: typeof import('../lib/ai/runs')
let conversations: typeof import('../lib/ai/conversations')
let settings: typeof import('../lib/ai/settings')
let start: RealRoute
let events: RealRoute
let stop: RealRoute
let convList: RealRoute
let convOne: RealRoute
let usage: RealRoute
let cookie = ''

before(async () => {
  await A.setup()
  runs = await import('../lib/ai/runs')
  conversations = await import('../lib/ai/conversations')
  settings = await import('../lib/ai/settings')
  const auth = await import('../lib/auth')
  cookie = `cv_admin_token=${auth.signAdminToken('owner@example.test', { sid: A.sessionId })}`
  start = await startRealRoute(await import('../pages/api/admin/ai/runs/index'))
  events = await startRealRoute(await import('../pages/api/admin/ai/runs/[id]/events'))
  stop = await startRealRoute(await import('../pages/api/admin/ai/runs/[id]/stop'))
  convList = await startRealRoute(await import('../pages/api/admin/ai/conversations/index'))
  convOne = await startRealRoute(await import('../pages/api/admin/ai/conversations/[id]'))
  usage = await startRealRoute(await import('../pages/api/admin/ai/usage'))
})
after(async () => {
  for (const r of [start, events, stop, convList, convOne, usage]) await r?.close()
  await A.teardown()
})
beforeEach(async () => {
  A.fake.reset()
  settings.writeAiSettings({ enabled: true }, { steppedUp: true })
  await runs.activeRun()?.done
})

type Frame = { id: number | null; event: string; data: any; at: number }

/** Read an SSE response frame by frame (until it ends or `until` says stop), timing each one. */
async function readFrames(res: Response, until?: (f: Frame, all: Frame[]) => boolean): Promise<Frame[]> {
  const frames: Frame[] = []
  let done = false
  const parser = createParser({
    onEvent: (e) => {
      const f: Frame = { id: e.id ? Number(e.id) : null, event: e.event ?? 'message', data: JSON.parse(e.data), at: Date.now() }
      frames.push(f)
      if (until?.(f, frames)) done = true
    },
  })
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  while (!done) {
    const { value, done: end } = await reader.read()
    if (end) break
    parser.feed(decoder.decode(value, { stream: true }))
  }
  if (done) await reader.cancel().catch(() => {})
  return frames
}

const post = (route: RealRoute, path: string, body: unknown, init: RequestInit = {}) =>
  route.fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body), ...init })

test('POST runs streams the run live: SSE headers, frames arrive while the model writes, seq increases, run_end closes it', async () => {
  A.fake.enqueue({ text: 'Streaming slowly. '.repeat(20), textFragmentSize: 6, delayMs: 15 })
  const res = await post(start, '/', { message: 'Write slowly.' })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8')
  assert.equal(res.headers.get('cache-control'), 'no-cache, no-transform')
  assert.equal(res.headers.get('x-accel-buffering'), 'no')
  const frames = await readFrames(res)
  const names = frames.map((f) => f.event)
  assert.equal(names[0], 'run')
  assert.equal(names.at(-1), 'run_end')
  assert.equal(frames.at(-1)!.data.state, 'finished')
  const texts = frames.filter((f) => f.event === 'text')
  assert.ok(texts.length > 10)
  assert.ok(frames.at(-1)!.at - texts[0].at > 300, 'the first words arrived well before the end: nothing buffered the stream')
  const ids = frames.map((f) => f.id)
  assert.deepEqual(ids, [...ids].sort((a, b) => (a as number) - (b as number)))
})

test('closing the stream does not cancel the run; re-attaching with after= gets exactly the rest', async () => {
  A.fake.enqueue({ text: 'One two three four five six seven eight nine ten. '.repeat(8), textFragmentSize: 5, delayMs: 10 })
  const ac = new AbortController()
  const res = await post(start, '/', { message: 'Count.' }, { signal: ac.signal })
  const seen = await readFrames(res, (_f, all) => all.filter((x) => x.event === 'text').length >= 3)
  const runId = seen[0].data.runId as string
  const lastSeen = seen.at(-1)!.id as number
  ac.abort()
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(runs.activeRun()?.id, runId, 'still running after the viewer left')

  const again = await events.fetch(`/?id=${runId}&after=${lastSeen}`, { headers: { cookie } })
  assert.equal(again.status, 200)
  const rest = await readFrames(again)
  assert.ok(rest.every((f) => (f.id as number) > lastSeen), 'nothing it already had')
  assert.equal(rest.at(-1)!.event, 'run_end')
  assert.equal(rest.at(-1)!.data.state, 'finished')
  const text = [...seen, ...rest].filter((f) => f.event === 'text').map((f) => f.data.delta).join('')
  assert.equal(text, 'One two three four five six seven eight nine ten. '.repeat(8), 'every word exactly once across the two views')
  assert.equal(A.fake.requests.length, 1, 'one model call, read to its end: the viewer leaving never touched it')

  // After the end, a late viewer still learns how it ended.
  const late = await readFrames(await events.fetch(`/?id=${runId}&after=${rest.at(-1)!.id}`, { headers: { cookie } }))
  assert.deepEqual(late.map((f) => [f.event, f.data.state]), [['run_end', 'finished']])
})

test('a viewer that re-attaches from 0 after finished steps gets them as turns, not their deltas', async () => {
  A.fake.enqueue({ toolCalls: [{ name: 'search_content', args: { query: 'x' } }] }, { text: 'Last words, slowly. '.repeat(10), textFragmentSize: 4, delayMs: 15 })
  const res = await post(start, '/', { message: 'Search then talk.' })
  const first = await readFrames(res, (_f, all) => all.filter((x) => x.event === 'text').length >= 2)
  const runId = first[0].data.runId as string
  const fromZero = await readFrames(await events.fetch(`/?id=${runId}&after=0`, { headers: { cookie } }))
  const turns = fromZero.filter((f) => f.event === 'turn').map((f) => f.data.role)
  assert.deepEqual(turns, ['user', 'assistant', 'tool', 'assistant'])
  const toolDeltas = fromZero.filter((f) => f.event === 'tool_start')
  assert.equal(toolDeltas.length, 0, 'the finished tool step comes as its turn')
})

test('Stop through its route ends the run as stopped, and the stream says so; a second Stop answers stopped: false', async () => {
  A.fake.enqueue({ text: 'y'.repeat(3000), textFragmentSize: 5, delayMs: 5 })
  const res = await post(start, '/', { message: 'Long.' })
  let runId = ''
  let stopped = false
  const frames = await readFrames(res, (f) => {
    if (f.event === 'run') runId = f.data.runId
    if (f.event === 'text' && !stopped) {
      stopped = true
      void stop.fetch(`/?id=${runId}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' })
    }
    return false
  })
  assert.equal(frames.at(-1)!.event, 'run_end')
  assert.equal(frames.at(-1)!.data.state, 'stopped')
  const again = await (await stop.fetch(`/?id=${runId}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' })).json()
  assert.equal(again.stopped, false)
  assert.equal(again.run.state, 'stopped')
})

test('one run at a time over HTTP: 409 RUN_ACTIVE (JSON) naming the running conversation', async () => {
  A.fake.enqueue({ text: 'z'.repeat(2000), textFragmentSize: 5, delayMs: 5 })
  const res = await post(start, '/', { message: 'Long.' })
  const first = await readFrames(res, (f) => f.event === 'text')
  const second = await post(start, '/', { message: 'Me too.' })
  assert.equal(second.status, 409)
  const body = await second.json()
  assert.equal(body.code, 'RUN_ACTIVE')
  assert.equal(body.runId, first[0].data.runId)
  assert.equal(body.conversationId, first[0].data.conversationId)
  runs.stopRun(body.runId)
  await runs.activeRun()?.done
})

test('turning AI access off through the settings route stops the run at once', async () => {
  const settingsRoute = await startRealRoute(await import('../pages/api/admin/ai/settings'))
  try {
    A.fake.enqueue({ text: 'w'.repeat(3000), textFragmentSize: 5, delayMs: 5 })
    const res = await post(start, '/', { message: 'Long.' })
    let switched = 0
    const frames = await readFrames(res, (f) => {
      if (f.event === 'text' && !switched) {
        switched = Date.now()
        void settingsRoute.fetch('/', { method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) })
      }
      return false
    })
    const end = frames.at(-1)!
    assert.equal(end.event, 'run_end')
    assert.deepEqual([end.data.state, end.data.reason], ['stopped', 'access-off'])
    assert.ok(end.at - switched < 900, `stopped by the route, not only by the 1 s watchdog (${end.at - switched} ms)`)
  } finally {
    await settingsRoute.close()
    settings.writeAiSettings({ enabled: true }, { steppedUp: true })
  }
})

test('refusals answer JSON, never a stream: no session, a bad field, AI off, an unknown conversation', async () => {
  assert.equal((await start.fetch('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"message":"x"}' })).status, 401)
  const bad = await post(start, '/', { message: 'x', temperature: 0.2 })
  assert.deepEqual([bad.status, (await bad.json()).field], [400, 'temperature'])
  const attach = await post(start, '/', { message: 'x', attachments: [{ kind: 'selection', ref: 'x' }] })
  assert.equal(attach.status, 400)
  // The model a new conversation freezes follows the providers routes' rule: nothing reaches a provider or an actor label.
  for (const model of ['fake-model\nInjected line', 'fake model', `fake-${'m'.repeat(200)}`, 'fake\u0000model', 42]) {
    const res = await post(start, '/', { message: 'x', model })
    assert.deepEqual([res.status, (await res.json()).field], [400, 'model'], JSON.stringify(model).slice(0, 40))
  }
  assert.equal(A.fake.requests.length, 0, 'nothing was sent to the provider')
  assert.equal(conversations.listConversations().filter((c) => c.model.includes('fake-m') && c.model !== 'fake-model').length, 0)
  const lib = await runs.startRun({ session: A.session(), message: 'x', model: 'fake\tmodel' })
  assert.deepEqual(lib.ok ? null : [lib.status, lib.code, lib.field], [400, 'INVALID', 'model'], 'the run itself refuses it too')
  const unknown = await post(start, '/', { message: 'x', conversationId: 'c_doesnotexistdoesnotexist' })
  assert.equal(unknown.status, 404)
  settings.writeAiSettings({ enabled: false }, { steppedUp: false })
  const off = await post(start, '/', { message: 'x' })
  assert.deepEqual([off.status, (await off.json()).code], [409, 'ACCESS_OFF'])
  settings.writeAiSettings({ enabled: true }, { steppedUp: true })
  assert.equal((await events.fetch('/?id=r_nosuchrunnosuchrun00', { headers: { cookie } })).status, 404)
})

test('a stored run this process does not drive answers one stored run_end', async () => {
  const conv = conversations.listConversations(1)[0]
  conversations.insertRun({ id: 'r_leftoverleftoverleft', conversationId: conv.id, sessionId: A.sessionId })
  const frames = await readFrames(await events.fetch('/?id=r_leftoverleftoverleft&after=0', { headers: { cookie } }))
  assert.deepEqual(frames.map((f) => [f.event, f.data.state, f.data.stored]), [['run_end', 'interrupted', true]])
})

test('conversations: the list, one conversation as display turns only (never native history or schemas), deletes', async () => {
  A.fake.enqueue({ text: 'Kept.' })
  const frames = await readFrames(await post(start, '/', { message: 'Keep me.' }))
  const convId = frames[0].data.conversationId as string
  const list = await (await convList.fetch('/', { headers: { cookie } })).json()
  assert.ok(list.conversations.some((c: { id: string }) => c.id === convId))
  assert.equal(list.keepDays, 90)
  const one = await (await convOne.fetch(`/?id=${convId}`, { headers: { cookie } })).json()
  assert.deepEqual(one.turns.map((t: { role: string }) => t.role), ['user', 'assistant'])
  const raw = JSON.stringify(one)
  assert.ok(!raw.includes('site_facts') && !raw.includes('inputSchema') && !raw.includes('You help the owner'), 'no native history, system text or schemas leave the server')
  assert.equal(one.conversation.providerLabel, 'Test model (scripted)')
  const del = await convOne.fetch(`/?id=${convId}`, { method: 'DELETE', headers: { cookie } })
  assert.deepEqual(await del.json(), { deleted: true })
  assert.equal((await convOne.fetch(`/?id=${convId}`, { headers: { cookie } })).status, 404)
  const all = await convList.fetch('/', { method: 'DELETE', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ all: true }) })
  assert.equal(all.status, 200)
  assert.equal(conversations.listConversations(10).length, 0)
})

test('usage: per day, provider and model, today against the limit; no prices anywhere', async () => {
  A.fake.enqueue({ text: 'Counted.', usage: { input: 500, output: 20 } })
  await readFrames(await post(start, '/', { message: 'Count me.' }))
  const u = await (await usage.fetch('/?days=7', { headers: { cookie } })).json()
  const row = u.rows.find((r: { model: string }) => r.model === 'fake-model')
  assert.ok(row && row.calls >= 1 && row.usageIn >= 500)
  assert.equal(row.providerLabel, 'Test model (scripted)')
  assert.equal(row.reportedMicroUsd, null, 'cost only where the provider reported it')
  assert.ok(u.today.weighted >= 520 && u.today.limit === 2_000_000)
})
