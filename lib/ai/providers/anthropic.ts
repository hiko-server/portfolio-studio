import { log as baseLog } from '../../log'
import { createScrubber, scrubbingLogger } from '../scrub'
import { anthropicEnvProblem } from './env'
import { watchIdle } from './sse'
import {
  kindOfStatus,
  plainProviderText,
  ProviderError,
  type ModelAdapter,
  type ModelEvent,
  type ModelInfo,
  type NativeTurn,
  type StopKind,
  type StreamRequest,
  type ToolAnswer,
  type ToolCall,
  type Usage,
} from './types'

/**
 * Claude through the official SDK (SERVER-ONLY, design §7.2 — binding rules
 * from the Claude API skill). The only module that loads
 * `@anthropic-ai/sdk`, and only with a dynamic import, so no other route pays
 * for it and no client chunk can contain it.
 *
 *   - Request: `client.beta.messages.stream` with the frozen system text
 *     (cached), the frozen tools with `eager_input_streaming`, top-level
 *     automatic caching, adaptive thinking (display `updates` when the probe
 *     accepted it), server-side fallbacks (`fallbacks: 'default'`) and
 *     `output_config.effort` — each only when the Models API says the model
 *     takes it. NEVER `temperature`, `top_p`, `top_k`, `budget_tokens`,
 *     `tool_choice` or an assistant prefill (API 2026-10-21 refuses them).
 *   - Manual streaming loop, not the tool runner: a provider-neutral loop is
 *     the case the runner's hooks do not fit.
 *   - Replay: `finalMessage().content` unchanged, thinking blocks included,
 *     except the one permitted edit (fallbackTurnContent). All parallel
 *     `tool_result` blocks go back in one user message.
 *   - Eager input: the SDK's tolerant parser can hand back a silently
 *     truncated object, so the raw JSON of each tool call is kept and the
 *     loop validates it strictly; an input the SDK cannot parse at all fails
 *     the stream with its own (non-API) error, which becomes a re-issue.
 *   - Errors: the SDK's typed classes, never string matching for the kind.
 *   - Environment: see ./env. The base URL is fixed in production; only
 *     tests pass another.
 */

export const ANTHROPIC_BASE = 'https://api.anthropic.com'
export const BETA_FALLBACK = 'server-side-fallback-2026-07-01'
export const BETA_DISPLAY_UPDATES = 'thinking-display-updates-2026-08-18'
/** Claude's sentinel at the end of an interrupted turn: shown as "stopped early", replayed unchanged. */
export const INTERRUPTED_SENTINEL = 'This part of the response was interrupted before it finished.'
/** Request timeout before a stream opens (the SDK's own; the idle watchdog covers the stream). */
const SDK_TIMEOUT_MS = 120_000
const IDLE_MS = 300_000
/** A model call's whole exchange (§7.7: 15 min), as on the fetch wires. */
const MODEL_CALL_MS = 15 * 60_000

type Sdk = typeof import('@anthropic-ai/sdk')
let sdkPromise: Promise<Sdk> | null = null
/** The SDK, loaded on first use. */
function loadSdk(): Promise<Sdk> {
  sdkPromise ??= import('@anthropic-ai/sdk')
  return sdkPromise
}

type Block = Record<string, unknown> & { type: string }
type ClaudeTurn = { role: 'user' | 'assistant'; content: Block[] }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * The one permitted edit of a Claude turn (design §7.2): after a fallback,
 * the blocks before the FINAL `fallback` block lose their thinking,
 * redacted thinking, tool use and any other internal block — only text stays
 * there — and everything from the fallback block on is echoed unchanged. A
 * turn with no fallback block comes back as it was. Pure, and the only code
 * that touches blocks.
 */
export function fallbackTurnContent<T extends { type: string }>(content: readonly T[]): T[] {
  let boundary = -1
  for (let i = content.length - 1; i >= 0; i--) {
    if (content[i].type === 'fallback') {
      boundary = i
      break
    }
  }
  if (boundary < 0) return [...content]
  return [...content.slice(0, boundary).filter((b) => b.type === 'text'), ...content.slice(boundary)]
}

/**
 * The history with a refused thinking block removed (signature 400 recovery,
 * once, logged as a bug): the named block and every thinking block after it,
 * in that message and all later ones. `messageIndex` counts the request's
 * messages, which are the native turns one to one.
 */
export function withoutThinkingFrom(native: readonly NativeTurn[], messageIndex: number, blockIndex: number): NativeTurn[] {
  return native.map((turn, i) => {
    if (i < messageIndex || !isObj(turn) || !Array.isArray(turn.content)) return turn
    const content = (turn.content as Block[]).filter((b, j) => {
      if (b.type !== 'thinking' && b.type !== 'redacted_thinking') return true
      return i === messageIndex && j < blockIndex
    })
    return { ...turn, content }
  })
}

