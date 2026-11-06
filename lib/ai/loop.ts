import type { Logger } from '../log'
import type { BusEventType } from './bus'
import { appendTurn, countRun, loadNative, recordUsage, retireTurn, rewriteNative, snapshotOf, type Conversation } from './conversations'
import type { ToolResult } from './execute'
import { INTERRUPTED_SENTINEL, withoutThinkingFrom } from './providers/anthropic'
import { estimateTokens, ProviderError, weightedOf, type ModelAdapter, type ModelEvent, type NativeTurn, type ToolAnswer, type ToolCall, type Usage } from './providers/types'
import { toolByName } from './registry'
import { CAPS, type Reservation, type RunBudget } from './runBudget'

/**
 * The agent loop (SERVER-ONLY, design §7.5): provider-neutral, one model
 * turn at a time, tools only after a turn ended cleanly.
 *
 *   for each step (at most 16):
 *     authority still holds? budget allows a call? reserve its output limit
 *     stream one turn → events to the run's viewers
 *     no terminal event      → error, never run tools
 *     refusal / filter       → nothing of the turn is kept; the run ends
 *     max_tokens with a call → never run it; retry once with a larger limit
 *     save the COMPLETE turn (only complete turns are ever saved)
 *     no tool calls          → done
 *     run every call through executeTool, in order; all results in ONE turn
 *   past the step limit: "Paused after 16 steps." — history valid, Continue
 *
 * Never persisted: a partial assistant turn (an orphan tool call breaks every
 * later request). So re-issuing a failed turn never runs a tool twice.
 *
 * Stop (or the kill switch, or the session ending) aborts the stream: the
 * partial text is kept for the owner as display-only "(stopped)"; a tool
 * already running finishes atomically, its unstarted siblings get
 * `cancelled by user` results so the history stays valid, and proposals stay
 * waiting.
 *
 * Retries: the transport retries before streaming; a stream that dies before
 * any output is re-issued once; a malformed tool call the model produced
 * (unparseable eager JSON, Groq's failed_generation) is re-issued, at most 2
 * in a row; a 400 on an output limit is re-issued once without it; Claude's
 * refused thinking block is dropped once (logged as a bug). Invalid
 * arguments on a completed call go back as an error result, at most 2 in a
 * row per tool. Tool failures are never retried here.
 */

export type StopCause = 'stopped' | 'access-off' | 'session-ended'

export type RunEnd = {
  state: 'finished' | 'stopped' | 'limit' | 'failed'
  /** Machine reason: end, max_tokens, steps, budget-run, budget-conversation, budget-day, context, refusal, loop, invalid-args, provider, stopped, access-off, session-ended. */
  reason: string
  /** What the owner reads (plain text). */
  message: string | null
  /** Provider failures: what the provider said, already scrubbed (plain text). */
  detail?: Record<string, unknown>
}

export type LoopDeps = {
  runId: string
  conversation: Conversation
  adapter: ModelAdapter
  budget: RunBudget
  providerId: string
  /** The owner's message turn of this run, if any (rolled back when the model declines at once). */
  userTurnSeq: number | null
  /** The run's abort signal (Stop, kill switch, session end) and why it fired. */
  signal: AbortSignal
  stopCause: () => StopCause | null
  /** Re-checked before every model call: why this run may not go on, or null. */
  authority: () => StopCause | null
  /** Runs one tool for this run (executeTool with the assistant's context). */
  runTool: (name: string, args: unknown) => Promise<ToolResult>
  emit: (type: BusEventType, data: Record<string, unknown>) => void
  log: Logger
  now?: () => number
}

const STOP_MESSAGES: Record<StopCause, string> = {
  stopped: 'Stopped.',
  'access-off': 'AI access was turned off.',
  'session-ended': 'This browser’s session ended.',
}

const RESULT_PREVIEW_MAX = 4096
const ARGS_PREVIEW_MAX = 2048

function preview(text: string, max: number): string {
  if (text.length <= max) return text
  // Never split a surrogate pair.
  let end = max
  const code = text.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end--
  return `${text.slice(0, end)}…`
}

