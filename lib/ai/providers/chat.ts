import type { Quirks } from '../presets'
import { createScrubber } from '../scrub'
import { getJson, guardedStream, joinUrl, openEventStream, transportError, withoutKey, type Endpoint, type ErrorAnswer } from './http'
import { createChatReducer } from './reducer'
import { jsonData, sseMessages } from './sse'
import {
  estimateTokens,
  ProviderError,
  plainProviderText,
  type ModelAdapter,
  type ModelEvent,
  type ModelInfo,
  type NativeTurn,
  type StopKind,
  type StreamRequest,
  type ToolAnswer,
  type Usage,
} from './types'

/**
 * The Chat Completions wire (SERVER-ONLY, design §7.1, PROVIDERS §4): one
 * adapter for DeepSeek, Gemini, Qwen, Kimi, GLM, MiniMax, Mistral, Groq,
 * Ollama, LM Studio and any compatible endpoint, with no per-provider code
 * beyond the preset's quirk flags. Plain fetch through safeFetchStream and
 * eventsource-parser; the `openai` package is not used.
 *
 * Native turn: `{ messages: [...] }` — the user message, the assistant
 * message exactly as the reducer rebuilt it (reasoning and signatures kept),
 * or one tool message per call. Never sent: temperature, top_p, n, stop,
 * penalties, logprobs, tool_choice, parallel_tool_calls.
 */

type ChatTurn = { messages: Array<Record<string, unknown>> }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Reasoning fields an assistant message may carry; dropped from the replay only when the owner turned echo off. */
const REASONING_FIELDS = ['reasoning_content', 'reasoning', 'reasoning_details']

function messagesOf(native: readonly NativeTurn[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const turn of native) {
    if (isObj(turn) && Array.isArray((turn as ChatTurn).messages)) out.push(...(turn as ChatTurn).messages.filter(isObj))
  }
  return out
}

function replayed(m: Record<string, unknown>, quirks: Quirks): Record<string, unknown> {
  if (m.role !== 'assistant') return m
  const copy: Record<string, unknown> = { ...m }
  if (!quirks.echoReasoning) for (const k of REASONING_FIELDS) delete copy[k]
  if (quirks.emptyContent === 'empty-string' && (copy.content === null || copy.content === undefined)) copy.content = ''
  return copy
}

/** chat finish_reason → stop kind (PROVIDERS §4.7); null for one that means an error. */
function stopOf(finish: string | null, hasCalls: boolean, refused: boolean): StopKind | null {
  if (refused) return 'refusal'
  switch (finish) {
    case 'length':
      return 'max_tokens'
    case 'content_filter':
      return 'content_filter'
    case 'insufficient_system_resource':
    case 'aborted':
    case 'error':
      return null
    case 'tool_calls':
      return 'tool_calls'
    default:
      return hasCalls ? 'tool_calls' : 'end'
  }
}

function usageOf(raw: unknown): Usage | null {
  if (!isObj(raw)) return null
  const prompt = Number(raw.prompt_tokens)
  const completion = Number(raw.completion_tokens)
  if (!Number.isFinite(prompt) && !Number.isFinite(completion)) return null
  const details = isObj(raw.prompt_tokens_details) ? raw.prompt_tokens_details : {}
  const cached = Number(details.cached_tokens ?? raw.prompt_cache_hit_tokens ?? 0) || 0
  const reasoning = Number(isObj(raw.completion_tokens_details) ? raw.completion_tokens_details.reasoning_tokens : 0) || 0
  const cost = Number(raw.cost)
  return {
    input: Math.max(0, (Number.isFinite(prompt) ? prompt : 0) - cached),
    cachedRead: cached,
    cacheWrite: 0,
    output: Number.isFinite(completion) ? completion : 0,
    reasoning,
    reportedMicroUsd: Number.isFinite(cost) && cost >= 0 ? Math.round(cost * 1e6) : null,
  }
}

/**
 * An error inside a 200 stream: OpenRouter's `error` + finish_reason "error",
 * or MiniMax's base_resp. Its words are scrubbed of the key before they are
 * capped (a provider may quote the key it refused).
 */
function inBandError(data: Record<string, unknown>, scrub: (s: string) => string): string | null {
  if (isObj(data.error)) return plainProviderText(data.error.message ?? data.error, scrub)
  if (typeof data.error === 'string') return plainProviderText(data.error, scrub)
  if (isObj(data.base_resp) && Number(data.base_resp.status_code) !== 0 && data.base_resp.status_code !== undefined) {
    return plainProviderText(data.base_resp.status_msg ?? `error ${data.base_resp.status_code}`, scrub)
  }
  return null
}

