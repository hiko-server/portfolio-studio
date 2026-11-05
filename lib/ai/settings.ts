import crypto from 'node:crypto'
import { getAuthDb } from '../adminAuth/db'
import { isLocalOnly } from '../env'
import { exactOrigin } from '../security/origin'

/**
 * The AI switches (SERVER-ONLY), read from auth.db on every call, never
 * cached (design §5.2). In this order:
 *
 *   1. AI_DISABLED in the environment beats everything — it works when
 *      auth.db is broken or the admin is compromised;
 *   2. `ai_settings.enabled`, the master switch: off (or unreadable) means
 *      every AI path is inert;
 *   3. `ai_settings.mcp_enabled`, "Allow connected apps": off means /mcp,
 *      /oauth/*, /.well-known/oauth-* and /ai/review/* do not exist — they
 *      answer exactly what an unknown path answers (proxy.ts);
 *   4. SITE_URL must be set: the MCP resource and the OAuth issuer come from
 *      it, never from the Host header.
 *
 * The row lives in auth.db, not content.db, so a content restore can never
 * flip it, and an R2 mirror never carries it.
 *
 * Changing a setting: tightening is free, loosening needs a recent
 * verification (requireRecentAuth) — writeAiSettings and openPairingWindow
 * refuse a loosening change unless the caller says the step-up passed, so a
 * route cannot forget it. Turning AI off has follow-ups the routes own (abort
 * runs, void waiting changes, audit, mail).
 */

export { isLocalOnly }

/** Code ceiling of the daily token limit (§5.2): no setting goes above it. */
export const DAILY_TOKEN_LIMIT_CEILING = 20_000_000
/** How long "Allow a new connection" waits for one OAuth connection (§6.4). */
export const PAIRING_WINDOW_MS = 10 * 60_000
/** Conversation retention: 0 = don't keep, -1 = until deleted, else days. */
export const KEEP_FOREVER = -1
export const KEEP_DAYS_MAX = 3650

export const PAIRING_APPS = ['claude-code', 'claude', 'chatgpt', 'cursor', 'vscode', 'codex', 'other'] as const
export type PairingApp = (typeof PAIRING_APPS)[number]

export type PairingWindow = { id: string; app: PairingApp; openedAt: number; expiresAt: number }

export type AiSettings = {
  enabled: boolean
  mcpEnabled: boolean
  autoApplyDrafts: boolean
  defaultProviderId: string | null
  keepConversationsDays: number
  dailyTokenLimit: number
  /** The pairing window as stored (it may have expired: see currentPairing). */
  pairing: PairingWindow | null
  changedAt: number
}

type Row = {
  enabled: number
  mcp_enabled: number
  auto_apply_drafts: number
  default_provider_id: string | null
  keep_conversations_days: number
  daily_token_limit: number
  pairing_id: string | null
  pairing_app: string | null
  pairing_opened_at: number | null
  pairing_expires_at: number | null
  changed_at: number
}

/** AI_DISABLED set to anything but an explicit "no" (0, false, no, off) turns everything off. */
export function aiDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.AI_DISABLED ?? '').trim().toLowerCase()
  return raw !== '' && !['0', 'false', 'no', 'off'].includes(raw)
}

function isPairingApp(v: unknown): v is PairingApp {
  return typeof v === 'string' && (PAIRING_APPS as readonly string[]).includes(v)
}

function toSettings(r: Row): AiSettings {
  const pairing =
    r.pairing_id && isPairingApp(r.pairing_app) && Number.isFinite(r.pairing_opened_at) && Number.isFinite(r.pairing_expires_at)
      ? { id: r.pairing_id, app: r.pairing_app, openedAt: Number(r.pairing_opened_at), expiresAt: Number(r.pairing_expires_at) }
      : null
  return {
    enabled: r.enabled === 1,
    mcpEnabled: r.mcp_enabled === 1,
    autoApplyDrafts: r.auto_apply_drafts === 1,
    defaultProviderId: r.default_provider_id,
    keepConversationsDays: Number(r.keep_conversations_days),
    dailyTokenLimit: Math.min(DAILY_TOKEN_LIMIT_CEILING, Number(r.daily_token_limit)),
    pairing,
    changedAt: Number(r.changed_at) || 0,
  }
}

