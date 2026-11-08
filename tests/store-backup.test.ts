/**
 * The encrypted off-server copy of auth, audit, ai and analytics.db
 * (lib/storeBackup.ts, scripts/restore-stores.mjs): sealing, the archive's
 * checks, what a run uploads and prunes, the restore script reading what the
 * server wrote, and the health warnings.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const prevCwd = process.cwd()
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'store-backup-'))
let sb: typeof import('../lib/storeBackup')
let restore: any

const KEY_B64 = crypto.randomBytes(32).toString('base64')
const KEY = Buffer.from(KEY_B64, 'base64')

before(async () => {
  process.chdir(tmp)
  sb = await import('../lib/storeBackup')
  restore = await import('../scripts/restore-stores.mjs')
  // Create the four stores (each opens and migrates itself).
  ;(await import('../lib/adminAuth/db')).getAuthDb()
  ;(await import('../lib/audit/db')).getAuditDb()
  ;(await import('../lib/ai/db')).getAiDb()
  ;(await import('../lib/analytics/db')).getAnalyticsDb().prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('store-backup-test', 'sentinel')`).run()
})

after(() => {
  process.chdir(prevCwd)
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('the key: 32 bytes of base64, anything else is no key', () => {
  assert.equal(sb.storeBackupKey({}), null)
  assert.equal(sb.storeBackupKey({ STORE_BACKUP_KEY: Buffer.alloc(16).toString('base64') }), null)
  assert.deepEqual(sb.storeBackupKey({ STORE_BACKUP_KEY: ` ${KEY_B64} ` }), KEY)
  assert.equal(sb.storeBackupIntervalHours({}), 24)
  assert.equal(sb.storeBackupIntervalHours({ STORE_BACKUP_INTERVAL_HOURS: '0' }), 0)
  assert.equal(sb.storeBackupIntervalHours({ STORE_BACKUP_INTERVAL_HOURS: 'x' }), 24)
})

test('sealing: round trip; a wrong key, a flipped byte or another file is refused', () => {
  const plain = Buffer.from('hello stores')
  const sealed = sb.sealStoreBackup(plain, KEY)
  assert.ok(sealed.subarray(0, 6).equals(sb.STORE_BACKUP_MAGIC))
  assert.ok(!sealed.includes(plain), 'the plaintext is not in the file')
  assert.deepEqual(sb.openStoreBackup(sealed, KEY), plain)
  assert.throws(() => sb.openStoreBackup(sealed, crypto.randomBytes(32)))
  const flipped = Buffer.from(sealed)
  flipped[20] ^= 1
  assert.throws(() => sb.openStoreBackup(flipped, KEY))
  assert.throws(() => sb.openStoreBackup(Buffer.from('PK\x03\x04 a zip file, not ours'), KEY), /not a store backup/)
  // Two seals of the same bytes differ (random IV).
  assert.ok(!sb.sealStoreBackup(plain, KEY).equals(sealed))
})

test('the bundle holds an online copy of each store with its checksum and schema version', async () => {
  const { bundle, manifest } = await sb.buildStoreBundle(Date.UTC(2026, 10, 8))
  assert.deepEqual(manifest.stores.map((s) => s.name), ['auth', 'audit', 'ai', 'analytics'])
  for (const s of manifest.stores) {
    assert.ok(s.bytes > 0, s.name)
    assert.match(s.sha256, /^[0-9a-f]{64}$/)
    assert.ok(typeof s.schemaVersion === 'number' && s.schemaVersion >= 1, `${s.name} v${s.schemaVersion}`)
  }
  const { files } = await sb.readStoreBackup(sb.sealStoreBackup(bundle, KEY), KEY)
  assert.ok(files.get('db/analytics.db')!.includes(Buffer.from('sentinel')))
})

test('a run seals, uploads dated and latest, prunes beyond the keep count, and records the result', async () => {
  const sent: Array<{ name: string; input: any }> = []
  const existing = Array.from({ length: 5 }, (_, i) => `store-backups/2026-10-0${i + 1}T03-00-00-000Z.pssb`)
  const fake = {
    async send(cmd: any) {
      sent.push({ name: cmd.constructor.name, input: cmd.input })
      if (cmd.constructor.name === 'ListObjectsV2Command') return { Contents: [...existing, 'store-backups/latest.pssb', 'store-backups/2026-11-08T03-00-00-000Z.pssb'].map((Key) => ({ Key })), IsTruncated: false }
      return {}
    },
  }
  const t = Date.UTC(2026, 10, 8, 3)
  const r = await sb.runStoreBackup({ now: () => t, env: { STORE_BACKUP_KEY: KEY_B64, STORE_BACKUP_KEEP: '3' }, target: { client: fake as any, bucket: 'b', own: false } })
  assert.equal(r.result, 'created')
  const puts = sent.filter((s) => s.name === 'PutObjectCommand')
  assert.deepEqual(puts.map((p) => p.input.Key), ['store-backups/2026-11-08T03-00-00-000Z.pssb', 'store-backups/latest.pssb'])
  const sealed = puts[0].input.Body as Buffer
  const { manifest } = await sb.readStoreBackup(sealed, KEY)
  assert.equal(manifest.stores.length, 4)
  // Newest 3 dated archives kept (latest.pssb never counts): the three oldest of six go.
  assert.deepEqual(
    sent.filter((s) => s.name === 'DeleteObjectCommand').map((d) => d.input.Key),
    ['store-backups/2026-10-03T03-00-00-000Z.pssb', 'store-backups/2026-10-02T03-00-00-000Z.pssb', 'store-backups/2026-10-01T03-00-00-000Z.pssb'],
  )
  const rec = sb.readStoreBackupRecord()
  assert.equal(rec.lastOk, true)
  assert.equal(rec.lastOkAt, t)
  assert.deepEqual(rec.stores, ['auth', 'audit', 'ai', 'analytics'])

  // The restore script opens what the server wrote.
  const out = path.join(tmp, 'restored')
  const m = await restore.restoreTo(sealed, KEY, out)
  assert.equal(m.stores.length, 4)
  for (const n of ['auth', 'audit', 'ai', 'analytics']) assert.ok(fs.statSync(path.join(out, `${n}.db`)).size > 0, n)
  assert.ok(fs.readFileSync(path.join(out, 'analytics.db')).includes(Buffer.from('sentinel')))
  await assert.rejects(restore.restoreTo(sealed, crypto.randomBytes(32), path.join(tmp, 'nope')), /wrong STORE_BACKUP_KEY/)
})

test('a write-only key cannot list: the upload still counts, nothing is pruned', async () => {
  const fake = {
    async send(cmd: any) {
      if (cmd.constructor.name === 'ListObjectsV2Command') throw Object.assign(new Error('Access Denied'), { name: 'AccessDenied' })
      return {}
    },
  }
  const r = await sb.runStoreBackup({ env: { STORE_BACKUP_KEY: KEY_B64 }, target: { client: fake as any, bucket: 'b', own: true } })
  assert.equal(r.result, 'created')
  assert.equal(r.pruned, 0)
})

test('a failed upload is recorded and reported; without a key or R2 nothing runs', async () => {
  const fake = { async send() { throw new Error('network down') } }
  const r = await sb.runStoreBackup({ env: { STORE_BACKUP_KEY: KEY_B64 }, target: { client: fake as any, bucket: 'b', own: false } })
  assert.deepEqual(r, { result: 'failed', error: 'network down' })
  assert.equal(sb.readStoreBackupRecord().lastOk, false)
  assert.equal((await sb.runStoreBackup({ env: {} })).result, 'off')
})

test('targets: the content mirror by default, a bucket of its own when STORE_BACKUP_R2_BUCKET is set', () => {
  const r2 = { R2_ENDPOINT: 'https://r2.example', R2_BUCKET: 'site', R2_ACCESS_KEY_ID: 'a', R2_SECRET_ACCESS_KEY: 's' }
  assert.equal(sb.storeBackupTarget({}), null)
  assert.deepEqual({ bucket: sb.storeBackupTarget(r2)!.bucket, own: sb.storeBackupTarget(r2)!.own }, { bucket: 'site', own: false })
  const own = sb.storeBackupTarget({ ...r2, STORE_BACKUP_R2_BUCKET: 'vault', STORE_BACKUP_R2_ACCESS_KEY_ID: 'w', STORE_BACKUP_R2_SECRET_ACCESS_KEY: 'x' })!
  assert.deepEqual({ bucket: own.bucket, own: own.own }, { bucket: 'vault', own: true })
})

test('health warnings: no key, a failed run, a late copy; quiet without R2 or when switched off', () => {
  const r2 = { R2_ENDPOINT: 'https://r2.example', R2_BUCKET: 'site', R2_ACCESS_KEY_ID: 'a', R2_SECRET_ACCESS_KEY: 's' }
  const rec = (over: object) => ({ lastRunAt: null, lastOkAt: null, lastOk: null, lastError: null, lastKey: null, lastBytes: null, stores: [], ...over }) as any
  const now = Date.UTC(2026, 10, 8, 12)
  assert.deepEqual(sb.storeBackupWarnings({}, rec({}), now), [])
  assert.deepEqual(sb.storeBackupWarnings({ ...r2, STORE_BACKUP_INTERVAL_HOURS: '0' }, rec({}), now), [])
  assert.match(sb.storeBackupWarnings(r2, rec({}), now)[0], /set STORE_BACKUP_KEY/)
  const keyed = { ...r2, STORE_BACKUP_KEY: KEY_B64 }
  assert.match(sb.storeBackupWarnings(keyed, rec({ lastOk: false }), now)[0], /failed/)
  assert.match(sb.storeBackupWarnings(keyed, rec({ lastOk: true, lastOkAt: now - 50 * 3_600_000 }), now)[0], /50 h old/)
  assert.deepEqual(sb.storeBackupWarnings(keyed, rec({ lastOk: true, lastOkAt: now - 3_600_000 }), now), [])
})
