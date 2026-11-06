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

/** The setup tab an OAuth pairing window is opened for (lib/ai/settings PAIRING_APPS). */
export type PairingApp = 'claude-code' | 'claude' | 'chatgpt' | 'cursor' | 'vscode' | 'codex' | 'other'

/** GET /api/admin/ai/pairing: the open window, never its id. */
export type PairingView = { app: PairingApp; openedAt: number; expiresAt: number; requests: number }

/** A consent given since a window opened, and whether the app collected its access. */
export type ConsentView = { at: number; grantId: string | null; exchanged: boolean; expired: boolean }

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
