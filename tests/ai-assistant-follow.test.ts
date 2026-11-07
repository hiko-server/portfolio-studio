/**
 * M4 — what the assistant view knows about runs, run by the hooks' own code
 * (stage M4b, round 3; design §7.5, §7.7, PRODUCT §4.7, §4.8). The hooks run
 * under tests/helpers/hookHarness (React's hooks, no DOM) against a scripted
 * fetch and real event streams:
 *
 * - a run's end that is read after the next message went is not reported: it
 *   would clear the newer answer's status line, its pending message and the
 *   page's knowledge of what is being written;
 * - an answer this view does not follow (another conversation's, or one the
 *   owner left while it was written) is asked about until it ends, so
 *   "another conversation is being answered" and the disabled Send end with it.
 *
 * The browser half is e2e/ai-assistant.spec.ts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { renderHook } from './helpers/hookHarness'
import { ROOT } from './helpers/importGraph'
import { useRun } from '../components/Admin/ai/useRun'
import { unfollowedRun, useRunWatch, WATCH_MS } from '../components/Admin/ai/useRunWatch'
import { applyFrame, emptyTranscript, type Transcript } from '../components/Admin/ai/runState'
import type { ConversationDetail, DisplayTurn, RunView } from '../components/Admin/ai/types'

// ── A page's globals: timers, focus and visibility events, a scripted fetch ──

class FakeWindow extends EventTarget {
  // Read at call time, so node:test's mock timers apply.
  setTimeout = (fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms)
  clearTimeout = (id: unknown) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>)
  setInterval = (fn: () => void, ms?: number) => globalThis.setInterval(fn, ms)
  clearInterval = (id: unknown) => globalThis.clearInterval(id as ReturnType<typeof setInterval>)
}
class FakeDocument extends EventTarget {
  visibilityState: 'visible' | 'hidden' = 'visible'
}
const win = new FakeWindow()
const doc = new FakeDocument()
Object.assign(globalThis, { window: win, document: doc })

type Call = { url: string; method: string; signal: AbortSignal | null }
let route: (call: Call) => Response | Promise<Response> = (call) => {
  throw new Error(`no route for ${call.method} ${call.url}`)
}
const calls: Call[] = []
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const call = { url: String(input), method: init?.method ?? 'GET', signal: init?.signal ?? null }
  calls.push(call)
  return route(call)
}) as typeof fetch

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** A response that waits until released, and fails as fetch does when its request is aborted. */
function held(signal: AbortSignal | null) {
  let release!: (res: Response) => void
  const answer = new Promise<Response>((resolve, reject) => {
    release = resolve
    const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'))
    if (signal?.aborted) abort()
    signal?.addEventListener('abort', abort, { once: true })
  })
  answer.catch(() => {})
  return { answer, release }
}

/** A run's event stream, written by the test frame by frame. */
function eventStream() {
  const enc = new TextEncoder()
  let ctrl!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c
    },
  })
  return {
    response: new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform' } }),
    send(event: string, id: number, data: unknown) {
      ctrl.enqueue(enc.encode(`event: ${event}\nid: ${id}\ndata: ${JSON.stringify(data)}\n\n`))
    },
    close() {
      ctrl.close()
    },
  }
}

const pause = (ms = 0) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, what: string): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > 3000) throw new Error(`timed out waiting until ${what}`)
    await pause(5)
  }
}

const CONV = 'c_bbbbbbbbbbbbbbbbbbbb'
const R1 = 'r_aaaaaaaaaaaaaaaaaaaa'
const R2 = 'r_cccccccccccccccccccc'
const R3 = 'r_dddddddddddddddddddd'

const userTurn = (seq: number, text: string, runId: string): DisplayTurn => ({ seq, role: 'user', display: { kind: 'user', text, continued: false, attachments: [] }, inHistory: true, runId, createdAt: seq })
const assistantTurn = (seq: number, text: string, runId: string): DisplayTurn => ({ seq, role: 'assistant', display: { kind: 'assistant', text, thinking: [], toolCalls: [] } as never, inHistory: true, runId, createdAt: seq })

