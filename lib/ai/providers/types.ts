/**
 * The provider layer's shapes (SERVER-ONLY, design §7.1). Three wires, one
 * contract: an adapter streams one model turn as provider-neutral events and
 * hands back the turn in the provider's own replay format (`NativeTurn`),
 * which only that adapter ever reads. History is never translated between
 * providers: a conversation pins provider, model, wire, system text and tool
 * list when it starts.
 */

export type Wire = 'anthropic' | 'responses' | 'chat'
export const WIRES: readonly Wire[] = ['anthropic', 'responses', 'chat']

/** Why a model turn ended, normalised across the three wires. */
export type StopKind = 'end' | 'tool_calls' | 'max_tokens' | 'paused' | 'refusal' | 'content_filter' | 'context_overflow'

/**
 * Token counts of one model call. `input` is UNCACHED input (Anthropic's
 * input_tokens; the other wires report cached tokens inside their input
 * count and the adapter subtracts them). Field names avoid "token", which
 * the logger redacts by name (lib/log SECRET_KEY).
 */
export type Usage = {
  input: number
  cachedRead: number
  cacheWrite: number
  output: number
  /** Reasoning tokens when the provider reports them (already inside `output`). */
  reasoning: number
  /** Cost the provider itself reported, in micro-dollars (OpenRouter `usage.cost`, xAI `cost_in_usd_ticks`); null otherwise. */
  reportedMicroUsd: number | null
}

export const ZERO_USAGE: Usage = Object.freeze({ input: 0, cachedRead: 0, cacheWrite: 0, output: 0, reasoning: 0, reportedMicroUsd: null })

/** JSON only its adapter reads. Stored verbatim in ai_turns.native_json. */
export type NativeTurn = unknown

/** A tool call as the model made it. `argsText` stays raw, so the loop validates every wire the same way. */
export type ToolCall = { id: string; name: string; argsText: string }

/** One tool's answer, as the loop hands it to the adapter (all of a turn's results go back in ONE turn). */
export type ToolAnswer = { id: string; name: string; text: string; isError: boolean }

export type Refusal = { category: string | null; explanation: string | null }

export type ModelEvent =
  | { type: 'text'; delta: string }
  /** `block`: which content block it belongs to, where the wire has blocks (Claude: each block is one progress note). */
  | { type: 'thinking'; delta: string; kind: 'update' | 'summary' | 'raw'; block?: number }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; json: string }
  | { type: 'usage'; usage: Usage; estimated: boolean }
  | { type: 'notice'; kind: 'fallback'; from: string; to: string }
  | { type: 'turn_end'; stop: StopKind; native: NativeTurn; toolCalls: ToolCall[]; refusal?: Refusal; text: string }

/** A tool as every wire receives it: name, static description, wire-profile JSON Schema (lib/ai/registry). */
export type FrozenTool = { name: string; description: string; inputSchema: Record<string, unknown> }

/** What a conversation froze when it started (design §7.2: byte-identical on every request). */
export type ConversationSnapshot = {
  model: string
  systemText: string
  tools: readonly FrozenTool[]
  /** Claude: `output_config.effort`; Responses/Chat: `reasoning.effort` / `reasoning_effort` only when the owner chose one. */
  effort: string | null
  /** Claude only: the thinking display the probe accepted for this model, frozen with the prefix. */
  display: 'updates' | 'omitted'
  /**
   * Claude only: the optional parameters the Models API said this model takes
   * when the conversation started (never a capability table in code). Null on
   * the other wires.
   */
  claude: { adaptiveThinking: boolean; fallbacks: boolean } | null
}

export type StreamRequest = {
  conv: ConversationSnapshot
  native: readonly NativeTurn[]
  /** Output limit to send, or undefined to send none (chat and responses wires, §7.7). */
  maxOutput: number | undefined
  signal: AbortSignal
}

