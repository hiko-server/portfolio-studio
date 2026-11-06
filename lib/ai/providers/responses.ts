import type { Quirks } from '../presets'
import { modelsOf } from './chat'
import { getJson, joinUrl, openEventStream, transportError, type Endpoint } from './http'
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
  type ToolCall,
  type Usage,
} from './types'

/**
 * The OpenAI Responses wire (SERVER-ONLY, design §7.1, PROVIDERS §3): the
 * default for OpenAI, xAI and OpenRouter, because Chat Completions can no
 * longer drive the top OpenAI and xAI models with tools. Plain fetch through
 * safeFetchStream and eventsource-parser.
 *
 * Stateless on purpose: `store: false`, no `previous_response_id`,
 * `instructions` re-sent every time; this site's database is the only copy
 * of the conversation. `response.output` is replayed unchanged — reasoning
 * items with their encrypted content, messages, function calls — followed by
 * one `function_call_output` per call. Native turn: `{ items: [...] }`.
 * Never sent: temperature, top_p, tool_choice, strict.
 */

type ResponsesTurn = { items: Array<Record<string, unknown>> }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function itemsOf(native: readonly NativeTurn[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const turn of native) if (isObj(turn) && Array.isArray((turn as ResponsesTurn).items)) out.push(...(turn as ResponsesTurn).items.filter(isObj))
  return out
}

function usageOf(raw: unknown): Usage | null {
  if (!isObj(raw)) return null
  const input = Number(raw.input_tokens)
  const output = Number(raw.output_tokens)
  if (!Number.isFinite(input) && !Number.isFinite(output)) return null
  const cached = Number(isObj(raw.input_tokens_details) ? raw.input_tokens_details.cached_tokens : 0) || 0
  const reasoning = Number(isObj(raw.output_tokens_details) ? raw.output_tokens_details.reasoning_tokens : 0) || 0
  const cacheWrite = Number(raw.cache_write_tokens) || 0
  let micro: number | null = null
  const ticks = Number(raw.cost_in_usd_ticks)
  const cost = Number(raw.cost)
  if (Number.isFinite(ticks) && ticks >= 0) micro = Math.round(ticks / 1e4)
  else if (Number.isFinite(cost) && cost >= 0) micro = Math.round(cost * 1e6)
  return {
    input: Math.max(0, (Number.isFinite(input) ? input : 0) - cached),
    cachedRead: cached,
    cacheWrite,
    output: Number.isFinite(output) ? output : 0,
    reasoning,
    reportedMicroUsd: micro,
  }
}

function callsOf(output: Array<Record<string, unknown>>): ToolCall[] {
  return output
    .filter((i) => i.type === 'function_call')
    .map((i) => ({ id: String(i.call_id ?? i.id ?? ''), name: typeof i.name === 'string' ? i.name : '', argsText: typeof i.arguments === 'string' ? i.arguments : '' }))
}

function refusalOf(output: Array<Record<string, unknown>>): string | null {
  for (const item of output) {
    if (item.type !== 'message' || !Array.isArray(item.content)) continue
    for (const part of item.content) if (isObj(part) && part.type === 'refusal' && typeof part.refusal === 'string') return part.refusal
  }
  return null
}

export type ResponsesAdapterOptions = Endpoint & { quirks: Quirks }

