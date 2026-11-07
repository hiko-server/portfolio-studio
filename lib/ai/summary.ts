import { log } from '../log'
import { liveGrants, tokenHints, type Grant } from './access'
import { hasChannel } from './bus'
import { appliedSchedules, changeStorageBytes, waitingCount } from './changes'
import { scheduleOf } from '../schedule/store'
import { getAiDb } from './db'
import { defaultProviderId, keyState, listProviders, statusOf, type ProbeStatus } from './providers/keys'
import { aiKeysSecretStatus } from './secretBox'
import { aiAccess, aiPublicState, isLocalOnly, readAiSettings, type AiPublicState } from './settings'
import { SCOPES } from './toolTypes'
import { canonicalResource } from '../mcp/http'

/**
 * What the admin shows about AI access (SERVER-ONLY): the state of the
 * switches, the connected apps, the assistant's models and run, and the
 * counts of the status strip and the Security page. Read on every request,
 * never cached, never a secret: a token or a key appears only as its last
 * four characters.
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
  /** OAuth: the host its redirect URI named when it was allowed. */
  redirectHost: string | null
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
    redirectHost: g.redirectHost,
  }))
}

/** The assistant at a glance (the status strip's Assistant tile): its models and whether it is writing now. */
export type AssistantSummary = {
  /** Saved model providers. */
  models: number
  /** The provider a new conversation uses, with its model and that model's last Test. */
  defaultModel: { providerId: string; label: string; model: string | null; status: ProbeStatus | 'untested' | 'replace-key' | 'no-secret' } | null
  /** The run being written now, if any (one at a time). */
  running: { runId: string; conversationId: string } | null
  /** The server can store keys (its key-encryption secret is usable). */
  canStoreKeys: boolean
}

/** A stored key that cannot be opened outranks the model's last Test: nothing can run until it is fixed. */
const unopenable = (row: Parameters<typeof keyState>[0]): 'replace-key' | 'no-secret' | null => {
  const k = keyState(row)
  return k === 'reenter' ? 'replace-key' : k === 'no-secret' ? 'no-secret' : null
}

export function assistantSummary(): AssistantSummary {
  const rows = listProviders()
  const defaultId = defaultProviderId()
  const row = rows.find((r) => r.id === defaultId) ?? null
  // A running row is live only while this process holds its event channel (a restart leaves it interrupted).
  const live = (getAiDb().prepare("SELECT id, conversation_id FROM ai_runs WHERE state = 'running' ORDER BY started_at DESC").all() as Array<{ id: string; conversation_id: string }>).find((r) =>
    hasChannel(r.id),
  )
  return {
    models: rows.length,
    // A key that no longer opens (its address or AI_KEYS_SECRET changed: replace it) or that no secret can open
    // (AI_KEYS_SECRET unset or unusable: set it) outranks the last Test: nothing can run.
    defaultModel: row ? { providerId: row.id, label: row.label, model: row.defaultModel, status: unopenable(row) ?? statusOf(row, row.defaultModel) } : null,
    running: live ? { runId: live.id, conversationId: live.conversation_id } : null,
    canStoreKeys: aiKeysSecretStatus().state === 'ready',
  }
}

export type AiSummary = {
  access: AccessState
  apps: { connected: number; lastUsedAt: number | null }
  /** Changes waiting for the owner, null when ai.db cannot be read. */
  waiting: number | null
  /** Null when its stores cannot be read. */
  assistant: AssistantSummary | null
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
  let assistant: AssistantSummary | null = null
  try {
    assistant = assistantSummary()
  } catch (err) {
    log.warn('AI assistant summary unavailable', { err })
  }
  const last = grants.reduce<number | null>((max, g) => (g.lastUsedAt !== null && (max === null || g.lastUsedAt > max) ? g.lastUsedAt : max), null)
  return { access: accessState(), apps: { connected: grants.length, lastUsedAt: last }, waiting, assistant }
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

export type AiSchedule = { changeId: string; actorId: string; collection: 'blog' | 'work'; slug: string; publishAt: string | null; unpublishAt: string | null }

/**
 * Schedules AI set that are still pending (design §5.2, §5.4; THREATS R17):
 * items an approved `item.schedule` change scheduled and that still carry a
 * schedule, of some apps or of all — so turning AI access off, or revoking
 * an app, can list them and offer to clear them before they run. Never
 * throws: an unreadable store lists nothing.
 */
export function aiSchedules(which: { all: true } | { actorIds: readonly string[] } = { all: true }): AiSchedule[] {
  try {
    const seen = new Set<string>()
    const out: AiSchedule[] = []
    for (const s of appliedSchedules(which)) {
      if ((s.collection !== 'blog' && s.collection !== 'work') || seen.has(`${s.collection}/${s.slug}`)) continue
      seen.add(`${s.collection}/${s.slug}`)
      const now = scheduleOf(s.collection, s.slug)
      if (now.publishAt === null && now.unpublishAt === null) continue
      out.push({
        changeId: s.changeId,
        actorId: s.actorId,
        collection: s.collection,
        slug: s.slug,
        publishAt: now.publishAt === null ? null : new Date(now.publishAt).toISOString(),
        unpublishAt: now.unpublishAt === null ? null : new Date(now.unpublishAt).toISOString(),
      })
    }
    return out
  } catch (err) {
    log.warn('AI schedules could not be listed', { err })
    return []
  }
}

/** Past this, System health warns about the stored AI change data (§3.2; the cap that evicts is 256 MB). */
export const AI_CHANGE_STORAGE_WARN_BYTES = 512 * 1024 * 1024

/** The stored AI change data's size, or null when ai.db cannot be read. */
export function aiChangeStorageBytes(): number | null {
  try {
    return changeStorageBytes()
  } catch {
    return null
  }
}
