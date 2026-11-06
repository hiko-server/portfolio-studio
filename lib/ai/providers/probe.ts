import { recordUsage } from '../conversations'
import { chargeDayCounter } from '../runBudget'
import { SYSTEM_PROMPT } from '../systemPrompt'
import type { ProbeStatus, StoredTest } from './keys'
import { ProviderError, weightedOf, type ConversationSnapshot, type FrozenTool, type ModelAdapter, type ModelEvent, type ModelInfo, type NativeTurn, type Usage, type Wire } from './types'

/**
 * Test, on the owner's own key and spend (SERVER-ONLY, design §7.7): a real,
 * small exchange that records what actually works, because claiming a
 * provider works without one would be fake.
 *
 *   1. Reach the provider and list its models (a 404 is tolerated).
 *   2. Stream a request with the FULL frozen tool catalogue plus
 *      `probe_echo` — providers refuse real schemas, not toy ones, so a
 *      refusal surfaces here and not in the owner's first chat — asking for
 *      `probe_echo {"value":"ok"}`.
 *   3. Send the tool result back and read the final text: this second request
 *      is what proves replay (where DeepSeek and Gemini fail when reasoning
 *      is not echoed).
 *   4. Claude: try thinking display `updates` first; on a 400 fall back to
 *      `omitted` and record which one the model accepted.
 *
 * Result: Ready, Chat only (answers, but made no tool call), Schema refused
 * (with the provider's words as plain text), Key refused, or Failed, with the
 * per-step results and what was observed. Nothing secret is stored: messages
 * are already scrubbed of the key by the adapters.
 */

export const PROBE_TOOL: FrozenTool = Object.freeze({
  name: 'probe_echo',
  description: 'Returns the value it is given. Used only by the connection test: call it exactly as asked.',
  inputSchema: { type: 'object', properties: { value: { type: 'string', description: 'The text to return.' } }, required: ['value'], additionalProperties: false },
})

export const PROBE_PROMPT = 'Call probe_echo with {"value":"ok"}. After the result comes back, reply with one short sentence.'
const PROBE_RESULT = '{"value":"ok"}'
/** Claude's output limit for the probe: large enough for reasoning, as a real turn needs. */
const CLAUDE_PROBE_OUTPUT = 16_000

export type ProbeInput = {
  adapter: ModelAdapter
  wire: Wire
  model: string
  /** The tools a conversation would freeze (lib/ai/runs assistantTools). */
  tools: readonly FrozenTool[]
  /** The effort the key is saved with (sent only where the model takes it). */
  effort: string | null
  /** The owner's maximum output for this key (chat and responses), or null. */
  maxOutputTokens: number | null
  signal: AbortSignal
  /** Where spend is recorded (the saved row; null for a typed key not saved yet). */
  providerId: string | null
  now?: () => number
}

type Collected = {
  turn: Extract<ModelEvent, { type: 'turn_end' }>
  usage: Usage | null
  estimated: boolean
  reasoning: boolean
  argDeltas: Map<string, number>
}

async function collect(adapter: ModelAdapter, conv: ConversationSnapshot, native: NativeTurn[], maxOutput: number | undefined, signal: AbortSignal): Promise<Collected> {
  let turn: Collected['turn'] | null = null
  let usage: Usage | null = null
  let estimated = false
  let reasoning = false
  const argDeltas = new Map<string, number>()
  for await (const e of adapter.stream({ conv, native, maxOutput, signal })) {
    if (e.type === 'thinking') reasoning = true
    else if (e.type === 'tool_call_delta') argDeltas.set(e.id, (argDeltas.get(e.id) ?? 0) + 1)
    else if (e.type === 'usage') {
      usage = e.usage
      estimated = e.estimated
    } else if (e.type === 'turn_end') turn = e
  }
  if (!turn) throw new ProviderError('network', 'The stream ended without a terminal event.')
  return { turn, usage, estimated, reasoning, argDeltas }
}

