/**
 * Owner notices (lib/ops/alerts, lib/ops/push, lib/ops/watch): the push
 * requests each channel gets, the daily limits, the texts (no address, no
 * message body, no secret), the disk rule and the proposal check — and the
 * places that report: backups, restore drills, new server errors.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuredChannels, pushRequests, pushToOwner, type PushRequest } from '../lib/ops/push'
import { notifyStatusLine, testResultLine } from '../components/Admin/system/notifyFormat'

const prevCwd = process.cwd()
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-alerts-'))
let alerts: typeof import('../lib/ops/alerts')
let watch: typeof import('../lib/ops/watch')
let aiDb: typeof import('../lib/ai/db')
let analytics: typeof import('../lib/analytics/db')

before(async () => {
  process.chdir(tmp)
  for (const k of Object.keys(process.env)) if (k.startsWith('NOTIFY_') || k.startsWith('SMTP_')) delete process.env[k]
  alerts = await import('../lib/ops/alerts')
  watch = await import('../lib/ops/watch')
  aiDb = await import('../lib/ai/db')
  analytics = await import('../lib/analytics/db')
})

after(() => {
  process.chdir(prevCwd)
  fs.rmSync(tmp, { recursive: true, force: true })
})

const ENV = {
  NOTIFY_NTFY_URL: 'https://ntfy.example/site-alerts',
  NOTIFY_NTFY_TOKEN: 'tk_secret',
  NOTIFY_TELEGRAM_BOT_TOKEN: '123:abc',
  NOTIFY_TELEGRAM_CHAT_ID: '42',
  NOTIFY_BARK_URL: 'https://bark.example/devicekey/',
  NOTIFY_WEBHOOK_URL: 'https://hooks.example/T000/B000',
}

const MSG = { title: 'Scheduled backup failed', text: 'disk full', url: 'https://marble-owl.example/admin/system', priority: 'high' as const, kind: 'backup-failed' }

test('channels: each needs its own settings, HTTPS only; a topic-less ntfy URL does not count', () => {
  assert.deepEqual(configuredChannels({}), [])
  assert.deepEqual(configuredChannels(ENV), ['ntfy', 'telegram', 'bark', 'webhook'])
  assert.deepEqual(configuredChannels({ NOTIFY_NTFY_URL: 'http://ntfy.example/t' }), [])
  assert.deepEqual(configuredChannels({ NOTIFY_NTFY_URL: 'https://ntfy.example/' }), [])
  assert.deepEqual(configuredChannels({ NOTIFY_TELEGRAM_BOT_TOKEN: 'x' }), [])
  assert.deepEqual(configuredChannels({ NOTIFY_WEBHOOK_URL: 'not a url' }), [])
})

test('push requests: ntfy JSON with topic and priority, Telegram text, Bark JSON, a Slack/Discord-ready webhook', () => {
  const reqs = pushRequests(MSG, ENV, 'Portfolio')
  const by = Object.fromEntries(reqs.map((r) => [r.channel, r])) as Record<string, PushRequest>
  assert.equal(by.ntfy.url, 'https://ntfy.example/')
  assert.equal(by.ntfy.headers.Authorization, 'Bearer tk_secret')
  assert.deepEqual(JSON.parse(by.ntfy.body), { topic: 'site-alerts', title: MSG.title, message: 'disk full', priority: 4, tags: ['backup-failed'], click: MSG.url })
  assert.equal(by.telegram.url, 'https://api.telegram.org/bot123:abc/sendMessage')
  assert.deepEqual(JSON.parse(by.telegram.body), { chat_id: '42', text: `${MSG.title}\n\ndisk full\n\n${MSG.url}`, disable_web_page_preview: true })
  assert.equal(by.bark.url, 'https://bark.example/devicekey')
  assert.deepEqual(JSON.parse(by.bark.body), { title: MSG.title, body: 'disk full', group: 'Portfolio', url: MSG.url, level: 'timeSensitive' })
  const hook = JSON.parse(by.webhook.body)
  assert.equal(hook.kind, 'backup-failed')
  assert.equal(hook.text, `${MSG.title}\ndisk full\n${MSG.url}`)
  assert.equal(hook.content, hook.text)
  // A default-priority notice: ntfy 3, no Bark time-sensitive level.
  const calm = pushRequests({ ...MSG, priority: 'default' }, ENV)
  assert.equal(JSON.parse(calm.find((r) => r.channel === 'ntfy')!.body).priority, 3)
  assert.equal(JSON.parse(calm.find((r) => r.channel === 'bark')!.body).level, undefined)
})

test('pushToOwner reports each channel and never throws; failures are logged without the URL', async () => {
  const seen: string[] = []
  const result = await pushToOwner(MSG, {
    env: ENV,
    send: async (r) => {
      seen.push(r.channel)
      if (r.channel === 'bark') throw Object.assign(new Error('nope'), { code: 'TIMEOUT' })
      return { status: r.channel === 'webhook' ? 500 : 200 }
    },
  })
  assert.deepEqual(seen.sort(), ['bark', 'ntfy', 'telegram', 'webhook'])
  assert.deepEqual(
    result.map((r) => [r.channel, r.ok, r.status ?? r.error]),
    [
      ['ntfy', true, 200],
      ['telegram', true, 200],
      ['bark', false, 'TIMEOUT'],
      ['webhook', false, 500],
    ],
  )
  assert.deepEqual(await pushToOwner(MSG, { env: {}, send: async () => assert.fail('nothing configured') }), [])
})

test('texts carry names and reasons only: no visitor address, no message body', () => {
  const contact = alerts.opsAlertText({ type: 'contact', from: 'Ada Lovelace', subject: 'Role at Example' })
  assert.equal(contact.title, 'New message from Ada Lovelace')
  assert.match(contact.text, /Role at Example/)
  const long = alerts.opsAlertText({ type: 'server-error', fingerprint: 'f', name: 'TypeError', message: 'x'.repeat(500), where: '/api/home' })
  assert.ok(long.text.length < 300, long.text)
  assert.match(long.text, /\(\/api\/home\)/)
  for (const type of Object.keys(alerts.OPS_POLICY) as Array<keyof typeof alerts.OPS_POLICY>) {
    const p = alerts.OPS_POLICY[type]
    assert.ok(p.path.startsWith('/admin'), type)
    assert.ok(p.perDay >= 1, type)
  }
  // The contact route mails the message itself; the notice only adds the push.
  assert.equal(alerts.OPS_POLICY.contact.mail, false)
})

test('limits: one notice per kind and subject a UTC day, within a daily cap per kind; a new day starts again', () => {
  const t = Date.UTC(2026, 10, 8, 3)
  assert.equal(alerts.claimOpsAlert('backup-failed', 'site', t), true)
  assert.equal(alerts.claimOpsAlert('backup-failed', 'site', t + 1000), false)
  assert.equal(alerts.claimOpsAlert('backup-failed', 'site', t + 86_400_000), true)
  // Server errors: per fingerprint, at most 5 a day.
  const day = Date.UTC(2026, 10, 9, 3)
  for (let i = 0; i < 5; i++) assert.equal(alerts.claimOpsAlert('server-error', `fp${i}`, day), true, `fp${i}`)
  assert.equal(alerts.claimOpsAlert('server-error', 'fp0', day), false)
  assert.equal(alerts.claimOpsAlert('server-error', 'fp9', day), false)
  // Claims older than three days are pruned (once a day per process).
  alerts.claimOpsAlert('disk-low', 'site', Date.UTC(2026, 10, 20))
  const keys = (analytics.getAnalyticsDb().prepare(`SELECT key FROM meta WHERE key LIKE 'ops|%'`).all() as Array<{ key: string }>).map((r) => r.key)
  assert.ok(keys.length > 0)
  assert.ok(keys.every((k) => k >= 'ops|2026-11-17'), keys.join(', '))
})

test('opsAlert never throws, even when nothing is configured', () => {
  assert.doesNotThrow(() => alerts.opsAlert({ type: 'test' }))
  assert.doesNotThrow(() => alerts.opsAlert({ type: 'disk-low', freeGb: 0.5, freePct: 3 }))
})

test('disk rule: under 10 % or 1 GB free', () => {
  const GB = 1024 ** 3
  assert.equal(watch.diskAlert(null), null)
  assert.equal(watch.diskAlert({ path: '/', freeBytes: 50 * GB, totalBytes: 100 * GB, usedPct: 50 }), null)
  assert.deepEqual(watch.diskAlert({ path: '/', freeBytes: 5 * GB, totalBytes: 100 * GB, usedPct: 95 }), { freeGb: 5, freePct: 5 })
  assert.ok(watch.diskAlert({ path: '/', freeBytes: 0.5 * GB, totalBytes: 4 * GB, usedPct: 87.5 }))
})

test('proposal check: only waiting changes of connected apps, created after the cursor', () => {
  const db = aiDb.getAiDb()
  const insert = (id: string, actorKind: string, createdAt: number, state = 'waiting') =>
    db
      .prepare(
        `INSERT INTO ai_changes (id, state, risk, tool, kind, actor_kind, actor_id, actor_label, issuer_version, target_kind, target_ref, title, args_sha256, preview_sha256, created_at, expires_at)
         VALUES (?, ?, 'live', 'propose_publishing', 'publish', ?, 'g1', 'Claude', 1, 'blog', 'hello', ?, 'a', 'p', ?, ?)`,
      )
      .run(id, state, actorKind, `Publish ${id}`, createdAt, createdAt + 7 * 86_400_000)
  const t = Date.UTC(2026, 10, 8, 12)
  insert('c-old', 'mcp', t - 60_000)
  insert('c-mcp', 'mcp', t + 1000)
  insert('c-assistant', 'assistant', t + 2000)
  insert('c-applied', 'mcp', t + 3000, 'applied')
  assert.deepEqual(
    watch.newWaitingChanges(t, t + 10_000).map((c) => c.id),
    ['c-mcp'],
  )
  watch.setChangeCheckCursor(t)
  assert.doesNotThrow(() => watch.runChangeCheck(t + 10_000))
  // The cursor moved past what was announced.
  assert.deepEqual(watch.newWaitingChanges(t + 1000, t + 10_000), [])
})

test('the admin card: what is set up, and how a test went', () => {
  assert.equal(notifyStatusLine({ mail: 'no-smtp', channels: [] }).canTest, false)
  assert.match(notifyStatusLine({ mail: 'no-smtp', channels: [] }).text, /SMTP is not set up/)
  const on = notifyStatusLine({ mail: 'ready', channels: ['ntfy'] })
  assert.equal(on.canTest, true)
  assert.match(on.text, /^Notices go to e-mail and ntfy: failed backups/)
  assert.deepEqual(testResultLine({ mail: 'sent', push: [{ channel: 'ntfy', ok: true, status: 200 }] }), { tone: 'success', title: 'Test notification sent', detail: 'Sent to e-mail, ntfy.' })
  assert.equal(testResultLine({ mail: 'off', push: [{ channel: 'bark', ok: false, error: 'TIMEOUT' }] }).tone, 'error')
  assert.equal(testResultLine({ mail: 'skipped', push: [{ channel: 'ntfy', ok: true }, { channel: 'webhook', ok: false, status: 404 }] }).detail, 'Sent to ntfy. Failed: webhook (HTTP 404).')
  assert.equal(testResultLine({ mail: 'skipped', push: [] }).tone, 'warning')
})

test('the reporting places call opsAlert: scheduled backups, scheduled drills, new server errors, contact, first share-link opens', () => {
  const src = (f: string) => fs.readFileSync(path.join(prevCwd, f), 'utf8')
  const backup = src('lib/backupSchedule.ts')
  assert.match(backup, /opsAlert\(\{ type: 'backup-failed'/)
  assert.match(backup, /opsAlert\(\{ type: 'backup-offsite-failed'/)
  assert.match(src('lib/restoreDrill.ts'), /result\.trigger === 'scheduled'\) opsAlert\(\{ type: 'drill-failed'/)
  assert.match(src('lib/errors/server.ts'), /outcome === 'new'\) opsAlert\(\{ type: 'server-error'/)
  assert.match(src('pages/api/contact.ts'), /opsAlert\(\{ type: 'contact', from: safeName, subject: safeSubject \}\)/)
  assert.match(src('pages/api/cv/share.ts'), /before\.openCount === 0/)
  assert.match(src('docker-entrypoint.sh'), /export R2_BOOT_SYNC_FAILED=1/)
  assert.match(src('instrumentation.ts'), /startOpsWatch\(\)/)
})
