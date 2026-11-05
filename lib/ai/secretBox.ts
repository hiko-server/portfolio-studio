import crypto from 'node:crypto'

/**
 * The owner's model provider keys at rest (SERVER-ONLY, design §7.4).
 *
 *   key   HKDF-SHA256(AI_KEYS_SECRET, salt "lucian-dev/ai-keys",
 *         info "provider-key-v1"), 32 bytes. A dedicated secret with no
 *         fallback to JWT_SECRET: every admin cookie is an offline oracle for
 *         that one, and rotating it would destroy the stored keys.
 *   seal  AES-256-GCM, a fresh 96-bit nonce per seal; stored as
 *         ciphertext || tag (key_cipher) and the nonce (key_nonce).
 *   AAD   "v1|<row id>|<preset>|<canonical base URL>": a key is sealed to
 *         its row and its URL. A database edit that points a row at another
 *         URL, or copies the ciphertext to another row, fails to open
 *         ("re-enter the key") instead of sending the key somewhere new.
 *
 * AI_KEYS_SECRET must decode (base64 or base64url) to exactly 32 random
 * bytes: `openssl rand -base64 32`. Unset, nothing can be stored. A rotated
 * secret opens nothing (every key reads "re-enter").
 *
 * Keys are opened per call; no plaintext key is cached. The honest limit:
 * this protects a stray copy of auth.db, nothing stronger — the server's
 * .env holds the secret, and scripts/deploy.sh backs both up together.
 */

export const KEY_ID = 1
const SALT = 'lucian-dev/ai-keys'
const INFO = 'provider-key-v1'
const NONCE_BYTES = 12
const TAG_BYTES = 16
/** Longest API key accepted: real ones are well under 1 KB. */
export const API_KEY_MAX = 4096

export type SecretStatus = { state: 'ready' } | { state: 'missing' } | { state: 'invalid'; reason: string }

/** Decode AI_KEYS_SECRET, or say why it cannot be used. Never returns or logs the value. */
function decodeSecret(raw: string | undefined): { ok: true; bytes: Buffer } | { ok: false; status: SecretStatus } {
  const text = (raw ?? '').trim()
  if (!text) return { ok: false, status: { state: 'missing' } }
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(text)) return { ok: false, status: { state: 'invalid', reason: 'not base64' } }
  const bytes = Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  if (bytes.length !== 32) return { ok: false, status: { state: 'invalid', reason: `decodes to ${bytes.length} bytes, not 32` } }
  // 32 random bytes nearly always hold 25 or more distinct values; a typed phrase or a repeated pattern does not.
  if (new Set(bytes).size < 16) return { ok: false, status: { state: 'invalid', reason: 'not random' } }
  return { ok: true, bytes }
}

export function aiKeysSecretStatus(raw: string | undefined = process.env.AI_KEYS_SECRET): SecretStatus {
  const d = decodeSecret(raw)
  return d.ok ? { state: 'ready' } : d.status
}

let cached: { raw: string; key: Buffer } | null = null

/** The AES key derived from AI_KEYS_SECRET, or null when it is missing or unusable. */
function sealKey(raw: string | undefined = process.env.AI_KEYS_SECRET): Buffer | null {
  const d = decodeSecret(raw)
  if (!d.ok) return null
  if (cached && cached.raw === raw) return cached.key
  const key = Buffer.from(crypto.hkdfSync('sha256', d.bytes, SALT, INFO, 32))
  cached = { raw: raw as string, key }
  return key
}

/**
 * The form of a base URL that goes into the AAD: lower-case scheme and host,
 * no default port, no trailing slash, no credentials, query or fragment.
 * Null for anything else. (Which URLs a provider may use at all is decided
 * where the owner enters one; this only makes one URL one string.)
 */
export function canonicalBaseUrl(raw: string): string | null {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  if (u.username || u.password || u.search || u.hash || /[?#]/.test(raw)) return null
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`
}

export type KeyRow = { id: string; preset: string; baseUrl: string }

function aadOf(row: KeyRow): Buffer {
  const url = canonicalBaseUrl(row.baseUrl)
  if (!url) throw new SecretBoxError('BAD_ROW', 'The base URL is not a usable URL')
  if (!/^p[A-Za-z0-9_-]{8,64}$/.test(row.id)) throw new SecretBoxError('BAD_ROW', 'Unexpected row id')
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(row.preset)) throw new SecretBoxError('BAD_ROW', 'Unexpected preset')
  return Buffer.from(`v1|${row.id}|${row.preset}|${url}`, 'utf8')
}

export class SecretBoxError extends Error {
  readonly code: 'NO_SECRET' | 'BAD_KEY' | 'BAD_ROW'
  constructor(code: SecretBoxError['code'], message: string) {
    super(message)
    this.name = 'SecretBoxError'
    this.code = code
  }
}

export type SealedKey = { cipher: Buffer; nonce: Buffer; kid: number; hint: string }

/** What the admin may see of a key: its last four characters (none for a short one). */
export function keyHint(apiKey: string): string {
  return apiKey.length >= 12 ? apiKey.slice(-4) : ''
}

/** Seal `apiKey` to `row`. Throws SecretBoxError (NO_SECRET, BAD_KEY, BAD_ROW); the key is never in the message. */
export function sealProviderKey(apiKey: string, row: KeyRow): SealedKey {
  const key = sealKey()
  if (!key) throw new SecretBoxError('NO_SECRET', 'AI_KEYS_SECRET is not set to 32 random bytes')
  const text = typeof apiKey === 'string' ? apiKey.trim() : ''
  if (!text || text.length > API_KEY_MAX || /[\s\u0000-\u001f\u007f]/.test(text)) throw new SecretBoxError('BAD_KEY', 'That does not look like an API key')
  const aad = aadOf(row)
  const nonce = crypto.randomBytes(NONCE_BYTES)
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce)
  c.setAAD(aad)
  const cipher = Buffer.concat([c.update(text, 'utf8'), c.final(), c.getAuthTag()])
  return { cipher, nonce, kid: KEY_ID, hint: keyHint(text) }
}

export type OpenedKey = { ok: true; apiKey: string } | { ok: false; reason: 'no-secret' | 'reenter' }

/**
 * Open a sealed key for one call. `reenter`: it was sealed under another
 * secret, to another row or URL, or the stored bytes were changed — the
 * owner has to type it again. `no-secret`: AI_KEYS_SECRET is unset or unusable.
 */
export function openProviderKey(sealed: { cipher: Buffer | Uint8Array | null; nonce: Buffer | Uint8Array | null; kid: number }, row: KeyRow): OpenedKey {
  const key = sealKey()
  if (!key) return { ok: false, reason: 'no-secret' }
  if (sealed.kid !== KEY_ID || !sealed.cipher || !sealed.nonce) return { ok: false, reason: 'reenter' }
  const cipher = Buffer.from(sealed.cipher)
  const nonce = Buffer.from(sealed.nonce)
  if (nonce.length !== NONCE_BYTES || cipher.length <= TAG_BYTES) return { ok: false, reason: 'reenter' }
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, nonce)
    d.setAAD(aadOf(row))
    d.setAuthTag(cipher.subarray(cipher.length - TAG_BYTES))
    const apiKey = Buffer.concat([d.update(cipher.subarray(0, cipher.length - TAG_BYTES)), d.final()]).toString('utf8')
    return { ok: true, apiKey }
  } catch {
    return { ok: false, reason: 'reenter' }
  }
}
