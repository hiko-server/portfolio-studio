import { log } from '../log'
import { liveGrants, tokenHints, type Grant } from './access'
import { waitingCount } from './changes'
import { getAiDb } from './db'
import { aiAccess, aiPublicState, isLocalOnly, readAiSettings, type AiPublicState } from './settings'
import { SCOPES } from './toolTypes'
import { canonicalResource } from '../mcp/http'

/**
 * What the admin shows about AI access (SERVER-ONLY): the state of the
 * switches, the connected apps, and the counts of the status strip and the
 * Security page. Read on every request, never cached, never a secret: a
 * token appears only as its last four characters.
 */

export type AccessState = {
  /** The switches as stored (false when auth.db cannot be read). */
  enabled: boolean
  mcpEnabled: boolean
  /** What holds AI off whatever the switches say: AI_DISABLED, or settings that cannot be read. */
  blocked: 'env' | 'unreadable' | null
  /** Do /mcp and the other public AI addresses exist right now? */
  open: boolean
  /** Why they do not, when they do not. */
  closedReason: Extract<AiPublicState, { open: false }>['reason'] | null
  /** SITE_URL is set: the server address and every token's audience come from it. */
  siteUrl: boolean
  /** SITE_URL names a loopback address: hosted clients cannot reach this server. */
  localOnly: boolean
  /** The MCP server address (`<SITE_URL origin>/mcp`), null without SITE_URL. */
  server: string | null
}

export function accessState(): AccessState {
  const access = aiAccess()
  let stored = { enabled: false, mcpEnabled: false }
  if (access.on) stored = { enabled: true, mcpEnabled: access.settings.mcpEnabled }
  else if (access.reason !== 'unreadable') {
    try {
      const s = readAiSettings()
      stored = { enabled: s.enabled, mcpEnabled: s.mcpEnabled }
    } catch {
      // Reported below as unreadable by the next read; the switches show off.
    }
  }
  const pub = aiPublicState()
  const server = canonicalResource()
  return {
    ...stored,
    blocked: access.on ? null : access.reason === 'env' || access.reason === 'unreadable' ? access.reason : null,
    open: pub.open,
    closedReason: pub.open ? null : pub.reason,
    siteUrl: server !== null,
    localOnly: isLocalOnly(),
    server,
  }
}

/** One connected app as Connections lists it. */
export type AppView = {
  id: string
  kind: 'pat' | 'oauth'
  name: string
  /** 1 Read published, 2 Read and draft, 3 Read, draft and propose (§5.1). */
  level: number
  scopes: string[]
  /** The last four characters of a personal token. */
  hint: string | null
  /** The name the app gives itself (self-declared, shown only as "says it is"). */
  clientReported: string | null
  /** When that name changed after it was first seen. */
  clientReportedChangedAt: number | null
  createdAt: number
  expiresAt: number
  firstUsedAt: number | null
  lastUsedAt: number | null
  /** The browser that made it, as it was labelled then. */
  createdDevice: string | null
  /** Made from the browser asking now. */
  createdHere: boolean
  /** Calls over the last 7 UTC days, null when the call log cannot be read. */
  callsThisWeek: number | null
}

const DAY = 86_400_000

/** Calls per grant over the last 7 UTC days (today included); null when ai.db cannot be read. */
function weeklyCalls(now: number): Map<string, number> | null {
  try {
    const since = new Date(now - 6 * DAY).toISOString().slice(0, 10)
    const rows = getAiDb().prepare('SELECT grant_id, SUM(calls) AS n FROM ai_grant_daily WHERE day >= ? GROUP BY grant_id').all(since) as Array<{ grant_id: string; n: number }>
    return new Map(rows.map((r) => [r.grant_id, Number(r.n) || 0]))
  } catch (err) {
    log.warn('AI call counts unavailable', { err })
    return null
  }
}

function levelOf(g: Grant): number {
  return Math.max(1, ...g.scopes.map((s) => SCOPES.indexOf(s) + 1))
}

/** The apps that may act now, newest first. */
export function appViews(currentSessionId: string | null, now = Date.now()): AppView[] {
  const grants = liveGrants(now)
  const hints = tokenHints(grants.map((g) => g.id))
  const calls = weeklyCalls(now)
  return grants.map((g) => ({
    id: g.id,
    kind: g.kind,
    name: g.name,
    level: levelOf(g),
    scopes: [...g.scopes],
    hint: hints.get(g.id) ?? null,
    clientReported: g.clientReported,
    clientReportedChangedAt: g.clientReportedChangedAt,
    createdAt: g.createdAt,
    expiresAt: g.expiresAt,
    firstUsedAt: g.firstUsedAt,
    lastUsedAt: g.lastUsedAt,
    createdDevice: g.createdDevice,
    createdHere: !!currentSessionId && g.createdSession === currentSessionId,
    callsThisWeek: calls ? (calls.get(g.id) ?? 0) : null,
  }))
}

export type AiSummary = {
  access: AccessState
  apps: { connected: number; lastUsedAt: number | null }
  /** Changes waiting for the owner, null when ai.db cannot be read. */
  waiting: number | null
}

/** The status strip (and, later, the admin portal and the palette). */
export function aiSummary(now = Date.now()): AiSummary {
  const grants = liveGrants(now)
  let waiting: number | null = null
  try {
    waiting = waitingCount(now)
  } catch (err) {
    log.warn('AI waiting count unavailable', { err })
  }
  const last = grants.reduce<number | null>((max, g) => (g.lastUsedAt !== null && (max === null || g.lastUsedAt > max) ? g.lastUsedAt : max), null)
  return { access: accessState(), apps: { connected: grants.length, lastUsedAt: last }, waiting }
}

export type SecurityAiFacts = {
  /** Connected apps that may act. */
  apps: number
  /** Whether they can reach the site right now (the public AI addresses exist). */
  reachable: boolean
  /** Live apps per browser session that created them. */
  bySession: Record<string, number>
}

/** What the Security page says about AI apps (rows in Signed-in browsers). */
export function securityAiFacts(now = Date.now()): SecurityAiFacts {
  const bySession: Record<string, number> = {}
  let apps = 0
  for (const g of liveGrants(now)) {
    apps++
    if (g.createdSession) bySession[g.createdSession] = (bySession[g.createdSession] || 0) + 1
  }
  return { apps, reachable: aiPublicState().open, bySession }
}
