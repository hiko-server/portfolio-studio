/**
 * Provider keys at rest (design §7.4, tests/ai-secretbox of §12.1): sealed
 * with AES-256-GCM under a key derived from AI_KEYS_SECRET only, bound to
 * the row id, preset and canonical base URL; a rotated secret, another row
 * or another URL reads "re-enter"; the key never appears in an error, a log
 * line or the stored bytes. (The request-shape rules — a stored key never
 * goes to a request-supplied URL, a custom URL with a typed key needs a
 * step-up — belong to the provider routes of stage M4 and are tested there.)
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scrubAiEnv } from './editorialHarness'

const SENTINEL_KEY = 'sk-test-SENTINEL-0123456789abcdefSECRETBOX'
const prevCwd = process.cwd()
let tmp = ''
const randomSecret = () => crypto.randomBytes(32).toString('base64')

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-secretbox-'))
  process.chdir(tmp)
})
after(async () => {
  const { closeAuthDb } = await import('../lib/adminAuth/db')
  closeAuthDb()
  scrubAiEnv()
  process.chdir(prevCwd)
  fs.rmSync(tmp, { recursive: true, force: true })
})

const row = { id: 'p_example0001', preset: 'deepseek', baseUrl: 'https://api.deepseek.com' }

/** Run `fn` with console output captured; returns everything written. */
async function captured(fn: () => unknown | Promise<unknown>): Promise<string> {
  const lines: string[] = []
  const saved = { log: console.log, error: console.error, warn: console.warn, info: console.info }
  const sink = (...args: unknown[]) => lines.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
  Object.assign(console, { log: sink, error: sink, warn: sink, info: sink })
  try {
    await fn()
  } finally {
    Object.assign(console, saved)
  }
  return lines.join('\n')
}

test('AI_KEYS_SECRET: missing, unusable or ready — and the reason never quotes the value', async () => {
  const { aiKeysSecretStatus } = await import('../lib/ai/secretBox')
  assert.deepEqual(aiKeysSecretStatus(undefined), { state: 'missing' })
  assert.deepEqual(aiKeysSecretStatus('   '), { state: 'missing' })
  assert.deepEqual(aiKeysSecretStatus('not base64 at all!'), { state: 'invalid', reason: 'not base64' })
  assert.deepEqual(aiKeysSecretStatus(crypto.randomBytes(16).toString('base64')), { state: 'invalid', reason: 'decodes to 16 bytes, not 32' })
  assert.deepEqual(aiKeysSecretStatus(Buffer.alloc(32).toString('base64')), { state: 'invalid', reason: 'not random' })
  assert.deepEqual(aiKeysSecretStatus(Buffer.from('ab'.repeat(16)).toString('base64')), { state: 'invalid', reason: 'not random' })
  const bytes = crypto.randomBytes(32)
  assert.deepEqual(aiKeysSecretStatus(bytes.toString('base64')), { state: 'ready' })
  assert.deepEqual(aiKeysSecretStatus(bytes.toString('base64url')), { state: 'ready' }, 'base64url without padding')
  assert.deepEqual(aiKeysSecretStatus(` ${bytes.toString('base64')}\n`), { state: 'ready' })
})

test('round trip: sealed to its row, a fresh nonce each time, the plaintext nowhere in what is stored', async () => {
  const { openProviderKey, sealProviderKey, KEY_ID } = await import('../lib/ai/secretBox')
  process.env.AI_KEYS_SECRET = randomSecret()
  const a = sealProviderKey(SENTINEL_KEY, row)
  const b = sealProviderKey(SENTINEL_KEY, row)
  assert.equal(a.kid, KEY_ID)
  assert.equal(a.nonce.length, 12)
  assert.notDeepEqual(a.nonce, b.nonce)
  assert.notDeepEqual(a.cipher, b.cipher)
  assert.equal(a.hint, 'TBOX', 'the last four characters only')
  for (const blob of [a.cipher, a.nonce]) assert.equal(blob.includes(Buffer.from('SENTINEL')), false)
  assert.equal(JSON.stringify(a).includes('SENTINEL'), false)
  assert.deepEqual(openProviderKey(a, row), { ok: true, apiKey: SENTINEL_KEY })
  assert.deepEqual(openProviderKey(b, row), { ok: true, apiKey: SENTINEL_KEY })
  // Surrounding whitespace from a paste is dropped before sealing.
  assert.deepEqual(openProviderKey(sealProviderKey(`  ${SENTINEL_KEY}\n`, row), row), { ok: true, apiKey: SENTINEL_KEY })
})