function messagesOf(native: readonly NativeTurn[]): ClaudeTurn[] {
  return native.filter((t): t is ClaudeTurn => isObj(t) && (t.role === 'user' || t.role === 'assistant') && Array.isArray(t.content))
}

function usageOf(raw: unknown): Usage {
  const u = isObj(raw) ? raw : {}
  const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0)
  const sum = { input: num(u.input_tokens), cachedRead: num(u.cache_read_input_tokens), cacheWrite: num(u.cache_creation_input_tokens), output: num(u.output_tokens) }
  // With fallbacks the top level covers only the serving attempt; iterations is the per-attempt truth.
  if (Array.isArray(u.iterations) && u.iterations.length) {
    sum.input = sum.cachedRead = sum.cacheWrite = sum.output = 0
    for (const it of u.iterations) {
      if (!isObj(it)) continue
      sum.input += num(it.input_tokens)
      sum.cachedRead += num(it.cache_read_input_tokens)
      sum.cacheWrite += num(it.cache_creation_input_tokens)
      sum.output += num(it.output_tokens)
    }
  }
  return { ...sum, reasoning: 0, reportedMicroUsd: null }
}

function stopOf(reason: unknown): StopKind {
  switch (reason) {
    case 'tool_use':
      return 'tool_calls'
    case 'max_tokens':
      return 'max_tokens'
    case 'refusal':
      return 'refusal'
    case 'pause_turn':
      return 'paused'
    case 'model_context_window_exceeded':
      return 'context_overflow'
    default:
      // end_turn, stop_sequence
      return 'end'
  }
}

/** The location a signature 400 names (`messages.N.content.M`), read only to know which block to drop. */
function refusedBlock(message: string): readonly [number, number] | null {
  if (!/signature/i.test(message)) return null
  const m = /messages\.(\d+)\.content\.(\d+)/.exec(message)
  return m ? [Number(m[1]), Number(m[2])] : null
}

export type AnthropicAdapterOptions = {
  apiKey: string
  /** Fixed to api.anthropic.com in production; only tests pass another. */
  baseURL?: string
  /** Stream idle limit (tests shorten it). */
  idleTimeoutMs?: number
}

