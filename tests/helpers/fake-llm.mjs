#!/usr/bin/env node
/**
 * A fake model provider: unit tests, e2e and `scripts/ai-trial.mjs --fake-model`
 * all use this one module. It is a real http.createServer on loopback, never
 * imported from lib/ or pages/, and tests/ is outside the image, so it cannot
 * ship and the product has no fake mode (design §12.2, PROVIDERS §11).
 *
 * It speaks the four wires the adapters use, through the same paths and headers
 * as the real hosts:
 *
 *   POST /v1/messages          Claude (official SDK, baseURL = this origin)
 *   POST /v1/responses         OpenAI Responses dialect
 *   POST /chat/completions     Chat Completions dialect (also /v1/chat/completions)
 *   GET  /models               model list (also /v1/models, Claude's shape when
 *                              the request carries anthropic-version)
 *
 * A path prefix picks a provider's dialect: /p/deepseek/chat/completions,
 * /p/xai/v1/responses, /p/gemini/models, ... (DIALECTS below; no prefix: the
 * server's `dialect` option, `openai` by default).
 *
 * It ENFORCES the documented failures, which turns a test into a conformance
 * check instead of a mock: an adapter that sends `temperature` to Claude, drops
 * DeepSeek's reasoning_content or splits tool results gets the same 400 it would
 * get in production. Every rule cites its source and the date it was read (SOURCES).
 * The rule that fired is in the `x-fake-rule` response header and its source in
 * `x-fake-source`; bodies stay faithful to the wire.
 *
 * Scripting:
 *
 *   const fake = await startFakeLlm()
 *   fake.enqueue({ text: 'Hello' })                       // the next completion
 *   fake.enqueue(MATRIX.wholeCall())                      // a matrix case
 *   fake.enqueue((req) => ({ text: req.body.model }))     // decided per request
 *   fake.requests                                         // what arrived
 *   await fake.settled(); await fake.close()
 *
 * With nothing queued, the scripted replies apply (see scriptedReply): this is
 * what the trial's "Test model (scripted)" answers, and it says so. A process
 * outside this one (e2e, the trial) scripts the same queue through /__fake/*.
 * Requests hold prompts and keys: in memory only, and nothing here logs them.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const READ_ON = '2026-11-05'

/** Where each enforced behaviour is documented (PROVIDERS, Sources). */
export const SOURCES = {
  claudeVersion: { url: 'https://platform.claude.com/docs/en/api/versioning', ref: 'Claude API skill, shared/api-version-migration.md', date: READ_ON },
  claudeThinking: { url: 'https://platform.claude.com/docs/en/build-with-claude/extended-thinking', ref: 'Claude API skill, shared/model-migration.md, Migrating to Claude Fable 5.1 from Claude Fable 5, Breaking change 3', date: READ_ON },
  claudeFallback: { url: 'https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback', ref: 'Claude API skill, shared/model-migration.md, refusal section', date: READ_ON },
  claudeToolUse: { url: 'https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview', ref: 'Claude API skill, shared/tool-use-concepts.md', date: READ_ON },
  openaiFunctionCalling: { url: 'https://developers.openai.com/api/docs/guides/function-calling', date: READ_ON },
  openaiReasoning: { url: 'https://developers.openai.com/api/docs/guides/reasoning', date: READ_ON },
  openaiStreaming: { url: 'https://developers.openai.com/api/reference/resources/responses/streaming-events', date: READ_ON },
  xai: { url: 'https://docs.x.ai/docs/guides/function-calling', date: READ_ON },
  openrouter: { url: 'https://openrouter.ai/docs/guides/features/tool-calling', date: READ_ON },
  openrouterErrors: { url: 'https://openrouter.ai/docs/llms-full.txt', date: READ_ON },
  deepseekThinking: { url: 'https://api-docs.deepseek.com/guides/thinking_mode', date: READ_ON },
  deepseekChat: { url: 'https://api-docs.deepseek.com/api/create-chat-completion', date: READ_ON },
  geminiSignature: { url: 'https://discuss.ai.google.dev/t/openai-api-compatibility-broken-due-to-thought-signature-on-gemini-3-pro-preview/109823', ref: 'user report; field name unverified until the first live probe', date: READ_ON },
  groq: { url: 'https://console.groq.com/docs/openai', date: READ_ON },
  groqTools: { url: 'https://console.groq.com/docs/tool-use', date: READ_ON },
  mistral: { url: 'https://docs.mistral.ai/capabilities/reasoning', date: READ_ON },
  alibaba: { url: 'https://www.alibabacloud.com/help/en/model-studio/qwen-function-calling', date: READ_ON },
  kimi: { url: 'https://platform.kimi.ai/docs/api/chat', date: READ_ON },
  glm: { url: 'https://docs.z.ai/guides/capabilities/stream-tool', date: READ_ON },
  minimax: { url: 'https://platform.minimax.io/docs/api-reference/text-openai-api', date: READ_ON },
  ollama: { url: 'https://docs.ollama.com/api/openai-compatibility', date: READ_ON },
  lmstudio: { url: 'https://lmstudio.ai/docs/developer/openai-compat/tools', date: READ_ON },
  expected: { url: 'research-providers.md section 11', ref: 'expected behaviour, confirmed in the live smoke', date: READ_ON },
}

/** The exact text Claude can end a turn with after an interruption. */
export const INTERRUPTED_SENTINEL = 'This part of the response was interrupted before it finished.'

/**
 * Provider dialects: how each streams on the chat or responses wire
 * (`shape`) and what it refuses (`rules`, see CHAT_RULES and RESPONSES_RULES).
 */
export const DIALECTS = {
  openai: { shape: {}, rules: ['samplingWithEffort'] },
  xai: { shape: { noArgDeltas: true, requireIncludeForEncrypted: true }, rules: ['xaiParams'] },
  openrouter: { shape: { noArgDeltas: true, comments: ['OPENROUTER PROCESSING'], usageAlways: true }, rules: [] },
  'groq-responses': { shape: {}, rules: ['groqResponsesParams'] },
  deepseek: { shape: { reasoningField: 'reasoning_content', defaultReasoning: 'Thinking it through.', comments: ['keep-alive'] }, rules: ['deepseekEcho', 'deepseekToolChoice', 'deepseekStreamOptions'] },
  gemini: { shape: { omitIndex: true, wholeToolCalls: true, signature: true }, rules: ['geminiSignature'] },
  mistral: { shape: { contentList: true, defaultReasoning: 'Thinking it through.' }, rules: ['mistralToolChoice'] },
  groq: { shape: { usageIn: 'x_groq' }, rules: ['groqParams'] },
  alibaba: { shape: { emptyIdFragments: true, reasoningField: 'reasoning_content' }, rules: ['alibabaSystem', 'alibabaNullContent'] },
  kimi: { shape: { reasoningField: 'reasoning_content', defaultReasoning: 'Thinking it through.' }, rules: ['kimiFixedParams', 'kimiEcho'] },
  glm: { shape: { reasoningField: 'reasoning_content', wholeUnlessToolStream: true }, rules: ['autoToolChoiceOnly'] },
  minimax: { shape: { reasoningField: 'reasoning_content' }, rules: ['autoToolChoiceOnly'] },
  ollama: { shape: { reasoningField: 'reasoning', wholeToolCalls: true, noUsage: true }, keyOptional: true, rules: [] },
  lmstudio: { shape: { reasoningField: 'reasoning' }, keyOptional: true, rules: [] },
}

/**
 * Default model list. A real provider decides these limits, so each test can
 * also pass its own `models`. `claude-opus-5-5` is listed because the Claude
 * preset preselects it.
 */
export const DEFAULT_MODELS = [
  { id: 'fake-model' },
  { id: 'fake-small-output', maxOutputTokens: 8192 },
  { id: 'fake-schema-refuser', refuseToolSchema: true },
  { id: 'fake-no-tools', noTools: true },
  { id: 'claude-opus-5-5', claude: true, maxOutputTokens: 128000, fallbacks: ['claude-opus-5'] },
  { id: 'claude-opus-5', claude: true, maxOutputTokens: 128000, fallbacks: [] },
  { id: 'fake-claude-small', claude: true, maxOutputTokens: 8192, fallbacks: [] },
  { id: 'fake-claude-no-updates', claude: true, maxOutputTokens: 128000, fallbacks: [], refuseDisplayUpdates: true },
]

const encoder = new TextEncoder()
const bytes = (s) => encoder.encode(s).length
const approxTokens = (s) => Math.max(1, Math.ceil(bytes(typeof s === 'string' ? s : JSON.stringify(s) ?? '') / 4))

