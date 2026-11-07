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