/** A tool call's arguments, parsed strictly (`""` is `{}`), or null when they are not a JSON object. */
export function parseArgs(argsText: string): Record<string, unknown> | null {
  if (argsText.trim() === '') return {}
  try {
    const v = JSON.parse(argsText)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const errorText = (code: string, message: string) => JSON.stringify({ error: { code, message } })

/** The change a tool result names (a draft write or a proposal), to tell the viewers. */
function changeOf(text: string): { id: string; status: string | null } | null {
  try {
    const v = JSON.parse(text)
    if (v && typeof v === 'object' && typeof v.change_id === 'string' && /^ch_[a-z2-7]{16}$/.test(v.change_id)) {
      return { id: v.change_id, status: typeof v.status === 'string' ? v.status.slice(0, 40) : null }
    }
  } catch {
    // Not JSON: no change.
  }
  return null
}

type TurnEnd = Extract<ModelEvent, { type: 'turn_end' }>

type Attempt =
  | { ok: true; turn: TurnEnd; usage: Usage | null; estimated: boolean; text: string; thinking: string[]; notices: Array<{ from: string; to: string }> }
  | { ok: false; error: ProviderError; text: string; output: boolean }

export async function runLoop(d: LoopDeps): Promise<RunEnd> {
  const conv = d.conversation
  const snapshot = snapshotOf(conv)
  const clock = d.now ?? Date.now
  let toolCallsThisRun = 0
  let pauses = 0
  let assistantTurns = 0
  const invalidInARow = new Map<string, number>()

  const stopped = (partial: string): RunEnd => {
    const cause = d.stopCause() ?? 'stopped'
    if (partial.trim()) {
      const seq = appendTurn(conv.id, 'assistant', null, { kind: 'assistant', text: partial, stopped: true }, d.runId, clock())
      d.emit('turn', { seq, role: 'assistant', display: { kind: 'assistant', text: partial, stopped: true } })
    }
    return { state: 'stopped', reason: cause, message: STOP_MESSAGES[cause] }
  }

  /** Stream one model call and collect its turn; never throws. */
  async function attempt(maxOutput: number | undefined): Promise<Attempt> {
    const native = loadNative(conv.id).map((t) => t.native)
    let text = ''
    let output = false
    const thinking: string[] = []
    const notices: Array<{ from: string; to: string }> = []
    let usage: Usage | null = null
    let estimated = false
    let turn: TurnEnd | null = null
    try {
      for await (const e of d.adapter.stream({ conv: snapshot, native, maxOutput, signal: d.signal })) {
        switch (e.type) {
          case 'text':
            output = true
            text += e.delta
            d.emit('text', { delta: e.delta })
            break
          case 'thinking':
            output = true
            if (thinking.length && e.kind !== 'update') thinking[thinking.length - 1] += e.delta
            else thinking.push(e.delta)
            d.emit('thinking', { delta: e.delta, kind: e.kind })
            break
          case 'tool_call_start':
            output = true
            break
          case 'tool_call_delta':
            break
          case 'notice':
            notices.push({ from: e.from, to: e.to })
            d.emit('notice', { kind: 'fallback', from: e.from, to: e.to })
            break
          case 'usage':
            usage = e.usage
            estimated = e.estimated
            break
          case 'turn_end':
            turn = e
            break
        }
      }
    } catch (err) {
      const error = err instanceof ProviderError ? err : new ProviderError('unknown', err instanceof Error ? err.message : String(err))
      return { ok: false, error: d.signal.aborted ? new ProviderError('aborted', 'The request was cancelled') : error, text, output }
    }
    if (d.signal.aborted) return { ok: false, error: new ProviderError('aborted', 'The request was cancelled'), text, output }
    if (!turn) return { ok: false, error: new ProviderError('network', 'The stream ended without a terminal event.', { retryable: true }), text, output }
    return { ok: true, turn, usage, estimated, text, thinking, notices }
  }

  /** Settle a call's reservation with what it really cost, and record it. */
  function account(r: Reservation, usage: Usage | null, estimated: boolean, fallbackText: string): void {
    const at = clock()
    if (usage) {
      const weighted = weightedOf(usage)
      d.budget.settle(r, weighted)
      recordUsage({ providerId: d.providerId, model: conv.model, conversationId: conv.id, runId: d.runId, usage, weighted, estimated, at })
      d.emit('usage', { usageIn: usage.input, cachedRead: usage.cachedRead, cacheWrite: usage.cacheWrite, usageOut: usage.output, reasoning: usage.reasoning, weighted, estimated, runWeighted: d.budget.used })
      return
    }
    // No usage (a stop, a dropped stream): the reservation stays charged — hidden reasoning was spent.
    d.budget.settle(r, null)
    const out = estimateTokens(fallbackText)
    recordUsage({
      providerId: d.providerId,
      model: conv.model,
      conversationId: conv.id,
      runId: d.runId,
      usage: { input: 0, cachedRead: 0, cacheWrite: 0, output: out, reasoning: 0, reportedMicroUsd: null },
      weighted: r.amount,
      estimated: true,
      at,
    })
    d.emit('usage', { usageIn: 0, cachedRead: 0, cacheWrite: 0, usageOut: out, reasoning: 0, weighted: r.amount, estimated: true, runWeighted: d.budget.used })
  }

  /** A failure the provider answered with an HTTP status generated nothing: its reservation is refunded. */
  function refund(r: Reservation): void {
    d.budget.settle(r, 0)
  }

  let raised = false
  for (let step = 0; step < CAPS.modelTurnsPerRun; ) {
    const cause = d.authority()
    if (cause) return { state: 'stopped', reason: cause, message: STOP_MESSAGES[cause] }
    if (d.signal.aborted) return stopped('')

    // One model turn, with the re-issues the design allows.
    let omitLimit = false
    let reissues = 0
    let streamRetried = false
    let thinkingRecovered = false
    let result: Attempt
    for (;;) {
      const c = d.budget.clamp({ raised, omitLimit })
      if (!c.ok) {
        return { state: 'limit', reason: `budget-${c.stop.kind}`, message: c.stop.message, ...(c.stop.retryAt ? { detail: { retryAt: c.stop.retryAt } } : {}) }
      }
      const r = d.budget.reserve(c.clamp.reserve)
      result = await attempt(c.clamp.maxOutput)
      if (result.ok) {
        account(r, result.usage, result.estimated, result.text)
        break
      }
      const err = result.error
      if (err.kind === 'aborted' || d.signal.aborted) {
        account(r, null, true, result.text)
        return stopped(result.text)
      }
      if (err.status !== null && !result.output) refund(r)
      else account(r, null, true, result.text)

      if (err.reissue && reissues < 2) {
        reissues++
        d.emit('notice', { kind: 'reissue', message: 'The model produced a malformed tool call; asking again.' })
        continue
      }
      if (err.badThinkingBlock && !thinkingRecovered && conv.wire === 'anthropic') {
        thinkingRecovered = true
        const stored = loadNative(conv.id)
        const [m, b] = err.badThinkingBlock
        if (m < stored.length) {
          const stripped = withoutThinkingFrom(stored.map((t) => t.native), m, b)
          rewriteNative(conv.id, stored.map((t, i) => ({ seq: t.seq, native: stripped[i] as NativeTurn })).filter((_, i) => i >= m))
          // The API refused a block this site replayed unchanged: a bug to look at, never a model's fault.
          d.log.error('Claude refused a replayed thinking block; it was dropped and the turn re-issued', { conversationId: conv.id, runId: d.runId, message: m, block: b })
          continue
        }
      }
      if (err.sentOutputLimit && err.kind === 'bad_request' && conv.wire !== 'anthropic' && !omitLimit) {
        omitLimit = true
        d.emit('notice', { kind: 'output_limit', message: 'This model refused that output length. Set a lower maximum in Models.' })
        continue
      }
      if (err.retryable && !result.output && !streamRetried) {
        streamRetried = true
        d.emit('notice', { kind: 'retry', message: 'The connection to the model dropped; trying once more.' })
        continue
      }
      if (result.text.trim()) {
        const seq = appendTurn(conv.id, 'assistant', null, { kind: 'assistant', text: result.text, failed: true }, d.runId, clock())
        d.emit('turn', { seq, role: 'assistant', display: { kind: 'assistant', text: result.text, failed: true } })
      }
      return {
        state: 'failed',
        reason: 'provider',
        message: err.message,
        detail: { kind: err.kind, status: err.status, providerMessage: err.providerMessage, requestId: err.requestId, retryAfterMs: err.retryAfterMs, output: result.output },
      }
    }

    const { turn, text, thinking, notices } = result
    countRun(d.runId, { modelTurns: 1 })

    if (turn.stop === 'refusal' || turn.stop === 'content_filter') {
      // Never run that turn's tools; nothing of it enters the history.
      const declined = { kind: 'declined', category: turn.refusal?.category ?? null, explanation: turn.refusal?.explanation ?? null, filter: turn.stop === 'content_filter' }
      // Declined at once: the message leaves the history too, so the next one does not carry it.
      if (assistantTurns === 0 && d.userTurnSeq !== null) retireTurn(conv.id, d.userTurnSeq, { declined: true })
      const seq = appendTurn(conv.id, 'assistant', null, declined, d.runId, clock())
      d.emit('turn', { seq, role: 'assistant', display: declined })
      return { state: 'finished', reason: 'refusal', message: turn.stop === 'refusal' ? 'The model declined this request.' : 'The provider’s content filter stopped this answer.', detail: { category: declined.category, explanation: declined.explanation } }
    }

    if (turn.stop === 'max_tokens' && turn.toolCalls.length) {
      // A tool input cut off at the limit usually parses: never run it. Retry the turn once with more room.
      if (!raised) {
        raised = true
        d.emit('notice', { kind: 'max_tokens_retry', message: 'The answer ran out of room inside a tool call; asking again with more.' })
        continue
      }
      return { state: 'failed', reason: 'max_tokens', message: 'The model ran out of output room in the middle of a tool call, twice. Nothing was run.' }
    }

    if (turn.stop === 'context_overflow') {
      if (text.trim()) {
        const seq = appendTurn(conv.id, 'assistant', null, { kind: 'assistant', text, stopped: true }, d.runId, clock())
        d.emit('turn', { seq, role: 'assistant', display: { kind: 'assistant', text, stopped: true } })
      }
      return { state: 'limit', reason: 'context', message: 'This conversation is longer than the model can read. Start a new conversation to go on.' }
    }

    // A complete turn: saved exactly as the provider produced it.
    const display = {
      kind: 'assistant',
      text,
      thinking,
      notices,
      stop: turn.stop,
      stoppedEarly: text.endsWith(INTERRUPTED_SENTINEL),
      toolCalls: turn.toolCalls.map((c) => ({ id: c.id, name: c.name, title: toolByName(c.name)?.title ?? null })),
    }
    const seq = appendTurn(conv.id, 'assistant', turn.native, display, d.runId, clock())
    assistantTurns++
    raised = false
    step++
    d.emit('turn', { seq, role: 'assistant', display })

    if (turn.stop === 'paused') {
      if (++pauses > CAPS.pauseResends) return { state: 'limit', reason: 'paused', message: 'The model paused its turn too many times.' }
      continue
    }
    if (turn.stop === 'max_tokens') return { state: 'finished', reason: 'max_tokens', message: 'The answer was cut off at its length limit. Continue asks for the rest.' }
    if (turn.stop !== 'tool_calls' || !turn.toolCalls.length) return { state: 'finished', reason: 'end', message: null }

    // Tools: in order, one at a time; every call gets a result, so the history stays valid.
    const answers: ToolAnswer[] = []
    const rows: Array<Record<string, unknown>> = []
    let loopStopped: string | null = null
    let invalidStop: string | null = null
    for (let i = 0; i < turn.toolCalls.length; i++) {
      const call: ToolCall = turn.toolCalls[i]
      const title = toolByName(call.name)?.title ?? null
      let text: string
      let okFlag = false
      let code: string | null = null
      if (d.signal.aborted) {
        text = errorText('CANCELLED', 'cancelled by user')
        code = 'CANCELLED'
      } else if (i >= CAPS.toolCallsPerTurn || toolCallsThisRun >= CAPS.toolCallsPerRun) {
        text = errorText('BUDGET', i >= CAPS.toolCallsPerTurn ? `At most ${CAPS.toolCallsPerTurn} tool calls per turn: this one was not run.` : `At most ${CAPS.toolCallsPerRun} tool calls per run: this one was not run.`)
        code = 'BUDGET'
      } else {
        const args = parseArgs(call.argsText)
        if (args === null) {
          // Built with JSON.stringify, so quotes in the bad input are escaped (the skill's INVALID_JSON shape).
          text = JSON.stringify({ INVALID_JSON: preview(call.argsText, 8192) })
          code = 'INVALID_JSON'
        } else {
          toolCallsThisRun++
          countRun(d.runId, { toolCalls: 1 })
          d.emit('tool_start', { id: call.id, name: call.name, title })
          const res = await d.runTool(call.name, args)
          text = res.text
          okFlag = res.ok
          code = res.code
          d.emit('tool_end', { id: call.id, name: call.name, title, ok: res.ok, code: res.code })
          const change = changeOf(res.text)
          if (change) d.emit('change', { id: change.id, status: change.status, tool: call.name })
          if (res.code === 'LOOP_STOPPED') loopStopped = call.name
        }
      }
      if (code === 'INVALID_JSON' || code === 'INVALID_INPUT') {
        const n = (invalidInARow.get(call.name) ?? 0) + 1
        invalidInARow.set(call.name, n)
        if (n > 2) invalidStop = call.name
      } else if (code !== 'CANCELLED' && code !== 'BUDGET') invalidInARow.set(call.name, 0)
      answers.push({ id: call.id, name: call.name, text, isError: !okFlag })
      rows.push({ id: call.id, name: call.name, title, ok: okFlag, code, args: preview(call.argsText, ARGS_PREVIEW_MAX), result: preview(text, RESULT_PREVIEW_MAX) })
    }
    const resultsSeq = appendTurn(conv.id, 'tool', d.adapter.toolResultsTurn(answers), { kind: 'tools', results: rows }, d.runId, clock())
    d.emit('turn', { seq: resultsSeq, role: 'tool', display: { kind: 'tools', results: rows } })

    if (d.signal.aborted) return stopped('')
    if (loopStopped) return { state: 'limit', reason: 'loop', message: `The model called ${loopStopped} with the same arguments too many times, so the run stopped.` }
    if (invalidStop) return { state: 'failed', reason: 'invalid-args', message: `The model kept sending invalid arguments to ${invalidStop}, so the run stopped.` }
  }
  return { state: 'limit', reason: 'steps', message: `Paused after ${CAPS.modelTurnsPerRun} steps.` }
}
