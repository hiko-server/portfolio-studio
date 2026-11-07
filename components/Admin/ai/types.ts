import type { EditorPayload } from './editorBridge'
/**
 * What the admin AI routes answer (pages/api/admin/ai/*), as the browser
 * reads it. The server's own types live in lib/ai/summary and
 * lib/ai/registry; these mirror the JSON so client code never imports them.
 */

export type AccessState = {
  enabled: boolean
  mcpEnabled: boolean
  blocked: 'env' | 'unreadable' | null
  open: boolean
  closedReason: 'env' | 'off' | 'unreadable' | 'apps-off' | 'no-site-url' | null
  siteUrl: boolean
  localOnly: boolean
  server: string | null
}

export type AppView = {
  id: string
  kind: 'pat' | 'oauth'
  name: string
  level: number
  scopes: string[]
  hint: string | null
  clientReported: string | null
  clientReportedChangedAt: number | null
  createdAt: number
  expiresAt: number
  firstUsedAt: number | null
  lastUsedAt: number | null
  createdDevice: string | null
  createdHere: boolean
  callsThisWeek: number | null
  /** OAuth: the host its redirect URI named when it was allowed. */
  redirectHost: string | null
}

export type Risk = 'read' | 'draft' | 'live' | 'destructive'

export type CatalogueTool = {
  name: string
  title: string
  description: string
  scope: string
  level: number
  risk: Risk
  cost: string
}

export type AccessLevel = { level: number; scopes: string[] }

// ── AI changes (stage M3): pages/api/admin/ai/changes, lib/ai/changeViews ──

/** A change's state as the server reads it now (lib/ai/changes stateAt). */
export type ChangeState = 'waiting' | 'applying' | 'applied' | 'rejected' | 'expired' | 'conflict' | 'failed' | 'undone' | 'voided' | 'in_editor'

/** One document of a change's preview, complete: MDX as `key: value` lines, `---`, then the body; JSON as visitors see it. */
export type PreviewDocument = { ref: string; label: string; publicUrl: string | null; format: 'mdx' | 'json'; before: string; after: string }

/** The canonical preview (design §5.3): the one thing the owner approves. Composed by the server, never by the model. */
export type ChangePreview = {
  kind: string
  risk: Risk
  title: string
  documents: PreviewDocument[]
  newLinks: { url: string; flags: string[] }[]
  newEmbeds: string[]
  zeroWidth: number
  effects: {
    publicPaths: string[]
    schedule: unknown | null
    deleted: boolean
    import: { url: string; host: string } | null
    hiddenValuesChanged: number | null
  }
}

export type ChangeActor = { kind: 'mcp' | 'assistant'; id: string; label: string; provider: string | null; model: string | null }

/** A row of the Changes view (no preview, no arguments). */
export type ChangeListItem = {
  id: string
  state: ChangeState
  risk: 'draft' | 'live' | 'destructive'
  kind: string
  tool: string
  title: string
  target: { kind: string; ref: string }
  actor: ChangeActor
  /** The model's own words, shown only as “The model says:”. */
  rationale: string | null
  created_at: string | null
  expires_at: string | null
  decided_at: string | null
  applied_at: string | null
  undone_at: string | null
  code: string | null
  reject_note: string | null
}

/** What an applied change produced (lib/ai/apply markApplied). */
export type ChangeResult = {
  version?: string
  /** Saved by the owner in the editor it was applied in (§7.8), not by an approval. */
  savedInEditor?: boolean
  savedOn?: string | null
  publicUrls?: string[]
  editUrl?: string
  approvedOn?: string | null
  revalidated?: string[]
  revalidateFailed?: string[]
  items?: string[]
  name?: string
  url?: string
}

export type PublishCheckNote = { id: string; level: 'ok' | 'warning' | 'error'; label: string; detail?: string }

/** One change as its card shows it (GET /api/admin/ai/changes/<id>). */
export type ChangeDetail = ChangeListItem & {
  preview: ChangePreview | null
  preview_sha256: string
  base_version: string | null
  result: ChangeResult | null
  undo: { available: true } | { available: false; code: string; message: string }
  /** Display-only, computed when the card loads, never hashed. */
  notes: { ai_written_earlier: string | null; publish_checks?: PublishCheckNote[] | null }
  /** What an editor applies (§7.8): a suggestion for the open editor, or a waiting post or page edit; null otherwise. */
  editor?: EditorPayload | null
  /** An editor change still open whose issuer lost access: it can't be applied. */
  editor_issuer_ended?: boolean
}

