import type { Wire } from './providers/types'

/**
 * Model provider presets (SERVER-ONLY data, design §7.3, PROVIDERS §4-§5).
 * Data only: which wire, which official host, how its model list is read and
 * which quirks its dialect needs. **No model ids, no prices, no capability
 * tables** — those go stale, which would be fake data. A preset shows
 * "Untested" until the owner's own Test passes on it (lib/ai/providers/probe).
 *
 * Official hosts are constants. Only Custom takes an owner-entered URL
 * (https, port 443, no IP literal, no userinfo/query/fragment), and the local
 * presets work only for origins listed in AI_LOCAL_PROVIDER_ORIGINS while the
 * site is local-only (lib/ai/settings localProviderOrigins). Qwen's host is
 * built from two owner-typed fields, each `^[a-z0-9-]+$`.
 */

/** The quirk flags of one key (PROVIDERS §4, the whole list). */
export type Quirks = {
  /** Which field carries the output limit on the chat wire. */
  maxTokensField: 'max_tokens' | 'max_completion_tokens'
  /** Extra JSON merged into every chat or responses request body (preset data, never owner input). */
  extraBody: Record<string, unknown>
  /** Chat: send `stream_options: { include_usage: true }`. */
  streamUsageOption: boolean
  /** Chat: how an assistant turn with no text is replayed (Alibaba needs ""). */
  emptyContent: 'null' | 'empty-string'
  /** Chat: tool messages carry `name` (Mistral's samples); Groq refuses it. */
  toolMessageName: boolean
  /** Replay the provider's reasoning fields (default on; the owner's escape hatch). */
  echoReasoning: boolean
  /** Responses: send `store: false` (Groq does not accept `store`). */
  responsesStore: boolean
  /** Responses: `include` (xAI: encrypted reasoning). */
  responsesInclude: string[]
  /** Until the response headers arrive. */
  connectTimeoutMs: number
  /** Longest silence while streaming (comments and pings count). */
  idleTimeoutMs: number
  /** How the model list is read. */
  listModels: 'openai' | 'openrouter-tools' | 'claude' | 'try' | 'none'
  /** Groq: a `failed_generation` 400 means the model's tool call was malformed — re-issue the turn. */
  reissueFailedGeneration: boolean
  /** The owner's maximum output for this key; null = the provider decides (§7.7). */
  maxOutputTokens: number | null
}

export const DEFAULT_QUIRKS: Quirks = Object.freeze({
  maxTokensField: 'max_tokens',
  extraBody: {},
  streamUsageOption: true,
  emptyContent: 'null',
  toolMessageName: false,
  echoReasoning: true,
  responsesStore: true,
  responsesInclude: [],
  connectTimeoutMs: 60_000,
  idleTimeoutMs: 300_000,
  listModels: 'openai',
  reissueFailedGeneration: false,
  maxOutputTokens: null,
}) as Quirks

export type PresetId =
  | 'claude'
  | 'openai'
  | 'xai'
  | 'openrouter'
  | 'deepseek'
  | 'gemini'
  | 'qwen'
  | 'kimi'
  | 'glm'
  | 'minimax'
  | 'mistral'
  | 'groq'
  | 'ollama'
  | 'lmstudio'
  | 'custom'

export type DataNote = { text: string; url: string; checked: string }

export type Preset = {
  id: PresetId
  name: string
  /** The wire, or null for Custom (the owner picks chat or responses). */
  wire: Wire | null
  /** Official base URLs; the first is the default, the others are the owner's alternatives (a China host). Empty: built or typed. */
  baseUrls: readonly string[]
  /** Qwen: the host is built from a Workspace ID and a region. */
  hostFromFields?: 'qwen'
  /** A local server, reachable only through AI_LOCAL_PROVIDER_ORIGINS while the site is local-only. */
  local?: boolean
  /** The key may be left empty (local servers). */
  keyOptional?: boolean
  /** Model to preselect when the provider lists it (never assumed to exist). */
  preselect?: string
  quirks: Partial<Quirks>
  /** One line about where data goes, with its source and the day it was read (§10.4). Null: no claim, the UI links nothing it has not checked. */
  dataNote: DataNote | null
}