/** The settings row as stored. Throws when auth.db cannot be read (callers treat that as off). */
export function readAiSettings(): AiSettings {
  const row = getAuthDb()
    .prepare(
      `SELECT enabled, mcp_enabled, auto_apply_drafts, default_provider_id, keep_conversations_days, daily_token_limit,
              pairing_id, pairing_app, pairing_opened_at, pairing_expires_at, changed_at
       FROM ai_settings WHERE id = 1`,
    )
    .get() as Row | undefined
  if (!row) throw new Error('ai_settings has no row')
  return toSettings(row)
}

export type AiAccess = { on: true; settings: AiSettings } | { on: false; reason: 'env' | 'off' | 'unreadable' }

/** Layers 1 and 2: is any AI path allowed to act right now? Never throws; unreadable is off. */
export function aiAccess(): AiAccess {
  if (aiDisabledByEnv()) return { on: false, reason: 'env' }
  let settings: AiSettings
  try {
    settings = readAiSettings()
  } catch {
    return { on: false, reason: 'unreadable' }
  }
  return settings.enabled ? { on: true, settings } : { on: false, reason: 'off' }
}

export type AiPublicState = { open: true } | { open: false; reason: 'env' | 'off' | 'unreadable' | 'apps-off' | 'no-site-url' }

/** All four layers: do the public AI paths (/mcp, /oauth/*, …) exist right now? Never throws. */
export function aiPublicState(): AiPublicState {
  const access = aiAccess()
  if (!access.on) return { open: false, reason: access.reason }
  if (!access.settings.mcpEnabled) return { open: false, reason: 'apps-off' }
  if (!(process.env.SITE_URL || '').trim()) return { open: false, reason: 'no-site-url' }
  return { open: true }
}

export function aiPublicOpen(): boolean {
  return aiPublicState().open
}

/**
 * AI_LOCAL_PROVIDER_ORIGINS as exact origins (comma or space separated),
 * honoured only while the site is local-only; empty otherwise. Entries that
 * are not exact origins are dropped.
 */
export function localProviderOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  if (!isLocalOnly()) return []
  const out: string[] = []
  for (const part of (env.AI_LOCAL_PROVIDER_ORIGINS ?? '').split(/[\s,]+/)) {
    const origin = part ? exactOrigin(part) : null
    if (origin && !out.includes(origin)) out.push(origin)
  }
  return out
}

// ── Changing settings ──────────────────────────────────────────────────────

export type AiSettingsPatch = Partial<Pick<AiSettings, 'enabled' | 'mcpEnabled' | 'autoApplyDrafts' | 'keepConversationsDays' | 'dailyTokenLimit'>>

const PATCH_KEYS = ['enabled', 'mcpEnabled', 'autoApplyDrafts', 'keepConversationsDays', 'dailyTokenLimit'] as const
type PatchKey = (typeof PATCH_KEYS)[number]

/** A patch with exactly the known keys, each of the right type and range; null names the first bad one. */
export function parseSettingsPatch(input: unknown): { ok: true; patch: AiSettingsPatch } | { ok: false; field: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, field: '(body)' }
  const obj = input as Record<string, unknown>
  const patch: AiSettingsPatch = {}
  for (const key of Object.keys(obj)) {
    if (!(PATCH_KEYS as readonly string[]).includes(key)) return { ok: false, field: key }
    const v = obj[key]
    switch (key as PatchKey) {
      case 'enabled':
      case 'mcpEnabled':
      case 'autoApplyDrafts':
        if (typeof v !== 'boolean') return { ok: false, field: key }
        patch[key as 'enabled'] = v
        break
      case 'keepConversationsDays':
        if (typeof v !== 'number' || !Number.isInteger(v) || v < KEEP_FOREVER || v > KEEP_DAYS_MAX) return { ok: false, field: key }
        patch.keepConversationsDays = v
        break
      case 'dailyTokenLimit':
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > DAILY_TOKEN_LIMIT_CEILING) return { ok: false, field: key }
        patch.dailyTokenLimit = v
        break
    }
  }
  return { ok: true, patch }
}

/** Retention as a rank: don't keep < n days (by n) < until deleted. */
const retentionRank = (days: number) => (days === KEEP_FOREVER ? Number.POSITIVE_INFINITY : days)

/** Which fields of `patch` loosen access compared with `current` (each needs a recent verification). */
export function looseningFields(current: AiSettings, patch: AiSettingsPatch): PatchKey[] {
  const out: PatchKey[] = []
  if (patch.enabled === true && !current.enabled) out.push('enabled')
  if (patch.mcpEnabled === true && !current.mcpEnabled) out.push('mcpEnabled')
  if (patch.autoApplyDrafts === true && !current.autoApplyDrafts) out.push('autoApplyDrafts')
  if (patch.keepConversationsDays !== undefined && retentionRank(patch.keepConversationsDays) > retentionRank(current.keepConversationsDays)) {
    out.push('keepConversationsDays')
  }
  if (patch.dailyTokenLimit !== undefined && patch.dailyTokenLimit > current.dailyTokenLimit) out.push('dailyTokenLimit')
  return out
}