/** A row of All calls (ai_tool_calls): never arguments or results. */
export type ToolCallRow = {
  id: number
  at: string | null
  actor_kind: 'mcp' | 'assistant'
  actor_id: string
  actor_label: string
  tool: string
  target: string | null
  risk: Risk
  outcome: 'ok' | 'error' | 'refused'
  code: string | null
  ms: number
  bytes_out: number
  era: string | null
}

/** An AI-set schedule still to run (lib/ai/summary aiSchedules). */
export type AiSchedule = { changeId: string; actorId: string; collection: 'blog' | 'work'; slug: string; publishAt: string | null; unpublishAt: string | null }

/** The setup tab an OAuth pairing window is opened for (lib/ai/settings PAIRING_APPS). */
export type PairingApp = 'claude-code' | 'claude' | 'chatgpt' | 'cursor' | 'vscode' | 'codex' | 'other'

/** GET /api/admin/ai/pairing: the open window, never its id. */
export type PairingView = { app: PairingApp; openedAt: number; expiresAt: number; requests: number }

/** A consent given since a window opened, and whether the app collected its access. */
export type ConsentView = { at: number; grantId: string | null; exchanged: boolean; live: boolean; expired: boolean }

/** GET /api/admin/ai/oauth/request, state ok: what the consent page shows (lib/ai/oauth ConsentFacts). */
export type ConsentFacts = {
  pairingId: string
  app: PairingApp
  windowEndsAt: number
  requests: number
  client: { kind: 'cimd' | 'dcr'; host: string | null; selfName: string | null; knownName: string | null }
  redirect: { uri: string; host: string; loopback: boolean }
  known: boolean
  requestedLevel: 1 | 2 | 3
  preselectedLevel: 1 | 2
  site: string
}

export type ConsentRequest =
  | { state: 'closed'; apps: boolean }
  | { state: 'invalid'; error: string; message: string }
  | { state: 'ok'; facts: ConsentFacts }

// ── The assistant and Models (stage M4): pages/api/admin/ai/{providers,runs,conversations,usage} ──

/** A model's last Test (lib/ai/providers/probe). `untested` until one ran here. */
export type ProbeStatus = 'ready' | 'chat-only' | 'schema-refused' | 'key-refused' | 'failed'
export type ModelStatus = ProbeStatus | 'untested'

/** One step of a Test, as the server measured it: plain text, never the key. */
export type ProbeStep = { step: string; ok: boolean; detail: string | null }

/** A Test's result (lib/ai/providers/keys StoredTest, without the Claude capability details). */
export type ProbeView = {
  status: ProbeStatus
  at: number
  display: 'updates' | 'omitted' | null
  observations: Record<string, boolean | number | string | null>
  steps: ProbeStep[]
  message: string | null
}

export type Wire = 'anthropic' | 'responses' | 'chat'

/** Whether a stored key opens: `none` for a keyless local server, `reenter` when it no longer opens at its address. */
export type KeyState = 'ok' | 'none' | 'reenter' | 'no-secret'

/** The owner-adjustable settings of a key (lib/ai/presets OwnerQuirks). */
export type OwnerQuirks = { echoReasoning?: boolean; maxTokensField?: 'max_tokens' | 'max_completion_tokens'; maxOutputTokens?: number | null }

/** A saved model provider as GET /api/admin/ai/providers lists it: never the key, only its last four characters. */
export type ProviderView = {
  id: string
  preset: string
  presetName: string
  label: string
  wire: Wire
  baseUrlHost: string
  local: boolean
  defaultModel: string | null
  effort: string | null
  quirks: OwnerQuirks
  hasKey: boolean
  keyHint: string | null
  keyState: KeyState
  status: ModelStatus
  tests: Record<string, ProbeView>
  isDefault: boolean
  createdAt: number
  updatedAt: number
  lastUsedAt: number | null
}

/** Where a provider's terms say the data goes (design §10.4), with its source and the day it was read. */
export type DataNote = { text: string; url: string; checked: string }

/** A preset of Add a model (lib/ai/presets, data only: no model ids, no prices). */
export type PresetView = {
  id: string
  name: string
  /** Null for Custom: the owner picks Chat Completions or Responses. */
  wire: Wire | null
  hosts: string[]
  baseUrls: string[]
  hostFromFields: 'qwen' | null
  local: boolean
  keyOptional: boolean
  preselect: string | null
  dataNote: DataNote | null
  /** A local preset is offered only while this site runs locally with its origin allowed. */
  available: boolean
}