/**
 * Splits a leading `<think>…</think>` off streamed content: it is shown as
 * reasoning, while the stored content keeps it unchanged (history).
 */
function thinkSplitter() {
  let buffer = ''
  let state: 'start' | 'inside' | 'text' = 'start'
  return (chunk: string): { thinking: string; text: string } => {
    if (state === 'text') return { thinking: '', text: chunk }
    buffer += chunk
    if (state === 'start') {
      const trimmed = buffer.replace(/^\s+/, '')
      if (trimmed.length < 7 && '<think>'.startsWith(trimmed)) return { thinking: '', text: '' }
      if (!trimmed.startsWith('<think>')) {
        state = 'text'
        const out = buffer
        buffer = ''
        return { thinking: '', text: out }
      }
      state = 'inside'
      buffer = trimmed.slice(7)
    }
    const end = buffer.indexOf('</think>')
    if (end < 0) {
      // Hold back what could be the start of the closing tag.
      const safe = buffer.length - 8
      if (safe <= 0) return { thinking: '', text: '' }
      const out = buffer.slice(0, safe)
      buffer = buffer.slice(safe)
      return { thinking: out, text: '' }
    }
    state = 'text'
    const thinking = buffer.slice(0, end)
    const text = buffer.slice(end + 8).replace(/^\s+/, '')
    buffer = ''
    return { thinking, text }
  }
}

export type ChatAdapterOptions = Endpoint & { quirks: Quirks }

