import crypto from 'node:crypto'
import { currentSessionVersion } from '../admin'
import { getAuthDb } from '../adminAuth/db'
import { liveSession } from '../adminAuth/sessions'
import { log } from '../log'
import { SafeFetchError, safeFetch, type SafeFetchOptions, type SafeFetchResult } from '../security/safeFetch'
import { canonicalResource, siteUrl } from '../mcp/http'
import { ACCESS_LEVELS, getGrant, grantProblem, mintToken, pruneAccess, revokeGrant, tokenHash, tokenKey, verifiedTokenKind, type Grant, type OnAccessEvent } from './access'
import { cleanLabelPart } from './audit'
import { voidOpenChanges } from './changes'
import { knownClient, knownClientsFor } from './knownClients'
import { PAIRING_WINDOW_MS, closePairingWindow, currentPairing, localProviderOrigins, type PairingApp, type PairingWindow } from './settings'
import { SCOPES, type Scope } from './toolTypes'

/**
 * The OAuth 2.1 authorization server of /mcp (SERVER-ONLY, design §6.4),
 * hand-written: libraries in this niche have shipped redirect and PKCE bugs,
 * and the rules below are few. The site is both the resource server and the
 * authorization server; the issuer and the resource come from SITE_URL, never
 * from the Host header.
 *
 * The public side stores nothing and fetches nothing before the owner is
 * involved:
 *
 *   GET  /oauth/authorize  counts the hit (in memory, nothing else) and
 *        bounces the browser, same-site, to /admin/ai/connect with the
 *        parameters — the same answer whether or not a connection is expected,
 *        so nobody can watch for the moment the owner is primed to approve;
 *   POST /oauth/register   DCR (deprecated, still what Cursor, Gemini CLI and
 *        mcp-remote use): a signed, self-contained client id
 *        (`dcr_<base64url json>.<tag>`), no row, the same answer open or closed;
 *   POST /oauth/token      the code exchange and the refresh rotation;
 *   POST /oauth/revoke     RFC 7009, always 200.
 *
 * Everything else happens behind the owner's session, during a pairing window
 * the owner opened (lib/ai/settings, 10 minutes, one grant closes it):
 * checkAuthorizeRequest resolves the client — a Client ID Metadata Document
 * fetched through safeFetch (no redirect, 3 s, 5 KB, the exact client_id, no
 * shared secret), or a DCR id whose tag must verify — matches the redirect
 * URI exactly (loopback on any port), and requires response_type=code, PKCE
 * S256, the canonical resource and known scopes. Every failure is a page on
 * this site, never a redirect (RFC 9700 §2.1). Consent (issueCode) closes the
 * window and stores a 60-second, single-use code: its SHA-256, the PKCE
 * challenge and what it is for. The grant itself is made when the code is
 * exchanged (exchangeCode), with its access token (1 hour) and refresh token
 * (rotated on every use; a rotated one presented again after 10 seconds ends
 * the grant), and lives at most 90 days, ending after 30 unused
 * (lib/ai/access grantProblem).
 *
 * Tokens, codes and verifiers are never logged and never stored in clear.
 */

export const CODE_TTL_MS = 60_000
export const ACCESS_TTL_MS = 3_600_000
/** An OAuth grant's absolute lifetime (§5.4). */
export const OAUTH_GRANT_MS = 90 * 86_400_000
/** A rotated refresh token presented again within this long is a concurrent refresh, not a theft. */
export const REFRESH_REUSE_GRACE_MS = 10_000
export const AUTHORIZE_QUERY_MAX = 4096
export const CIMD_MAX_BYTES = 5 * 1024
export const CIMD_TIMEOUT_MS = 3000
export const DCR_MAX_REDIRECT_URIS = 5
/** Bytes of what a registration keeps (its redirect URIs and name), as JSON. */
export const DCR_METADATA_MAX = 1024
export const CLIENT_NAME_MAX = 64
/** Every scope a client may ask for: the three content scopes and offline_access (accepted; a refresh token comes anyway). */
export const OAUTH_SCOPES = [...SCOPES, 'offline_access'] as const


// ── Discovery documents ───────────────────────────────────────────────────

/** The issuer: SITE_URL's origin, or null without SITE_URL. */
export function issuer(): string | null {
  return siteUrl()?.origin ?? null
}

/** RFC 9728 Protected Resource Metadata of /mcp. Only content:read: clients ask for whatever is listed when a 401 names nothing. */
export function protectedResourceMetadata(): Record<string, unknown> | null {
  const iss = issuer()
  const resource = canonicalResource()
  if (!iss || !resource) return null
  return { resource, authorization_servers: [iss], scopes_supported: ['content:read'], bearer_methods_supported: ['header'] }
}

/** RFC 8414 Authorization Server Metadata. */
export function authorizationServerMetadata(): Record<string, unknown> | null {
  const iss = issuer()
  if (!iss) return null
  return {
    issuer: iss,
    authorization_endpoint: `${iss}/oauth/authorize`,
    token_endpoint: `${iss}/oauth/token`,
    registration_endpoint: `${iss}/oauth/register`,
    revocation_endpoint: `${iss}/oauth/revoke`,
    scopes_supported: [...OAUTH_SCOPES],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  }
}

// ── Authorize hits (in memory: a count, nothing else) ─────────────────────

type HitStore = { at: number[] }
const HITS_KEPT = 5000