export type SettingsWrite =
  | { ok: true; before: AiSettings; after: AiSettings; loosened: PatchKey[] }
  | { ok: false; code: 'STEP_UP_REQUIRED'; fields: PatchKey[] }
  | { ok: false; code: 'INVALID'; field: string }

/**
 * Apply a settings change atomically. A change that loosens anything is
 * refused (STEP_UP_REQUIRED, nothing written) unless `steppedUp` says the
 * caller just passed requireRecentAuth; tightening never needs it.
 */
export function writeAiSettings(input: unknown, opts: { steppedUp: boolean; now?: number }): SettingsWrite {
  const parsed = parseSettingsPatch(input)
  if (!parsed.ok) return { ok: false, code: 'INVALID', field: parsed.field }
  const { patch } = parsed
  const db = getAuthDb()
  return db.transaction((): SettingsWrite => {
    const before = readAiSettings()
    const loosened = looseningFields(before, patch)
    if (loosened.length && !opts.steppedUp) return { ok: false, code: 'STEP_UP_REQUIRED', fields: loosened }
    const sets: string[] = []
    const params: unknown[] = []
    const col: Record<PatchKey, string> = {
      enabled: 'enabled',
      mcpEnabled: 'mcp_enabled',
      autoApplyDrafts: 'auto_apply_drafts',
      keepConversationsDays: 'keep_conversations_days',
      dailyTokenLimit: 'daily_token_limit',
    }
    for (const key of PATCH_KEYS) {
      const v = patch[key]
      if (v === undefined) continue
      sets.push(`${col[key]} = ?`)
      params.push(typeof v === 'boolean' ? (v ? 1 : 0) : v)
    }
    if (sets.length) {
      sets.push('changed_at = ?')
      params.push(opts.now ?? Date.now())
      db.prepare(`UPDATE ai_settings SET ${sets.join(', ')} WHERE id = 1`).run(...params)
    }
    return { ok: true, before, after: readAiSettings(), loosened }
  }).immediate()
}

// ── The pairing window (§6.4) ──────────────────────────────────────────────

/** The open pairing window, or null when none is open (or it expired). */
export function currentPairing(now = Date.now()): PairingWindow | null {
  const p = readAiSettings().pairing
  return p && p.expiresAt > now ? p : null
}

/** Open a 10-minute window for one OAuth connection from `app` (opening loosens: step-up). */
export function openPairingWindow(
  app: unknown,
  opts: { steppedUp: boolean; now?: number },
): { ok: true; pairing: PairingWindow } | { ok: false; code: 'STEP_UP_REQUIRED' | 'INVALID' } {
  if (!isPairingApp(app)) return { ok: false, code: 'INVALID' }
  if (!opts.steppedUp) return { ok: false, code: 'STEP_UP_REQUIRED' }
  const now = opts.now ?? Date.now()
  const pairing: PairingWindow = { id: `pw_${crypto.randomBytes(16).toString('base64url')}`, app, openedAt: now, expiresAt: now + PAIRING_WINDOW_MS }
  getAuthDb()
    .prepare('UPDATE ai_settings SET pairing_id = ?, pairing_app = ?, pairing_opened_at = ?, pairing_expires_at = ?, changed_at = ? WHERE id = 1')
    .run(pairing.id, pairing.app, pairing.openedAt, pairing.expiresAt, now)
  return { ok: true, pairing }
}

/**
 * Close the pairing window (no step-up: closing only reduces access). With
 * `expectedId`, only that window closes (a grant closes the window it was
 * made in, never a newer one). Returns whether a window was closed.
 */
export function closePairingWindow(opts: { expectedId?: string; now?: number } = {}): boolean {
  const db = getAuthDb()
  const where = opts.expectedId ? 'id = 1 AND pairing_id = ?' : 'id = 1 AND pairing_id IS NOT NULL'
  const params: unknown[] = [opts.now ?? Date.now()]
  if (opts.expectedId) params.push(opts.expectedId)
  const info = db
    .prepare(`UPDATE ai_settings SET pairing_id = NULL, pairing_app = NULL, pairing_opened_at = NULL, pairing_expires_at = NULL, changed_at = ? WHERE ${where}`)
    .run(...params)
  return info.changes > 0
}