function detail(turns: DisplayTurn[]): ConversationDetail {
  return {
    conversation: { id: CONV, title: 'first', providerId: 'p_x', providerLabel: 'Test model (scripted)', providerAvailable: true, wire: 'chat', model: 'fake-model', effort: null, tools: 24, chatOnly: false, tokensWeighted: 0, createdAt: 1, updatedAt: 2 },
    turns,
    runs: [],
    active: null,
  }
}

const runView = (id: string, conversationId = CONV): RunView => ({ id, conversationId, state: 'running', reason: null, startedAt: 1, finishedAt: null, live: true, lastSeq: 3 })

// ── useRun: a run's end after the next message went ────────────────────────

test('a run’s end that is read after the next message went is not reported: the newer answer keeps its status, its pending message and what is being written', async () => {
  calls.length = 0
  const first = eventStream()
  const second = eventStream()
  const posts = [first, second]
  let reread: ReturnType<typeof held> | null = null
  route = (call) => {
    if (call.method === 'POST' && call.url === '/api/admin/ai/runs') return posts.shift()!.response
    if (call.method === 'GET' && call.url === `/api/admin/ai/conversations/${CONV}`) {
      // The first run's re-read is slow (the window the owner sends in); later ones answer at once.
      if (!reread) {
        reread = held(call.signal)
        return reread.answer
      }
      return json(detail([userTurn(1, 'first', R1), assistantTurn(2, 'One.', R1), userTurn(3, 'second', R2), assistantTurn(4, 'Two.', R2)]))
    }
    throw new Error(`unexpected ${call.method} ${call.url}`)
  }
  const ended: Transcript[] = []
  const started: Transcript[] = []
  const h = renderHook(() => useRun({ onUnauthorized: () => assert.fail('signed out'), onEnded: (t) => ended.push(t), onStarted: (t) => started.push(t) }))
  try {
    assert.equal(await h.current.send({ conversationId: CONV, message: 'first' }), true)
    first.send('run', 1, { runId: R1, conversationId: CONV, title: 'first' })
    first.send('turn', 2, { seq: 1, role: 'user', display: { kind: 'user', text: 'first', continued: false, attachments: [] } })
    first.send('turn', 3, { seq: 2, role: 'assistant', display: { kind: 'assistant', text: 'One.', thinking: [], toolCalls: [] } })
    first.send('run_end', 4, { state: 'finished', reason: 'end', message: null })
    first.close()
    await until(() => reread !== null, 'the first run’s conversation is read again')
    assert.equal(h.current.transcript.end?.state, 'finished')

    // The owner sends the next message while that re-read is still on its way.
    assert.equal(await h.current.send({ conversationId: CONV, message: 'second' }), true)
    second.send('run', 1, { runId: R2, conversationId: CONV, title: 'first' })
    await until(() => h.current.transcript.runId === R2 && h.current.transcript.live !== null, 'the second answer is followed')
    // The first run's re-read answers now (when its request was not given up with the run it belonged to).
    reread!.release(json(detail([userTurn(1, 'first', R1), assistantTurn(2, 'One.', R1)])))
    await pause(120)
    assert.deepEqual(ended.map((t) => t.runId), [], 'no end is reported while the second answer is written: the status line would say nothing over “replying”, and a proposal would be said before its end')
    assert.equal(h.current.sending, 'second', 'the second message stays on its way (Send stays busy) until its own turn arrives')
    assert.equal(h.current.transcript.runId, R2)
    assert.ok(h.current.transcript.live, 'the second answer is still being written')

    // The second run goes on to its own end, which is reported once, as that run's.
    second.send('turn', 2, { seq: 3, role: 'user', display: { kind: 'user', text: 'second', continued: false, attachments: [] } })
    await until(() => h.current.sending === null, 'the second message’s own turn replaces it')
    second.send('turn', 3, { seq: 4, role: 'assistant', display: { kind: 'assistant', text: 'Two.', thinking: [], toolCalls: [] } })
    second.send('run_end', 4, { state: 'finished', reason: 'end', message: null })
    second.close()
    await until(() => ended.length > 0, 'the second run’s end is reported')
    await pause(60)
    assert.deepEqual(ended.map((t) => [t.runId, t.end?.state]), [[R2, 'finished']])
    assert.deepEqual(started.map((t) => t.runId), [R1, R2])
    assert.deepEqual(h.current.transcript.turns.map((t) => t.seq), [1, 2, 3, 4], 'the conversation as the server keeps it')
  } finally {
    h.unmount()
  }
})