/** Shared by every route bundle of this process (each API route is its own bundle). */
function hits(): HitStore {
  const g = globalThis as typeof globalThis & { __aiOauthAuthorizeHits?: HitStore }
  g.__aiOauthAuthorizeHits ??= { at: [] }
  return g.__aiOauthAuthorizeHits
}

/** One more GET /oauth/authorize. Only its time is kept, and only as long as a pairing window can last. */
export function noteAuthorizeHit(now = Date.now()): void {
  const store = hits()
  const keepFrom = now - PAIRING_WINDOW_MS - 60_000
  let drop = 0
  while (drop < store.at.length && store.at[drop] < keepFrom) drop++
  if (drop) store.at.splice(0, drop)
  if (store.at.length >= HITS_KEPT) store.at.splice(0, store.at.length - HITS_KEPT + 1)
  store.at.push(now)
}

/** Authorize hits since `since` (the pairing window's opening). */
export function authorizeHitsSince(since: number): number {
  return hits().at.filter((t) => t >= since).length
}

// ── Shapes ────────────────────────────────────────────────────────────────

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export type RedirectForm =
  | { ok: true; url: URL; loopback: boolean }
  | { ok: false; reason: 'missing' | 'parse' | 'custom-scheme' | 'plain-http' | 'fragment' | 'userinfo' | 'wildcard' }

/** Is `raw` a redirect URI this site would ever send a browser to: https, or http on a loopback host; no fragment, userinfo or wildcard. */
export function redirectForm(raw: unknown): RedirectForm {
  if (typeof raw !== 'string' || !raw) return { ok: false, reason: 'missing' }
  if (raw.length > 2048) return { ok: false, reason: 'parse' }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'parse' }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: 'custom-scheme' }
  if (raw.includes('#')) return { ok: false, reason: 'fragment' }
  if (url.username || url.password) return { ok: false, reason: 'userinfo' }
  if (raw.includes('*')) return { ok: false, reason: 'wildcard' }
  const loopback = LOOPBACK_HOSTS.has(url.hostname)
  if (url.protocol === 'http:' && !loopback) return { ok: false, reason: 'plain-http' }
  return { ok: true, url, loopback }
}

/** `raw` with the port of a loopback http(s) address removed (the only part a loopback redirect may vary in). */
function withoutLoopbackPort(raw: string): string {
  return raw.replace(/^(https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]))(?::\d{1,5})?(?=[/?]|$)/, '$1')
}

/**
 * Does the requested redirect URI match a registered one? Exactly, byte for
 * byte — except that a loopback address (localhost, 127.0.0.1, [::1]) may
 * use any port, as native apps pick theirs at run time (RFC 8252 §7.3;
 * Claude Code needs it for localhost too).
 */
export function redirectMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true
  const a = redirectForm(registered)
  const b = redirectForm(requested)
  if (!a.ok || !b.ok || !a.loopback || !b.loopback) return false
  return withoutLoopbackPort(registered) === withoutLoopbackPort(requested)
}

/** A client's self-declared name: control, bidi and invisible characters gone, at most 64 characters. Never shown as verified. */
export function cleanClientName(v: unknown): string | null {
  if (typeof v !== 'string') return null
  // U+061C ARABIC LETTER MARK is a bidi control cleanLabelPart's ranges leave out.
  return cleanLabelPart(v.replace(/\u061c/g, ' '), CLIENT_NAME_MAX) || null
}

export type RequestedScope = { ok: true; content: Scope[]; offline: boolean; level: 1 | 2 | 3 } | { ok: false; unknown: string }

/** The scope parameter: known names only. The level is the highest content scope asked for (levels are cumulative, §5.1). */
export function parseRequestedScope(raw: string | null | undefined): RequestedScope {
  const names = String(raw ?? '').split(' ').filter(Boolean)
  for (const n of names) if (!(OAUTH_SCOPES as readonly string[]).includes(n)) return { ok: false, unknown: n.slice(0, 64) }
  const content = SCOPES.filter((s) => names.includes(s))
  const level = Math.max(1, ...content.map((s) => SCOPES.indexOf(s) + 1)) as 1 | 2 | 3
  return { ok: true, content, offline: names.includes('offline_access'), level }
}

export type ResourceCheck = { ok: true } | { ok: false; message: string }

/** The resource parameter must name this server's canonical MCP address (host compared without case). */
export function checkResource(raw: unknown, canonical: string): ResourceCheck {
  const expected = new URL(canonical)
  if (typeof raw !== 'string' || !raw) return { ok: false, message: `The app sent no resource. This server’s MCP address is ${canonical}.` }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, message: `The app asked for an address that isn’t one. This server’s MCP address is ${canonical}.` }
  }
  const samePlace = url.protocol === expected.protocol && url.port === expected.port && url.pathname === expected.pathname && !url.search && !raw.includes('#')
  if (samePlace && url.hostname === expected.hostname) return { ok: true }
  if (samePlace && LOOPBACK_HOSTS.has(url.hostname) && LOOPBACK_HOSTS.has(expected.hostname)) {
    return { ok: false, message: `The app added this server as ${url.hostname}, but its address is ${canonical}. Remove it from the app and add it again with exactly that address.` }
  }
  return { ok: false, message: `The app asked for access to ${raw.slice(0, 200)}, which isn’t this server. Its MCP address is ${canonical}.` }
}

// ── Clients: Client ID Metadata Documents and DCR ids ─────────────────────

export type OAuthClient = {
  kind: 'cimd' | 'dcr'
  clientId: string
  redirectUris: string[]
  /** What the client calls itself (never verified). */
  name: string | null
  /** CIMD: the host of the client_id URL (what identifies it); DCR: null. */
  host: string | null
}

