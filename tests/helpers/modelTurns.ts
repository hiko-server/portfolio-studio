/**
 * Helpers of the provider tests: a frozen conversation snapshot, the
 * adapters pointed at tests/helpers/fake-llm.mjs through the ordinary paths
 * (chat and responses as a local custom provider through
 * AI_LOCAL_PROVIDER_ORIGINS' own gate; Claude through the factory's
 * `baseURL`, the one parameter only tests set), and the events of one turn.
 * Import lib modules inside tests (after a harness moved the cwd) when they
 * touch a store; the adapters touch none.
 */
import type { ConversationSnapshot, FrozenTool, ModelAdapter, ModelEvent, NativeTurn } from '../../lib/ai/providers/types'
import type { Quirks } from '../../lib/ai/presets'

export const GET_CONTENT: FrozenTool = {
  name: 'get_content',
  description: 'Read one item.',
  inputSchema: { type: 'object', properties: { slug: { type: 'string', description: 'The slug.' }, collection: { type: 'string', description: 'blog or work.' } }, additionalProperties: false },
}
export const CREATE_DRAFT: FrozenTool = {
  name: 'create_draft',
  description: 'Create a draft.',
  inputSchema: { type: 'object', properties: { title: { type: 'string', description: 'Title.' }, body: { type: 'string', description: 'Body.' } }, additionalProperties: false },
}

export function snap(over: Partial<ConversationSnapshot> = {}): ConversationSnapshot {
  return { model: 'fake-model', systemText: 'System text for tests.', tools: [GET_CONTENT, CREATE_DRAFT], effort: null, display: 'omitted', claude: null, ...over }
}

export type Collected = {
  events: ModelEvent[]
  turn: Extract<ModelEvent, { type: 'turn_end' }> | null
  text: string
  thinking: string
  error: unknown
}

/** Every event of one model call; a thrown error is returned, not rethrown. */
export async function collect(adapter: ModelAdapter, native: NativeTurn[], opts: { conv?: ConversationSnapshot; maxOutput?: number; signal?: AbortSignal } = {}): Promise<Collected> {
  const out: Collected = { events: [], turn: null, text: '', thinking: '', error: null }
  try {
    for await (const e of adapter.stream({ conv: opts.conv ?? snap(), native, maxOutput: opts.maxOutput, signal: opts.signal ?? new AbortController().signal })) {
      out.events.push(e)
      if (e.type === 'text') out.text += e.delta
      if (e.type === 'thinking') out.thinking += e.delta
      if (e.type === 'turn_end') out.turn = e
    }
  } catch (err) {
    out.error = err
  }
  return out
}

/** Every key at any depth of a JSON value (to prove what a request never carried). */
export function deepKeys(v: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => deepKeys(x, into))
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      into.add(k)
      deepKeys(x, into)
    }
  }
  return into
}

/** Parameters no request may ever carry, on any provider (design §7.2, §7.7). */
export const NEVER_SENT = ['temperature', 'top_p', 'top_k', 'budget_tokens', 'tool_choice']

export function testQuirks(over: Partial<Quirks> = {}): Quirks {
  return {
    maxTokensField: 'max_tokens',
    extraBody: {},
    extraBodyByModel: [],
    streamUsageOption: true,
    emptyContent: 'null',
    toolMessageName: false,
    echoReasoning: true,
    responsesStore: true,
    responsesInclude: [],
    connectTimeoutMs: 5_000,
    idleTimeoutMs: 5_000,
    listModels: 'openai',
    reissueFailedGeneration: false,
    maxOutputTokens: null,
    ...over,
  }
}