test('the AAD binds row, preset and URL: any other one reads "re-enter"; one URL has one spelling', async () => {
  const { openProviderKey, sealProviderKey } = await import('../lib/ai/secretBox')
  process.env.AI_KEYS_SECRET = randomSecret()
  const sealed = sealProviderKey(SENTINEL_KEY, { ...row, baseUrl: 'https://api.example.com/v1' })
  const base = { ...row, baseUrl: 'https://api.example.com/v1' }
  assert.equal(openProviderKey(sealed, base).ok, true)
  // The same URL written differently opens.
  for (const same of ['https://API.Example.com/v1/', 'https://api.example.com:443/v1', ' https://api.example.com/v1// ']) {
    assert.equal(openProviderKey(sealed, { ...base, baseUrl: same }).ok, true, same)
  }
  // Another URL (a DB edit pointing the key elsewhere), row or preset does not.
  for (const other of [
    { ...base, baseUrl: 'https://attacker.example/v1' },
    { ...base, baseUrl: 'https://api.example.com/v2' },
    { ...base, baseUrl: 'http://api.example.com/v1' },
    { ...base, baseUrl: 'https://api.example.com:8443/v1' },
    { ...base, id: 'p_example0002' },
    { ...base, preset: 'custom' },
  ]) {
    assert.deepEqual(openProviderKey(sealed, other), { ok: false, reason: 'reenter' }, JSON.stringify(other))
  }
  // Tampered bytes, a swapped nonce, an unknown key id.
  const flipped = Buffer.from(sealed.cipher)
  flipped[0] ^= 1
  assert.deepEqual(openProviderKey({ ...sealed, cipher: flipped }, base), { ok: false, reason: 'reenter' })
  assert.deepEqual(openProviderKey({ ...sealed, nonce: crypto.randomBytes(12) }, base), { ok: false, reason: 'reenter' })
  assert.deepEqual(openProviderKey({ ...sealed, kid: 2 }, base), { ok: false, reason: 'reenter' })
  assert.deepEqual(openProviderKey({ ...sealed, cipher: null }, base), { ok: false, reason: 'reenter' })
  assert.deepEqual(openProviderKey({ ...sealed, cipher: sealed.cipher.subarray(0, 10) }, base), { ok: false, reason: 'reenter' })
})

test('a rotated secret opens nothing (re-enter); restoring it opens again; there is no JWT_SECRET fallback', async () => {
  const { openProviderKey, sealProviderKey, SecretBoxError } = await import('../lib/ai/secretBox')
  const first = randomSecret()
  process.env.AI_KEYS_SECRET = first
  const sealed = sealProviderKey(SENTINEL_KEY, row)
  process.env.AI_KEYS_SECRET = randomSecret()
  assert.deepEqual(openProviderKey(sealed, row), { ok: false, reason: 'reenter' })
  process.env.AI_KEYS_SECRET = first
  assert.equal(openProviderKey(sealed, row).ok, true)

  delete process.env.AI_KEYS_SECRET
  process.env.JWT_SECRET = 'ai-secretbox-jwt-secret-0123456789abcdef0123456789'
  assert.deepEqual(openProviderKey(sealed, row), { ok: false, reason: 'no-secret' })
  assert.throws(() => sealProviderKey(SENTINEL_KEY, row), (e: unknown) => e instanceof SecretBoxError && e.code === 'NO_SECRET')
  process.env.AI_KEYS_SECRET = Buffer.alloc(32, 7).toString('base64')
  assert.deepEqual(openProviderKey(sealed, row), { ok: false, reason: 'no-secret' }, 'an unusable secret is no secret')
  delete process.env.JWT_SECRET
})