/** Splits by code point, so a default fragment is always valid text. */
function fragments(text, size = 8) {
  const points = Array.from(text)
  const out = []
  for (let i = 0; i < points.length; i += size) out.push(points.slice(i, i + size).join(''))
  return out
}

/** The arguments of a tool call as the deltas that carry them. */
function argFragments(call) {
  if (call.argFragments) return call.argFragments
  const text = argsText(call)
  if (call.argSplit === 'unit') return text.split('')
  if (typeof call.argSplit === 'number') return fragments(text, call.argSplit)
  return text ? fragments(text, 12) : []
}

const argsText = (call) => (call.argsText !== undefined ? call.argsText : JSON.stringify(call.args ?? {}))

const sse = (data, event) => `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`

// ── Enforcement ─────────────────────────────────────────────────────────

class Refusal extends Error {
  constructor(rule, status, message, extra = {}) {
    super(message)
    this.rule = rule
    this.status = status
    this.extra = extra
  }
}
const refuse = (rule, message, extra) => {
  throw new Refusal(rule, 400, message, extra)
}

const toolChoiceName = (c) => (typeof c === 'string' ? c : c?.type)

const CHAT_RULES = {
  /** "Remove temperature, top_p and top_logprobs whenever effort is not none." */
  samplingWithEffort(body) {
    const effort = body.reasoning_effort ?? body.reasoning?.effort
    if (effort && effort !== 'none') {
      for (const k of ['temperature', 'top_p', 'top_logprobs']) if (k in body) refuse('openai.sampling', `Unsupported parameter: '${k}' is not supported with this model.`, { source: SOURCES.openaiReasoning })
    }
  },
  deepseekEcho(body) {
    if (!body.tools?.length) return
    body.messages.forEach((m, i) => {
      if (m.role === 'assistant' && !m.reasoning_content) refuse('deepseek.reasoning_content', `The \`reasoning_content\` in the thinking mode must be passed back to the API. (messages[${i}])`, { source: SOURCES.deepseekThinking })
    })
  },
  deepseekToolChoice(body) {
    const c = toolChoiceName(body.tool_choice)
    if (c && !['auto', 'none'].includes(c)) refuse('deepseek.tool_choice', 'Forced tool_choice is not supported in thinking mode.', { source: SOURCES.deepseekThinking })
  },
  deepseekStreamOptions(body) {
    if (body.stream_options && !body.stream) refuse('deepseek.stream_options', 'stream_options is only allowed when stream is true.', { source: SOURCES.deepseekChat })
  },
  geminiSignature(body, state) {
    for (const m of body.messages) {
      if (m.role !== 'assistant') continue
      for (const call of m.tool_calls ?? []) {
        const sig = call.extra_content?.google?.thought_signature
        const expected = state.signatures.get(call.id)
        if (!sig || (expected && sig !== expected)) refuse('gemini.thought_signature', 'Function call is missing a thought_signature in functionCall parts.', { source: SOURCES.geminiSignature })
      }
    }
  },
  mistralToolChoice(body) {
    const c = toolChoiceName(body.tool_choice)
    if (c && !['auto', 'any', 'none'].includes(c)) refuse('mistral.tool_choice', `Invalid tool_choice: ${c}`, { source: SOURCES.mistral })
  },
  groqParams(body) {
    for (const k of ['logprobs', 'logit_bias', 'top_logprobs']) if (k in body) refuse('groq.param', `'${k}' is not supported.`, { source: SOURCES.groq })
    if (body.n !== undefined && body.n !== 1) refuse('groq.n', 'n must be 1.', { source: SOURCES.groq })
    if (body.reasoning_format === 'raw' && body.tools?.length) refuse('groq.reasoning_format', 'reasoning_format "raw" cannot be used with tools.', { source: SOURCES.groqTools })
    body.messages.forEach((m, i) => {
      if ('name' in m) refuse('groq.messages.name', `'messages.${i}' : property 'name' is unsupported`, { source: SOURCES.groq })
    })
  },
  alibabaSystem(body) {
    body.messages.forEach((m, i) => {
      if (m.role === 'system' && i !== 0) refuse('alibaba.system', 'Only messages[0] can be a system message.', { source: SOURCES.alibaba })
    })
  },
  alibabaNullContent(body) {
    body.messages.forEach((m, i) => {
      if (m.role === 'assistant' && m.content === null) refuse('alibaba.null_content', `messages[${i}].content must be a string; send "" instead of null.`, { source: SOURCES.alibaba })
    })
  },
  kimiFixedParams(body) {
    for (const k of ['temperature', 'top_p', 'n', 'frequency_penalty', 'presence_penalty']) if (k in body) refuse('kimi.fixed_param', `'${k}' is fixed for this model; passing any other value returns an error.`, { source: SOURCES.kimi })
  },
  kimiEcho(body) {
    if (!body.tools?.length) return
    body.messages.forEach((m, i) => {
      if (m.role === 'assistant' && m.tool_calls?.length && !m.reasoning_content) refuse('kimi.reasoning_content', `messages[${i}] is missing reasoning_content.`, { source: SOURCES.kimi })
    })
  },
  autoToolChoiceOnly(body) {
    const c = toolChoiceName(body.tool_choice)
    if (c && c !== 'auto') refuse('tool_choice.auto_only', 'tool_choice supports only auto.', { source: SOURCES.glm })
  },
}

const RESPONSES_RULES = {
  samplingWithEffort: CHAT_RULES.samplingWithEffort,
  xaiParams(body) {
    for (const k of ['presencePenalty', 'frequencyPenalty', 'presence_penalty', 'frequency_penalty', 'stop']) if (k in body) refuse('xai.param', `'${k}' is not supported on reasoning models.`, { source: SOURCES.xai })
  },
  groqResponsesParams(body) {
    for (const k of ['store', 'include', 'previous_response_id', 'truncation', 'safety_identifier', 'prompt_cache_key']) if (k in body) refuse('groq.responses_param', `'${k}' is not supported on this endpoint.`, { source: SOURCES.groq })
  },
}

/** Any chat wire: a tool call must be answered, by contiguous tool messages, before anything else. */
function checkChatToolPairing(messages) {
  let pending = null
  messages.forEach((m, i) => {
    if (m.role === 'tool') {
      if (!pending?.has(m.tool_call_id)) refuse('chat.tool_result_orphan', `messages[${i}]: a tool message must follow an assistant tool call with the same id.`, { source: SOURCES.expected })
      pending.delete(m.tool_call_id)
      if (!pending.size) pending = null
      return
    }
    if (pending) refuse('chat.tool_unanswered', `messages[${i}]: an assistant message with tool_calls must be followed by tool messages for each call (missing ${[...pending].join(', ')}).`, { source: SOURCES.expected })
    if (m.role === 'assistant' && m.tool_calls?.length) pending = new Set(m.tool_calls.map((c) => c.id))
  })
  if (pending) refuse('chat.tool_unanswered', `An assistant message with tool_calls must be followed by tool messages for each call (missing ${[...pending].join(', ')}).`, { source: SOURCES.expected })
}

/** Responses wire: every function_call answered before the next message, and its reasoning item replayed. */
function checkResponsesInput(body, state) {
  if (body.previous_response_id && body.store === false) refuse('responses.previous_response_id', 'previous_response_id cannot be used: nothing is stored with store: false.', { source: SOURCES.openaiReasoning })
  const input = typeof body.input === 'string' ? [] : (body.input ?? [])
  const seenReasoning = new Map()
  const pending = new Set()
  for (const item of input) {
    if (item.type === 'reasoning') {
      seenReasoning.set(item.id, item.encrypted_content ?? null)
    } else if (item.type === 'function_call') {
      const needed = state.reasoningFor.get(item.call_id)
      if (needed) {
        if (!seenReasoning.has(needed.id)) refuse('responses.reasoning_missing', `Item '${item.id ?? item.call_id}' of type 'function_call' was provided without its required 'reasoning' item: '${needed.id}'.`, { source: SOURCES.openaiReasoning })
        if (seenReasoning.get(needed.id) !== needed.encrypted) refuse('responses.reasoning_changed', `The encrypted content of reasoning item '${needed.id}' does not match.`, { source: SOURCES.openaiReasoning })
      }
      pending.add(item.call_id)
    } else if (item.type === 'function_call_output') {
      if (!pending.delete(item.call_id)) refuse('responses.output_orphan', `No tool call found for function call output with call_id ${item.call_id}.`, { source: SOURCES.openaiFunctionCalling })
    } else if (pending.size) {
      refuse('responses.tool_unanswered', `No tool output found for function call ${[...pending][0]}.`, { source: SOURCES.openaiFunctionCalling })
    }
  }
  if (pending.size) refuse('responses.tool_unanswered', `No tool output found for function call ${[...pending][0]}.`, { source: SOURCES.openaiFunctionCalling })
}