export type ClientDocFetcher = (url: string, opts: SafeFetchOptions) => Promise<SafeFetchResult>

type Resolved = { ok: true; client: OAuthClient } | { ok: false; error: string; message: string }

type CimdCache = Map<string, { pairingId: string; until: number; client: OAuthClient }>

function cimdCache(): CimdCache {
  const g = globalThis as typeof globalThis & { __aiOauthCimdCache?: CimdCache }
  g.__aiOauthCimdCache ??= new Map()
  return g.__aiOauthCimdCache
}

/** Forget every cached client document (tests; a window's documents expire with it anyway). */
export function clearClientDocumentCache(): void {
  cimdCache().clear()
}

/**
 * Is `clientId` a Client ID Metadata Document URL: https with a path? (Or,
 * while the site is local-only, an exact origin listed in
 * AI_LOCAL_PROVIDER_ORIGINS on plain http — the same local exception
 * safeFetch makes, so a local client or a test stub can be tried.)
 */
function cimdUrl(clientId: string): { url: URL; local: string[] } | null {
  let url: URL
  try {
    url = new URL(clientId)
  } catch {
    return null
  }
  if (url.username || url.password || clientId.includes('#') || url.pathname === '/' || !url.pathname) return null
  const local = localProviderOrigins()
  if (url.protocol === 'https:') return { url, local: local.includes(url.origin) ? local : [] }
  if (url.protocol === 'http:' && local.includes(url.origin)) return { url, local }
  return null
}

const CIMD_FAILURE: Record<SafeFetchError['code'], string> = {
  BAD_URL: 'its address isn’t one this site will fetch',
  BLOCKED_HOST: 'its address is not on the public internet',
  DNS: 'its host name could not be resolved',
  TIMEOUT: 'it did not answer within 3 seconds',
  IDLE: 'it stopped answering',
  TOO_LARGE: `it is larger than ${CIMD_MAX_BYTES} bytes`,
  REDIRECTS: 'it answered with a redirect',
  NETWORK: 'the connection failed',
  ABORTED: 'the request was stopped',
}

const SECRET_METHODS = new Set(['client_secret_basic', 'client_secret_post', 'client_secret_jwt'])

/**
 * Fetch and check a client's metadata document (draft-ietf-oauth-client-id-
 * metadata-document): no redirect followed, 3 seconds, at most 5 KB (more is
 * an error), 200 only, `client_id` equal to the URL by exact string, no
 * client secret, and a public client: `none` listed in either auth-method
 * field, or neither field present. A good answer is kept for the window it
 * was fetched in; an error never is.
 */
async function resolveClientDocument(clientId: string, target: { url: URL; local: string[] }, pairing: PairingWindow, fetcher: ClientDocFetcher, now: number): Promise<Resolved> {
  const cache = cimdCache()
  const hit = cache.get(clientId)
  if (hit && hit.pairingId === pairing.id && hit.until > now) return { ok: true, client: hit.client }
  const fail = (why: string): Resolved => ({ ok: false, error: 'invalid_client', message: `The app’s client document at ${target.url.host} can’t be used: ${why}.` })
  let res: SafeFetchResult
  try {
    res = await fetcher(clientId, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'manual',
      timeoutMs: CIMD_TIMEOUT_MS,
      maxBytes: CIMD_MAX_BYTES,
      localOrigins: target.local.length ? target.local : undefined,
    })
  } catch (err) {
    return fail(err instanceof SafeFetchError ? CIMD_FAILURE[err.code] : 'it could not be fetched')
  }
  if (res.status !== 200) return fail(res.status >= 300 && res.status < 400 ? 'it answered with a redirect' : `it answered HTTP ${res.status}`)
  let doc: unknown
  try {
    doc = JSON.parse(res.body.toString('utf8'))
  } catch {
    return fail('it isn’t JSON')
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return fail('it isn’t a JSON object')
  const d = doc as Record<string, unknown>
  if (d.client_id !== clientId) return fail('the client_id inside it is not its own address')
  if (Object.keys(d).some((k) => k.startsWith('client_secret'))) return fail('it carries a client secret')
  const methods = [d.token_endpoint_auth_method, ...(Array.isArray(d.token_endpoint_auth_methods_supported) ? d.token_endpoint_auth_methods_supported : [])].filter(
    (m): m is string => typeof m === 'string',
  )
  if (methods.length && !methods.includes('none')) {
    return fail(methods.some((m) => SECRET_METHODS.has(m)) ? 'it needs a shared secret, and this site has public clients only' : 'it lists no public sign-in method (none)')
  }
  const uris = Array.isArray(d.redirect_uris) ? d.redirect_uris.filter((u): u is string => typeof u === 'string') : []
  if (!uris.length) return fail('it lists no redirect URI')
  const client: OAuthClient = { kind: 'cimd', clientId, redirectUris: uris.slice(0, 20), name: cleanClientName(d.client_name), host: target.url.hostname }
  cache.set(clientId, { pairingId: pairing.id, until: pairing.expiresAt, client })
  return { ok: true, client }
}

let cachedDcrKey: { secret: string; key: Buffer } | null = null