test('bad input is refused without echoing the key', async () => {
  const { sealProviderKey, SecretBoxError, keyHint } = await import('../lib/ai/secretBox')
  process.env.AI_KEYS_SECRET = randomSecret()
  const refusals: Array<[string, typeof row, string]> = [
    ['', row, 'BAD_KEY'],
    [`${SENTINEL_KEY} extra`, row, 'BAD_KEY'],
    [`${SENTINEL_KEY}\u0000`, row, 'BAD_KEY'],
    ['x'.repeat(5000), row, 'BAD_KEY'],
    [SENTINEL_KEY, { ...row, baseUrl: 'not a url' }, 'BAD_ROW'],
    [SENTINEL_KEY, { ...row, baseUrl: 'https://u:p@api.example.com' }, 'BAD_ROW'],
    [SENTINEL_KEY, { ...row, baseUrl: 'https://api.example.com/?k=v' }, 'BAD_ROW'],
    [SENTINEL_KEY, { ...row, id: 'p|evil' }, 'BAD_ROW'],
    [SENTINEL_KEY, { ...row, preset: 'Deep|Seek' }, 'BAD_ROW'],
  ]
  for (const [key, r, code] of refusals) {
    let caught: unknown = null
    try {
      sealProviderKey(key, r)
    } catch (e) {
      caught = e
    }
    assert.ok(caught instanceof SecretBoxError, `${code} for ${JSON.stringify(r)}`)
    assert.equal((caught as InstanceType<typeof SecretBoxError>).code, code)
    assert.doesNotMatch(`${(caught as Error).message}\n${(caught as Error).stack}`, /SENTINEL/)
  }
  assert.equal(keyHint(SENTINEL_KEY), 'TBOX')
  assert.equal(keyHint('short-key'), '', 'a short key shows no hint')
})

test('stored in auth.db ai_provider_keys and read back, the key opens; nothing about it reaches the console', async () => {
  const { getAuthDb } = await import('../lib/adminAuth/db')
  const { openProviderKey, sealProviderKey } = await import('../lib/ai/secretBox')
  process.env.AI_KEYS_SECRET = randomSecret()
  const out = await captured(() => {
    const sealed = sealProviderKey(SENTINEL_KEY, row)
    getAuthDb()
      .prepare(
        `INSERT INTO ai_provider_keys (id, preset, label, wire, base_url, key_cipher, key_nonce, key_kid, key_hint, created_at, updated_at)
         VALUES (?, ?, 'DeepSeek', 'chat', ?, ?, ?, ?, ?, 1, 1)`,
      )
      .run(row.id, row.preset, row.baseUrl, sealed.cipher, sealed.nonce, sealed.kid, sealed.hint)
    const stored = getAuthDb().prepare('SELECT * FROM ai_provider_keys WHERE id = ?').get(row.id) as { key_cipher: Buffer; key_nonce: Buffer; key_kid: number; base_url: string }
    assert.deepEqual(openProviderKey({ cipher: stored.key_cipher, nonce: stored.key_nonce, kid: stored.key_kid }, { ...row, baseUrl: stored.base_url }), { ok: true, apiKey: SENTINEL_KEY })
    // A hand edit of the stored URL makes it unopenable (§13 check 10).
    getAuthDb().prepare("UPDATE ai_provider_keys SET base_url = 'https://collector.example' WHERE id = ?").run(row.id)
    const edited = getAuthDb().prepare('SELECT * FROM ai_provider_keys WHERE id = ?').get(row.id) as { key_cipher: Buffer; key_nonce: Buffer; key_kid: number; base_url: string }
    assert.deepEqual(openProviderKey({ cipher: edited.key_cipher, nonce: edited.key_nonce, kid: edited.key_kid }, { ...row, baseUrl: edited.base_url }), { ok: false, reason: 'reenter' })
    // The raw database file holds no plaintext key.
    const files = fs.readdirSync(path.join(tmp, 'data')).filter((f) => f.startsWith('auth.db'))
    for (const f of files) assert.equal(fs.readFileSync(path.join(tmp, 'data', f)).includes(Buffer.from('SENTINEL')), false, f)
  })
  assert.doesNotMatch(out, /SENTINEL/)
})
