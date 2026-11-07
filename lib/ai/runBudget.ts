import { getAiDb } from './db'
import { addConversationTokens } from './conversations'
import type { Wire } from './providers/types'

/**
 * The assistant's spending brakes (SERVER-ONLY, design §7.7). Weighted
 * tokens (`input + cacheWrite + output + 0.1 × cachedRead`) are a runaway
 * brake, not a bill: prices are not in code.
 *
 *   model turns per run          16       "Paused after 16 steps." + Continue
 *   tool calls per run / turn    40 / 16  extras get an error result
 *   weighted tokens per run      300k     stops with history valid
 *   per conversation             400k     offers a new conversation
 *   per day, all conversations   ai_settings.daily_token_limit (2M default,
 *                                20M code ceiling); pauses until the next UTC day
 *
 * Reserve before each call: the call's output limit — or 64,000 when none is
 * sent — is added to the persisted day counter (ai.db `ai_counters`) and the
 * conversation's count before the request leaves, and the difference is
 * refunded when real usage arrives. A process that dies mid-call therefore
 * errs on the safe side, and after a Stop with no usage the reservation stays
 * charged, because hidden reasoning was spent. Missing usage is estimated at
 * UTF-8 bytes / 3 (marked estimated) and counts against every cap.
 */

export const CAPS = Object.freeze({
  modelTurnsPerRun: 16,
  toolCallsPerRun: 40,
  toolCallsPerTurn: 16,
  runTokens: 300_000,
  conversationTokens: 400_000,
  /** Reserved when a call sends no output limit (and Claude's own ceiling per call, §7.2). */
  defaultReservation: 64_000,
  /** Below this much left, stop rather than send a request that spends everything on reasoning. */
  reasoningFloor: 25_000,
  /** pause_turn re-sends per run (Claude, §7.2). */
  pauseResends: 5,
})

const DAY_KEY = 'assistant-weighted|day'
const DAY_MS = 86_400_000
const dayStart = (now: number) => Math.floor(now / DAY_MS) * DAY_MS

/** Weighted tokens charged today (UTC), reservations included. */
export function dayUsed(now = Date.now()): number {
  const r = getAiDb().prepare('SELECT n FROM ai_counters WHERE key = ? AND window_start = ?').get(DAY_KEY, dayStart(now)) as { n: number } | undefined
  return Number(r?.n ?? 0)
}

function chargeDay(delta: number, now: number): void {
  if (!delta) return
  const db = getAiDb()
  const start = dayStart(now)
  db.transaction(() => {
    db.prepare('INSERT INTO ai_counters (key, window_start, n) VALUES (?, ?, ?) ON CONFLICT (key, window_start) DO UPDATE SET n = MAX(0, n + excluded.n)').run(DAY_KEY, start, Math.round(delta))
    // Earlier days are history only: the counter table keeps today.
    db.prepare('DELETE FROM ai_counters WHERE key = ? AND window_start < ?').run(DAY_KEY, start)
  }).immediate()
}

/** Add a model call's weighted tokens to today's counter outside a run (the provider Test). */
export function chargeDayCounter(weighted: number, now = Date.now()): void {
  chargeDay(Math.max(0, Math.round(weighted)), now)
}

export type BudgetStop ={ kind: 'run' | 'conversation' | 'day' | 'floor'; message: string; retryAt: number | null }

export type Clamp = {
  /** The output limit to send (undefined: send none — chat and responses wires only). */
  maxOutput: number | undefined
  /** What to reserve for this call. */
  reserve: number
}

export type Reservation = { amount: number; at: number; settled: boolean }

export type RunBudgetInput = {
  conversationId: string
  conversationUsed: number
  dayLimit: number
  wire: Wire
  /** The owner's maximum output for this key (chat and responses), or null. */
  maxOutputTokens: number | null
  /** The model's own output cap from the provider (Claude's Models API), or null. */
  modelCap: number | null
  now?: () => number
}

export class RunBudget {
  readonly conversationId: string
  private runUsed = 0
  private conversationUsed: number
  private readonly dayLimit: number
  private readonly wire: Wire
  private readonly maxOutputTokens: number | null
  private readonly modelCap: number | null
  private readonly clock: () => number

  constructor(input: RunBudgetInput) {
    this.conversationId = input.conversationId
    this.conversationUsed = input.conversationUsed
    this.dayLimit = input.dayLimit
    this.wire = input.wire
    this.maxOutputTokens = input.maxOutputTokens
    this.modelCap = input.modelCap
    this.clock = input.now ?? Date.now
  }