function nativeHasReasoning(native: NativeTurn): boolean {
  const text = JSON.stringify(native ?? null)
  return /"(reasoning_content|reasoning|reasoning_details|thought_signature|encrypted_content)"\s*:/.test(text) || /"type"\s*:\s*"(thinking|redacted_thinking|reasoning)"/.test(text)
}

const statusOfError = (err: ProviderError): ProbeStatus => (err.kind === 'auth' || err.kind === 'permission' || err.kind === 'billing' ? 'key-refused' : 'failed')

export async function probeProvider(input: ProbeInput): Promise<StoredTest> {
  const clock = input.now ?? Date.now
  const started = clock()
  const steps: StoredTest['steps'] = []
  const obs: StoredTest['observations'] = {}
  const done = (status: ProbeStatus, message: string | null, extra: Partial<StoredTest> = {}): StoredTest => {
    obs.elapsedMs = clock() - started
    return { status, at: clock(), display: null, claude: null, observations: obs, steps, message, ...extra }
  }
  const spend = (c: Collected) => {
    if (!c.usage) return
    const weighted = weightedOf(c.usage)
    try {
      chargeDayCounter(weighted, clock())
      if (input.providerId) recordUsage({ providerId: input.providerId, model: input.model, conversationId: null, runId: null, usage: c.usage, weighted, estimated: c.estimated, at: clock() })
    } catch {
      // Spend accounting must never turn a working Test into a failed one.
    }
  }

  // 1. Reach and list.
  let info: ModelInfo | null = null
  try {
    const models = await input.adapter.listModels(input.signal)
    info = models.find((m) => m.id === input.model) ?? null
    obs.modelsListed = models.length
    obs.modelListed = !!info
    steps.push({ step: 'models', ok: true, detail: models.length ? null : 'This provider lists no models; the model name is used as typed.' })
  } catch (err) {
    const e = err instanceof ProviderError ? err : new ProviderError('unknown', String(err))
    if (e.status === 404) {
      steps.push({ step: 'models', ok: true, detail: 'This provider has no model list; the model name is used as typed.' })
    } else {
      steps.push({ step: 'models', ok: false, detail: e.message })
      return done(statusOfError(e), e.message)
    }
  }

  const claudeCaps = input.wire === 'anthropic' ? (info?.claude ?? null) : null
  if (input.wire === 'anthropic' && !info) {
    steps.push({ step: 'tools', ok: false, detail: 'Claude does not list this model for this key.' })
    return done('failed', 'Claude does not list this model for this key.')
  }
  const claude = claudeCaps ? { adaptiveThinking: claudeCaps.adaptiveThinking, fallbacks: claudeCaps.fallbacks } : null
  const maxCap = info?.maxOutputTokens ?? null
  const conv = (display: 'updates' | 'omitted'): ConversationSnapshot => ({
    model: input.model,
    systemText: SYSTEM_PROMPT,
    tools: [...input.tools, PROBE_TOOL],
    effort: input.wire === 'anthropic' ? (claudeCaps?.effort ? input.effort : null) : input.effort,
    display,
    claude,
  })
  let maxOutput: number | undefined = input.wire === 'anthropic' ? Math.min(CLAUDE_PROBE_OUTPUT, maxCap ?? CLAUDE_PROBE_OUTPUT) : (input.maxOutputTokens ?? undefined)
  let display: 'updates' | 'omitted' = claude?.adaptiveThinking ? 'updates' : 'omitted'
  const user = input.adapter.userTurn(PROBE_PROMPT)

  // 2. A real streaming request with the whole catalogue.
  let first: Collected | null = null
  for (let attempt = 0; attempt < 3 && !first; attempt++) {
    try {
      first = await collect(input.adapter, conv(display), [user], maxOutput, input.signal)
    } catch (err) {
      const e = err instanceof ProviderError ? err : new ProviderError('unknown', String(err))
      if (e.kind === 'bad_request' && input.wire === 'anthropic' && display === 'updates') {
        // The model does not take progress updates: record it and go on without them.
        steps.push({ step: 'display', ok: false, detail: 'This model does not accept thinking display "updates"; progress notes are off.' })
        display = 'omitted'
        continue
      }
      if (e.kind === 'bad_request' && e.sentOutputLimit && input.wire !== 'anthropic' && maxOutput !== undefined) {
        obs.outputLimitAccepted = false
        steps.push({ step: 'output_limit', ok: false, detail: 'This model refused that output length. Set a lower maximum in Models.' })
        maxOutput = undefined
        continue
      }
      steps.push({ step: 'tools', ok: false, detail: e.message })
      if (e.kind === 'bad_request') return done('schema-refused', e.providerMessage || e.message, { display: input.wire === 'anthropic' ? display : null })
      return done(statusOfError(e), e.message)
    }
  }
  if (!first) return done('failed', 'The test request could not be sent.')
  spend(first)
  if (input.wire === 'anthropic') {
    if (display === 'updates') steps.push({ step: 'display', ok: true, detail: null })
  }
  if (maxOutput !== undefined && obs.outputLimitAccepted === undefined) obs.outputLimitAccepted = true
  obs.usageSeen = !!first.usage && !first.estimated
  obs.cachedSeen = !!first.usage && first.usage.cachedRead > 0
  obs.reasoningSeen = first.reasoning || nativeHasReasoning(first.turn.native)
  const claudeRecord = claudeCaps ? { ...claudeCaps, maxOutputTokens: maxCap } : null

  const call = first.turn.toolCalls.find((c) => c.name === PROBE_TOOL.name)
  if (first.turn.stop === 'refusal' || first.turn.stop === 'content_filter') {
    steps.push({ step: 'tools', ok: false, detail: 'The model declined the test message.' })
    return done('failed', 'The model declined the test message.', { display: input.wire === 'anthropic' ? display : null, claude: claudeRecord })
  }
  if (!call) {
    steps.push({ step: 'tools', ok: false, detail: 'The model answered but made no tool call.' })
    return done('chat-only', 'The model answered but made no tool call: it can chat, but not read or change the site.', { display: input.wire === 'anthropic' ? display : null, claude: claudeRecord })
  }
  let args: unknown = null
  try {
    args = JSON.parse(call.argsText || '{}')
  } catch {
    args = null
  }
  const exact = !!args && typeof args === 'object' && (args as Record<string, unknown>).value === 'ok' && Object.keys(args as object).length === 1
  obs.toolsWork = true
  obs.argsArrived = (first.argDeltas.get(call.id) ?? 0) > 1 ? 'fragmented' : 'whole'
  obs.argsExact = exact
  steps.push({ step: 'tools', ok: true, detail: exact ? null : 'The model called the tool with other arguments than asked.' })

  // 3. Replay: the answer goes back with the result, exactly as a run sends it.
  let second: Collected
  try {
    const results = input.adapter.toolResultsTurn(first.turn.toolCalls.map((c) => ({ id: c.id, name: c.name, text: c.id === call.id ? PROBE_RESULT : JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Only probe_echo runs during a test.' } }), isError: c.id !== call.id })))
    second = await collect(input.adapter, conv(display), [user, first.turn.native, results], maxOutput, input.signal)
  } catch (err) {
    const e = err instanceof ProviderError ? err : new ProviderError('unknown', String(err))
    steps.push({ step: 'replay', ok: false, detail: e.message })
    return done(statusOfError(e), `Sending the tool result back failed: ${e.message}`, { display: input.wire === 'anthropic' ? display : null, claude: claudeRecord })
  }
  spend(second)
  const replied = second.turn.stop === 'end' || second.turn.stop === 'tool_calls' || second.turn.stop === 'max_tokens'
  steps.push({ step: 'replay', ok: replied, detail: replied ? null : 'The model did not answer after the tool result.' })
  if (!replied) return done('failed', 'The model did not answer after the tool result.', { display: input.wire === 'anthropic' ? display : null, claude: claudeRecord })
  return done('ready', null, { display: input.wire === 'anthropic' ? display : null, claude: claudeRecord })
}