function checkModelLimits(model, requested, field) {
  if (model?.maxOutputTokens !== undefined && typeof requested === 'number' && requested > model.maxOutputTokens) {
    refuse('model.output_cap', `${field}: ${requested} > ${model.maxOutputTokens}, which is the maximum allowed number of output tokens for ${model.id}`, { source: SOURCES.expected })
  }
}

function checkToolSchemas(model, tools, nameOf) {
  if (model?.refuseToolSchema && tools?.length) {
    refuse('model.tool_schema', `Invalid schema for function '${nameOf(tools[0])}': schema is not supported by this model.`, { source: SOURCES.expected })
  }
}

// ── Claude's history rules ─────────────────────────────────────────────

/** What a replayed block must keep; the SDK's snapshot may add empty fields around it. */
function essentialBlock(b) {
  switch (b.type) {
    case 'text':
      return { type: 'text', text: b.text }
    case 'thinking':
      return { type: 'thinking', thinking: b.thinking, signature: b.signature }
    case 'redacted_thinking':
      return { type: 'redacted_thinking', data: b.data }
    case 'tool_use':
      return { type: 'tool_use', id: b.id, name: b.name, input: b.input }
    case 'fallback':
      return { type: 'fallback', from: b.from, to: b.to }
    default:
      return b
  }
}

const turnKey = (content) => JSON.stringify((Array.isArray(content) ? content : [{ type: 'text', text: content }]).map(essentialBlock))

function normalizedMessage(m) {
  return m.role === 'assistant' ? { role: m.role, content: JSON.parse(turnKey(m.content)) } : m
}

const prefixKey = (body, messagesBefore) =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify([body.system ?? null, body.tools ?? [], messagesBefore.map(normalizedMessage)]))
    .digest('hex')

/** The one permitted edit: thinking, redacted thinking and tool use before the final fallback block go. */
function fallbackVariants(content) {
  const boundary = content.map((b) => b.type).lastIndexOf('fallback')
  if (boundary < 0) return [content]
  const before = content.slice(0, boundary).filter((b) => !['thinking', 'redacted_thinking', 'tool_use'].includes(b.type))
  const after = content.slice(boundary + 1)
  return [
    [...before, content[boundary], ...after],
    [...before, ...after],
  ]
}

function checkClaudeBody(body, headers, model, state, options) {
  for (const k of ['temperature', 'top_p', 'top_k']) if (k in body) refuse('claude.sampling', `${k}: this parameter is not supported on API version 2026-10-21.`, { source: SOURCES.claudeVersion })
  if (body.thinking?.budget_tokens !== undefined || body.thinking?.type === 'enabled') refuse('claude.budget_tokens', 'thinking.type: "enabled" with budget_tokens is not supported on this model. Use "adaptive".', { source: SOURCES.claudeThinking })
  if (body.thinking?.type === 'disabled') refuse('claude.thinking_disabled', 'thinking.type: "disabled" is not supported on this model.', { source: SOURCES.claudeThinking })
  if ('tool_choice' in body) refuse('claude.tool_choice', 'tool_choice: type "tool" and "any" are not supported for this model.', { source: SOURCES.claudeThinking })
  const messages = body.messages ?? []
  const last = messages[messages.length - 1]
  if (last?.role === 'assistant') refuse('claude.prefill', 'This model does not support assistant message prefill. The conversation must end with a user message.', { source: SOURCES.claudeThinking })

  const betas = String(headers['anthropic-beta'] ?? '')
    .split(',')
    .map((b) => b.trim())
  if (body.fallbacks !== undefined) {
    if (body.fallbacks === 'default' && !betas.includes('server-side-fallback-2026-07-01')) refuse('claude.fallback_beta', 'fallbacks: "default" requires the server-side-fallback-2026-07-01 beta.', { source: SOURCES.claudeFallback })
    if (model?.claude && !model.fallbacks?.length) refuse('claude.fallback_unsupported', `fallbacks is not supported when ${model.id} is the primary model.`, { source: SOURCES.claudeFallback })
  }
  if (body.thinking?.display === 'updates') {
    if (!betas.includes('thinking-display-updates-2026-08-18')) refuse('claude.display_beta', 'thinking.display: "updates" requires the thinking-display-updates-2026-08-18 beta.', { source: SOURCES.claudeThinking })
    if (model?.refuseDisplayUpdates) refuse('claude.display_updates', `thinking.display: "updates" is not supported on ${model.id}.`, { source: SOURCES.claudeThinking })
  }

  // Tool results: every tool_use answered, all of a turn's results in the one next user message.
  messages.forEach((m, i) => {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) return
    const ids = m.content.filter((b) => b.type === 'tool_use').map((b) => b.id)
    if (!ids.length) return
    const next = messages[i + 1]
    const answered = new Set(Array.isArray(next?.content) ? next.content.filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id) : [])
    const missing = ids.filter((id) => !answered.has(id))
    if (missing.length) refuse('claude.tool_unanswered', `messages.${i + 1}: \`tool_use\` ids were found without \`tool_result\` blocks immediately after: ${missing.join(', ')}. Each \`tool_use\` block must have a corresponding \`tool_result\` block in the next message.`, { source: SOURCES.claudeToolUse })
  })
  messages.forEach((m, i) => {
    if (m.role !== 'user' || !Array.isArray(m.content)) return
    for (const b of m.content) {
      if (b.type !== 'tool_result') continue
      const prev = messages[i - 1]
      const known = prev?.role === 'assistant' && Array.isArray(prev.content) && prev.content.some((p) => p.type === 'tool_use' && p.id === b.tool_use_id)
      if (!known) refuse('claude.tool_result_orphan', `messages.${i}: unexpected \`tool_use_id\` found in \`tool_result\` blocks: ${b.tool_use_id}.`, { source: SOURCES.claudeToolUse })
    }
  })

  // Preserved thinking: a replayed thinking block is bound to its model and to the exact prefix it was produced after.
  if (options.strictHistory === false) return
  messages.forEach((m, i) => {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) return
    m.content.forEach((b, j) => {
      if (b.type !== 'thinking' && b.type !== 'redacted_thinking') return
      const where = `messages.${i}.content.${j}`
      const key = b.type === 'thinking' ? b.signature : b.data
      const produced = state.thinking.get(key)
      const invalid = `${where}: Invalid signature in thinking block: the block is bound to a different conversation.`
      if (!produced) refuse('claude.thinking_signature', invalid, { source: SOURCES.claudeThinking })
      if (produced.prefix !== prefixKey(body, messages.slice(0, i))) refuse('claude.thinking_prefix', invalid, { source: SOURCES.claudeThinking })
      if (!produced.variants.has(turnKey(m.content))) refuse('claude.thinking_block_changed', invalid, { source: SOURCES.claudeThinking })
    })
  })
}

// ── Reading a request: what the scripted replies and the tests need ────

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((p) => typeof p?.text === 'string')
    .map((p) => p.text)
    .join('\n')
}

export function inspectRequest(wire, body) {
  if (wire === 'messages') {
    const last = body.messages?.[body.messages.length - 1]
    return {
      lastIsToolResult: Array.isArray(last?.content) && last.content.some((b) => b.type === 'tool_result'),
      lastUserText: last?.role === 'user' ? textOf(last.content) : '',
      toolNames: (body.tools ?? []).map((t) => t.name),
    }
  }
  if (wire === 'responses') {
    const input = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : (body.input ?? [])
    const last = input[input.length - 1]
    return {
      lastIsToolResult: last?.type === 'function_call_output',
      lastUserText: last?.role === 'user' ? textOf(last.content) : '',
      toolNames: (body.tools ?? []).map((t) => t.name),
    }
  }
  const last = body.messages?.[body.messages.length - 1]
  return {
    lastIsToolResult: last?.role === 'tool',
    lastUserText: last?.role === 'user' ? textOf(last.content) : '',
    toolNames: (body.tools ?? []).map((t) => t.function?.name ?? t.name),
  }
}

/** Markdown a hostile model might answer with; the images and links point at this server's collector. */
export const hostileMarkdown = (origin) =>
  [
    'Here is a hostile reply.',
    '',
    `![pixel](${origin}/__fake/collect/inline.png?d=secret)`,
    '',
    `![ref][1] and [a link][1] and [draft](/api/admin/draft) and [review](/ai/review/x)`,
    '',
    `<img src="${origin}/__fake/collect/raw.png"> <script>window.__owned = true</script>`,
    '',
    `[1]: ${origin}/__fake/collect/ref.png`,
  ].join('\n')