test('a run left during its re-read (New chat) reports no end either; an end read in peace is reported exactly once', async () => {
  calls.length = 0
  const first = eventStream()
  const second = eventStream()
  const posts = [first, second]
  let reread: ReturnType<typeof held> | null = null
  route = (call) => {
    if (call.method === 'POST' && call.url === '/api/admin/ai/runs') return posts.shift()!.response
    if (call.method === 'GET' && call.url === `/api/admin/ai/conversations/${CONV}`) {
      if (!reread) {
        reread = held(call.signal)
        return reread.answer
      }
      return json(detail([userTurn(1, 'first', R1), assistantTurn(2, 'One.', R1), userTurn(3, 'third', R3), assistantTurn(4, 'Three.', R3)]))
    }
    throw new Error(`unexpected ${call.method} ${call.url}`)
  }
  const ended: Transcript[] = []
  const h = renderHook(() => useRun({ onUnauthorized: () => assert.fail('signed out'), onEnded: (t) => ended.push(t) }))
  try {
    await h.current.send({ conversationId: CONV, message: 'first' })
    first.send('run', 1, { runId: R1, conversationId: CONV, title: 'first' })
    first.send('run_end', 2, { state: 'finished', reason: 'end', message: null })
    first.close()
    await until(() => reread !== null, 'the re-read is on its way')
    h.current.reset()
    reread!.release(json(detail([userTurn(1, 'first', R1), assistantTurn(2, 'One.', R1)])))
    await pause(80)
    assert.equal(ended.length, 0, 'a new chat shows nothing of that run’s end')
    assert.equal(h.current.transcript.conversationId, null)
    assert.equal(h.current.sending, null, 'a message on its way from the conversation left is not carried into the new chat')

    // In peace: the end is reported once.
    await h.current.send({ conversationId: CONV, message: 'third' })
    second.send('run', 1, { runId: R3, conversationId: CONV, title: 'first' })
    second.send('run_end', 2, { state: 'finished', reason: 'end', message: null })
    second.close()
    await until(() => ended.length > 0, 'the end is reported')
    await pause(60)
    assert.deepEqual(ended.map((t) => t.runId), [R3])
  } finally {
    h.unmount()
  }
})

// ── useRunWatch: an answer this view does not follow ───────────────────────

test('which answer the view asks about: one being written that it does not follow', () => {
  const following = applyFrame(emptyTranscript(), { event: 'run', id: 1, data: { runId: R1, conversationId: CONV } })
  assert.ok(following.live)
  const none = { runId: null, live: null }
  assert.equal(unfollowedRun(null, none), null, 'nothing is being written')
  assert.equal(unfollowedRun({ ...runView(R1), live: false }, none), null, 'an answer that is over')
  assert.equal(unfollowedRun(runView(R1, 'c_other_conversation_xx'), none), R1, 'another conversation’s, from a new chat')
  assert.equal(unfollowedRun(runView(R1), { runId: R1, live: null }), R1, 'the one shown, its stream given up or never opened')
  assert.equal(unfollowedRun(runView(R1), following), null, 'followed here: its own stream says its end')
  assert.equal(unfollowedRun(runView(R2), following), R2, 'a different run than the one followed')
})

