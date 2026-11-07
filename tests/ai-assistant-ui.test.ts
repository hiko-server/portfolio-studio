/**
 * M4 — the assistant view and Models, the parts that need no browser (stage
 * M4b): the event-stream parser, the run reducer (a reload re-attaches
 * without doubling a word), the composer's keys (an input method's Enter
 * never sends), how a run's end reads, usage, suggestions from true facts,
 * the copy's voice, and the boundary (the panels load with the page through
 * dynamic(), and nothing under components/Admin/ai reaches the server's AI
 * layer). The browser half is e2e/ai-assistant.spec.ts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, reachable, rel } from './helpers/importGraph'
import { createSseParser, type SseFrame } from '../components/Admin/ai/sseClient'
import { applyFrame, changesOfTools, emptyTranscript, followFromStart, fromConversation, lastHistoryRole, lastUserText, type Frame, type Transcript } from '../components/Admin/ai/runState'
import {
  assistantTile,
  compactCount,
  composerKey,
  endView,
  formatCost,
  messageLang,
  promptLang,
  suggestedPrompts,
  usageByModel,
  usageLine,
} from '../components/Admin/ai/assistantFormat'
import { ASSISTANT_COPY, CHAT_MD_COPY, MODELS_COPY, PROMPT_COPY } from '../components/Admin/ai/copy'
import type { ConversationDetail, UsageRow } from '../components/Admin/ai/types'

const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8')

// ── The event-stream parser ────────────────────────────────────────────────

function parseAll(chunks: string[]): SseFrame[] {
  const out: SseFrame[] = []
  const p = createSseParser((f) => out.push(f))
  for (const c of chunks) p.push(c)
  p.end()
  return out
}

test('the event-stream parser: frames split anywhere, CRLF and CR, comments, multi-line data, a BOM, an unfinished last event dropped', () => {
  const stream = '﻿id: 1\nevent: run\ndata: {"runId":"r_x"}\n\n: a comment\n\nevent: ping\ndata: {}\n\nid: 2\r\nevent: text\r\ndata: {"delta":"你好"}\r\n\r\nid: 3\revent: text\rdata: line one\rdata: line two\r\rid: 4\nevent: text\ndata: never finished'
  const whole = parseAll([stream])
  assert.deepEqual(whole, [
    { event: 'run', id: 1, data: '{"runId":"r_x"}' },
    { event: 'ping', id: null, data: '{}' },
    { event: 'text', id: 2, data: '{"delta":"你好"}' },
    { event: 'text', id: 3, data: 'line one\nline two' },
  ])
  // Every split point gives the same frames (a CR at the end of one chunk and its LF at the start of the next included).
  for (let i = 1; i < stream.length; i++) assert.deepEqual(parseAll([stream.slice(0, i), stream.slice(i)]), whole, `split at ${i}`)
  // One character at a time.
  assert.deepEqual(parseAll(Array.from(stream)), whole)
  // An id that is not a number is no seq; data with no space after the colon keeps its first character.
  assert.deepEqual(parseAll(['id: x\ndata:{"a":1}\n\n']), [{ event: 'message', id: null, data: '{"a":1}' }])
  // An event with no data line is not dispatched.
  assert.deepEqual(parseAll(['event: run\n\n']), [])
})

// ── The run reducer ────────────────────────────────────────────────────────

const f = (event: string, id: number | null, data: unknown): Frame => ({ event, id, data })

function run(frames: Frame[], start: Transcript = emptyTranscript()): Transcript {
  return frames.reduce(applyFrame, start)
}

const RUN = 'r_aaaaaaaaaaaaaaaaaaaa'
const CONV = 'c_bbbbbbbbbbbbbbbbbbbb'
const CHANGE = 'ch_abcdefghijklmnop'

const frames: Frame[] = [
  f('run', 1, { runId: RUN, conversationId: CONV, title: 'Draft a post', provider: 'Test model (scripted)', model: 'fake-model', userTurnSeq: 1 }),
  f('turn', 2, { seq: 1, role: 'user', display: { kind: 'user', text: '起草一篇文章', continued: false, attachments: [] } }),
  f('thinking', 3, { delta: 'Reading ', kind: 'raw' }),
  f('thinking', 4, { delta: 'the site.', kind: 'raw' }),
  f('text', 5, { delta: 'I will ' }),
  f('text', 6, { delta: 'draft it.' }),
  f('turn', 7, { seq: 2, role: 'assistant', display: { kind: 'assistant', text: 'I will draft it.', thinking: ['Reading the site.'], toolCalls: [{ id: 't1', name: 'create_draft', title: 'Create a draft' }] } }),
  f('tool_start', 8, { id: 't1', name: 'create_draft', title: 'Create a draft' }),
  f('tool_end', 9, { id: 't1', name: 'create_draft', title: 'Create a draft', ok: true, code: null }),
  f('change', 10, { id: CHANGE, status: 'saved', tool: 'create_draft' }),
  f('turn', 11, { seq: 3, role: 'tool', display: { kind: 'tools', results: [{ id: 't1', name: 'create_draft', title: 'Create a draft', ok: true, code: null, args: '{}', result: `{"status":"saved","saved_as":"draft","change_id":"${CHANGE}"}` }] } }),
  f('usage', 12, { usageIn: 1200, cachedRead: 800, cacheWrite: 100, usageOut: 340, reasoning: 0, weighted: 1720, estimated: false, runWeighted: 1720 }),
  f('text', 13, { delta: 'Done: a draft.' }),
  f('turn', 14, { seq: 4, role: 'assistant', display: { kind: 'assistant', text: 'Done: a draft.', thinking: [], toolCalls: [] } }),
  f('run_end', 15, { state: 'finished', reason: 'end', message: null }),
]

test('the run reducer builds the turn being written from deltas, then lets the finished turn replace it exactly', () => {
  const mid = run(frames.slice(0, 6))
  assert.equal(mid.conversationId, CONV)
  assert.equal(mid.runId, RUN)
  assert.equal(mid.live?.text, 'I will draft it.')
  assert.deepEqual(mid.live?.thinking, ['Reading the site.'], 'one note per uninterrupted run of reasoning')
  assert.equal(mid.turns.length, 1)
  const afterTurn = run(frames.slice(0, 7))
  assert.equal(afterTurn.live?.text, '', 'the finished turn replaces its deltas')
  assert.equal(afterTurn.turns.length, 2)
  const tools = run(frames.slice(0, 9))
  assert.deepEqual(tools.live?.tools, [{ id: 't1', name: 'create_draft', title: 'Create a draft', done: true, ok: true, code: null }])
  const done = run(frames)
  assert.equal(done.live, null)
  assert.deepEqual(done.end, { state: 'finished', reason: 'end', message: null })
  assert.deepEqual(done.turns.map((t) => [t.seq, t.role]), [[1, 'user'], [2, 'assistant'], [3, 'tool'], [4, 'assistant']])
  assert.deepEqual(done.changes, [{ id: CHANGE, status: 'saved', tool: 'create_draft' }])
  assert.equal(done.usage?.usageIn, 1200)
  assert.equal(done.usage?.calls, 1)
  assert.equal(done.lastSeq, 15)
  assert.deepEqual(changesOfTools(done.turns[2].display as never), [CHANGE])
})

test('a reload re-attaches: the loaded turns and the replay from seq 0 never draw a turn or a word twice; a reconnect from lastSeq skips what it has', () => {
  // The page reloaded after seq 9: the conversation holds turns 1-2 (finished), the bus replays run, both turns, and the current deltas.
  const detail: ConversationDetail = {
    conversation: { id: CONV, title: 'Draft a post', providerId: 'pX', providerLabel: 'Test model (scripted)', providerAvailable: true, wire: 'chat', model: 'fake-model', effort: null, tools: 24, chatOnly: false, tokensWeighted: 0, createdAt: 1, updatedAt: 2 },
    turns: [
      { seq: 1, role: 'user', display: { kind: 'user', text: '起草一篇文章', continued: false, attachments: [] }, inHistory: true, runId: RUN, createdAt: 1 },
      { seq: 2, role: 'assistant', display: { kind: 'assistant', text: 'I will draft it.' }, inHistory: true, runId: RUN, createdAt: 2 },
    ],
    runs: [],
    active: null,
  }
  const loaded = followFromStart(fromConversation(detail), RUN)
  // What the bus keeps after a finished turn: run, turns, change/usage/notice, and the deltas since the last turn.
  const replay = [frames[0], frames[1], frames[6], frames[7], frames[8]]
  const attached = run(replay, loaded)
  assert.deepEqual(attached.turns.map((t) => t.seq), [1, 2], 'each finished turn once')
  assert.equal(attached.live?.tools.length, 1)
  // The connection drops; the view asks again from its last seq, and the overlap is skipped.
  const resumed = run([frames[8], frames[9], frames[10], ...frames.slice(11)], attached)
  assert.deepEqual(resumed.turns.map((t) => t.seq), [1, 2, 3, 4])
  assert.equal(resumed.live, null)
  // Seen twice (an overlapping replay): nothing doubles.
  const doubled = run(frames.slice(11), resumed)
  assert.equal(doubled.usage?.calls, 1)
  assert.equal(doubled.turns.length, 4)
  // A text delta seen twice in the same stream is applied once.
  const once = run([frames[0], frames[4], frames[4], frames[5]])
  assert.equal(once.live?.text, 'I will draft it.')
})

test('a Stop: the stopped text is a display-only turn, the end is stopped; Retry follows the next run fresh', () => {
  const stopped = run([
    frames[0],
    frames[1],
    f('text', 3, { delta: 'Half an ans' }),
    f('turn', 4, { seq: 2, role: 'assistant', display: { kind: 'assistant', text: 'Half an ans', stopped: true } }),
    f('run_end', 5, { state: 'stopped', reason: 'stopped', message: 'Stopped.' }),
  ])
  assert.equal(stopped.turns[1].inHistory, false)
  assert.equal(stopped.end?.state, 'stopped')
  assert.equal(lastHistoryRole(stopped.turns), 'user', 'Retry re-sends the message')
  const next = run([f('run', 1, { runId: 'r_cccccccccccccccccccc', conversationId: CONV })], stopped)
  assert.equal(next.lastSeq, 1, 'another run starts from its own first seq')
  assert.equal(next.end, null)
  assert.equal(next.turns.length, 2, 'the conversation stays')
})

test('cards come only from writes and proposals the server answered; a read naming a change is no card; a cut result still names its change', () => {
  const tools = (result: string, ok = true) => ({ kind: 'tools' as const, results: [{ id: 'x', name: 'n', title: null, ok, code: null, args: '{}', result }] })
  assert.deepEqual(changesOfTools(tools(`{"status":"waiting_for_owner","change_id":"${CHANGE}","review_url":"/admin/ai/change/${CHANGE}"}`)), [CHANGE])
  assert.deepEqual(changesOfTools(tools(`{"change_id":"${CHANGE}","state":"applied"}`)), [], 'get_change is a read')
  assert.deepEqual(changesOfTools(tools(`{"status":"saved","change_id":"${CHANGE}"}`, false)), [], 'a failed call is no card')
  assert.deepEqual(changesOfTools(tools(`{"status":"saved","saved_as":"draft","change_id":"${CHANGE}","x":"${'y'.repeat(5000)}…`)), [CHANGE], 'cut at 4 KB')
  assert.deepEqual(changesOfTools(tools('{"status":"saved","change_id":"ch_NOT-A-CHANGE"}')), [])
  assert.equal(lastUserText([{ seq: 1, role: 'user', display: { kind: 'user', text: 'first', continued: false, attachments: [] }, inHistory: true, runId: null, createdAt: 0 }, { seq: 3, role: 'user', display: { kind: 'user', text: 'second', continued: false, attachments: [] }, inHistory: true, runId: null, createdAt: 0 }], 3), 'first')
})

// ── The composer's keys ────────────────────────────────────────────────────

test('the composer: Enter sends, Shift+Enter breaks, an input method’s Enter never sends, touch Enter is a new line, Esc stops, ↑ recalls', () => {
  const idle = { composing: false, touch: false, running: false, empty: false }
  assert.equal(composerKey({ key: 'Enter' }, idle), 'send')
  assert.equal(composerKey({ key: 'Enter', shiftKey: true }, idle), 'none')
  assert.equal(composerKey({ key: 'Enter', altKey: true }, idle), 'none')
  assert.equal(composerKey({ key: 'Enter', isComposing: true }, idle), 'none', 'the Enter that confirms 你好')
  assert.equal(composerKey({ key: 'Enter', keyCode: 229 }, idle), 'none', 'a browser that reports composition as 229')
  assert.equal(composerKey({ key: 'Enter' }, { ...idle, composing: true }), 'none', 'between compositionstart and the tick after compositionend')
  assert.equal(composerKey({ key: 'Enter' }, { ...idle, touch: true }), 'none', 'touch: the button sends')
  assert.equal(composerKey({ key: 'Enter', metaKey: true }, { ...idle, touch: true }), 'send')
  assert.equal(composerKey({ key: 'Escape' }, { ...idle, running: true }), 'stop')
  assert.equal(composerKey({ key: 'Escape' }, idle), 'none')
  assert.equal(composerKey({ key: 'ArrowUp' }, { ...idle, empty: true }), 'recall')
  assert.equal(composerKey({ key: 'ArrowUp' }, idle), 'none', 'not while there is text')
  assert.equal(composerKey({ key: 'a' }, idle), 'none')
  // The component wires it: Enter only sends when it can, the box stays editable while a reply is written.
  const composer = read('components/Admin/ai/Composer.tsx')
  assert.match(composer, /composerKey\(e\.nativeEvent, \{ composing: composing\.current, touch, running, empty: value === '' \}\)/)
  assert.match(composer, /onCompositionEnd=\{\(\) => \{[\s\S]{0,200}window\.setTimeout\(\(\) => \{\s*composing\.current = false/)
  assert.match(composer, /if \(canSend\) onSend\(\)/)
  assert.doesNotMatch(composer, /isDisabled=\{running/, 'the box is never disabled while a reply is written')
  assert.doesNotMatch(composer, /autoFocus/, 'it never takes the focus by itself')
})

// ── How a run ends ─────────────────────────────────────────────────────────

test('a run’s end reads in the admin’s words with one action; the provider’s own words are plain text under it', () => {
  assert.equal(endView({ state: 'finished', reason: 'end', message: null }, 'P'), null)
  assert.equal(endView(null, 'P'), null)
  const auth = endView({ state: 'failed', reason: 'provider', message: 'The provider refused the key.', detail: { kind: 'auth', providerMessage: 'invalid x-api-key' } }, 'DeepSeek')
  assert.deepEqual([auth?.line, auth?.action, auth?.providerSaid], ['DeepSeek refused the key.', 'replace-key', 'invalid x-api-key'])
  assert.equal(endView({ state: 'failed', reason: 'provider', message: 'm', detail: { kind: 'billing' } }, 'DeepSeek')?.line, 'This key has no balance left at DeepSeek.')
  assert.equal(endView({ state: 'failed', reason: 'provider', message: 'm', detail: { kind: 'rate_limit', retryAfterMs: 20_000 } }, 'DeepSeek')?.line, 'DeepSeek is rate limiting this key. Try again in 20 sec.')
  assert.equal(endView({ state: 'failed', reason: 'provider', message: 'm', detail: { kind: 'network', output: true } }, 'P')?.line, 'The connection dropped. What arrived is kept above.')
  assert.equal(endView({ state: 'failed', reason: 'provider', message: 'm', detail: { kind: 'timeout', output: false } }, 'P')?.line, 'P didn’t answer.')
  assert.equal(endView({ state: 'limit', reason: 'steps', message: 'Paused after 16 steps.' }, 'P')?.action, 'continue')
  assert.equal(endView({ state: 'finished', reason: 'max_tokens', message: 'cut' }, 'P')?.action, 'continue')
  assert.equal(endView({ state: 'limit', reason: 'context', message: 'long' }, 'P')?.action, 'new-chat')
  assert.equal(endView({ state: 'limit', reason: 'budget-day', message: 'day' }, 'P')?.action, 'change-limit')
  assert.equal(endView({ state: 'stopped', reason: 'stopped', message: 'Stopped.' }, 'P')?.action, 'retry')
  assert.equal(endView({ state: 'stopped', reason: 'access-off', message: 'AI access was turned off.' }, 'P')?.action, null)
  assert.equal(endView({ state: 'interrupted', reason: null, message: null, stored: true }, 'P')?.line, ASSISTANT_COPY.end.interrupted)
  assert.equal(endView({ state: 'failed', reason: 'connection', message: null }, 'P')?.line, ASSISTANT_COPY.end.connection)
  // The panel renders the provider's words as text, never through ChatMarkdown.
  assert.match(read('components/Admin/ai/MessageList.tsx'), /\{view\.providerSaid\}/)
})

// ── Usage, language, suggestions ───────────────────────────────────────────

test('the per-answer usage line, counts, cost only as reported, usage per model for this month and today', () => {
  assert.deepEqual([compactCount(950), compactCount(2140), compactCount(12_400), compactCount(1_250_000), compactCount(25_000_000)], ['950', '2.1k', '12k', '1.3M', '25M'])
  assert.equal(usageLine({ usageIn: 2000, cachedRead: 1800, cacheWrite: 140, usageOut: 340, reasoning: 0, estimated: false, calls: 2, runWeighted: 0 }), '↑ 2.1k ↓ 340 · cached 1.8k')
  assert.equal(usageLine({ usageIn: 0, cachedRead: 0, cacheWrite: 0, usageOut: 300, reasoning: 0, estimated: true, calls: 1, runWeighted: 0 }), '↓ ~300', 'no “↑ 0” when nothing was reported')
  assert.equal(usageLine(null), null)
  const now = Date.UTC(2026, 10, 7, 12)
  const row = (day: string, model: string, extra: Partial<UsageRow> = {}): UsageRow => ({ day, providerId: 'p1', providerLabel: 'DeepSeek', model, calls: 1, usageIn: 100, cachedRead: 0, cacheWrite: 0, usageOut: 10, reasoning: 0, weighted: 110, reportedMicroUsd: null, estimatedCalls: 0, ...extra })
  const rows = [row('2026-11-07', 'a', { reportedMicroUsd: 1000 }), row('2026-11-03', 'a', { reportedMicroUsd: null }), row('2026-11-07', 'b', { reportedMicroUsd: 2500, weighted: 500 }), row('2026-10-31', 'a')]
  const month = usageByModel(rows, 'month', now)
  assert.deepEqual(month.map((r) => [r.model, r.calls, r.reportedMicroUsd]), [['b', 1, 2500], ['a', 2, null]], 'a partial cost is no cost; October is not this month')
  assert.deepEqual(usageByModel(rows, 'today', now).map((r) => [r.model, r.reportedMicroUsd]), [['b', 2500], ['a', 1000]])
  assert.equal(formatCost(2500), '<$0.01')
  assert.equal(formatCost(420_000), '$0.42')
})

test('a message in Chinese is marked zh-Hans; suggestions follow the browser’s language and appear only while their fact is true', () => {
  assert.equal(messageLang('起草一篇关于 SWCS 的文章'), 'zh-Hans')
  assert.equal(messageLang('Draft a post about SWCS'), undefined)
  assert.equal(messageLang(''), undefined)
  assert.equal(promptLang(['zh-CN', 'en']), 'zh')
  assert.equal(promptLang(['en-GB', 'zh-CN']), 'en')
  assert.equal(promptLang([]), 'en')
  const none = { drafts: 0, published: 0, aboutEmpty: false, missingAlt: 0, healthIssues: 0 }
  assert.deepEqual(suggestedPrompts(none, 'en'), [PROMPT_COPY.en.changed], 'only the always-true one')
  const unknown = { drafts: null, published: null, aboutEmpty: null, missingAlt: null, healthIssues: null }
  assert.deepEqual(suggestedPrompts(unknown, 'en'), [PROMPT_COPY.en.changed], 'an unknown fact shows nothing')
  const all = suggestedPrompts({ drafts: 3, published: 5, aboutEmpty: true, missingAlt: 2, healthIssues: 4 }, 'zh')
  assert.equal(all.length, 4, 'at most four')
  assert.equal(all[0], '我的 3 篇草稿里哪篇最接近完成？还缺什么？')
  assert.ok(all.includes('逐一查看这 4 个内容问题，并提出修复方案。'))
  // No suggestion needs a tool the catalogue lacks (the CV readiness prompt is the editors' entry point, design §8.4).
  assert.ok(!Object.keys(PROMPT_COPY.en).includes('cv'))
})

test('the Assistant tile: the model new chats use and its state, or that none is set up', () => {
  assert.deepEqual(assistantTile(null), { label: 'Assistant', value: '—', sub: MODELS_COPY.strip.unreadable })
  assert.deepEqual(assistantTile({ models: 0, defaultModel: null, running: null, canStoreKeys: true }), { label: 'Assistant', value: 'Not set up', sub: 'add a model' })
  assert.deepEqual(assistantTile({ models: 1, defaultModel: { providerId: 'p', label: 'Claude', model: 'claude-opus-5-5', status: 'ready' }, running: null, canStoreKeys: true }), { label: 'Assistant', value: 'Claude', sub: 'claude-opus-5-5 · ready' })
  assert.equal(assistantTile({ models: 1, defaultModel: { providerId: 'p', label: 'Claude', model: 'm', status: 'chat-only' }, running: { runId: 'r', conversationId: 'c' }, canStoreKeys: true }).sub, 'm · writing an answer now')
})

// ── Voice and boundary ─────────────────────────────────────────────────────

test('the assistant’s and Models’ words keep the admin’s voice: no exclamation marks, curly quotes, no server secret named', () => {
  const strings: string[] = []
  const walk = (v: unknown) => {
    if (typeof v === 'string') strings.push(v)
    else if (typeof v === 'function') {
      for (const args of [[2, 2], ['Example', 'example.com']]) {
        const out = (v as (...a: unknown[]) => unknown)(...args)
        if (typeof out === 'string') strings.push(out)
      }
    } else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  walk(ASSISTANT_COPY)
  walk(MODELS_COPY)
  walk(PROMPT_COPY)
  walk(CHAT_MD_COPY)
  assert.ok(strings.length > 200, `the copy was walked (${strings.length})`)
  for (const s of strings) {
    assert.doesNotMatch(s, /!(?!=)/, s)
    assert.doesNotMatch(s, /(^|\s)"|"(\s|$|[.,])/, `straight double quotes: ${s}`)
    assert.doesNotMatch(s, /(^|\s)'|'(\s|$|[.,])/, `straight single quotes: ${s}`)
    assert.doesNotMatch(s, /AI_KEYS_SECRET|JWT_SECRET/, s)
  }
  // The never-sent list is design §8.5's.
  for (const w of ['Inbox', 'analytics', 'error reports', 'system logs', 'hidden CV fields', 'phone', 'e-mail', 'passwords', 'passkeys', 'tokens', 'API keys', 'backups']) assert.match(MODELS_COPY.leaves.neverList, new RegExp(w), w)
  assert.equal(ASSISTANT_COPY.header.privacy('DeepSeek', 'api.deepseek.com'), 'Your messages and what the tools read go to DeepSeek (api.deepseek.com).')
  assert.equal(MODELS_COPY.remove.body('DeepSeek'), 'The key is deleted from this server. Also revoke it at DeepSeek. Past conversations stay readable, but can’t go on with this model.')
})

test('the assistant and Models load with the page through dynamic(); nothing under components/Admin/ai reaches the server; the assistant is the default view', () => {
  const page = read('pages/admin/ai.tsx')
  for (const panel of ['AssistantPanel', 'ChangesPanel', 'ConnectionsPanel', 'ModelsPanel']) {
    assert.match(page, new RegExp(`dynamic\\(\\(\\) => import\\('\\.\\./\\.\\./components/Admin/ai/${panel}'\\), \\{\\s*ssr: false`), panel)
  }
  assert.match(page, /const DEFAULT_VIEW: View = 'assistant'/)
  assert.match(page, /const AI_VIEWS = \['assistant', 'changes', 'connections', 'models'\] as const/)
  const files = fs.readdirSync(path.join(ROOT, 'components/Admin/ai')).map((f) => rel(path.join(ROOT, 'components/Admin/ai', f)))
  const graph = reachable(files)
  const server = Array.from(graph.entries())
    .filter(([f]) => /^lib\/(ai|mcp)\//.test(f) || /^pages\/api\//.test(f))
    .map(([, chain]) => chain.join(' -> '))
  assert.deepEqual(server, [], 'client code reaches server modules')
  assert.ok(graph.has('components/Admin/ai/AssistantPanel.tsx') && graph.has('components/Admin/ai/ModelsPanel.tsx'), 'sanity: the graph was walked')
  // A reply is drawn only by ChatMarkdown; the tool rows and the end notice are plain text.
  assert.match(read('components/Admin/ai/MessageList.tsx'), /<ChatMarkdown text=\{text\}/)
  for (const f of ['ToolRow.tsx', 'ProbeResult.tsx', 'ConversationRail.tsx']) assert.doesNotMatch(read(`components/Admin/ai/${f}`), /ChatMarkdown|dangerouslySetInnerHTML/, f)
  // The chord's label names the destination (PRODUCT §3).
  assert.match(read('components/Admin/shell/adminCommands.ts'), /\{ key: 'j', href: '\/admin\/ai', label: 'AI assistant'/)
})