/**
 * The replies when nothing is queued: what `--fake-model` answers. No model
 * runs, and the default answer says so. Tests and trial walkers drive it with
 * plain directives in the message:
 *
 *   /say <text>             answers exactly that text (any language)
 *   /tool <name> <json>     calls a tool; several lines make parallel calls
 *   /hostile                answers hostile Markdown (see above)
 *   /slow <text>            streams a long answer slowly, for Stop and re-attach
 *
 * "Call probe_echo with ..." calls probe_echo when offered, like Test does.
 */
export function scriptedReply(info, ctx = {}) {
  if (info.lastIsToolResult) return { text: 'Test model (scripted): the tool call finished.', reasoning: 'Reading the tool result.' }
  const text = info.lastUserText ?? ''
  if (/\bprobe_echo\b/.test(text) && info.toolNames.includes('probe_echo')) {
    return { toolCalls: [{ name: 'probe_echo', args: { value: 'ok' } }], reasoning: 'Calling the probe.' }
  }
  const tools = [...text.matchAll(/^\/tool\s+([A-Za-z_][\w-]*)[ \t]*(.*)$/gm)]
  if (tools.length) {
    return {
      reasoning: 'Calling the tool the message named.',
      toolCalls: tools.map(([, name, json]) => ({ name, argsText: json.trim() || '{}' })),
    }
  }
  const say = text.match(/^\/say\s+([\s\S]*)$/m)
  if (say) return { text: say[1], reasoning: 'Saying what the message asked for.' }
  if (/^\/hostile\b/m.test(text)) return { text: hostileMarkdown(ctx.origin ?? 'http://127.0.0.1'), reasoning: 'Answering with hostile Markdown.' }
  const slow = text.match(/^\/slow\s*([\s\S]*)$/m)
  if (slow) return { text: `${slow[1] || 'A slow answer.'} `.repeat(40), textFragmentSize: 6, delayMs: 100, reasoning: 'Answering slowly.' }
  return { text: 'Test model (scripted): no model ran. Send /say <text>, /tool <name> <json>, /hostile or /slow <text>.', reasoning: 'No directive in this message.' }
}

// ── Usage ───────────────────────────────────────────────────────────────

function usageOf(turn, body, outputText) {
  const u = turn.usage ?? {}
  return {
    input: u.input ?? approxTokens(body),
    output: u.output ?? approxTokens(outputText || ' '),
    cachedRead: u.cachedRead ?? 0,
    cacheWrite: u.cacheWrite ?? 0,
    reasoning: u.reasoning ?? 0,
    cost: u.cost,
    costTicks: u.costTicks,
  }
}

// ── Chat Completions ────────────────────────────────────────────────────

function renderChat(turn, ctx) {
  const { body, seq, shape: dialectShape, state, created } = ctx
  const shape = { ...dialectShape, ...turn.shape }
  const model = body.model
  const id = `chatcmpl-fake${seq}`
  const chunk = (delta, finish = null, extra = {}) => sse({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })
  const frames = []
  const message = { role: 'assistant', content: null }

  const field = shape.reasoningField
  const reasoning = turn.reasoning === null ? '' : (turn.reasoning ?? shape.defaultReasoning ?? '')
  frames.push(chunk({ role: 'assistant', content: shape.contentList ? [] : '' }))

  if (reasoning && shape.contentList) {
    const parts = fragments(reasoning)
    for (const p of parts) frames.push(chunk({ content: [{ type: 'thinking', thinking: [{ type: 'text', text: p }] }] }))
    message.content = [{ type: 'thinking', thinking: [{ type: 'text', text: reasoning }] }]
  } else if (reasoning && field) {
    for (const p of fragments(reasoning)) frames.push(chunk({ [field]: p }))
    message[field] = reasoning
  }

  let text = typeof turn.text === 'string' ? turn.text : Array.isArray(turn.text) ? turn.text.join('') : ''
  const parts = Array.isArray(turn.text) ? [...turn.text] : text ? fragments(text, turn.textFragmentSize) : []
  if (shape.thinkTag && reasoning) {
    parts.unshift(`<think>${reasoning}</think>`)
    text = `<think>${reasoning}</think>${text}`
  }
  for (const p of parts) frames.push(chunk({ content: p }))
  if (text) message.content = shape.contentList && message.content ? [...message.content, { type: 'text', text }] : text

  if (turn.refusal) {
    for (const p of fragments(turn.refusal)) frames.push(chunk({ refusal: p }))
    message.refusal = turn.refusal
  }

  // Tool calls.
  const calls = (turn.toolCalls ?? []).map((c, i) => ({ ...c, id: c.id ?? `call_fake${seq}_${i}` }))
  const whole = shape.wholeToolCalls || (shape.wholeUnlessToolStream && !body.tool_stream)
  calls.forEach((call, i) => {
    const signature = shape.signature ? `fake-signature-${seq}-${i}` : null
    if (signature) state.signatures.set(call.id, signature)
    const extra = signature ? { extra_content: { google: { thought_signature: signature } } } : {}
    const indexed = (d) => (shape.omitIndex ? d : { index: i, ...d })
    if (whole) {
      frames.push(chunk({ tool_calls: [indexed({ id: call.id, type: 'function', function: { name: call.name, arguments: argsText(call) }, ...extra })] }))
      return
    }
    frames.push(chunk({ tool_calls: [indexed({ id: call.id, type: 'function', function: { name: call.name, arguments: '' }, ...extra })] }))
    for (const frag of argFragments(call)) {
      const delta = shape.emptyIdFragments ? { id: '', type: 'function', function: { name: null, arguments: frag } } : { function: { arguments: frag } }
      frames.push(chunk({ tool_calls: [indexed(delta)] }))
    }
  })
  if (calls.length) {
    message.tool_calls = calls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: argsText(call) },
      ...(shape.signature ? { extra_content: { google: { thought_signature: state.signatures.get(call.id) } } } : {}),
    }))
  }

  const finish = turn.finishReason ?? { max_tokens: 'length', content_filter: 'content_filter' }[turn.stop] ?? (calls.length ? 'tool_calls' : 'stop')

  const usage = usageOf(turn, body, text + reasoning + calls.map(argsText).join(''))
  const wireUsage = {
    prompt_tokens: usage.input + usage.cachedRead,
    completion_tokens: usage.output,
    total_tokens: usage.input + usage.cachedRead + usage.output,
    prompt_tokens_details: { cached_tokens: usage.cachedRead },
    completion_tokens_details: { reasoning_tokens: usage.reasoning },
    ...(usage.cost !== undefined ? { cost: usage.cost } : {}),
    ...(ctx.dialect === 'deepseek' ? { prompt_cache_hit_tokens: usage.cachedRead, prompt_cache_miss_tokens: usage.input } : {}),
  }
  const wantsUsage = !shape.noUsage && (body.stream_options?.include_usage || shape.usageAlways || shape.usageIn === 'x_groq')

  if (shape.usageIn === 'x_groq') frames.push(chunk({}, finish, { x_groq: { usage: wireUsage } }))
  else if (shape.usageOnFinish && wantsUsage) frames.push(chunk({}, finish, { usage: wireUsage }))
  else frames.push(chunk({}, finish))
  if (wantsUsage && shape.usageIn !== 'x_groq' && !shape.usageOnFinish) frames.push(sse({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: wireUsage }))
  if (!shape.noDone) frames.push(sse('[DONE]'))

  return {
    frames,
    final: { id, object: 'chat.completion', created, model, choices: [{ index: 0, message, finish_reason: finish }], usage: wireUsage },
  }
}

/** An error inside a 200 stream: OpenRouter's shape, or MiniMax's native base_resp. */
function chatInBandError(err, ctx) {
  const id = `chatcmpl-fake${ctx.seq}`
  if (err.shape === 'minimax') return sse({ id, base_resp: { status_code: err.code ?? 1008, status_msg: err.message } })
  return sse({ id, object: 'chat.completion.chunk', created: ctx.created, model: ctx.body.model, error: { message: err.message, code: err.code ?? 502 }, choices: [{ index: 0, delta: {}, finish_reason: 'error' }] })
}

// ── Responses ───────────────────────────────────────────────────────────