export type ProvidersAnswer = {
  providers: ProviderView[]
  presets: PresetView[]
  defaultProviderId: string | null
  keys: { canStore: boolean; state: string }
  claudeBlocked: string | null
  localOrigins: string[]
  efforts: string[]
  outputTokens: { min: number; max: number }
  copy: { customTrust: string; keyAdvice: string }
}

/** One model a key can use, as the provider listed it today (Check key). */
export type ModelOption = { id: string; label: string | null; maxOutputTokens: number | null; maxInputTokens: number | null }

/** The assistant at a glance (lib/ai/summary AssistantSummary): the status strip's Assistant tile. */
export type AssistantSummary = {
  models: number
  defaultModel: { providerId: string; label: string; model: string | null; status: ModelStatus } | null
  running: { runId: string; conversationId: string } | null
  canStoreKeys: boolean
}

/** GET /api/admin/ai/summary. */
export type AiSummaryView = {
  access: AccessState
  apps: { connected: number; lastUsedAt: number | null }
  waiting: number | null
  assistant: AssistantSummary | null
}

export type RunState = 'running' | 'finished' | 'stopped' | 'limit' | 'failed' | 'interrupted'

/** A run as the admin sees it (lib/ai/runs RunView). */
export type RunView = { id: string; conversationId: string; state: RunState; reason: string | null; startedAt: number; finishedAt: number | null; live: boolean; lastSeq: number }

/** A row of the conversation rail. */
export type ConversationListItem = { id: string; title: string; providerLabel: string; wire: Wire; model: string; tokensWeighted: number; createdAt: number; updatedAt: number }

/** A typed reference the owner attached to a message (a chip); `dirty` marks the editor it came from, `words` a selection. */
export type AttachmentRef = { kind: string; ref: string; version?: string | null; dirty?: boolean; words?: number }

/** What the admin renders of a stored turn (lib/ai/loop): never the provider's native history. */
export type UserDisplay = { kind: 'user'; text: string | null; continued: boolean; attachments: AttachmentRef[]; declined?: boolean }
export type AssistantDisplay = {
  kind: 'assistant'
  text: string
  thinking?: string[]
  notices?: Array<{ from: string; to: string }>
  stop?: string
  stoppedEarly?: boolean
  toolCalls?: Array<{ id: string; name: string; title: string | null }>
  /** Display-only: what arrived before a Stop, or before the stream failed (never in the history). */
  stopped?: boolean
  failed?: boolean
}
export type DeclinedDisplay = { kind: 'declined'; category: string | null; explanation: string | null; filter: boolean }
export type ToolResultRow = { id: string; name: string; title: string | null; ok: boolean; code: string | null; args: string; result: string }
export type ToolsDisplay = { kind: 'tools'; results: ToolResultRow[] }
export type TurnDisplay = UserDisplay | AssistantDisplay | DeclinedDisplay | ToolsDisplay

export type DisplayTurn = { seq: number; role: 'user' | 'assistant' | 'tool'; display: TurnDisplay; inHistory: boolean; runId: string | null; createdAt: number }

/** GET /api/admin/ai/conversations/<id>. */
export type ConversationDetail = {
  conversation: {
    id: string
    title: string
    providerId: string
    providerLabel: string
    providerAvailable: boolean
    wire: Wire
    model: string
    effort: string | null
    tools: number
    chatOnly: boolean
    tokensWeighted: number
    createdAt: number
    updatedAt: number
  }
  turns: DisplayTurn[]
  runs: Array<RunView | null>
  active: RunView | null
}

/** How a run ended (run_end): `message` is the server's plain-text words for the owner. */
export type RunEnd = { state: RunState; reason: string | null; message: string | null; detail?: Record<string, unknown>; stored?: boolean }

/** One UTC day of one model's usage (GET /api/admin/ai/usage). */
export type UsageRow = {
  day: string
  providerId: string
  providerLabel: string | null
  model: string
  calls: number
  usageIn: number
  cachedRead: number
  cacheWrite: number
  usageOut: number
  reasoning: number
  weighted: number
  /** Null unless every call of the group reported its cost. */
  reportedMicroUsd: number | null
  estimatedCalls: number
}

export type UsageAnswer = {
  days: number
  rows: UsageRow[]
  today: { weighted: number; limit: number | null; resetsAt: number }
  caps: { runTokens: number; conversationTokens: number; modelTurnsPerRun: number; toolCallsPerRun: number }
}

/** The assistant's settings (GET|PATCH /api/admin/ai/settings). */
export type AiSettingsView = { enabled: boolean; mcpEnabled: boolean; autoApplyDrafts: boolean; keepConversationsDays: number; dailyTokenLimit: number }
