import crypto from 'node:crypto'
import { currentSessionVersion } from '../admin'
import { getAuthDb } from '../adminAuth/db'
import { getAiDb } from './db'
import { cleanLabelPart } from './audit'
import { SCOPES, parseScopes, type Scope } from './toolTypes'

/**
 * Connected apps (SERVER-ONLY, design §5.4): personal tokens and OAuth grants
 * in auth.db, and the check every /mcp request passes.
 *
 * Tokens: `pst_` (personal), `pso_` (OAuth access) or `psr_` (OAuth refresh),
 * then a 32-character secret (24 random bytes) and an 11-character tag: an
 * HMAC of prefix and secret under a key derived from JWT_SECRET (HKDF,
 * purpose "mcp-token-v1"; the lib/cvShare/token pattern). The tag is checked
 * first, in constant time, so a guessed or mangled token never reads the
 * store, and rotating JWT_SECRET ends every token. Never a JWT. The store
 * keeps SHA-256 of a token only; a personal token is shown once.
 *
 * A grant is bound to:
 *   - the session version it was made under: "Sign out everywhere", a
 *     password reset or a password change with sign-out ends it, and an
 *     admin.json that cannot be read fails closed;
 *   - its resource: the canonical MCP URL at issue must still be the one;
 *   - an absolute expiry, and for OAuth grants an end after 30 days unused.
 *
 * Events an owner should hear about (first use, a new country, a refused
 * token still in use, a new grant) go to the `onEvent` callback a route
 * passes in: this module never sends mail itself (lib/ai/alerts does, and
 * only routes import it), so the tool closure never reaches lib/mailer.
 */

export const TOKEN_PREFIX = { pat: 'pst_', access: 'pso_', refresh: 'psr_' } as const
export type TokenKind = keyof typeof TOKEN_PREFIX
const SECRET_CHARS = 32
const TAG_BYTES = 8
/** A token's full shape: prefix, 32-character secret, 11-character tag. */
export const TOKEN_RE = /^ps[tor]_[A-Za-z0-9_-]{43}$/

export const PAT_LIFETIME_DAYS = [7, 30, 90, 365] as const
export const PAT_DEFAULT_DAYS = 90
/** An OAuth grant ends after this long unused (§5.4). */
export const OAUTH_IDLE_MS = 30 * 86_400_000
/** last_used_at is written at most this often. */
export const TOUCH_EVERY_MS = 60_000
const DAY = 86_400_000
const NAME_MAX = 48

export type AccessEvent =
  | { type: 'grant-issued'; grantId: string; label: string; kind: 'pat' | 'oauth' }
  | { type: 'first-use'; grantId: string; label: string }
  | { type: 'new-country'; grantId: string; label: string; country: string }
  | { type: 'refused-token'; grantId: string; label: string; reason: string }

export type OnAccessEvent = (event: AccessEvent) => void

export type Grant = {
  id: string
  kind: 'pat' | 'oauth'
  name: string
  clientId: string | null
  redirectHost: string | null
  scopes: Scope[]
  resource: string
  sessionVersion: number
  createdSession: string | null
  createdDevice: string | null
  clientReported: string | null
  clientReportedChangedAt: number | null
  createdAt: number
  expiresAt: number
  firstUsedAt: number | null
  lastUsedAt: number | null
  lastIpPrefix: string | null
  lastCountry: string | null
  revokedAt: number | null
  revokeReason: string | null
}

type GrantRow = {
  id: string
  kind: string
  name: string
  client_id: string | null
  redirect_host: string | null
  scopes: string
  resource: string
  session_version: number
  created_session: string | null
  created_device: string | null
  client_reported: string | null
  client_reported_changed_at: number | null
  created_at: number
  expires_at: number
  first_used_at: number | null
  last_used_at: number | null
  last_ip_prefix: string | null
  last_country: string | null
  revoked_at: number | null
  revoke_reason: string | null
}