function renderResponses(turn, ctx) {
  const { body, seq, shape: dialectShape, state, created } = ctx
  const shape = { ...dialectShape, ...turn.shape }
  const responseId = `resp_fake${seq}`
  const frames = []
  let n = 0
  const ev = (type, data) => frames.push(sse({ type, sequence_number: n++, ...data }, type))
  const output = []
  const base = { id: responseId, object: 'response', created_at: created, model: body.model, error: null, incomplete_details: null, instructions: body.instructions ?? null, store: body.store ?? true }
  ev('response.created', { response: { ...base, status: 'in_progress', output: [] } })
  ev('response.in_progress', { response: { ...base, status: 'in_progress', output: [] } })

  const reasoning = turn.reasoning === null ? undefined : (turn.reasoning ?? shape.defaultReasoning)
  let reasoningItem = null
  if (reasoning !== undefined) {
    const itemId = `rs_fake${seq}`
    const wantsEncrypted = !shape.requireIncludeForEncrypted || body.include?.includes('reasoning.encrypted_content')
    const encrypted = wantsEncrypted ? crypto.createHmac('sha256', state.secret).update(`${seq}:${reasoning}`).digest('base64') : null
    reasoningItem = { id: itemId, type: 'reasoning', summary: reasoning ? [{ type: 'summary_text', text: reasoning }] : [], ...(encrypted ? { encrypted_content: encrypted } : {}) }
    const output_index = output.length
    ev('response.output_item.added', { output_index, item: { id: itemId, type: 'reasoning', summary: [] } })
    for (const p of fragments(reasoning)) ev('response.reasoning_summary_text.delta', { item_id: itemId, output_index, summary_index: 0, delta: p })
    ev('response.output_item.done', { output_index, item: reasoningItem })
    output.push(reasoningItem)
  }

  const text = Array.isArray(turn.text) ? turn.text.join('') : (turn.text ?? '')
  if (text || turn.refusal) {
    const itemId = `msg_fake${seq}`
    const output_index = output.length
    const content = []
    ev('response.output_item.added', { output_index, item: { id: itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] } })
    if (text) {
      const content_index = content.length
      ev('response.content_part.added', { item_id: itemId, output_index, content_index, part: { type: 'output_text', text: '', annotations: [] } })
      for (const p of Array.isArray(turn.text) ? turn.text : fragments(text, turn.textFragmentSize)) ev('response.output_text.delta', { item_id: itemId, output_index, content_index, delta: p })
      ev('response.output_text.done', { item_id: itemId, output_index, content_index, text })
      const part = { type: 'output_text', text, annotations: [] }
      ev('response.content_part.done', { item_id: itemId, output_index, content_index, part })
      content.push(part)
    }
    if (turn.refusal) {
      const content_index = content.length
      ev('response.content_part.added', { item_id: itemId, output_index, content_index, part: { type: 'refusal', refusal: '' } })
      for (const p of fragments(turn.refusal)) ev('response.refusal.delta', { item_id: itemId, output_index, content_index, delta: p })
      ev('response.refusal.done', { item_id: itemId, output_index, content_index, refusal: turn.refusal })
      const part = { type: 'refusal', refusal: turn.refusal }
      ev('response.content_part.done', { item_id: itemId, output_index, content_index, part })
      content.push(part)
    }
    const item = { id: itemId, type: 'message', role: 'assistant', status: 'completed', content }
    ev('response.output_item.done', { output_index, item })
    output.push(item)
  }

  const calls = (turn.toolCalls ?? []).map((c, i) => ({ ...c, id: c.id ?? `call_fake${seq}_${i}` }))
  calls.forEach((call, i) => {
    const itemId = `fc_fake${seq}_${i}`
    const output_index = output.length
    const args = argsText(call)
    ev('response.output_item.added', { output_index, item: { id: itemId, type: 'function_call', status: 'in_progress', call_id: call.id, name: call.name, arguments: '' } })
    if (!shape.noArgDeltas) {
      for (const frag of argFragments(call)) ev('response.function_call_arguments.delta', { item_id: itemId, output_index, delta: frag })
      ev('response.function_call_arguments.done', { item_id: itemId, output_index, arguments: args })
    }
    const item = { id: itemId, type: 'function_call', status: 'completed', call_id: call.id, name: call.name, arguments: args }
    ev('response.output_item.done', { output_index, item })
    output.push(item)
    if (reasoningItem) state.reasoningFor.set(call.id, { id: reasoningItem.id, encrypted: reasoningItem.encrypted_content ?? null })
  })

  const usage = usageOf(turn, body, text + (reasoning ?? '') + calls.map(argsText).join(''))
  const wireUsage = {
    input_tokens: usage.input + usage.cachedRead,
    input_tokens_details: { cached_tokens: usage.cachedRead },
    output_tokens: usage.output,
    output_tokens_details: { reasoning_tokens: usage.reasoning },
    total_tokens: usage.input + usage.cachedRead + usage.output,
    ...(usage.cost !== undefined ? { cost: usage.cost } : {}),
    ...(usage.costTicks !== undefined ? { cost_in_usd_ticks: usage.costTicks } : {}),
  }
  const final = { ...base, status: 'completed', output, usage: wireUsage }
  if (turn.incomplete) {
    const response = { ...final, status: 'incomplete', incomplete_details: { reason: turn.incomplete } }
    ev('response.incomplete', { response })
    return { frames, final: response }
  }
  if (turn.failed) {
    const response = { ...final, status: 'failed', error: { code: turn.failed.code ?? 'server_error', message: turn.failed.message } }
    ev('response.failed', { response })
    return { frames, final: response }
  }
  if (turn.errorEvent) {
    frames.push(sse({ type: 'error', sequence_number: n++, code: turn.errorEvent.code ?? 'server_error', message: turn.errorEvent.message, param: null }, 'error'))
    return { frames, final }
  }
  ev('response.completed', { response: final })
  return { frames, final }
}

// ── Claude Messages ─────────────────────────────────────────────────────

function claudeBlocks(turn, ctx) {
  if (turn.blocks) return turn.blocks
  const display = ctx.body.thinking?.display
  const blocks = []
  const fb = turn.fallback && { type: 'fallback', from: { model: turn.fallback.from ?? ctx.body.model }, to: { model: turn.fallback.to ?? 'claude-opus-5' }, trigger: { type: 'refusal', category: turn.fallback.category ?? 'cyber' } }
  if (fb && turn.fallback.position !== 'mid') blocks.push(fb)
  if (turn.reasoning !== null) blocks.push({ type: 'thinking', thinking: display === 'updates' ? (turn.reasoning ?? '') : '' })
  const text = Array.isArray(turn.text) ? turn.text.join('') : turn.text
  if (text) blocks.push({ type: 'text', text })
  if (fb && turn.fallback.position === 'mid') {
    blocks.push(fb)
    if (turn.reasoning !== null) blocks.push({ type: 'thinking', thinking: '' })
    blocks.push({ type: 'text', text: turn.fallback.continuation ?? 'The fallback model continued.' })
  }
  for (const [i, c] of (turn.toolCalls ?? []).entries()) {
    blocks.push({ type: 'tool_use', id: c.id ?? `toolu_fake${ctx.seq}_${i}`, name: c.name, call: c })
  }
  if (turn.sentinel) blocks.push({ type: 'text', text: INTERRUPTED_SENTINEL })
  return blocks
}