export type ModelInfo = {
  id: string
  label: string | null
  /** Output cap the provider states (Claude's Models API `max_tokens`); null when unknown. */
  maxOutputTokens: number | null
  maxInputTokens: number | null
  /** Claude only: live capabilities (never a table in code). `imageInput` / `pdfInput`: null when the Models API did not say. */
  claude?: { effort: boolean; adaptiveThinking: boolean; fallbacks: boolean; imageInput?: boolean | null; pdfInput?: boolean | null }
}

/**
 * A file that travels with the owner's message (lib/ai/media): the adapter
 * puts a placeholder `{ $aiMedia: id, enc }` where its wire wants the data,
 * filled in just before each call, so stored history never holds the bytes.
 */
export type MediaPart = { id: string; kind: 'image' | 'pdf' | 'audio'; mime: string; name: string }

export interface ModelAdapter {
  readonly wire: Wire
  stream(req: StreamRequest): AsyncIterable<ModelEvent>
  /** The owner's message as this wire's user turn, with the files it carries (none: exactly the text-only turn). */
  userTurn(text: string, media?: readonly MediaPart[]): NativeTurn
  /** All of one turn's tool results, in ONE turn. */
  toolResultsTurn(results: readonly ToolAnswer[]): NativeTurn
  listModels(signal: AbortSignal): Promise<ModelInfo[]>
}

export type ProviderErrorKind =
  | 'auth'
  | 'permission'
  | 'not_found'
  | 'rate_limit'
  | 'overloaded'
  | 'billing'
  | 'bad_request'
  | 'too_large'
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'blocked'
  | 'config'
  | 'unknown'

/**
 * Why a model call failed. `providerMessage` is the provider's own words,
 * already scrubbed of the key and capped: shown to the owner as plain text,
 * never sent to a model.
 */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind
  readonly retryable: boolean
  readonly status: number | null
  readonly retryAfterMs: number | null
  readonly requestId: string | null
  readonly providerMessage: string
  /** The output limit the request carried (a 400 on it is re-issued once without, §7.7). */
  readonly sentOutputLimit: boolean
  /** A bad turn the model produced (unparseable eager JSON, Groq `failed_generation`): re-issue the turn. */
  readonly reissue: boolean
  /** Claude: a replayed thinking block the API refused, as `[message index, block index]`. */
  readonly badThinkingBlock: readonly [number, number] | null

  constructor(
    kind: ProviderErrorKind,
    message: string,
    opts: {
      retryable?: boolean
      status?: number | null
      retryAfterMs?: number | null
      requestId?: string | null
      providerMessage?: string
      sentOutputLimit?: boolean
      reissue?: boolean
      badThinkingBlock?: readonly [number, number] | null
    } = {},
  ) {
    super(message)
    this.name = 'ProviderError'
    this.kind = kind
    this.retryable = opts.retryable ?? false
    this.status = opts.status ?? null
    this.retryAfterMs = opts.retryAfterMs ?? null
    this.requestId = opts.requestId ?? null
    this.providerMessage = opts.providerMessage ?? message
    this.sentOutputLimit = opts.sentOutputLimit ?? false
    this.reissue = opts.reissue ?? false
    this.badThinkingBlock = opts.badThinkingBlock ?? null
  }
}

/** The same failure, no longer worth retrying (the transport already spent its retries on it). */
export function settled(err: ProviderError): ProviderError {
  if (!err.retryable) return err
  return new ProviderError(err.kind, err.message, {
    retryable: false,
    status: err.status,
    retryAfterMs: err.retryAfterMs,
    requestId: err.requestId,
    providerMessage: err.providerMessage,
    sentOutputLimit: err.sentOutputLimit,
    reissue: err.reissue,
    badThinkingBlock: err.badThinkingBlock,
  })
}

/**
 * The same failure with every word it carries passed through `scrub`
 * (design §7.4: the literal key never leaves the provider layer, whatever a
 * provider quoted back to us, in a status body or inside a 200 stream): the
 * message, the stack, the provider's own words and the request id.
 */