/** The DCR tag key (its own HKDF purpose), or null without JWT_SECRET. */
function dcrKey(secret: string | undefined = process.env.JWT_SECRET): Buffer | null {
  if (!secret || secret === 'change-me') return null
  if (cachedDcrKey?.secret === secret) return cachedDcrKey.key
  const key = Buffer.from(crypto.hkdfSync('sha256', secret, 'lucian-dev/mcp-dcr', 'mcp-dcr-v1', 32))
  cachedDcrKey = { secret, key }
  return key
}

const DCR_ID_RE = /^dcr_([A-Za-z0-9_-]{1,3000})\.([A-Za-z0-9_-]{22})$/
const dcrTag = (body: string, key: Buffer) => crypto.createHmac('sha256', key).update(`dcr:${body}`).digest().subarray(0, 16).toString('base64url')

type DcrPayload = { v: 1; r: string[]; n: string | null; t: number }

/** A DCR client id this site signed (tag checked first, in constant time), else null. */
export function readDcrClient(clientId: string): OAuthClient | null {
  const m = DCR_ID_RE.exec(clientId)
  const key = dcrKey()
  if (!m || !key) return null
  const expected = Buffer.from(dcrTag(m[1], key))
  const given = Buffer.from(m[2])
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null
  try {
    const p = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')) as DcrPayload
    if (p?.v !== 1 || !Array.isArray(p.r) || !p.r.every((u) => typeof u === 'string')) return null
    return { kind: 'dcr', clientId, redirectUris: p.r, name: cleanClientName(p.n), host: null }
  } catch {
    return null
  }
}

export type Registration =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: 400 | 503; error: 'invalid_redirect_uri' | 'invalid_client_metadata' | 'server_error'; description: string }

/**
 * RFC 7591 registration, stateless: the answer IS the client — its redirect
 * URIs and name, signed — so strangers cannot fill a table or lock the owner
 * out, and nothing needs pruning. Requested auth methods are ignored: every
 * client is public (`none`). https or loopback redirect URIs only, at most 5,
 * at most 1,024 bytes of kept metadata. The name is never treated as verified.
 */
export function registerClient(input: unknown, now = Date.now()): Registration {
  const bad = (error: 'invalid_redirect_uri' | 'invalid_client_metadata', description: string): Registration => ({ ok: false, status: 400, error, description })
  if (!input || typeof input !== 'object' || Array.isArray(input)) return bad('invalid_client_metadata', 'Send the client metadata as a JSON object.')
  const body = input as Record<string, unknown>
  const uris = body.redirect_uris
  if (!Array.isArray(uris) || !uris.length) return bad('invalid_redirect_uri', 'redirect_uris must list at least one redirect URI.')
  if (uris.length > DCR_MAX_REDIRECT_URIS) return bad('invalid_redirect_uri', `At most ${DCR_MAX_REDIRECT_URIS} redirect URIs.`)
  for (const u of uris) {
    const form = redirectForm(u)
    if (!form.ok) {
      if (form.reason === 'custom-scheme') log.info('OAuth registration refused: a custom-scheme redirect URI', { scheme: String(u).split(':')[0].slice(0, 32) })
      return bad('invalid_redirect_uri', 'Every redirect URI must be https, or http on a loopback address (localhost, 127.0.0.1, [::1]), with no fragment.')
    }
  }
  if (body.client_name !== undefined && typeof body.client_name !== 'string') return bad('invalid_client_metadata', 'client_name must be a string.')
  const name = cleanClientName(body.client_name)
  const kept = { redirect_uris: uris as string[], ...(name ? { client_name: name } : {}) }
  if (Buffer.byteLength(JSON.stringify(kept), 'utf8') > DCR_METADATA_MAX) return bad('invalid_client_metadata', `The redirect URIs and name together exceed ${DCR_METADATA_MAX} bytes.`)
  const key = dcrKey()
  if (!key) return { ok: false, status: 503, error: 'server_error', description: 'The server has no JWT_SECRET, so it cannot register clients.' }
  const issuedAt = Math.floor(now / 1000)
  const payload: DcrPayload = { v: 1, r: kept.redirect_uris, n: name, t: issuedAt }
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return {
    ok: true,
    body: {
      client_id: `dcr_${encoded}.${dcrTag(encoded, key)}`,
      client_id_issued_at: issuedAt,
      ...kept,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    },
  }
}

// ── The authorization request, behind the owner's session ────────────────

const PARAMS = ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'scope', 'state', 'resource'] as const
type ParamName = (typeof PARAMS)[number]

/** What a valid request asks for, as the consent and the code keep it. */
export type ValidRequest = {
  clientId: string
  redirectUri: string
  codeChallenge: string
  state: string | null
  resource: string
}

export type ConsentFacts = {
  pairingId: string
  app: PairingApp
  /** When the window ends. */
  windowEndsAt: number
  /** /oauth/authorize hits since the window opened (this request among them). */
  requests: number
  client: {
    kind: 'cimd' | 'dcr'
    /** CIMD: the host of its client_id URL. */
    host: string | null
    /** What it calls itself; for DCR the only name there is (shown as unverified). */
    selfName: string | null
    /** The known client's name, for an exact known pair. */
    knownName: string | null
  }
  redirect: { uri: string; host: string; loopback: boolean }
  /** An exact (client_id, redirect_uri) pair from lib/ai/knownClients: no typed hostname needed. */
  known: boolean
  requestedLevel: 1 | 2 | 3
  /** What the page selects first: the request's level, at most Read and draft (§6.4). */
  preselectedLevel: 1 | 2
  /** The site's host (SITE_URL). */
  site: string
}