function renderMessages(turn, ctx) {
  const { body, seq, state } = ctx
  const id = `msg_fake${seq}`
  const frames = []
  const ev = (type, data) => frames.push(sse({ type, ...data }, type))
  const blocks = claudeBlocks(turn, ctx)
  const servedBy = turn.servedBy ?? (turn.fallback && turn.fallback.position !== 'mid' ? (turn.fallback.to ?? 'claude-opus-5') : body.model)

  const finalContent = []
  const outputParts = []
  const startUsage = usageOf(turn, body, ' ')
  ev('message_start', {
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: servedBy,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      stop_details: null,
      usage: { input_tokens: startUsage.input, output_tokens: 1, cache_creation_input_tokens: startUsage.cacheWrite, cache_read_input_tokens: startUsage.cachedRead },
    },
  })
  ev('ping', {})

  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      ev('content_block_start', { index, content_block: { type: 'text', text: '' } })
      for (const p of block.fragments ?? fragments(block.text, turn.textFragmentSize)) ev('content_block_delta', { index, delta: { type: 'text_delta', text: p } })
      ev('content_block_stop', { index })
      finalContent.push({ type: 'text', text: block.text })
      outputParts.push(block.text)
    } else if (block.type === 'thinking') {
      const signature = block.signature ?? crypto.createHmac('sha256', state.secret).update(`${id}:${index}:${block.thinking}`).digest('base64')
      ev('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } })
      if (block.thinking) for (const p of fragments(block.thinking)) ev('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: p } })
      ev('content_block_delta', { index, delta: { type: 'signature_delta', signature } })
      ev('content_block_stop', { index })
      finalContent.push({ type: 'thinking', thinking: block.thinking, signature })
      outputParts.push(block.thinking)
    } else if (block.type === 'redacted_thinking') {
      const data = block.data ?? crypto.createHmac('sha256', state.secret).update(`${id}:${index}:redacted`).digest('base64')
      ev('content_block_start', { index, content_block: { type: 'redacted_thinking', data } })
      ev('content_block_stop', { index })
      finalContent.push({ type: 'redacted_thinking', data })
    } else if (block.type === 'tool_use') {
      const call = block.call ?? block
      ev('content_block_start', { index, content_block: { type: 'tool_use', id: block.id ?? `toolu_fake${seq}_${index}`, name: block.name, input: {} } })
      for (const frag of argFragments(call)) ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: frag } })
      ev('content_block_stop', { index })
      let input = {}
      try {
        input = JSON.parse(argsText(call) || '{}')
      } catch {
        input = {}
      }
      finalContent.push({ type: 'tool_use', id: block.id ?? `toolu_fake${seq}_${index}`, name: block.name, input })
      outputParts.push(argsText(call))
    } else {
      // fallback, and anything a test supplies by hand.
      ev('content_block_start', { index, content_block: block })
      ev('content_block_stop', { index })
      finalContent.push(block)
    }
  })

  const hasTool = finalContent.some((b) => b.type === 'tool_use')
  const stop_reason = turn.stopReason ?? (turn.stop === 'max_tokens' ? 'max_tokens' : turn.stop === 'refusal' ? 'refusal' : hasTool ? 'tool_use' : 'end_turn')
  const stop_details =
    stop_reason === 'refusal'
      ? {
          type: 'refusal',
          category: turn.refusalCategory === undefined ? 'cyber' : turn.refusalCategory,
          explanation: turn.refusalExplanation === undefined ? 'The request was declined.' : turn.refusalExplanation,
          fallback_credit_token: null,
          fallback_has_prefill_claim: null,
          recommended_model: null,
        }
      : null
  const usage = usageOf(turn, body, outputParts.join(''))
  const wireUsage = {
    input_tokens: usage.input,
    output_tokens: usage.output,
    cache_creation_input_tokens: usage.cacheWrite,
    cache_read_input_tokens: usage.cachedRead,
    ...(turn.iterations ? { iterations: turn.iterations } : {}),
  }
  ev('message_delta', { delta: { stop_reason, stop_sequence: null, stop_details }, usage: wireUsage })
  ev('message_stop', {})

  // What a replay of this turn is checked against.
  const messages = body.messages ?? []
  const prefix = prefixKey(body, messages)
  const variants = new Set(fallbackVariants(finalContent).map((c) => turnKey(c)))
  const mid = turn.fallback?.position === 'mid' || (turn.blocks && turn.blocks.findIndex((b) => b.type === 'fallback') > 0)
  if (!mid) variants.add(turnKey(finalContent))
  for (const b of finalContent) {
    if (b.type === 'thinking') state.thinking.set(b.signature, { prefix, variants, model: servedBy })
    if (b.type === 'redacted_thinking') state.thinking.set(b.data, { prefix, variants, model: servedBy })
  }

  return {
    frames,
    final: { id, type: 'message', role: 'assistant', model: servedBy, content: finalContent, stop_reason, stop_sequence: null, stop_details, usage: wireUsage },
  }
}

// ── Matrix presets (PROVIDERS §11) ──────────────────────────────────────

/** Each entry returns a fresh turn. Use with enqueue(), or by name through /__fake/enqueue. */
export const MATRIX = {
  text: () => ({ text: 'Hello from the test model.' }),
  textChinese: () => ({ text: '你好，这是测试模型的回复。' }),
  oneTool: () => ({ toolCalls: [{ name: 'get_content', args: { collection: 'blog', slug: 'hello' } }] }),
  parallelTools: () => ({
    toolCalls: [
      { name: 'get_content', args: { slug: 'a' } },
      { name: 'list_content', args: { collection: 'work' } },
    ],
  }),
  // Transport: every byte is its own write, so a boundary falls inside each UTF-8 character.
  everyByte: () => ({ text: '逐字节流', toolCalls: [{ name: 'create_draft', args: { title: '标题 🎉 title' } }], chunking: { every: 1 } }),
  // Deltas split at every UTF-16 code unit, including inside a surrogate pair.
  everyArgUnit: () => ({ toolCalls: [{ name: 'create_draft', args: { title: 'emoji 🎉' }, argSplit: 'unit' }] }),
  wholeCall: () => ({ toolCalls: [{ name: 'get_content', args: { slug: 'whole' } }], shape: { wholeToolCalls: true } }),
  missingIndex: () => ({ toolCalls: [{ name: 'get_content', args: { slug: 'a' } }, { name: 'get_content', args: { slug: 'b' } }], shape: { omitIndex: true, wholeToolCalls: true } }),
  emptyIdNullName: () => ({ toolCalls: [{ name: 'get_content', args: { slug: 'fragments' } }], shape: { emptyIdFragments: true } }),
  emptyArguments: () => ({ toolCalls: [{ name: 'site_status', argsText: '' }] }),
  comments: () => ({ text: 'After comments.', comments: ['keep-alive', 'OPENROUTER PROCESSING'] }),
  crlf: () => ({ text: 'Lines end in CRLF.', crlf: true }),
  noDone: () => ({ text: 'No DONE marker.', shape: { noDone: true } }),
  usageChunk: () => ({ text: 'Usage arrives in a chunk with no choices.', shape: { usageAlways: true } }),
  contentAsList: () => ({ reasoning: 'Thinking in a list.', text: 'Then plain text.', shape: { contentList: true } }),
  leadingThink: () => ({ reasoning: 'Thinking inline.', text: 'The visible answer.', shape: { thinkTag: true } }),
  inBandError: () => ({ text: 'Partial text before the failure.', inBandError: { afterFrames: 3, message: 'Upstream provider failed.', code: 502 } }),
  inBandErrorMinimax: () => ({ text: 'Partial text.', inBandError: { afterFrames: 2, message: 'insufficient balance', code: 1008, shape: 'minimax' } }),
  lengthWithTool: () => ({ toolCalls: [{ name: 'create_draft', args: { title: 'cut off' } }], stop: 'max_tokens' }),
  insufficientResources: () => ({ text: 'Cut.', finishReason: 'insufficient_system_resource' }),
  contentFilter: () => ({ text: 'Blocked.', stop: 'content_filter' }),
  refusalBeforeOutput: () => ({ reasoning: null, stop: 'refusal', refusalCategory: 'cyber', refusalExplanation: 'Declined before any output.', text: '' }),
  refusalMidStream: () => ({ reasoning: null, text: 'Started to answer ', stop: 'refusal', refusalCategory: null, refusalExplanation: null }),
  responsesRefusal: () => ({ refusal: 'I cannot help with that.' }),
  responsesIncomplete: () => ({ text: 'Partial.', incomplete: 'max_output_tokens' }),
  responsesFailed: () => ({ text: 'Partial.', failed: { message: 'The model failed.' } }),
  responsesErrorEvent: () => ({ text: 'Partial.', errorEvent: { message: 'Stream error.' } }),
  claudeFallbackBefore: () => ({ text: 'Served by the fallback model.', fallback: { position: 'before', to: 'claude-opus-5' }, iterations: [{ type: 'message', model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null }, { type: 'fallback_message', model: 'claude-opus-5', input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null }] }),
  claudeFallbackMid: () => ({ reasoning: 'Note before the switch.', text: 'Before the switch. ', toolCalls: [], fallback: { position: 'mid', to: 'claude-opus-5', continuation: 'After the switch.' } }),
  claudeSentinel: () => ({ text: 'Text that stopped early.', sentinel: true, stop: 'max_tokens' }),
  pauseTurn: () => ({ text: 'Paused.', stopReason: 'pause_turn' }),
  contextWindow: () => ({ text: 'The window is full.', stopReason: 'model_context_window_exceeded' }),
  stopSequence: () => ({ text: 'Stopped by a sequence.', stopReason: 'stop_sequence' }),
  // Not JSON at any length: the SDK's tolerant parser throws its own error when the input is read.
  malformedEagerJson: () => ({ reasoning: null, toolCalls: [{ name: 'create_draft', argsText: '{"title":1,}' }] }),
  // Cut mid-string: the tolerant parser silently returns a shorter object, which is why the loop validates.
  truncatedEagerJson: () => ({ reasoning: null, toolCalls: [{ name: 'create_draft', argsText: '{"title":"cut', argFragments: ['{"title":', '"cut'] }], stopReason: 'max_tokens' }),
  abortMidText: () => ({ text: 'x'.repeat(4000), textFragmentSize: 8, delayMs: 5 }),
  abortMidTool: () => ({ toolCalls: [{ name: 'create_draft', args: { body: 'x'.repeat(4000) }, argSplit: 8 }], delayMs: 5 }),
  idle: () => ({ text: 'Then silence.', hangAfter: 3 }),
  eof: () => ({ text: 'Ends with no terminal event.', truncateAfter: 3 }),
  connectionLost: () => ({ text: 'The socket dies.', destroyAfter: 3 }),
  rateLimited: () => ({ status: 429, headers: { 'retry-after': '7' }, errorMessage: 'Rate limit exceeded.', errorType: 'rate_limit_error' }),
  unauthorized: () => ({ status: 401, errorMessage: 'Invalid API key.', errorType: 'authentication_error' }),
  overloaded: () => ({ status: 529, errorMessage: 'Overloaded.', errorType: 'overloaded_error' }),
  billing: () => ({ status: 402, errorMessage: 'Your credit balance is too low.', errorType: 'billing_error' }),
  groqFailedGeneration: () => ({ status: 400, errorBody: { error: { message: 'Failed to call a function. Please adjust your prompt.', type: 'invalid_request_error', code: 'tool_use_failed', failed_generation: '<function=get_content{"slug":' } } }),
  redactedThinking: () => ({ blocks: [{ type: 'redacted_thinking' }, { type: 'text', text: 'After redacted thinking.' }] }),
}