function toGrant(r: GrantRow): Grant {
  return {
    id: r.id,
    kind: r.kind === 'oauth' ? 'oauth' : 'pat',
    name: r.name,
    clientId: r.client_id,
    redirectHost: r.redirect_host,
    scopes: parseScopes(r.scopes),
    resource: r.resource,
    sessionVersion: Number(r.session_version),
    createdSession: r.created_session,
    createdDevice: r.created_device,
    clientReported: r.client_reported,
    clientReportedChangedAt: r.client_reported_changed_at,
    createdAt: Number(r.created_at),
    expiresAt: Number(r.expires_at),
    firstUsedAt: r.first_used_at,
    lastUsedAt: r.last_used_at,
    lastIpPrefix: r.last_ip_prefix,
    lastCountry: r.last_country,
    revokedAt: r.revoked_at,
    revokeReason: r.revoke_reason,
  }
}

// ── Tokens ────────────────────────────────────────────────────────────────

let cachedKey: { secret: string; key: Buffer } | null = null

/** The tag key, or null when JWT_SECRET is not configured (then no token can be made or accepted). */
export function tokenKey(secret: string | undefined = process.env.JWT_SECRET): Buffer | null {
  if (!secret || secret === 'change-me') return null
  if (cachedKey?.secret === secret) return cachedKey.key
  const key = Buffer.from(crypto.hkdfSync('sha256', secret, 'lucian-dev/mcp-token', 'mcp-token-v1', 32))
  cachedKey = { secret, key }
  return key
}

function tagOf(prefix: string, secretPart: string, key: Buffer): string {
  return crypto.createHmac('sha256', key).update(`mcp-token:${prefix}${secretPart}`).digest().subarray(0, TAG_BYTES).toString('base64url')
}

/** SHA-256 (hex) of a token: what the store keeps and looks up. */
export function tokenHash(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex')
}

/** A new token of `kind`, its hash and its hint (last four characters). */
export function mintToken(kind: TokenKind, key: Buffer): { token: string; hash: string; hint: string } {
  const prefix = TOKEN_PREFIX[kind]
  const secretPart = crypto.randomBytes(24).toString('base64url')
  const token = `${prefix}${secretPart}${tagOf(prefix, secretPart, key)}`
  return { token, hash: tokenHash(token), hint: token.slice(-4) }
}

/** The token's kind when its shape and tag verify under `key`, else null. Reads nothing. */
export function verifiedTokenKind(token: unknown, key: Buffer | null): TokenKind | null {
  if (!key || typeof token !== 'string' || !TOKEN_RE.test(token)) return null
  const prefix = token.slice(0, 4)
  const kind = (Object.keys(TOKEN_PREFIX) as TokenKind[]).find((k) => TOKEN_PREFIX[k] === prefix)
  if (!kind) return null
  const secretPart = token.slice(4, 4 + SECRET_CHARS)
  const expected = Buffer.from(tagOf(prefix, secretPart, key))
  const given = Buffer.from(token.slice(4 + SECRET_CHARS))
  return expected.length === given.length && crypto.timingSafeEqual(expected, given) ? kind : null
}

// ── Grants ────────────────────────────────────────────────────────────────

/** The access levels a grant may hold (§5.1): cumulative, never a partial set. */
export const ACCESS_LEVELS: ReadonlyArray<readonly Scope[]> = [SCOPES.slice(0, 1), SCOPES.slice(0, 2), SCOPES.slice(0, 3)]

/** True when `scopes` is exactly one of the three levels. */
export function isAccessLevel(scopes: readonly string[]): scopes is Scope[] {
  const set = new Set(scopes)
  return set.size === scopes.length && ACCESS_LEVELS.some((level) => level.length === set.size && level.every((s) => set.has(s)))
}

export type CreatePersonalToken = {
  /** The owner's name for it ("laptop", "Claude Code"). */
  name: unknown
  scopes: unknown
  /** 7, 30, 90 or 365 (no "never"). */
  days: unknown
  /** The canonical MCP URL (lib/mcp/http canonicalResource). */
  resource: string
  /** The browser session that made it, and its coarse device label (kept after the session row goes). */
  session: { id: string | null; device: string | null }
}

export type CreatedToken = { ok: true; token: string; grant: Grant } | { ok: false; code: 'INVALID'; field: 'name' | 'scopes' | 'days' | 'resource' } | { ok: false; code: 'NO_SECRET' }

/**
 * Make a personal token: a grant and its one token, in one transaction. The
 * token is returned once and never stored. Callers check the owner's fresh
 * verification first (requireFreshAuth, §5.2).
 */