  /** Weighted tokens this run has used, reservations included. */
  get used(): number {
    return this.runUsed
  }

  /** What is left before the tightest cap. */
  remaining(): { tokens: number; cap: BudgetStop['kind'] } {
    const now = this.clock()
    const left: Array<[number, BudgetStop['kind']]> = [
      [CAPS.runTokens - this.runUsed, 'run'],
      [CAPS.conversationTokens - this.conversationUsed, 'conversation'],
      [this.dayLimit - dayUsed(now), 'day'],
    ]
    left.sort((a, b) => a[0] - b[0])
    return { tokens: Math.max(0, left[0][0]), cap: left[0][1] }
  }

  private stopFor(cap: BudgetStop['kind']): BudgetStop {
    const now = this.clock()
    switch (cap) {
      case 'run':
        return { kind: 'run', message: 'This run used its token budget. Continue starts a new run with the history kept.', retryAt: null }
      case 'conversation':
        return { kind: 'conversation', message: 'This conversation used its token budget. Start a new conversation to go on.', retryAt: null }
      case 'day':
        return { kind: 'day', message: 'Today’s token limit for the assistant is used up. It resets at midnight UTC.', retryAt: dayStart(now) + DAY_MS }
      default:
        return { kind: 'floor', message: 'Too little of the token budget is left for a useful answer.', retryAt: null }
    }
  }

  /**
   * The output limit for the next call (§7.7), or why no call may start.
   *
   *   Claude: always sent, min(64,000, the model's cap, what is left).
   *   Chat / Responses: omitted, unless the owner set a maximum for the key
   *   or what is left is below `maxOutputTokens ?? 64,000` — then
   *   min(maxOutputTokens, what is left).
   *   Floor: with less than min(25,000, maxOutputTokens ?? 25,000) left,
   *   stop with a clear message.
   */
  clamp(opts: { raised?: boolean; omitLimit?: boolean } = {}): { ok: true; clamp: Clamp } | { ok: false; stop: BudgetStop } {
    const { tokens, cap } = this.remaining()
    const ownerMax = this.wire === 'anthropic' ? this.modelCap : this.maxOutputTokens
    const floor = Math.min(CAPS.reasoningFloor, ownerMax ?? CAPS.reasoningFloor)
    if (tokens < floor) return { ok: false, stop: this.stopFor(cap) }
    if (this.wire === 'anthropic') {
      // A turn cut at max_tokens with a tool call is retried once with the model's whole cap (still within budget).
      const ceiling = opts.raised ? (this.modelCap ?? CAPS.defaultReservation * 2) : Math.min(CAPS.defaultReservation, this.modelCap ?? CAPS.defaultReservation)
      const maxOutput = Math.max(1, Math.min(ceiling, tokens))
      return { ok: true, clamp: { maxOutput, reserve: maxOutput } }
    }
    const limit = this.maxOutputTokens ?? CAPS.defaultReservation
    if (!opts.omitLimit && (this.maxOutputTokens !== null || tokens < limit)) {
      const maxOutput = Math.max(1, Math.min(limit, tokens))
      return { ok: true, clamp: { maxOutput, reserve: maxOutput } }
    }
    // No limit sent: the reservation is the default, which must still fit.
    if (tokens < CAPS.defaultReservation) return { ok: false, stop: { ...this.stopFor(cap), kind: 'floor', message: 'Too little of the token budget is left to send a request without an output limit.' } }
    return { ok: true, clamp: { maxOutput: undefined, reserve: CAPS.defaultReservation } }
  }

  /** Charge `amount` before a call leaves: day counter, conversation and run. */
  reserve(amount: number): Reservation {
    const at = this.clock()
    chargeDay(amount, at)
    addConversationTokens(this.conversationId, amount)
    this.conversationUsed += amount
    this.runUsed += amount
    return { amount, at, settled: false }
  }

  /**
   * Replace a reservation with what the call really cost. `weighted` null
   * (no usage at all — a Stop, a dropped stream) keeps the reservation.
   */
  settle(r: Reservation, weighted: number | null): void {
    if (r.settled) return
    r.settled = true
    if (weighted === null) return
    const delta = weighted - r.amount
    chargeDay(delta, r.at)
    addConversationTokens(this.conversationId, delta)
    this.conversationUsed += delta
    this.runUsed += delta
  }
}