// ── The server ──────────────────────────────────────────────────────────

const MAX_BODY_BYTES = 32 * 1024 * 1024

const CONTROL_PREFIX = '/__fake'

function errorBody(wire, status, message, type) {
  if (wire === 'messages') {
    const t = type ?? { 400: 'invalid_request_error', 401: 'authentication_error', 402: 'billing_error', 403: 'permission_error', 404: 'not_found_error', 429: 'rate_limit_error', 500: 'api_error', 529: 'overloaded_error' }[status] ?? 'api_error'
    return { type: 'error', error: { type: t, message }, request_id: `req_fake${crypto.randomBytes(6).toString('hex')}` }
  }
  return { error: { message, type: type ?? 'invalid_request_error', param: null, code: null } }
}

function listModels(models, { claude, dialect, query }) {
  if (claude) {
    const data = models.filter((m) => m.claude).map((m) => ({
      id: m.id,
      type: 'model',
      display_name: m.displayName ?? m.id,
      created_at: '2026-01-01T00:00:00Z',
      deprecated_at: null,
      lifecycle: 'active',
      line: null,
      max_input_tokens: m.maxInputTokens ?? 1000000,
      max_tokens: m.maxOutputTokens ?? 64000,
      allowed_fallback_models: m.fallbacks ?? [],
      capabilities: {
        batch: { supported: true },
        citations: { supported: true },
        code_execution: { supported: false },
        compaction: null,
        context_management: null,
        effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: true }, max: { supported: true } },
        image_input: { supported: true },
        pdf_input: { supported: true },
        server_tools: { supported: false, code_execution: { supported: false }, web_search: { supported: false } },
        structured_outputs: { supported: true },
        thinking: { supported: true, types: { adaptive: { supported: true }, between_tools: { supported: false }, disabled: { supported: false }, enabled: { supported: false } } },
      },
    }))
    return { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data[data.length - 1]?.id ?? null }
  }
  let list = models.filter((m) => !m.claude)
  if (dialect === 'openrouter' && query.get('supported_parameters') === 'tools') list = list.filter((m) => !m.noTools)
  return {
    object: 'list',
    data: list.map((m) => ({
      id: m.id,
      object: 'model',
      created: 1767225600,
      owned_by: 'fake-llm',
      ...(dialect === 'openrouter' ? { supported_parameters: m.noTools ? ['max_tokens'] : ['max_tokens', 'tools'] } : {}),
    })),
  }
}