export function createAnthropicAdapter(opts: AnthropicAdapterOptions): ModelAdapter {
  const baseURL = opts.baseURL ?? ANTHROPIC_BASE
  const scrub = createScrubber([opts.apiKey])
  const idleMs = opts.idleTimeoutMs ?? IDLE_MS

  async function client() {
    const problem = anthropicEnvProblem()
    if (problem) throw new ProviderError('config', problem)
    const { default: Anthropic } = await loadSdk()
    const log = scrubbingLogger(baseLog, () => [opts.apiKey])
    const logger = {
      error: (msg: string, ...rest: unknown[]) => log.error(String(msg), { detail: rest }),
      warn: (msg: string, ...rest: unknown[]) => log.warn(String(msg), { detail: rest }),
      info: (msg: string, ...rest: unknown[]) => log.info(String(msg), { detail: rest }),
      debug: (msg: string, ...rest: unknown[]) => log.debug(String(msg), { detail: rest }),
    }
    return {
      Anthropic,
      client: new Anthropic({
        apiKey: opts.apiKey,
        baseURL,
        timeout: SDK_TIMEOUT_MS,
        maxRetries: 2,
        logLevel: 'off',
        logger,
        openTelemetry: { traces: false, propagation: false },
      }),
    }
  }

  /** An SDK failure as a ProviderError, classified by its class, the key scrubbed from every word kept. */
  function failure(Anthropic: Sdk['default'], err: unknown, ctx: { sentOutputLimit: boolean; badJson: boolean }): ProviderError {
    if (err instanceof ProviderError) return err
    if (err instanceof Anthropic.APIError) {
      const status = typeof err.status === 'number' ? err.status : null
      const headers = (err as { headers?: Headers }).headers
      const providerMessage = scrub.text(plainProviderText(isObj(err.error) && isObj(err.error.error) ? err.error.error.message : err.message))
      const requestId = typeof err.requestID === 'string' ? plainProviderText(err.requestID).slice(0, 100) : null
      const retryAfterHeader = headers?.get?.('retry-after') ?? null
      const retryAfter = retryAfterHeader !== null && Number.isFinite(Number(retryAfterHeader)) ? Number(retryAfterHeader) * 1000 : null
      const common = { status, requestId, providerMessage, sentOutputLimit: ctx.sentOutputLimit, retryAfterMs: retryAfter }
      // Most specific first (the skill's order). The SDK already retried 408/409/429/5xx twice before the stream opened.
      if (err instanceof Anthropic.APIUserAbortError) return new ProviderError('aborted', 'The request was cancelled')
      if (err instanceof Anthropic.BadRequestError) {
        return new ProviderError('bad_request', `Claude refused the request: ${providerMessage}`, { ...common, badThinkingBlock: refusedBlock(providerMessage) })
      }
      if (err instanceof Anthropic.AuthenticationError) return new ProviderError('auth', `Claude did not accept the key: ${providerMessage}`, common)
      if (err instanceof Anthropic.PermissionDeniedError) return new ProviderError('permission', `Claude refused this key access: ${providerMessage}`, common)
      if (err instanceof Anthropic.NotFoundError) return new ProviderError('not_found', `Claude does not know this model or path: ${providerMessage}`, common)
      if (err instanceof Anthropic.RateLimitError) return new ProviderError('rate_limit', `Claude’s rate limit: ${providerMessage}`, common)
      if (err instanceof Anthropic.APIConnectionTimeoutError) return new ProviderError('timeout', 'Claude did not answer in time.', { ...common, retryable: true })
      if (err instanceof Anthropic.APIConnectionError) return new ProviderError('network', `Could not reach Claude: ${scrub.text(plainProviderText(err.message))}`, { ...common, retryable: true })
      if (err instanceof Anthropic.InternalServerError) return new ProviderError(status === 529 ? 'overloaded' : 'unknown', `Claude failed: ${providerMessage}`, common)
      const kind = status !== null ? kindOfStatus(status).kind : 'unknown'
      return new ProviderError(kind, `Claude answered ${status ?? 'an error'}: ${providerMessage}`, common)
    }
    // Not an API error: either a tool input the SDK could not parse at all, or the stream broke.
    if (ctx.badJson) return new ProviderError('bad_request', 'The model produced tool input that is not JSON.', { reissue: true })
    if (err instanceof Anthropic.AnthropicError) return new ProviderError('network', `The stream from Claude broke: ${scrub.text(plainProviderText(err.message))}`, { retryable: true })
    return new ProviderError('unknown', scrub.text(plainProviderText(err instanceof Error ? err.message : String(err))))
  }

  async function* stream(req: StreamRequest): AsyncGenerator<ModelEvent> {
    const { Anthropic, client: c } = await client()
    const conv = req.conv
    const flags = conv.claude ?? { adaptiveThinking: false, fallbacks: false }
    const display = flags.adaptiveThinking && conv.display === 'updates' ? 'updates' : 'omitted'
    if (req.maxOutput === undefined) throw new ProviderError('config', 'Claude needs an output limit on every request.')
    const params = {
      model: conv.model,
      max_tokens: req.maxOutput,
      betas: [...(flags.fallbacks ? [BETA_FALLBACK] : []), ...(display === 'updates' ? [BETA_DISPLAY_UPDATES] : [])],
      ...(flags.fallbacks ? { fallbacks: 'default' as const } : {}),
      ...(flags.adaptiveThinking ? { thinking: display === 'updates' ? { type: 'adaptive' as const, display: 'updates' as const } : { type: 'adaptive' as const } } : {}),
      ...(conv.effort ? { output_config: { effort: conv.effort } } : {}),
      cache_control: { type: 'ephemeral' as const },
      system: [{ type: 'text' as const, text: conv.systemText, cache_control: { type: 'ephemeral' as const } }],
      ...(conv.tools.length ? { tools: conv.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema, eager_input_streaming: true })) } : {}),
      messages: messagesOf(req.native),
    }
    const idle = new AbortController()
    // The run's signal, the idle watchdog and the model call's own wall clock (§7.5), to the SDK.
    const signal = AbortSignal.any([req.signal, idle.signal, AbortSignal.timeout(MODEL_CALL_MS)])
    const rawJson = new Map<number, string>()
    const toolIds = new Map<number, string>()
    const badJson = () => [...rawJson.values()].some((t) => {
      try {
        JSON.parse(t === '' ? '{}' : t)
        return false
      } catch {
        return true
      }
    })
    let final: Record<string, unknown>
    try {
      // The SDK types do not list every beta field this API version takes; the request is built only from the frozen snapshot.
      const s = c.beta.messages.stream(params as never, { signal })
      for await (const event of watchIdle(s as AsyncIterable<unknown>, idleMs, () => idle.abort())) {
        if (!isObj(event)) continue
        if (event.type === 'content_block_start' && isObj(event.content_block)) {
          const block = event.content_block
          const index = Number(event.index)
          if (block.type === 'tool_use') {
            const id = String(block.id ?? '')
            toolIds.set(index, id)
            rawJson.set(index, '')
            yield { type: 'tool_call_start', id, name: String(block.name ?? '') }
          } else if (block.type === 'fallback') {
            const from = isObj(block.from) ? String(block.from.model ?? '') : ''
            const to = isObj(block.to) ? String(block.to.model ?? '') : ''
            yield { type: 'notice', kind: 'fallback', from: plainProviderText(from).slice(0, 80), to: plainProviderText(to).slice(0, 80) }
          }
        } else if (event.type === 'content_block_delta' && isObj(event.delta)) {
          const d = event.delta
          const index = Number(event.index)
          if (d.type === 'text_delta' && typeof d.text === 'string' && d.text) yield { type: 'text', delta: d.text }
          else if (d.type === 'thinking_delta' && typeof d.thinking === 'string' && d.thinking) yield { type: 'thinking', delta: d.thinking, kind: 'update' }
          else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
            rawJson.set(index, (rawJson.get(index) ?? '') + d.partial_json)
            const id = toolIds.get(index)
            if (id && d.partial_json) yield { type: 'tool_call_delta', id, json: d.partial_json }
          }
        }
      }
      final = (await s.finalMessage()) as unknown as Record<string, unknown>
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'timeout') throw err
      // Aborted, but not by the run: the call's own wall clock ran out.
      if (!req.signal.aborted && signal.aborted) throw new ProviderError('timeout', 'Claude did not finish this answer in time.')
      throw failure(Anthropic, err, { sentOutputLimit: true, badJson: !(err instanceof Anthropic.APIError) && badJson() })
    }

    const content = (Array.isArray(final.content) ? final.content : []).filter(isObj) as Block[]
    // The served turn exactly as the SDK assembled it, as plain JSON (inputs are settled at each block's end).
    const settledContent = JSON.parse(JSON.stringify(content)) as Block[]
    const replay = fallbackTurnContent(settledContent)
    const stop = stopOf(final.stop_reason)
    // Tool calls come from the replayed content (a call before a fallback was the declined model's and is not echoed);
    // their raw JSON from the stream, so a truncated input is never mistaken for a whole one.
    const indexOfBlock = new Map(settledContent.map((b, i) => [b, i]))
    const toolCalls: ToolCall[] = replay
      .filter((b) => b.type === 'tool_use')
      .map((b) => {
        const at = indexOfBlock.get(b) ?? -1
        const raw = rawJson.get(at)
        return { id: String(b.id ?? ''), name: String(b.name ?? ''), argsText: raw !== undefined ? raw : JSON.stringify(b.input ?? {}) }
      })
    const text = replay.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join('')
    yield { type: 'usage', usage: usageOf(final.usage), estimated: false }
    const details = isObj(final.stop_details) ? final.stop_details : null
    yield {
      type: 'turn_end',
      stop,
      native: { role: 'assistant', content: replay } satisfies ClaudeTurn,
      toolCalls: stop === 'tool_calls' || stop === 'max_tokens' ? toolCalls : [],
      text,
      ...(stop === 'refusal'
        ? { refusal: { category: details && typeof details.category === 'string' ? plainProviderText(details.category).slice(0, 60) : null, explanation: details && typeof details.explanation === 'string' ? plainProviderText(details.explanation) : null } }
        : {}),
    }
  }

  return {
    wire: 'anthropic',
    stream,
    userTurn: (text: string): ClaudeTurn => ({ role: 'user', content: [{ type: 'text', text }] }),
    toolResultsTurn: (results: readonly ToolAnswer[]): ClaudeTurn => ({
      role: 'user',
      content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.text, ...(r.isError ? { is_error: true } : {}) })),
    }),
    async listModels(signal: AbortSignal): Promise<ModelInfo[]> {
      const { Anthropic, client: c } = await client()
      const out: ModelInfo[] = []
      try {
        for await (const m of c.beta.models.list({ limit: 100 }, { signal })) {
          const model = m as unknown as Record<string, unknown>
          const caps = isObj(model.capabilities) ? model.capabilities : {}
          const effort = isObj(caps.effort) && caps.effort.supported === true
          const thinking = isObj(caps.thinking) && isObj(caps.thinking.types) && isObj(caps.thinking.types.adaptive) && caps.thinking.types.adaptive.supported === true
          const fallbacks = Array.isArray(model.allowed_fallback_models) && model.allowed_fallback_models.length > 0
          const id = typeof model.id === 'string' ? model.id : ''
          if (!id) continue
          out.push({
            id,
            label: typeof model.display_name === 'string' ? plainProviderText(model.display_name).slice(0, 120) : null,
            maxOutputTokens: Number.isInteger(model.max_tokens) ? (model.max_tokens as number) : null,
            maxInputTokens: Number.isInteger(model.max_input_tokens) ? (model.max_input_tokens as number) : null,
            claude: { effort, adaptiveThinking: thinking, fallbacks },
          })
          if (out.length >= 500) break
        }
      } catch (err) {
        throw failure(Anthropic, err, { sentOutputLimit: false, badJson: false })
      }
      return out
    },
  }
}
