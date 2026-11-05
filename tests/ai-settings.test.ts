/**
 * The AI switches (design §5.2): read from auth.db on every call, AI_DISABLED
 * first, unreadable is off, SITE_URL required for the public paths; settings
 * changes loosen only behind a step-up; the pairing window; local provider
 * origins honoured only while local-only; what System health says.
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scrubAiEnv } from './editorialHarness'

const prevCwd = process.cwd()
let tmp = ''
const saved = { SITE_URL: process.env.SITE_URL, NEXT_PUBLIC_SITE_HOST: process.env.NEXT_PUBLIC_SITE_HOST }

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-settings-'))
  process.chdir(tmp)
})
after(async () => {
  const { closeAuthDb } = await import('../lib/adminAuth/db')
  closeAuthDb()
  scrubAiEnv()
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  process.chdir(prevCwd)
  fs.rmSync(tmp, { recursive: true, force: true })
})
beforeEach(async () => {
  scrubAiEnv()
  process.env.SITE_URL = 'http://127.0.0.1:3002'
  delete process.env.NEXT_PUBLIC_SITE_HOST
  const { getAuthDb } = await import('../lib/adminAuth/db')
  getAuthDb()
    .prepare(
      `UPDATE ai_settings SET enabled = 0, mcp_enabled = 0, auto_apply_drafts = 1, keep_conversations_days = 90, daily_token_limit = 2000000,
       pairing_id = NULL, pairing_app = NULL, pairing_opened_at = NULL, pairing_expires_at = NULL, changed_at = 0 WHERE id = 1`,
    )
    .run()
})

const setRow = async (sql: string) => (await import('../lib/adminAuth/db')).getAuthDb().prepare(`UPDATE ai_settings SET ${sql} WHERE id = 1`).run()

test('off by default; on only with the master switch; the public paths also need connected apps and SITE_URL', async () => {
  const { aiAccess, aiPublicOpen, aiPublicState } = await import('../lib/ai/settings')
  assert.deepEqual(aiAccess(), { on: false, reason: 'off' })
  assert.deepEqual(aiPublicState(), { open: false, reason: 'off' })
  await setRow('enabled = 1')
  const on = aiAccess()
  assert.equal(on.on, true)
  assert.deepEqual(aiPublicState(), { open: false, reason: 'apps-off' })
  await setRow('mcp_enabled = 1')
  assert.deepEqual(aiPublicState(), { open: true })
  assert.equal(aiPublicOpen(), true)
  delete process.env.SITE_URL
  assert.deepEqual(aiPublicState(), { open: false, reason: 'no-site-url' })
  process.env.SITE_URL = '   '
  assert.equal(aiPublicOpen(), false)
  process.env.SITE_URL = 'https://site.example'
  assert.equal(aiPublicOpen(), true, 'a public SITE_URL is a configured one')
  // Uncached: a change in auth.db is seen by the very next call.
  await setRow('enabled = 0')
  assert.equal(aiPublicOpen(), false)
})

test('AI_DISABLED beats everything; only an explicit "no" leaves it on', async () => {
  const { aiAccess, aiDisabledByEnv, aiPublicOpen } = await import('../lib/ai/settings')
  await setRow('enabled = 1, mcp_enabled = 1')
  for (const v of ['1', 'true', 'yes', 'ON', 'anything']) {
    process.env.AI_DISABLED = v
    assert.deepEqual(aiAccess(), { on: false, reason: 'env' }, v)
    assert.equal(aiPublicOpen(), false, v)
  }
  for (const v of ['', '0', 'false', 'no', 'off', ' OFF ']) {
    process.env.AI_DISABLED = v
    assert.equal(aiDisabledByEnv(), false, JSON.stringify(v))
    assert.equal(aiAccess().on, true, JSON.stringify(v))
  }
})

test('an unreadable auth.db counts as off, and AI_DISABLED still answers without it', async () => {
  const { closeAuthDb, authDbPath } = await import('../lib/adminAuth/db')
  const { aiAccess, aiPublicOpen } = await import('../lib/ai/settings')
  await setRow('enabled = 1, mcp_enabled = 1')
  closeAuthDb()
  const file = authDbPath()
  const aside = `${file}.aside`
  fs.renameSync(file, aside)
  fs.mkdirSync(file) // a directory where the database should be: SQLite cannot open it
  try {
    assert.deepEqual(aiAccess(), { on: false, reason: 'unreadable' })
    assert.equal(aiPublicOpen(), false)
    process.env.AI_DISABLED = '1'
    assert.deepEqual(aiAccess(), { on: false, reason: 'env' })
  } finally {
    fs.rmdirSync(file)
    fs.renameSync(aside, file)
  }
  delete process.env.AI_DISABLED
  assert.equal(aiPublicOpen(), true)
})

test('loosening needs the step-up, tightening never does; nothing is written on a refusal', async () => {
  const { readAiSettings, writeAiSettings, looseningFields, DAILY_TOKEN_LIMIT_CEILING } = await import('../lib/ai/settings')
  const loosen: Array<[Record<string, unknown>, string]> = [
    [{ enabled: true }, 'enabled'],
    [{ mcpEnabled: true }, 'mcpEnabled'],
    [{ dailyTokenLimit: 2_000_001 }, 'dailyTokenLimit'],
    [{ keepConversationsDays: 365 }, 'keepConversationsDays'],
    [{ keepConversationsDays: -1 }, 'keepConversationsDays'],
  ]
  for (const [patch, field] of loosen) {
    const before = readAiSettings()
    const r = writeAiSettings(patch, { steppedUp: false, now: 1000 })
    assert.deepEqual(r, { ok: false, code: 'STEP_UP_REQUIRED', fields: [field] }, JSON.stringify(patch))
    assert.deepEqual(readAiSettings(), before, 'nothing written')
  }
  // Tightening: no step-up.
  const tight = writeAiSettings({ autoApplyDrafts: false, keepConversationsDays: 7, dailyTokenLimit: 100_000 }, { steppedUp: false, now: 2000 })
  assert.equal(tight.ok, true)
  assert.deepEqual(tight.ok && tight.loosened, [])
  const now = readAiSettings()
  assert.deepEqual([now.autoApplyDrafts, now.keepConversationsDays, now.dailyTokenLimit, now.changedAt], [false, 7, 100_000, 2000])
  // Retention order: don't keep (0) < days < until deleted (-1).
  assert.deepEqual(looseningFields({ ...now, keepConversationsDays: 0 }, { keepConversationsDays: 1 }), ['keepConversationsDays'])
  assert.deepEqual(looseningFields({ ...now, keepConversationsDays: -1 }, { keepConversationsDays: 3650 }), [])
  assert.deepEqual(looseningFields({ ...now, keepConversationsDays: 30 }, { keepConversationsDays: 0 }), [])
  assert.deepEqual(looseningFields({ ...now, autoApplyDrafts: false }, { autoApplyDrafts: true }), ['autoApplyDrafts'])
  // Mixed: one loosening field refuses the whole change.
  const mixed = writeAiSettings({ dailyTokenLimit: 50_000, enabled: true }, { steppedUp: false })
  assert.deepEqual(mixed, { ok: false, code: 'STEP_UP_REQUIRED', fields: ['enabled'] })
  assert.equal(readAiSettings().dailyTokenLimit, 100_000)
  // With the step-up: written, and reported as loosened (for the audit and the mail).
  const on = writeAiSettings({ enabled: true, mcpEnabled: true }, { steppedUp: true, now: 3000 })
  assert.equal(on.ok, true)
  assert.deepEqual(on.ok && on.loosened, ['enabled', 'mcpEnabled'])
  assert.equal(on.ok && on.before.enabled, false)
  // Turning off is instant.
  assert.equal(writeAiSettings({ enabled: false }, { steppedUp: false }).ok, true)
  assert.equal(readAiSettings().enabled, false)
  // The code ceiling holds even with a step-up, and the row can never read above it.
  assert.deepEqual(writeAiSettings({ dailyTokenLimit: DAILY_TOKEN_LIMIT_CEILING + 1 }, { steppedUp: true }), { ok: false, code: 'INVALID', field: 'dailyTokenLimit' })
  await setRow(`daily_token_limit = ${DAILY_TOKEN_LIMIT_CEILING * 5}`)
  assert.equal(readAiSettings().dailyTokenLimit, DAILY_TOKEN_LIMIT_CEILING)
})

test('a settings patch has known keys of the right type only', async () => {
  const { parseSettingsPatch } = await import('../lib/ai/settings')
  for (const [input, field] of [
    [null, '(body)'],
    [[], '(body)'],
    [{ enabled: 'yes' }, 'enabled'],
    [{ keepConversationsDays: 1.5 }, 'keepConversationsDays'],
    [{ keepConversationsDays: -2 }, 'keepConversationsDays'],
    [{ keepConversationsDays: 3651 }, 'keepConversationsDays'],
    [{ dailyTokenLimit: -1 }, 'dailyTokenLimit'],
    [{ defaultProviderId: 'p1' }, 'defaultProviderId'],
    [{ pairing_id: 'x' }, 'pairing_id'],
    [JSON.parse('{"__proto__": {"enabled": true}}'), '__proto__'],
  ] as const) {
    assert.deepEqual(parseSettingsPatch(input), { ok: false, field }, JSON.stringify(input))
  }
  assert.deepEqual(parseSettingsPatch({ enabled: false, keepConversationsDays: 0 }), { ok: true, patch: { enabled: false, keepConversationsDays: 0 } })
})

test('the pairing window: opened behind a step-up for one app, ten minutes, closed freely or by its own id', async () => {
  const { closePairingWindow, currentPairing, openPairingWindow, PAIRING_WINDOW_MS } = await import('../lib/ai/settings')
  assert.equal(currentPairing(), null)
  assert.deepEqual(openPairingWindow('claude-code', { steppedUp: false }), { ok: false, code: 'STEP_UP_REQUIRED' })
  assert.deepEqual(openPairingWindow('evil-app', { steppedUp: true }), { ok: false, code: 'INVALID' })
  assert.equal(currentPairing(), null)
  const t0 = 1_800_000_000_000
  const opened = openPairingWindow('claude-code', { steppedUp: true, now: t0 })
  assert.ok(opened.ok)
  const p = opened.ok ? opened.pairing : null
  assert.match(p?.id ?? '', /^pw_[A-Za-z0-9_-]{22}$/)
  assert.deepEqual(currentPairing(t0 + 1), p)
  assert.equal(currentPairing(t0 + PAIRING_WINDOW_MS), null, 'expired at ten minutes')
  // Another window replaces it; closing the old one by id does nothing.
  const second = openPairingWindow('cursor', { steppedUp: true, now: t0 + 1000 })
  assert.ok(second.ok)
  assert.equal(closePairingWindow({ expectedId: p!.id }), false)
  assert.equal(currentPairing(t0 + 2000)?.app, 'cursor')
  assert.equal(closePairingWindow({ expectedId: second.ok ? second.pairing.id : '' }), true)
  assert.equal(currentPairing(t0 + 2000), null)
  assert.equal(closePairingWindow(), false, 'nothing left to close')
})

test('local provider origins: exact origins, honoured only while the site is local-only', async () => {
  const { localProviderOrigins } = await import('../lib/ai/settings')
  const env = { AI_LOCAL_PROVIDER_ORIGINS: 'http://127.0.0.1:11434, http://localhost:1234 http://127.0.0.1:11434 http://127.0.0.1:8000/v1 bogus' } as unknown as NodeJS.ProcessEnv
  assert.deepEqual(localProviderOrigins(env), ['http://127.0.0.1:11434', 'http://localhost:1234'])
  process.env.SITE_URL = 'https://site.example'
  assert.deepEqual(localProviderOrigins(env), [], 'a public host: ignored')
  process.env.SITE_URL = 'http://127.0.0.1:3002'
  process.env.NEXT_PUBLIC_SITE_HOST = 'site.example'
  assert.deepEqual(localProviderOrigins(env), [])
  delete process.env.NEXT_PUBLIC_SITE_HOST
  delete process.env.SITE_URL
  assert.deepEqual(localProviderOrigins(env), [], 'no SITE_URL is not local')
})

test('System health says why: local origins with a public host, an unusable key secret, apps on without SITE_URL', async () => {
  const { aiHealthWarnings } = await import('../lib/ai/health')
  assert.deepEqual(aiHealthWarnings(), [])
  process.env.AI_LOCAL_PROVIDER_ORIGINS = 'http://127.0.0.1:11434'
  assert.deepEqual(aiHealthWarnings(), [], 'local-only: fine')
  process.env.SITE_URL = 'https://site.example'
  assert.deepEqual(aiHealthWarnings(), ['AI_LOCAL_PROVIDER_ORIGINS is set, but this site has a public host: local model providers are ignored.'])
  delete process.env.AI_LOCAL_PROVIDER_ORIGINS
  process.env.AI_KEYS_SECRET = 'SENTINEL not a key!'
  const w = aiHealthWarnings()
  assert.equal(w.length, 1)
  assert.match(w[0], /^AI_KEYS_SECRET is set but unusable \(not base64\)/)
  assert.doesNotMatch(w.join(' '), /SENTINEL/)
  delete process.env.AI_KEYS_SECRET
  await setRow('enabled = 1, mcp_enabled = 1')
  delete process.env.SITE_URL
  assert.deepEqual(aiHealthWarnings(), ['Connected apps are allowed, but SITE_URL is not set: /mcp stays closed until it is.'])
})