const LOCAL_TIMEOUTS = { connectTimeoutMs: 300_000, idleTimeoutMs: 300_000 }

export const PRESETS: readonly Preset[] = Object.freeze([
  {
    id: 'claude',
    name: 'Claude',
    wire: 'anthropic',
    baseUrls: ['https://api.anthropic.com'],
    preselect: 'claude-opus-5-5',
    quirks: { listModels: 'claude' },
    dataNote: {
      text: 'Anthropic deletes API inputs and outputs from its backend within 30 days by default, with exceptions.',
      url: 'https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data',
      checked: '2026-11-05',
    },
  },
  { id: 'openai', name: 'OpenAI', wire: 'responses', baseUrls: ['https://api.openai.com/v1'], quirks: {}, dataNote: null },
  { id: 'xai', name: 'xAI', wire: 'responses', baseUrls: ['https://api.x.ai/v1'], quirks: { responsesInclude: ['reasoning.encrypted_content'] }, dataNote: null },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    wire: 'responses',
    baseUrls: ['https://openrouter.ai/api/v1'],
    quirks: { listModels: 'openrouter-tools', extraBody: { provider: { require_parameters: true } } },
    dataNote: null,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    wire: 'chat',
    baseUrls: ['https://api.deepseek.com'],
    quirks: {},
    dataNote: {
      text: 'DeepSeek’s policy says data is collected, processed and stored in the PRC, and inputs are used for training unless you opt out.',
      url: 'https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html',
      checked: '2026-11-05',
    },
  },
  { id: 'gemini', name: 'Gemini', wire: 'chat', baseUrls: ['https://generativelanguage.googleapis.com/v1beta/openai'], quirks: {}, dataNote: null },
  {
    id: 'qwen',
    name: 'Qwen (Alibaba Cloud)',
    wire: 'chat',
    baseUrls: [],
    hostFromFields: 'qwen',
    quirks: { emptyContent: 'empty-string', listModels: 'try' },
    dataNote: null,
  },
  { id: 'kimi', name: 'Kimi', wire: 'chat', baseUrls: ['https://api.moonshot.ai/v1', 'https://api.moonshot.cn/v1'], quirks: { maxTokensField: 'max_completion_tokens' }, dataNote: null },
  {
    id: 'glm',
    name: 'GLM (Z.ai)',
    wire: 'chat',
    baseUrls: ['https://api.z.ai/api/paas/v4', 'https://open.bigmodel.cn/api/paas/v4'],
    quirks: { extraBody: { tool_stream: true }, listModels: 'none' },
    dataNote: null,
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    wire: 'chat',
    baseUrls: ['https://api.minimax.io/v1', 'https://api.minimaxi.com/v1'],
    quirks: { extraBody: { reasoning_split: true }, maxTokensField: 'max_completion_tokens' },
    dataNote: null,
  },
  { id: 'mistral', name: 'Mistral', wire: 'chat', baseUrls: ['https://api.mistral.ai/v1'], quirks: { toolMessageName: true }, dataNote: null },
  {
    id: 'groq',
    name: 'Groq',
    wire: 'chat',
    baseUrls: ['https://api.groq.com/openai/v1'],
    quirks: { extraBody: { reasoning_format: 'hidden' }, reissueFailedGeneration: true },
    dataNote: null,
  },
  { id: 'ollama', name: 'Ollama', wire: 'chat', baseUrls: ['http://127.0.0.1:11434/v1'], local: true, keyOptional: true, quirks: { ...LOCAL_TIMEOUTS }, dataNote: null },
  { id: 'lmstudio', name: 'LM Studio', wire: 'chat', baseUrls: ['http://127.0.0.1:1234/v1'], local: true, keyOptional: true, quirks: { ...LOCAL_TIMEOUTS }, dataNote: null },
  { id: 'custom', name: 'Custom', wire: null, baseUrls: [], keyOptional: true, quirks: { listModels: 'try' }, dataNote: null },
] satisfies Preset[])

