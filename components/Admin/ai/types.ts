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