/** Starts the fake on 127.0.0.1. `port` 0 picks a free one. Binding anywhere else is not offered. */
export async function startFakeLlm(options = {}) {
  const { port = 0, dialect: defaultDialect = 'openai', models: modelList = DEFAULT_MODELS, apiKey = null, strictModels = false, strictHistory = true } = options

  const queue = []
  const modelsQueue = []
  const requests = []
  const collected = []
  const sockets = new Set()
  const state = { secret: crypto.randomBytes(32), thinking: new Map(), reasoningFor: new Map(), signatures: new Map() }
  let seq = 0
  let inFlight = 0
  let settledWaiters = []
  let origin = ''

  const noteSettled = () => {
    if (inFlight === 0) {
      for (const w of settledWaiters) w()
      settledWaiters = []
    }
  }

  const modelById = (id) => modelList.find((m) => m.id === id)

  const resolveTurn = (entry) => {
    if (entry && typeof entry === 'object' && typeof entry.preset === 'string') {
      const make = MATRIX[entry.preset]
      if (!make) throw new Error(`no such preset: ${entry.preset}`)
      return { ...make(), ...entry, preset: undefined }
    }
    return entry
  }

  function writeJson(res, status, body, headers = {}) {
    const text = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers })
    res.end(text)
  }

  async function streamFrames(res, frames, turn, ctx) {
    const inBand = turn.inBandError
    let list = frames
    if (inBand) list = [...frames.slice(0, inBand.afterFrames), chatInBandError(inBand, ctx)]
    let abrupt = false
    let hang = false
    if (turn.truncateAfter !== undefined) list = list.slice(0, turn.truncateAfter)
    if (turn.destroyAfter !== undefined) {
      list = list.slice(0, turn.destroyAfter)
      abrupt = true
    }
    if (turn.hangAfter !== undefined) {
      list = list.slice(0, turn.hangAfter)
      hang = true
    }
    const shapeComments = turn.comments ?? turn.shape?.comments ?? ctx.shape.comments
    if (shapeComments?.length && ctx.wire !== 'messages') {
      list = list.flatMap((f) => [...shapeComments.map((c) => `: ${c}\n\n`), f])
    }
    let payloads = list.map((f) => Buffer.from(turn.crlf ? f.replace(/\n/g, '\r\n') : f, 'utf8'))
    if (turn.chunking) {
      const all = Buffer.concat(payloads)
      const cuts = turn.chunking.cutAt ?? []
      payloads = []
      if (turn.chunking.every) {
        for (let i = 0; i < all.length; i += turn.chunking.every) payloads.push(all.subarray(i, i + turn.chunking.every))
      } else {
        let from = 0
        for (const cut of [...cuts, all.length]) {
          if (cut > from) payloads.push(all.subarray(from, cut))
          from = Math.max(from, cut)
        }
      }
    }
    const pause = turn.delayMs ? () => new Promise((r) => setTimeout(r, turn.delayMs)) : () => new Promise((r) => setImmediate(r))
    for (const p of payloads) {
      if (res.destroyed || res.closed) return
      res.write(p)
      await pause()
    }
    if (res.destroyed || res.closed) return
    if (abrupt) {
      res.socket?.destroy()
      return
    }
    if (hang) return // stays open until the client hangs up or close() ends it
    res.end()
  }

  async function handleCompletion(req, res, wire, dialectName, record) {
    const dialect = DIALECTS[dialectName] ?? DIALECTS.openai
    const body = record.body
    const model = modelById(body.model)
    try {
      if (strictModels && !model) throw new Refusal('model.unknown', 404, `The model '${body.model}' does not exist.`)
      if (wire === 'messages') {
        checkModelLimits(model, body.max_tokens, 'max_tokens')
        checkToolSchemas(model, body.tools, (t) => t.name)
        checkClaudeBody(body, req.headers, model, state, { strictHistory })
      } else if (wire === 'responses') {
        checkModelLimits(model, body.max_output_tokens, 'max_output_tokens')
        checkToolSchemas(model, body.tools, (t) => t.name)
        for (const r of dialect.rules) RESPONSES_RULES[r]?.(body, state)
        checkResponsesInput(body, state)
      } else {
        checkModelLimits(model, body.max_completion_tokens ?? body.max_tokens, body.max_completion_tokens !== undefined ? 'max_completion_tokens' : 'max_tokens')
        checkToolSchemas(model, body.tools, (t) => t.function?.name ?? t.name)
        if (!Array.isArray(body.messages)) refuse('chat.messages', 'messages must be an array.')
        for (const r of dialect.rules) CHAT_RULES[r]?.(body, state)
        checkChatToolPairing(body.messages)
      }
    } catch (err) {
      if (!(err instanceof Refusal)) throw err
      record.status = err.status
      record.rule = err.rule
      writeJson(res, err.status, errorBody(wire, err.status, err.message), { 'x-fake-rule': err.rule, ...(err.extra.source ? { 'x-fake-source': err.extra.source.url } : {}) })
      return
    }

    const info = inspectRequest(wire, body)
    const scripted = queue.length ? queue.shift() : scriptedReply(info, { origin })
    const resolved = typeof scripted === 'function' ? await scripted(record, info) : scripted
    const turn = resolveTurn(resolved ?? {})
    if (model?.noTools && turn.toolCalls) delete turn.toolCalls

    if (turn.status) {
      record.status = turn.status
      writeJson(res, turn.status, turn.errorBody ?? errorBody(wire, turn.status, turn.errorMessage ?? 'Scripted failure.', turn.errorType), turn.headers)
      return
    }

    const ctx = { body, seq: ++seq, shape: dialect.shape, dialect: dialectName, wire, state, created: 1767225600 }
    const rendered = wire === 'messages' ? renderMessages(turn, ctx) : wire === 'responses' ? renderResponses(turn, ctx) : renderChat(turn, ctx)

    record.status = 200
    if (!body.stream) {
      writeJson(res, 200, rendered.final, { ...(wire === 'messages' ? { 'request-id': `req_fake${ctx.seq}` } : {}), ...turn.headers })
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      ...(wire === 'messages' ? { 'request-id': `req_fake${ctx.seq}` } : {}),
      ...turn.headers,
    })
    res.flushHeaders()
    res.socket?.setNoDelay(true)
    await streamFrames(res, rendered.frames, turn, ctx)
    record.completed = res.writableEnded
  }

  function handleControl(req, res, pathname) {
    const action = pathname.slice(CONTROL_PREFIX.length)
    if (req.method === 'GET' && action.startsWith('/collect')) {
      collected.push({ path: req.url, userAgent: req.headers['user-agent'] ?? null, hadAuthorization: 'authorization' in req.headers, at: Date.now() })
      res.writeHead(200, { 'content-type': 'image/gif', 'cache-control': 'no-store' })
      res.end(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'))
      return true
    }
    if (req.method === 'GET' && action === '/health') {
      writeJson(res, 200, { ok: true })
      return true
    }
    if (req.method === 'GET' && action === '/requests') {
      writeJson(res, 200, { requests })
      return true
    }
    if (req.method === 'GET' && action === '/collected') {
      writeJson(res, 200, { collected })
      return true
    }
    return false
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    let pathname = url.pathname
    // Only this machine by name, so a page in a browser cannot reach it through DNS rebinding.
    const host = String(req.headers.host ?? '')
    if (host !== `127.0.0.1:${server.address().port}` && host !== `localhost:${server.address().port}`) {
      writeJson(res, 403, { error: { message: 'Use the loopback address.' } })
      return
    }

    if (pathname.startsWith(CONTROL_PREFIX)) {
      if (handleControl(req, res, pathname)) return
    }

    let dialectName = defaultDialect
    const prefixed = pathname.match(/^\/p\/([a-z-]+)(\/.*)$/)
    if (prefixed) {
      dialectName = prefixed[1]
      pathname = prefixed[2]
      if (!DIALECTS[dialectName]) {
        writeJson(res, 404, { error: { message: `No such dialect: ${dialectName}` } })
        return
      }
    }
    const wirePath = pathname.replace(/^\/v1(?=\/)/, '')
    const isClaude = 'anthropic-version' in req.headers
    const wire = req.method === 'POST' ? { '/messages': 'messages', '/responses': 'responses', '/chat/completions': 'chat' }[wirePath] : null
    const isModels = req.method === 'GET' && wirePath === '/models'
    const isControlPost = req.method === 'POST' && pathname.startsWith(CONTROL_PREFIX)

    if (!wire && !isModels && !isControlPost) {
      writeJson(res, 404, { error: { message: `No route: ${req.method} ${pathname}` } })
      return
    }

    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size <= MAX_BODY_BYTES) chunks.push(c)
    })
    req.on('error', () => {})
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')

      if (isControlPost) {
        let payload = {}
        try {
          payload = raw ? JSON.parse(raw) : {}
        } catch {
          writeJson(res, 400, { error: { message: 'Invalid JSON.' } })
          return
        }
        const action = pathname.slice(CONTROL_PREFIX.length)
        if (action === '/enqueue') {
          for (const turn of payload.turns ?? []) {
            try {
              queue.push(resolveTurn(turn))
            } catch (err) {
              writeJson(res, 400, { error: { message: err.message } })
              return
            }
          }
          writeJson(res, 200, { queued: queue.length })
        } else if (action === '/models') {
          modelsQueue.push(payload)
          writeJson(res, 200, { queued: modelsQueue.length })
        } else if (action === '/reset') {
          api.reset()
          writeJson(res, 200, { ok: true })
        } else {
          writeJson(res, 404, { error: { message: 'No such control action.' } })
        }
        return
      }

      const key = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || String(req.headers['x-api-key'] ?? '')
      const record = {
        wire: wire ?? 'models',
        dialect: isClaude ? 'claude' : dialectName,
        method: req.method,
        path: req.url,
        headers: { ...req.headers },
        body: undefined,
        status: 0,
        aborted: false,
        completed: false,
        at: Date.now(),
      }
      requests.push(record)
      inFlight++
      res.on('close', () => {
        record.aborted = !res.writableFinished
        inFlight--
        noteSettled()
      })

      const dialect = DIALECTS[dialectName]
      const keyRequired = !dialect?.keyOptional
      const badKey = apiKey ? key !== apiKey : keyRequired && !key
      if (badKey) {
        record.status = 401
        writeJson(res, 401, errorBody(wire === 'messages' || isClaude ? 'messages' : 'chat', 401, 'Invalid API key.'), { 'x-fake-rule': 'auth.key' })
        return
      }

      if (isModels) {
        const scripted = modelsQueue.shift()
        if (scripted) {
          record.status = scripted.status ?? 200
          if (scripted.status && scripted.status >= 300 && scripted.status < 400) {
            res.writeHead(scripted.status, { location: scripted.location ?? `${origin}${CONTROL_PREFIX}/collect/redirected`, ...scripted.headers })
            res.end()
            return
          }
          writeJson(res, record.status, scripted.body ?? { error: { message: 'Scripted failure.' } }, scripted.headers)
          return
        }
        record.status = 200
        writeJson(res, 200, listModels(modelList, { claude: isClaude, dialect: dialectName, query: url.searchParams }))
        return
      }

      if (isClaude && wire !== 'messages') {
        record.status = 400
        writeJson(res, 400, errorBody('chat', 400, 'anthropic-version sent to a non-Claude endpoint.'))
        return
      }
      if (wire === 'messages' && !isClaude) {
        record.status = 400
        writeJson(res, 400, errorBody('messages', 400, 'anthropic-version: header is required.'), { 'x-fake-rule': 'claude.version' })
        return
      }
      try {
        record.body = raw ? JSON.parse(raw) : {}
      } catch {
        record.status = 400
        writeJson(res, 400, errorBody(wire, 400, 'The request body is not valid JSON.'), { 'x-fake-rule': 'body.json' })
        return
      }
      handleCompletion(req, res, wire, dialectName, record).catch((err) => {
        record.status = 500
        record.error = err.message
        if (!res.headersSent) writeJson(res, 500, errorBody(wire, 500, 'The fake provider failed: see the test.'))
        else res.destroy()
      })
    })
  })

  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const boundPort = server.address().port
  origin = `http://127.0.0.1:${boundPort}`

  const api = {
    origin,
    port: boundPort,
    /** OpenAI-style base URL of a dialect: chat at `<base>/chat/completions`, responses at `<base>/responses`, list at `<base>/models`. */
    baseUrl: (dialect) => (dialect ? `${origin}/p/${dialect}/v1` : `${origin}/v1`),
    requests,
    collected,
    enqueue(...turns) {
      for (const t of turns) queue.push(typeof t === 'function' ? t : resolveTurn(t))
    },
    enqueueModels(...specs) {
      modelsQueue.push(...specs)
    },
    pending: () => queue.length,
    /** Empties the queue and the request log. Conversations stay valid: what was produced is still known. */
    reset() {
      queue.length = 0
      modelsQueue.length = 0
      requests.length = 0
      collected.length = 0
    },
    /** Resolves once every open response has ended, so `aborted` and `completed` are final. */
    settled(timeoutMs = 5000) {
      if (inFlight === 0) return Promise.resolve()
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${inFlight} response(s) still open after ${timeoutMs} ms`)), timeoutMs)
        settledWaiters.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
        for (const s of sockets) s.destroy()
      })
    },
  }
  return api
}

// ── Command line: `node tests/helpers/fake-llm.mjs [--port N]` ──────────

async function main(argv) {
  const at = argv.indexOf('--port')
  const port = at >= 0 ? Number(argv[at + 1]) : 0
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('usage: node tests/helpers/fake-llm.mjs [--port <0-65535>]')
    process.exit(2)
  }
  const fake = await startFakeLlm({ port })
  console.log(`[fake-llm] listening on ${fake.origin} (OpenAI wires at ${fake.baseUrl()}, Claude at ${fake.origin})`)
  const stop = () => fake.close().finally(() => process.exit(0))
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main(process.argv.slice(2)).catch((err) => {
    console.error('[fake-llm] failed:', err.message)
    process.exit(1)
  })
}