const BY_ID = new Map(PRESETS.map((p) => [p.id, p]))

export function presetById(id: unknown): Preset | null {
  return typeof id === 'string' ? (BY_ID.get(id as PresetId) ?? null) : null
}

/** The trust line shown when adding a Custom provider (§7.3). */
export const CUSTOM_TRUST_LINE = 'You are trusting whoever runs this URL with everything sent to it.'
/** Advice shown when adding any key (§7.3). */
export const KEY_ADVICE = 'Use a dedicated project key with a spend limit or a prepaid balance.'

/** Qwen's Workspace ID and region: the only host built from owner input, so each part is this narrow. */
export const QWEN_FIELD_RE = /^[a-z0-9-]{1,63}$/

export function qwenBaseUrl(workspaceId: string, region: string): string | null {
  if (!QWEN_FIELD_RE.test(workspaceId) || !QWEN_FIELD_RE.test(region)) return null
  if (workspaceId.startsWith('-') || workspaceId.endsWith('-') || region.startsWith('-') || region.endsWith('-')) return null
  return `https://${workspaceId}.${region}.maas.aliyuncs.com/compatible-mode/v1`
}

/** The owner-adjustable quirks of a key (§7.7): everything else is preset data. */
export type OwnerQuirks = { echoReasoning?: boolean; maxTokensField?: Quirks['maxTokensField']; maxOutputTokens?: number | null }

/** Longest output an owner may set (Claude's documented output maximum is the largest of any preset). */
export const MAX_OUTPUT_TOKENS_LIMIT = 128_000
/** Smallest: below the reasoning floor (§7.7) every request would be refused anyway. */
export const MIN_OUTPUT_TOKENS = 1024

/** A preset's quirks with the owner's adjustments over them. */
export function quirksFor(preset: Preset, owner: OwnerQuirks = {}): Quirks {
  const base: Quirks = { ...DEFAULT_QUIRKS, ...preset.quirks, extraBody: { ...(preset.quirks.extraBody ?? {}) }, responsesInclude: [...(preset.quirks.responsesInclude ?? [])] }
  if (typeof owner.echoReasoning === 'boolean') base.echoReasoning = owner.echoReasoning
  if (owner.maxTokensField === 'max_tokens' || owner.maxTokensField === 'max_completion_tokens') base.maxTokensField = owner.maxTokensField
  if (owner.maxOutputTokens === null || (typeof owner.maxOutputTokens === 'number' && Number.isInteger(owner.maxOutputTokens))) {
    base.maxOutputTokens = owner.maxOutputTokens === null ? null : Math.min(MAX_OUTPUT_TOKENS_LIMIT, Math.max(MIN_OUTPUT_TOKENS, owner.maxOutputTokens))
  }
  return base
}

/** Validate owner quirks from a request: exactly the three keys, each of the right type. */
export function parseOwnerQuirks(input: unknown): { ok: true; quirks: OwnerQuirks } | { ok: false; field: string } {
  if (input === undefined) return { ok: true, quirks: {} }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, field: 'quirks' }
  const out: OwnerQuirks = {}
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (k === 'echoReasoning') {
      if (typeof v !== 'boolean') return { ok: false, field: 'quirks.echoReasoning' }
      out.echoReasoning = v
    } else if (k === 'maxTokensField') {
      if (v !== 'max_tokens' && v !== 'max_completion_tokens') return { ok: false, field: 'quirks.maxTokensField' }
      out.maxTokensField = v
    } else if (k === 'maxOutputTokens') {
      if (v !== null && (typeof v !== 'number' || !Number.isInteger(v) || v < MIN_OUTPUT_TOKENS || v > MAX_OUTPUT_TOKENS_LIMIT)) return { ok: false, field: 'quirks.maxOutputTokens' }
      out.maxOutputTokens = v as number | null
    } else return { ok: false, field: `quirks.${k}` }
  }
  return { ok: true, quirks: out }
}

/** Efforts the UI offers (a hint only: a provider that refuses one says so in Test). Claude's come from the Models API. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export const DEFAULT_CLAUDE_EFFORT = 'medium'