export type AuthorizeCheck =
  | { state: 'closed' }
  | { state: 'invalid'; error: string; message: string }
  | { state: 'ok'; facts: ConsentFacts; request: ValidRequest }

const invalid = (error: string, message: string): AuthorizeCheck => ({ state: 'invalid', error, message })

/**
 * Check an authorization request (the query /oauth/authorize was given),
 * behind the owner's session. Closed when no pairing window is open. In this
 * order: the parameters (each at most once), the window's app (a window for
 * an app with known clients takes no other client_id), the redirect URI's
 * form, response_type, PKCE S256, the resource and the scopes — then the
 * client (its document, or its DCR tag) and the redirect URI against its
 * list. Fetches a client document only here, only during a window, and only
 * for a request that passed everything else.
 */
export async function checkAuthorizeRequest(search: URLSearchParams, deps: { now?: number; fetcher?: ClientDocFetcher } = {}): Promise<AuthorizeCheck> {
  const now = deps.now ?? Date.now()
  let pairing: PairingWindow | null
  try {
    pairing = currentPairing(now)
  } catch {
    return { state: 'closed' }
  }
  if (!pairing) return { state: 'closed' }
  const canonical = canonicalResource()
  const site = siteUrl()
  if (!canonical || !site) return invalid('server_error', 'SITE_URL isn’t set on the server, so it has no address an app could connect to.')

  const p = {} as Record<ParamName, string | null>
  for (const name of PARAMS) {
    const all = search.getAll(name)
    if (all.length > 1) return invalid('invalid_request', `The request names “${name}” more than once.`)
    p[name] = all[0] ?? null
  }
  const clientId = p.client_id
  if (!clientId) return invalid('invalid_request', 'The request doesn’t say which app it is from (no client_id).')

  const appClients = knownClientsFor(pairing.app)
  if (appClients.length && !appClients.some((c) => c.clientId === clientId)) {
    return invalid('wrong_app', `This window was opened for ${appClients[0].label}. If you are connecting another app, open its tab in Connections and allow a new connection there.`)
  }

  // Everything that needs no client document first: a request that fails here never makes the server fetch one.
  const form = redirectForm(p.redirect_uri)
  if (!form.ok) {
    if (form.reason === 'custom-scheme') {
      log.info('OAuth request refused: a custom-scheme redirect URI', { scheme: String(p.redirect_uri).split(':')[0].slice(0, 32) })
      return invalid('invalid_redirect_uri', 'The app asked to come back to an address that isn’t a web address. Apps of that kind connect with a personal token instead (Connections → New token).')
    }
    return invalid('invalid_redirect_uri', form.reason === 'missing' ? 'The request doesn’t say where to send you back (no redirect_uri).' : 'The app asked to come back to an address this site never sends anyone to: it must be https, or http on this computer, with no fragment.')
  }
  const redirectUri = p.redirect_uri as string
  if (p.response_type !== 'code') return invalid('unsupported_response_type', 'Only the authorization code flow is supported (response_type=code).')
  if (p.code_challenge_method !== 'S256' || !p.code_challenge) return invalid('invalid_request', 'The request has no PKCE S256 challenge. This site accepts only S256 (code_challenge_method=S256 with a code_challenge).')
  if (!/^[A-Za-z0-9_-]{43}$/.test(p.code_challenge)) return invalid('invalid_request', 'The PKCE challenge isn’t an S256 one (43 base64url characters).')
  const resource = checkResource(p.resource, canonical)
  if (!resource.ok) return invalid('invalid_target', resource.message)
  const scope = parseRequestedScope(p.scope)
  if (!scope.ok) return invalid('invalid_scope', `The app asked for a permission this site doesn’t have: “${scope.unknown}”.`)

  let client: OAuthClient | null = null
  if (clientId.startsWith('dcr_')) {
    client = readDcrClient(clientId)
    if (!client) return invalid('invalid_client', 'This app’s registration wasn’t made by this site, or was made before the server’s secret changed. Connect again from the app.')
  } else {
    const target = cimdUrl(clientId)
    if (!target) return invalid('invalid_client', 'The app’s identity can’t be checked: its client_id must be the https address of its client document, or an id this site registered.')
    const resolved = await resolveClientDocument(clientId, target, pairing, deps.fetcher ?? safeFetch, now)
    if (!resolved.ok) return invalid(resolved.error, resolved.message)
    client = resolved.client
  }
  if (!client.redirectUris.some((r) => redirectMatches(r, redirectUri))) {
    return invalid('invalid_redirect_uri', `The app asked to come back to ${form.url.host}, which isn’t an address it registered.`)
  }

  const kc = knownClient(clientId)
  const known = !!kc && kc.redirectUris.some((r) => redirectMatches(r, redirectUri))
  return {
    state: 'ok',
    request: { clientId, redirectUri, codeChallenge: p.code_challenge, state: p.state, resource: canonical },
    facts: {
      pairingId: pairing.id,
      app: pairing.app,
      windowEndsAt: pairing.expiresAt,
      requests: authorizeHitsSince(pairing.openedAt),
      client: { kind: client.kind, host: client.host, selfName: client.name, knownName: known && kc ? kc.label : null },
      redirect: { uri: redirectUri, host: form.url.hostname, loopback: form.loopback },
      known,
      requestedLevel: scope.level,
      preselectedLevel: Math.min(scope.level, 2) as 1 | 2,
      site: site.host,
    },
  }
}