test('an answer this view does not follow is asked about every few seconds while the page is visible and at once when it comes back; its end is said once, with what is written now', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  calls.length = 0
  let active: RunView | null = runView(R1, 'c_other_conversation_xx')
  let unauthorized = false
  route = (call) => {
    assert.deepEqual([call.method, call.url], ['GET', '/api/admin/ai/runs'])
    return unauthorized ? json({ code: 'NO_SESSION', error: 'Unauthorized' }, 401) : json({ active })
  }
  const overs: Array<[string, RunView | null]> = []
  let signedOut = 0
  let watching: string | null = R1
  const h = renderHook(() => useRunWatch(watching, { onOver: (id, now) => overs.push([id, now]), onUnauthorized: () => signedOut++ }))
  try {
    assert.equal(calls.length, 0, 'nothing is asked at once')
    t.mock.timers.tick(WATCH_MS)
    await pause(10)
    assert.equal(calls.length, 1)
    assert.deepEqual(overs, [], 'still being written: nothing changes')

    // A hidden page asks nothing.
    doc.visibilityState = 'hidden'
    t.mock.timers.tick(WATCH_MS * 4)
    await pause(10)
    assert.equal(calls.length, 1, 'no request while the page is hidden')

    // The answer ends while the page is hidden; the page coming back asks at once.
    active = null
    doc.visibilityState = 'visible'
    doc.dispatchEvent(new Event('visibilitychange'))
    await pause(10)
    assert.equal(calls.length, 2)
    assert.deepEqual(overs, [[R1, null]], 'over, and nothing else is being written')

    // Watching ends (the page cleared it): nothing more is asked.
    watching = null
    h.rerender()
    t.mock.timers.tick(WATCH_MS * 3)
    win.dispatchEvent(new Event('focus'))
    doc.dispatchEvent(new Event('visibilitychange'))
    await pause(10)
    assert.equal(calls.length, 2, 'no request once nothing is watched')

    // Another answer begun since counts as the end of the one watched, and names the new one.
    watching = R1
    active = runView(R2, 'c_third_conversation_xx')
    h.rerender()
    win.dispatchEvent(new Event('focus'))
    await pause(10)
    assert.deepEqual(overs.at(-1), [R1, active])

    // A session that ended sends the owner to sign in, as every admin request does.
    watching = R2
    unauthorized = true
    h.rerender()
    t.mock.timers.tick(WATCH_MS)
    await pause(10)
    assert.equal(signedOut, 1)
  } finally {
    h.unmount()
    doc.visibilityState = 'visible'
  }
  const before = calls.length
  t.mock.timers.tick(WATCH_MS * 3)
  await pause(10)
  assert.equal(calls.length, before, 'unmounted: nothing is asked')
})

test('the assistant view wires it: the watch clears what is written and reloads the rail; opening a conversation settles it; only the latest list answer says what is written', () => {
  const panel = fs.readFileSync(path.join(ROOT, 'components/Admin/ai/AssistantPanel.tsx'), 'utf8')
  assert.match(panel, /useRunWatch\(unfollowedRun\(writing, transcript\), \{\s*onOver: \(id, active\) => \{\s*setWriting\(\(prev\) => \(prev\?\.id === id \? active : prev\)\)\s*void loadListRef\.current\(\)/, 'the end clears the notice, the dot and the disabled Send, and the rail reads how it ended')
  assert.match(panel, /setHeader\(detail\?\.conversation \?\? null\)\s*if \(detail\) settleWriting\(detail\)/, 'opening a conversation (Open it) settles what is written')
  assert.match(panel, /if \(mine === listSeq\.current\) setWriting\(/, 'an older list answer never undoes a newer start or end')
  assert.match(panel, /if \(transcript\.end && transcript\.runId && writing\?\.id === transcript\.runId\) setWriting\(null\)/, 'a followed run whose end is drawn is not being written, even if the page leaves before its re-read')
  assert.match(panel, /const leaveConversation = useCallback\(\(\) => \{[\s\S]{0,300}?setAnnounce\(''\)/, 'leaving a conversation empties the status line it spoke in')
  // A run whose end the view never handled keeps what came to wait in it for the next end's line; a change decided
  // before the end is not said as waiting.
  assert.match(panel, /if \(!inRun\.current\) approvalsInRun\.current = new Map\(\)/)
  assert.match(panel, /if \(state !== 'waiting'\) approvalsInRun\.current\.delete\(id\)/)
})