export function scrubbedError(err: ProviderError, scrub: (s: string) => string): ProviderError {
  const copy = new ProviderError(err.kind, scrub(err.message), {
    retryable: err.retryable,
    status: err.status,
    retryAfterMs: err.retryAfterMs,
    requestId: err.requestId === null ? null : scrub(err.requestId),
    providerMessage: scrub(err.providerMessage),
    sentOutputLimit: err.sentOutputLimit,
    reissue: err.reissue,
    badThinkingBlock: err.badThinkingBlock,
  })
  copy.stack = err.stack === undefined ? undefined : scrub(err.stack)
  return copy
}

/** The longest provider message kept: enough to read, never a page of HTML. */
export const PROVIDER_MESSAGE_MAX = 600

/**
 * A provider error body as plain text: control characters out, whitespace
 * folded, capped. `scrub` runs on the whole text BEFORE the cap, so a key
 * that straddles the cut can never leave half of itself behind.
 */
export function plainProviderText(raw: unknown, scrub: (s: string) => string = (t) => t): string {
  const s = scrub(typeof raw === 'string' ? raw : raw === undefined || raw === null ? '' : JSON.stringify(raw))
  // eslint-disable-next-line no-control-regex
  const flat = s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim()
  return flat.length > PROVIDER_MESSAGE_MAX ? `${flat.slice(0, PROVIDER_MESSAGE_MAX - 1)}…` : flat
}

/** HTTP status → kind and whether it is worth retrying before any byte streamed (§7.7). */
export function kindOfStatus(status: number): { kind: ProviderErrorKind; retryable: boolean } {
  if (status === 401) return { kind: 'auth', retryable: false }
  if (status === 402) return { kind: 'billing', retryable: false }
  if (status === 403) return { kind: 'permission', retryable: false }
  if (status === 404) return { kind: 'not_found', retryable: false }
  if (status === 408) return { kind: 'timeout', retryable: true }
  if (status === 409) return { kind: 'unknown', retryable: true }
  if (status === 413) return { kind: 'too_large', retryable: false }
  if (status === 429) return { kind: 'rate_limit', retryable: true }
  if (status === 529 || status === 503) return { kind: 'overloaded', retryable: true }
  if (status >= 500) return { kind: 'unknown', retryable: true }
  if (status >= 400) return { kind: 'bad_request', retryable: false }
  return { kind: 'unknown', retryable: false }
}

/** `retry-after` in seconds or as an HTTP date, in ms; null when absent or unreadable. */
export function retryAfterMs(value: string | string[] | null | undefined, now = Date.now()): number | null {
  const v = Array.isArray(value) ? value[0] : value
  if (!v) return null
  const n = Number(v)
  if (Number.isFinite(n) && n >= 0) return Math.round(n * 1000)
  const at = Date.parse(v)
  return Number.isFinite(at) ? Math.max(0, at - now) : null
}

/** Weighted tokens (§7.7): a runaway brake, not a bill. */
export function weightedOf(u: Usage): number {
  return Math.ceil(u.input + u.cacheWrite + u.output + 0.1 * u.cachedRead)
}

/** Tokens estimated from UTF-8 bytes / 3 (§7.7): counting characters would under-count Chinese several-fold. */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3)
}

/** What one attached file is counted as when a provider reports no usage (a large image's order of magnitude). */
export const MEDIA_TOKEN_ESTIMATE = 1_600
const DATA_RUN = /data:[a-z0-9.+/-]{1,80};base64,[A-Za-z0-9+/=]+|[A-Za-z0-9+/]{2048,}={0,2}/gi

/**
 * A request body's tokens when the provider reports none: base64 file data
 * would count as hundreds of thousands of "tokens" by bytes / 3, so each run
 * of it counts as MEDIA_TOKEN_ESTIMATE instead.
 */
export function estimatePayloadTokens(payload: string): number {
  let files = 0
  const rest = payload.replace(DATA_RUN, () => {
    files++
    return ''
  })
  return estimateTokens(rest) + files * MEDIA_TOKEN_ESTIMATE
}