export function createPersonalToken(input: CreatePersonalToken, opts: { now?: number; onEvent?: OnAccessEvent } = {}): CreatedToken {
  const now = opts.now ?? Date.now()
  const name = cleanLabelPart(input.name, NAME_MAX)
  if (!name) return { ok: false, code: 'INVALID', field: 'name' }
  const scopes = Array.isArray(input.scopes) ? input.scopes.filter((s): s is string => typeof s === 'string') : []
  if (!Array.isArray(input.scopes) || scopes.length !== input.scopes.length || !isAccessLevel(scopes)) return { ok: false, code: 'INVALID', field: 'scopes' }
  if (!(PAT_LIFETIME_DAYS as readonly unknown[]).includes(input.days)) return { ok: false, code: 'INVALID', field: 'days' }
  if (typeof input.resource !== 'string' || !/^https?:\/\/[^/]+\/mcp$/.test(input.resource)) return { ok: false, code: 'INVALID', field: 'resource' }
  const key = tokenKey()
  if (!key) return { ok: false, code: 'NO_SECRET' }
  const sessionVersion = currentSessionVersion()
  const id = `g${crypto.randomBytes(16).toString('base64url')}`
  const expiresAt = now + Number(input.days) * DAY
  const minted = mintToken('pat', key)
  const ordered = SCOPES.filter((s) => scopes.includes(s))
  const db = getAuthDb()
  db.transaction(() => {
    db.prepare(
      `INSERT INTO ai_grants (id, kind, name, scopes, resource, session_version, created_session, created_device, created_at, expires_at)
       VALUES (?, 'pat', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, name, ordered.join(' '), input.resource, sessionVersion, input.session.id, cleanLabelPart(input.session.device, 64) || null, now, expiresAt)
    db.prepare(`INSERT INTO ai_tokens (token_hash, grant_id, kind, hint, created_at, expires_at) VALUES (?, ?, 'pat', ?, ?, ?)`).run(minted.hash, id, minted.hint, now, expiresAt)
  })()
  pruneAccess(now)
  const grant = getGrant(id) as Grant
  opts.onEvent?.({ type: 'grant-issued', grantId: id, label: name, kind: 'pat' })
  return { ok: true, token: minted.token, grant }
}

export function getGrant(id: string): Grant | null {
  const row = getAuthDb().prepare('SELECT * FROM ai_grants WHERE id = ?').get(id) as GrantRow | undefined
  return row ? toGrant(row) : null
}

/** Every grant, newest first (revoked and expired ones too, until pruned). */
export function listGrants(): Grant[] {
  return (getAuthDb().prepare('SELECT * FROM ai_grants ORDER BY created_at DESC').all() as GrantRow[]).map(toGrant)
}

export type GrantProblem = 'revoked' | 'expired' | 'idle' | 'session' | 'unavailable'

/**
 * Why a grant may not act now, or null when it may: revoked, past its
 * expiry, an OAuth grant unused for 30 days, or made under an older session
 * version (an admin.json that cannot be read counts as one: fail closed).
 */
export function grantProblem(grant: Grant, now = Date.now()): GrantProblem | null {
  if (grant.revokedAt !== null) return 'revoked'
  if (grant.expiresAt <= now) return 'expired'
  if (grant.kind === 'oauth' && (grant.lastUsedAt ?? grant.createdAt) + OAUTH_IDLE_MS <= now) return 'idle'
  let version: number
  try {
    version = currentSessionVersion()
  } catch {
    return 'unavailable'
  }
  return grant.sessionVersion === version ? null : 'session'
}

/** The grant when it may act now (lib/ai/execute re-checks before every tool call), else null. */
export function liveGrant(id: string, now = Date.now()): Grant | null {
  const grant = getGrant(id)
  return grant && grantProblem(grant, now) === null ? grant : null
}

export type VerifyFailure = {
  ok: false
  /** malformed and tag: refused without reading the store. */
  reason: 'malformed' | 'tag' | 'unknown' | 'kind' | 'expired' | 'resource' | GrantProblem
  /** The grant a token with a valid tag belongs to, when it is still stored. */
  grant: Pick<Grant, 'id' | 'name'> | null
  /** The tag verified: the token was made here (a theft signal when refused). */
  validTag: boolean
}

export type VerifyResult = { ok: true; grant: Grant; kind: TokenKind } | VerifyFailure

/**
 * Check a bearer token for `resource` (the canonical MCP URL): tag first,
 * then the stored hash, the token's own expiry and kind (a refresh token is
 * never a bearer), the grant (grantProblem) and its audience.
 */
export function verifyBearerToken(token: string, opts: { resource: string; now?: number }): VerifyResult {
  const now = opts.now ?? Date.now()
  if (!TOKEN_RE.test(token)) return { ok: false, reason: 'malformed', grant: null, validTag: false }
  const kind = verifiedTokenKind(token, tokenKey())
  if (!kind) return { ok: false, reason: 'tag', grant: null, validTag: false }
  const row = getAuthDb()
    .prepare('SELECT t.kind AS token_kind, t.expires_at AS token_expires_at, g.* FROM ai_tokens t JOIN ai_grants g ON g.id = t.grant_id WHERE t.token_hash = ?')
    .get(tokenHash(token)) as (GrantRow & { token_kind: string; token_expires_at: number }) | undefined
  if (!row) return { ok: false, reason: 'unknown', grant: null, validTag: true }
  const grant = toGrant(row)
  const named = { id: grant.id, name: grant.name }
  if (row.token_kind !== kind || kind === 'refresh') return { ok: false, reason: 'kind', grant: named, validTag: true }
  if (Number(row.token_expires_at) <= now) return { ok: false, reason: 'expired', grant: named, validTag: true }
  const problem = grantProblem(grant, now)
  if (problem) return { ok: false, reason: problem, grant: named, validTag: true }
  if (grant.resource !== opts.resource) return { ok: false, reason: 'resource', grant: named, validTag: true }
  return { ok: true, grant, kind }
}

export type GrantUse = { ipPrefix: string | null; country: string | null; clientReported: string | null }

/**
 * Note a request a grant made: its first use, the last use (at most once a
 * minute: network prefix and country), a country it was never seen from
 * before, and the client name the request reports about itself (kept only
 * as "says it is", flagged when it changes).
 */
export function touchGrant(grant: Grant, use: GrantUse, opts: { now?: number; onEvent?: OnAccessEvent } = {}): void {
  const now = opts.now ?? Date.now()
  const db = getAuthDb()
  // Cloudflare's XX (unknown) and T1 (Tor) are no country.
  const country = use.country && /^[A-Z]{2}$/.test(use.country) && use.country !== 'XX' && use.country !== 'T1' ? use.country : null
  if (grant.firstUsedAt === null) {
    const first = db.prepare('UPDATE ai_grants SET first_used_at = ? WHERE id = ? AND first_used_at IS NULL').run(now, grant.id)
    if (first.changes) opts.onEvent?.({ type: 'first-use', grantId: grant.id, label: grant.name })
  }
  if (country && grant.lastCountry && country !== grant.lastCountry && !seenFrom(grant.id, country)) {
    opts.onEvent?.({ type: 'new-country', grantId: grant.id, label: grant.name, country })
  }
  if (grant.lastUsedAt === null || now - grant.lastUsedAt >= TOUCH_EVERY_MS || (country && country !== grant.lastCountry)) {
    db.prepare('UPDATE ai_grants SET last_used_at = ?, last_ip_prefix = ?, last_country = COALESCE(?, last_country) WHERE id = ?').run(now, use.ipPrefix, country, grant.id)
  }
  const reported = cleanLabelPart(use.clientReported, 80)
  if (reported && reported !== grant.clientReported) {
    db.prepare('UPDATE ai_grants SET client_reported = ?, client_reported_changed_at = CASE WHEN client_reported IS NULL THEN client_reported_changed_at ELSE ? END WHERE id = ?').run(
      reported,
      now,
      grant.id,
    )
  }
}

/** Has this grant been seen from `country` before (ai.db's daily roll-up keeps 400 days)? Unreadable counts as seen: no mail on a guess. */
function seenFrom(grantId: string, country: string): boolean {
  try {
    return !!getAiDb().prepare('SELECT 1 FROM ai_grant_daily WHERE grant_id = ? AND country = ? LIMIT 1').get(grantId, country)
  } catch {
    return true
  }
}

/** Revoke a grant (no step-up: reducing access has no friction). False when it was already revoked or does not exist. */
export function revokeGrant(id: string, reason: string, now = Date.now()): boolean {
  const done = getAuthDb()
    .prepare('UPDATE ai_grants SET revoked_at = ?, revoke_reason = ? WHERE id = ? AND revoked_at IS NULL')
    .run(now, cleanLabelPart(reason, 64) || 'revoked', id).changes > 0
  pruneAccess(now)
  return done
}

/**
 * Revoke, in one transaction, every grant not yet revoked that `which`
 * names: all of them, or those a set of browser sessions created (signing
 * those browsers out, §5.4). Returns the ids it revoked (callers void their
 * waiting changes and record what happened).
 */
export function revokeGrants(which: { all: true } | { createdSessions: readonly string[] }, reason: string, now = Date.now()): string[] {
  const db = getAuthDb()
  const why = cleanLabelPart(reason, 64) || 'revoked'
  const ids = db.transaction((): string[] => {
    let rows: Array<{ id: string }>
    if ('all' in which) {
      rows = db.prepare('SELECT id FROM ai_grants WHERE revoked_at IS NULL').all() as Array<{ id: string }>
    } else {
      const sessions = Array.from(new Set(which.createdSessions.filter((s) => typeof s === 'string' && s)))
      if (!sessions.length) return []
      rows = db
        .prepare(`SELECT id FROM ai_grants WHERE revoked_at IS NULL AND created_session IN (${sessions.map(() => '?').join(', ')})`)
        .all(...sessions) as Array<{ id: string }>
    }
    const revoke = db.prepare('UPDATE ai_grants SET revoked_at = ?, revoke_reason = ? WHERE id = ? AND revoked_at IS NULL')
    return rows.filter((r) => revoke.run(now, why, r.id).changes > 0).map((r) => r.id)
  })()
  pruneAccess(now)
  return ids
}

/** Rename a grant (the owner's label). Null when it does not exist, is revoked, or the name is empty. */
export function renameGrant(id: string, name: unknown): Grant | null {
  const clean = cleanLabelPart(name, NAME_MAX)
  if (!clean) return null
  const done = getAuthDb().prepare('UPDATE ai_grants SET name = ? WHERE id = ? AND revoked_at IS NULL').run(clean, id).changes > 0
  return done ? getGrant(id) : null
}

/**
 * Hand a browser's grants to the session that replaced it (a password
 * change re-issues this browser's session): signing that browser out later
 * still ends the apps it created.
 */
export function moveCreatedSession(from: string, to: string): number {
  if (!from || !to || from === to) return 0
  return getAuthDb().prepare('UPDATE ai_grants SET created_session = ? WHERE created_session = ? AND revoked_at IS NULL').run(to, from).changes
}

/** The grants that may act right now (grantProblem is null), newest first. */
export function liveGrants(now = Date.now()): Grant[] {
  return listGrants().filter((g) => grantProblem(g, now) === null)
}

/** The last four characters of each grant's newest personal token (what the owner can match a token by). */
export function tokenHints(grantIds: readonly string[]): Map<string, string> {
  const out = new Map<string, string>()
  if (!grantIds.length) return out
  const rows = getAuthDb()
    .prepare(`SELECT grant_id, hint FROM ai_tokens WHERE kind = 'pat' AND grant_id IN (${grantIds.map(() => '?').join(', ')}) ORDER BY created_at ASC`)
    .all(...grantIds) as Array<{ grant_id: string; hint: string }>
  for (const r of rows) out.set(r.grant_id, r.hint)
  return out
}

/**
 * Housekeeping, on write (§3.1): tokens 7 days past their expiry, grants 90
 * days after they were revoked or expired (with their tokens: auth.db does
 * not enforce foreign keys), authorization codes after an hour.
 */
export function pruneAccess(now = Date.now()): void {
  const db = getAuthDb()
  db.transaction(() => {
    db.prepare('DELETE FROM ai_tokens WHERE expires_at <= ?').run(now - 7 * DAY)
    const gone = `SELECT id FROM ai_grants WHERE (revoked_at IS NOT NULL AND revoked_at <= ?) OR expires_at <= ?`
    db.prepare(`DELETE FROM ai_tokens WHERE grant_id IN (${gone})`).run(now - 90 * DAY, now - 90 * DAY)
    db.prepare(`DELETE FROM ai_grants WHERE id IN (${gone})`).run(now - 90 * DAY, now - 90 * DAY)
    db.prepare('DELETE FROM ai_oauth_codes WHERE expires_at <= ?').run(now - 3_600_000)
  })()
}