export function createResponsesAdapter(opts: ResponsesAdapterOptions): ModelAdapter {
  const { quirks } = opts

  function body(req: StreamRequest): { text: string; sentOutputLimit: boolean } {
    const out: Record<string, unknown> = { ...quirks.extraBody }
    out.model = req.conv.model
    out.stream = true
    if (quirks.responsesStore) out.store = false
    out.instructions = req.conv.systemText
    out.input = itemsOf(req.native)
    if (req.conv.tools.length) out.tools = req.conv.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.inputSchema }))
    if (req.conv.effort) out.reasoning = { effort: req.conv.effort }
    if (quirks.responsesInclude.length) out.include = [...quirks.responsesInclude]
    if (req.maxOutput !== undefined) out.max_output_tokens = req.maxOutput
    return { text: JSON.stringify(out), sentOutputLimit: req.maxOutput !== undefined }
  }

  async function* stream(req: StreamRequest): AsyncGenerator<ModelEvent> {
    const { text: payload, sentOutputLimit } = body(req)
    const res = await openEventStream(joinUrl(opts.baseUrl, 'responses'), payload, opts, { signal: req.signal, sentOutputLimit })
    const done = new Map<number, Record<string, unknown>>()
    const callAt = new Map<number, string>()
    let text = ''
    let thinking = ''
    let final: Record<string, unknown> | null = null
    let terminal: 'completed' | 'incomplete' | null = null
    try {
      for await (const msg of sseMessages(res.body)) {
        const data = jsonData(msg.data)
        if (!data) continue
        const type = typeof data.type === 'string' ? data.type : msg.event
        const index = Number(data.output_index)
        switch (type) {
          case 'response.output_item.added': {
            const item = isObj(data.item) ? data.item : null
            if (item?.type === 'function_call') {
              const id = String(item.call_id ?? item.id ?? `call_${index}`)
              callAt.set(index, id)
              yield { type: 'tool_call_start', id, name: typeof item.name === 'string' ? item.name : '' }
            }
            break
          }
          case 'response.function_call_arguments.delta':
            if (typeof data.delta === 'string' && callAt.has(index)) yield { type: 'tool_call_delta', id: callAt.get(index) as string, json: data.delta }
            break
          case 'response.output_text.delta':
            if (typeof data.delta === 'string' && data.delta) {
              text += data.delta
              yield { type: 'text', delta: data.delta }
            }
            break
          case 'response.reasoning_summary_text.delta':
          case 'response.reasoning_text.delta':
            if (typeof data.delta === 'string' && data.delta) {
              thinking += data.delta
              yield { type: 'thinking', delta: data.delta, kind: type === 'response.reasoning_text.delta' ? 'raw' : 'summary' }
            }
            break
          case 'response.output_item.done':
            // The authoritative item: xAI and OpenRouter may send whole arguments only here.
            if (isObj(data.item) && Number.isInteger(index)) done.set(index, data.item)
            break
          case 'response.completed':
            final = isObj(data.response) ? data.response : {}
            terminal = 'completed'
            break
          case 'response.incomplete':
            final = isObj(data.response) ? data.response : {}
            terminal = 'incomplete'
            break
          case 'response.failed': {
            const r = isObj(data.response) ? data.response : {}
            const message = plainProviderText(isObj(r.error) ? r.error.message : 'The response failed.')
            throw new ProviderError('unknown', `The provider failed mid-answer: ${message}`, { providerMessage: message })
          }
          case 'error': {
            const message = plainProviderText(data.message ?? data.error ?? 'Stream error.')
            throw new ProviderError('unknown', `The provider failed mid-answer: ${message}`, { providerMessage: message })
          }
          default:
            break
        }
        if (terminal) break
      }
    } catch (err) {
      throw err instanceof ProviderError ? err : transportError(err, opts)
    } finally {
      res.close()
    }
    if (!terminal || !final) throw new ProviderError('network', 'The stream ended without a terminal event.')

    const output: Array<Record<string, unknown>> = Array.isArray(final.output) && final.output.length ? final.output.filter(isObj) : [...done.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => item)
    const calls = callsOf(output)
    const refusal = refusalOf(output)
    let stop: StopKind
    if (terminal === 'incomplete') {
      const reason = isObj(final.incomplete_details) ? final.incomplete_details.reason : null
      if (reason === 'max_output_tokens') stop = 'max_tokens'
      else if (reason === 'content_filter') stop = 'content_filter'
      else throw new ProviderError('unknown', `The answer stopped early (${plainProviderText(reason ?? 'no reason given')}).`)
    } else stop = refusal ? 'refusal' : calls.length ? 'tool_calls' : 'end'

    const usage = usageOf(final.usage)
    if (usage) yield { type: 'usage', usage, estimated: false }
    else yield { type: 'usage', usage: { input: estimateTokens(payload), cachedRead: 0, cacheWrite: 0, output: estimateTokens(text + thinking + calls.map((c) => c.argsText).join('')), reasoning: 0, reportedMicroUsd: null }, estimated: true }
    yield {
      type: 'turn_end',
      stop,
      native: { items: output } satisfies ResponsesTurn,
      toolCalls: stop === 'tool_calls' || stop === 'max_tokens' ? calls : [],
      text,
      ...(refusal || stop === 'content_filter' ? { refusal: { category: stop === 'content_filter' ? 'content_filter' : null, explanation: refusal } } : {}),
    }
  }

  return {
    wire: 'responses',
    stream,
    userTurn: (text: string): ResponsesTurn => ({ items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }] }),
    toolResultsTurn: (results: readonly ToolAnswer[]): ResponsesTurn => ({
      items: results.map((r) => ({ type: 'function_call_output', call_id: r.id, output: r.text })),
    }),
    async listModels(): Promise<ModelInfo[]> {
      if (quirks.listModels === 'none') return []
      const path = quirks.listModels === 'openrouter-tools' ? 'models?supported_parameters=tools' : 'models'
      try {
        const { json } = await getJson(joinUrl(opts.baseUrl, path), opts)
        return modelsOf(json)
      } catch (err) {
        if (quirks.listModels === 'try' && err instanceof ProviderError && err.status === 404) return []
        throw err
      }
    },
  }
}