/** Does the typed hostname name the redirect host (case, a trailing dot and IPv6 brackets aside)? */
export function typedHostMatches(typed: unknown, host: string): boolean {
  if (typeof typed !== 'string') return false
  const norm = (h: string) => h.trim().toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '')
  const t = norm(typed)
  if (!t) return false
  let ascii = t
  try {
    ascii = new URL(`http://${t.includes(':') ? `[${t}]` : t}/`).hostname.replace(/^\[|\]$/g, '')
  } catch {
    return false
  }
  return ascii === norm(host)
}

/** The authorization response: `redirectUri` with the fields appended (its own query kept). */
export function authorizationResponse(redirectUri: string, fields: Record<string, string | null>): string {
  const url = new URL(redirectUri)
  for (const [k, v] of Object.entries(fields)) if (v !== null) url.searchParams.append(k, v)
  return url.href
}

export type IssuedCode = { ok: true; code: string; redirect: string } | { ok: false; reason: 'window' | 'level' | 'session' | 'unavailable' }

/**
 * The owner allowed it: in one transaction, close the window this request was
 * checked in (it must still be that window) and store a single-use code for
 * 60 seconds — its SHA-256, the client, the exact redirect URI, the PKCE
 * challenge, the scopes of the chosen level, the resource, the session
 * version and the browser session that allowed it. Returns the redirect with
 * code, state and iss.
 */