export function createChatAdapter(opts: ChatAdapterOptions): ModelAdapter {
  const { quirks } = opts
  const scrub = createScrubber([opts.apiKey])

  function body(req: StreamRequest): { text: string; sentOutputLimit: boolean } {
    const messages = [{ role: 'system', content: req.conv.systemText }, ...messagesOf(req.native).map((m) => replayed(m, quirks))]
    const out: Record<string, unknown> = { ...quirks.extraBody }
    out.model = req.conv.model
    out.messages = messages
    if (req.conv.tools.length) {
      out.tools = req.conv.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }))
    }
    out.stream = true
    if (quirks.streamUsageOption) out.stream_options = { include_usage: true }
    if (req.maxOutput !== undefined) out[quirks.maxTokensField] = req.maxOutput
    if (req.conv.effort) out.reasoning_effort = req.conv.effort
    return { text: JSON.stringify(out), sentOutputLimit: req.maxOutput !== undefined }
  }

  const classify = (answer: ErrorAnswer, base: ProviderError): ProviderError => {
    if (!quirks.reissueFailedGeneration || answer.status !== 400) return base
    try {
      const parsed = JSON.parse(answer.body)
      if (isObj(parsed) && isObj(parsed.error) && 'failed_generation' in parsed.error) {
        return new ProviderError('bad_request', 'The model produced a malformed tool call.', { status: 400, reissue: true, providerMessage: base.providerMessage })
      }
    } catch {
      // Not JSON: the base error stands.
    }
    return base
  }

  async function* stream(req: StreamRequest): AsyncGenerator<ModelEvent> {
    const { text: payload, sentOutputLimit } = body(req)
    const res = await openEventStream(joinUrl(opts.baseUrl, 'chat/completions'), payload, opts, { signal: req.signal, sentOutputLimit, classify })
    const reducer = createChatReducer()
    const split = thinkSplitter()
    let finish: string | null = null
    let done = false
    let usage: Usage | null = null
    let started = 0
    const argsSeen: number[] = []
    let reasoningSeen = 0
    try {
      for await (const msg of sseMessages(res.body)) {
        if (msg.data === '[DONE]') {
          done = true
          break
        }
        const data = jsonData(msg.data)
        if (!data) continue
        const failure = inBandError(data, scrub.text)
        if (failure) throw new ProviderError('unknown', `The provider failed mid-answer: ${failure}`, { providerMessage: failure })
        const u = usageOf(data.usage) ?? (isObj(data.x_groq) ? usageOf(data.x_groq.usage) : null)
        if (u) usage = u
        const choice = Array.isArray(data.choices) && isObj(data.choices[0]) ? data.choices[0] : null
        if (!choice) continue
        const delta = isObj(choice.delta) ? choice.delta : null
        if (delta) {
          reducer.add(delta)
          if (typeof delta.content === 'string' && delta.content) {
            const parts = split(delta.content)
            if (parts.thinking) yield { type: 'thinking', delta: parts.thinking, kind: 'raw' }
            if (parts.text) yield { type: 'text', delta: parts.text }
          } else if (Array.isArray(delta.content)) {
            for (const chunk of delta.content) {
              if (isObj(chunk) && chunk.type === 'text' && typeof chunk.text === 'string' && chunk.text) yield { type: 'text', delta: chunk.text }
            }
          }
          const reasoningNow = reducer.reasoning()
          if (reasoningNow.length > reasoningSeen) {
            yield { type: 'thinking', delta: reasoningNow.slice(reasoningSeen), kind: 'raw' }
            reasoningSeen = reasoningNow.length
          }
          // Tool calls: announced once their name is known, then their arguments as they grow.
          const calls = reducer.toolCalls()
          while (started < calls.length && calls[started].name) {
            yield { type: 'tool_call_start', id: calls[started].id, name: calls[started].name }
            argsSeen.push(0)
            started++
          }
          for (let i = 0; i < started; i++) {
            const args = calls[i].argsText
            if (args.length > argsSeen[i]) {
              yield { type: 'tool_call_delta', id: calls[i].id, json: args.slice(argsSeen[i]) }
              argsSeen[i] = args.length
            }
          }
        }
        if (typeof choice.finish_reason === 'string' && choice.finish_reason) finish = choice.finish_reason
      }
    } catch (err) {
      throw err instanceof ProviderError ? err : transportError(err, opts)
    } finally {
      res.close()
    }
    if (!done && finish === null) throw new ProviderError('network', 'The stream ended without a terminal event.')

    const message = reducer.message()
    const refusal = typeof message.refusal === 'string' && message.refusal ? message.refusal : null
    const calls = reducer.toolCalls()
    const stop = stopOf(finish, calls.length > 0, refusal !== null)
    if (stop === null) throw new ProviderError('overloaded', `The provider stopped the answer (${plainProviderText(finish)}).`, { retryable: false })
    const visible = reducer.text().replace(/^\s*<think>[\s\S]*?<\/think>\s*/, '')
    if (usage) yield { type: 'usage', usage, estimated: false }
    else {
      const output = estimateTokens(reducer.text() + reducer.reasoning() + calls.map((c) => c.argsText).join(''))
      yield { type: 'usage', usage: { input: estimateTokens(payload), cachedRead: 0, cacheWrite: 0, output, reasoning: 0, reportedMicroUsd: null }, estimated: true }
    }
    yield {
      type: 'turn_end',
      stop,
      native: { messages: [message] } satisfies ChatTurn,
      toolCalls: stop === 'tool_calls' || stop === 'max_tokens' ? calls : [],
      text: visible,
      ...(refusal || stop === 'content_filter' ? { refusal: { category: stop === 'content_filter' ? 'content_filter' : null, explanation: refusal } } : {}),
    }
  }

  return {
    wire: 'chat',
    // Every failure leaves through withoutKey: the key is in none of its words (§7.4).
    stream: (req: StreamRequest) => guardedStream(stream(req), opts),
    userTurn: (text: string): ChatTurn => ({ messages: [{ role: 'user', content: text }] }),
    toolResultsTurn: (results: readonly ToolAnswer[]): ChatTurn => ({
      messages: results.map((r) => ({ role: 'tool', tool_call_id: r.id, content: r.text, ...(quirks.toolMessageName ? { name: r.name } : {}) })),
    }),
    async listModels(): Promise<ModelInfo[]> {
      if (quirks.listModels === 'none') return []
      const path = quirks.listModels === 'openrouter-tools' ? 'models?supported_parameters=tools' : 'models'
      try {
        const { json } = await getJson(joinUrl(opts.baseUrl, path), opts)
        return modelsOf(json)
      } catch (err) {
        if (quirks.listModels === 'try' && err instanceof ProviderError && err.status === 404) return []
        throw withoutKey(err, opts)
      }
    },
  }
}

/** `{ data: [{ id }] }` (OpenAI's list shape), ids only: no capability claims (none are reported). */
export function modelsOf(json: unknown): ModelInfo[] {
  const data = isObj(json) && Array.isArray(json.data) ? json.data : Array.isArray(json) ? json : []
  const out: ModelInfo[] = []
  const seen = new Set<string>()
  for (const m of data) {
    const id = isObj(m) && typeof m.id === 'string' ? m.id.trim() : ''
    if (!id || id.length > 200 || seen.has(id)) continue
    seen.add(id)
    const name = isObj(m) && typeof m.name === 'string' ? plainProviderText(m.name).slice(0, 120) : null
    out.push({ id, label: name, maxOutputTokens: null, maxInputTokens: null })
    if (out.length >= 2000) break
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