export function issueCode(input: { request: ValidRequest; pairingId: string; level: number; sessionId: string }, now = Date.now()): IssuedCode {
  const level = input.level
  if (!Number.isInteger(level) || level < 1 || level > ACCESS_LEVELS.length) return { ok: false, reason: 'level' }
  if (!input.sessionId) return { ok: false, reason: 'session' }
  const iss = issuer()
  if (!iss) return { ok: false, reason: 'unavailable' }
  let sessionVersion: number
  try {
    sessionVersion = currentSessionVersion()
  } catch {
    return { ok: false, reason: 'unavailable' }
  }
  const code = crypto.randomBytes(32).toString('base64url')
  const db = getAuthDb()
  const stored = db
    .transaction((): boolean => {
      const open = currentPairing(now)
      if (!open || open.id !== input.pairingId) return false
      if (!closePairingWindow({ expectedId: input.pairingId, now })) return false
      db.prepare(
        `INSERT INTO ai_oauth_codes (code_hash, client_id, redirect_uri, code_challenge, scopes, resource, session_version, created_session, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(tokenHash(code), input.request.clientId, input.request.redirectUri, input.request.codeChallenge, ACCESS_LEVELS[level - 1].join(' '), input.request.resource, sessionVersion, input.sessionId, now + CODE_TTL_MS)
      return true
    })
    .immediate()
  if (!stored) return { ok: false, reason: 'window' }
  pruneAccess(now)
  return { ok: true, code, redirect: authorizationResponse(input.request.redirectUri, { code, state: input.request.state, iss }) }
}

/**
 * Codes the owner allowed since `since` (the Connections page asks while it
 * waits for an app to collect its access): when, whether it was exchanged and
 * for which grant, and whether it ran out unused. Never the code.
 */
export function consentsSince(since: number, now = Date.now()): Array<{ at: number; grantId: string | null; exchanged: boolean; expired: boolean }> {
  const rows = getAuthDb()
    .prepare('SELECT expires_at, used_at, grant_id FROM ai_oauth_codes WHERE expires_at >= ? ORDER BY expires_at DESC LIMIT 5')
    .all(since + CODE_TTL_MS) as Array<{ expires_at: number; used_at: number | null; grant_id: string | null }>
  return rows.map((r) => ({ at: Number(r.expires_at) - CODE_TTL_MS, grantId: r.grant_id, exchanged: r.used_at !== null && r.grant_id !== null, expired: r.used_at === null && Number(r.expires_at) <= now }))
}

// ── The token endpoint ────────────────────────────────────────────────────

export type TokenError = 'invalid_request' | 'invalid_grant' | 'invalid_target' | 'invalid_scope' | 'unsupported_grant_type' | 'server_error'

export type TokenBody = { access_token: string; token_type: 'Bearer'; expires_in: number; refresh_token: string; scope: string }

export type TokenAnswer =
  | { ok: true; body: TokenBody; grant: Grant; created: boolean }
  | { ok: false; status: 400 | 503; error: TokenError; description: string; ended?: Grant }

const refuse = (error: TokenError, description: string, status: 400 | 503 = 400): TokenAnswer => ({ ok: false, status, error, description })

/** The granted scope as the response states it: the grant's content scopes, and offline_access (a refresh token always comes). */
const scopeText = (scopes: readonly string[]) => [...scopes, 'offline_access'].join(' ')

const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/

/** S256 of a PKCE verifier (RFC 7636). */
export function pkceChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url')
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

/** A new access and refresh token for `grantId`, stored as hashes. */
function mintPair(grantId: string, refreshUntil: number, now: number, key: Buffer): { access: string; refresh: string } {
  const access = mintToken('access', key)
  const refresh = mintToken('refresh', key)
  const insert = getAuthDb().prepare('INSERT INTO ai_tokens (token_hash, grant_id, kind, hint, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
  insert.run(access.hash, grantId, 'access', access.hint, now, now + ACCESS_TTL_MS)
  insert.run(refresh.hash, grantId, 'refresh', refresh.hint, now, refreshUntil)
  return { access: access.token, refresh: refresh.token }
}

function bodyOf(pair: { access: string; refresh: string }, scopes: readonly string[]): TokenBody {
  return { access_token: pair.access, token_type: 'Bearer', expires_in: ACCESS_TTL_MS / 1000, refresh_token: pair.refresh, scope: scopeText(scopes) }
}

/** End a grant that showed a theft signal, and withdraw what it still had waiting. */
function endGrant(grant: Grant, reason: string, now: number): Grant | undefined {
  if (!revokeGrant(grant.id, reason, now)) return undefined
  try {
    voidOpenChanges({ actorIds: [grant.id] }, 'ISSUER_ENDED', now)
  } catch (err) {
    log.error('AI changes of an ended OAuth grant could not be withdrawn', { err })
  }
  return getGrant(grant.id) ?? grant
}

/** The name a new OAuth grant gets: the known client's, else the verified host (the client_id URL's for a document, the redirect host for DCR). */
function grantNameOf(clientId: string, redirectUri: string): string {
  const kc = knownClient(clientId)
  if (kc && kc.redirectUris.some((r) => redirectMatches(r, redirectUri))) return kc.label
  if (!clientId.startsWith('dcr_')) {
    try {
      return new URL(clientId).hostname
    } catch {
      /* fall through */
    }
  }
  return new URL(redirectUri).hostname
}

type CodeRow = {
  code_hash: string
  client_id: string
  redirect_uri: string
  code_challenge: string
  scopes: string
  resource: string
  session_version: number
  created_session: string | null
  expires_at: number
  used_at: number | null
  grant_id: string | null
}

/**
 * grant_type=authorization_code. The code is claimed first, atomically and
 * once (`UPDATE … WHERE used_at IS NULL`, in auth.db: a restart forgets
 * nothing), so a wrong verifier burns it; a used code presented again ends
 * the grant it issued. Then client_id, the exact redirect_uri and the
 * resource must be the code's, the verifier must hash to its S256
 * challenge, the session version must still be the one it was allowed under,
 * and the browser that allowed it must still be signed in. The grant is made
 * here, with its access and refresh token.
 */
export function exchangeCode(form: URLSearchParams, opts: { now?: number; onEvent?: OnAccessEvent } = {}): TokenAnswer {
  const now = opts.now ?? Date.now()
  const code = form.get('code')
  const verifier = form.get('code_verifier')
  const redirectUri = form.get('redirect_uri')
  const clientId = form.get('client_id')
  if (!code) return refuse('invalid_request', 'code is missing.')
  if (!clientId) return refuse('invalid_request', 'client_id is missing.')
  if (!redirectUri) return refuse('invalid_request', 'redirect_uri is missing.')
  if (!verifier) return refuse('invalid_request', 'code_verifier is missing: this site requires PKCE.')
  const canonical = canonicalResource()
  const key = tokenKey()
  if (!canonical || !key) return refuse('server_error', 'The server is not configured to issue tokens.', 503)
  const db = getAuthDb()
  const hash = tokenHash(code)
  const claimed = db.prepare('UPDATE ai_oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?').run(now, hash, now).changes > 0
  const row = db.prepare('SELECT * FROM ai_oauth_codes WHERE code_hash = ?').get(hash) as CodeRow | undefined
  if (!claimed) {
    if (row && row.used_at !== null && row.grant_id) {
      const issued = getGrant(row.grant_id)
      const ended = issued ? endGrant(issued, 'authorization code used twice', now) : undefined
      return { ...(refuse('invalid_grant', 'The authorization code was already used.') as Extract<TokenAnswer, { ok: false }>), ended }
    }
    return refuse('invalid_grant', row && row.used_at !== null ? 'The authorization code was already used.' : 'The authorization code is unknown or expired.')
  }
  const r = row as CodeRow
  if (r.client_id !== clientId) return refuse('invalid_grant', 'The code was issued to another client.')
  if (r.redirect_uri !== redirectUri) return refuse('invalid_grant', 'redirect_uri is not the one the code was issued for.')
  const resource = form.get('resource')
  if (resource !== null && !checkResource(resource, canonical).ok) return refuse('invalid_target', `The resource must be ${canonical}.`)
  if (r.resource !== canonical) return refuse('invalid_grant', 'The code was issued for another resource.')
  if (!VERIFIER_RE.test(verifier) || !sameText(pkceChallenge(verifier), r.code_challenge)) return refuse('invalid_grant', 'The code_verifier does not match the code’s challenge.')
  let version: number
  try {
    version = currentSessionVersion()
  } catch {
    return refuse('invalid_grant', 'The sign-in state cannot be read; connect again.')
  }
  if (Number(r.session_version) !== version) return refuse('invalid_grant', 'The owner signed out everywhere after allowing this; connect again.')
  const session = r.created_session ? liveSession(r.created_session, now) : null
  if (!session) return refuse('invalid_grant', 'The browser that allowed this is no longer signed in; connect again.')
  const scopes = r.scopes.split(' ').filter((s): s is Scope => (SCOPES as readonly string[]).includes(s))
  if (!scopes.length) return refuse('invalid_grant', 'The code grants nothing.')

  const id = `g${crypto.randomBytes(16).toString('base64url')}`
  const name = grantNameOf(r.client_id, r.redirect_uri)
  const expiresAt = now + OAUTH_GRANT_MS
  const pair = db.transaction(() => {
    db.prepare(
      `INSERT INTO ai_grants (id, kind, name, client_id, redirect_host, scopes, resource, session_version, created_session, created_device, created_at, expires_at)
       VALUES (?, 'oauth', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, name, r.client_id, new URL(r.redirect_uri).hostname, scopes.join(' '), r.resource, version, session.id, cleanLabelPart(session.device, 64) || null, now, expiresAt)
    db.prepare('UPDATE ai_oauth_codes SET grant_id = ? WHERE code_hash = ?').run(id, hash)
    return mintPair(id, expiresAt, now, key)
  })()
  const grant = getGrant(id) as Grant
  opts.onEvent?.({ type: 'grant-issued', grantId: id, label: name, kind: 'oauth' })
  return { ok: true, body: bodyOf(pair, grant.scopes), grant, created: true }
}

type TokenRow = { token_hash: string; grant_id: string; kind: string; expires_at: number; rotated_at: number | null }

/**
 * grant_type=refresh_token: rotates in the same response (the old one is
 * marked rotated, a new access and refresh token come back). A rotated
 * token presented again within 10 seconds is a concurrent refresh and only
 * refused; after that it is a copy in someone else's hands, and the grant
 * ends (`ended` tells the route to record and mail). Every refusal is
 * invalid_grant (RFC 6749 codes only), whatever the reason.
 */
export function refreshTokens(form: URLSearchParams, opts: { now?: number } = {}): TokenAnswer {
  const now = opts.now ?? Date.now()
  const token = form.get('refresh_token')
  if (!token) return refuse('invalid_request', 'refresh_token is missing.')
  const canonical = canonicalResource()
  const key = tokenKey()
  if (!canonical || !key) return refuse('server_error', 'The server is not configured to issue tokens.', 503)
  if (verifiedTokenKind(token, key) !== 'refresh') return refuse('invalid_grant', 'The refresh token is not valid.')
  const db = getAuthDb()
  const hash = tokenHash(token)
  const row = db.prepare("SELECT token_hash, grant_id, kind, expires_at, rotated_at FROM ai_tokens WHERE token_hash = ? AND kind = 'refresh'").get(hash) as TokenRow | undefined
  const grant = row ? getGrant(row.grant_id) : null
  if (!row || !grant || grant.kind !== 'oauth') return refuse('invalid_grant', 'The refresh token is not valid.')
  if (row.rotated_at !== null) {
    if (now - Number(row.rotated_at) <= REFRESH_REUSE_GRACE_MS) return refuse('invalid_grant', 'This refresh token was just exchanged; use the one that came back.')
    const ended = grant.revokedAt === null ? endGrant(grant, 'refresh token used twice', now) : undefined
    return { ...(refuse('invalid_grant', 'This refresh token was already exchanged. The connection has been ended; connect again.') as Extract<TokenAnswer, { ok: false }>), ended }
  }
  if (Number(row.expires_at) <= now) return refuse('invalid_grant', 'The refresh token expired; connect again.')
  if (grantProblem(grant, now)) return refuse('invalid_grant', 'This connection has ended; connect again.')
  if (grant.resource !== canonical) return refuse('invalid_grant', 'This connection was made for another address.')
  const clientId = form.get('client_id')
  if (clientId !== null && clientId !== grant.clientId) return refuse('invalid_grant', 'The refresh token was issued to another client.')
  const resource = form.get('resource')
  if (resource !== null && !checkResource(resource, canonical).ok) return refuse('invalid_target', `The resource must be ${canonical}.`)
  const scope = form.get('scope')
  if (scope !== null) {
    const asked = parseRequestedScope(scope)
    if (!asked.ok || asked.content.some((s) => !grant.scopes.includes(s))) return refuse('invalid_scope', 'A refresh cannot add permissions: connect again to change them.')
  }
  const pair = db.transaction(() => {
    if (db.prepare('UPDATE ai_tokens SET rotated_at = ? WHERE token_hash = ? AND rotated_at IS NULL').run(now, hash).changes === 0) return null
    return mintPair(grant.id, grant.expiresAt, now, key)
  })()
  if (!pair) return refuse('invalid_grant', 'This refresh token was just exchanged; use the one that came back.')
  pruneAccess(now)
  return { ok: true, body: bodyOf(pair, grant.scopes), grant, created: false }
}

/**
 * RFC 7009 revocation: an OAuth access or refresh token (tag checked first)
 * ends its whole grant — the app is disconnecting. A personal token is not
 * an OAuth client's and is left to Connections; a token another client_id
 * names is left alone. The endpoint answers 200 whatever happens here.
 */
export function revokeByToken(form: URLSearchParams, now = Date.now()): { ended: Grant | null } {
  const token = form.get('token')
  const key = tokenKey()
  const kind = token ? verifiedTokenKind(token, key) : null
  if (!token || (kind !== 'access' && kind !== 'refresh')) return { ended: null }
  const row = getAuthDb().prepare('SELECT grant_id FROM ai_tokens WHERE token_hash = ? AND kind = ?').get(tokenHash(token), kind) as { grant_id: string } | undefined
  const grant = row ? getGrant(row.grant_id) : null
  if (!grant || grant.kind !== 'oauth') return { ended: null }
  const clientId = form.get('client_id')
  if (clientId !== null && clientId !== grant.clientId) return { ended: null }
  return { ended: endGrant(grant, 'revoked by the app', now) ?? null }
}

/** Parse an x-www-form-urlencoded body; null when a parameter appears twice (RFC 6749 §3.2). */
export function parseForm(raw: string): URLSearchParams | null {
  const form = new URLSearchParams(raw)
  const seen = new Set<string>()
  for (const k of form.keys()) {
    if (seen.has(k)) return null
    seen.add(k)
  }
  return form
}
