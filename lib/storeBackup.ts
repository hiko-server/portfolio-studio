import fs from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import crypto from 'crypto'
import { pipeline } from 'stream/promises'
import { Readable, Writable } from 'stream'
import Database from 'better-sqlite3'
import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3'
// @ts-expect-error -- tar-stream ships no type declarations.
import tarStream from 'tar-stream'
import { authDbPath, getAuthDb } from './adminAuth/db'
import { auditDbPath, getAuditDb } from './audit/db'
import { aiDbPath, getAiDb } from './ai/db'
import { analyticsDbPath, getAnalyticsDb } from './analytics/db'
import { CONTENT_DB_PATH } from './db'
import { log } from './log'
import { opsAlert } from './ops/alerts'
import { R2_TIMEOUTS } from './r2'
import { currentVersion } from '../scripts/db/migrate.mjs'

/**
 * An encrypted copy of the four stores the content snapshots leave out
 * (SERVER-ONLY): auth.db (sessions, passkeys, review and share links, AI
 * grants), audit.db (the activity log), ai.db (AI settings, sealed provider
 * keys, change cards) and analytics.db (visits, Web Vitals, errors). Before
 * this, their only copies were the deploy script's backups on the same
 * server: a lost disk lost them all.
 *
 * Every STORE_BACKUP_INTERVAL_HOURS (default 24, 0 = off): each store is
 * copied with SQLite's online backup API, the copies and a MANIFEST.json
 * (bytes, SHA-256, schema version) are packed as tar.gz, the archive is
 * sealed with AES-256-GCM under STORE_BACKUP_KEY, and the result goes to R2
 * as `store-backups/<UTC>.pssb` and `store-backups/latest.pssb` — to its own
 * bucket when STORE_BACKUP_R2_BUCKET is set (give that bucket a key that can
 * only write, and versioning or an object lock, so a leaked server key
 * cannot delete the history), else to the content mirror's bucket. The
 * newest STORE_BACKUP_KEEP (30) are kept when the key may list and delete;
 * otherwise use the bucket's lifecycle rules.
 *
 * STORE_BACKUP_KEY (32 random bytes, base64: `openssl rand -base64 32`) must
 * ALSO be kept off the server (a password manager): an archive is useless
 * without it, and the server that held it may be the thing that was lost.
 * `scripts/restore-stores.mjs` opens an archive into a folder; nothing here
 * ever writes to the live stores.
 *
 * File format: "PSSB1\n" (6 bytes, also the GCM additional data) · 12-byte
 * IV · ciphertext · 16-byte tag.
 */

export const STORE_BACKUP_MAGIC = Buffer.from('PSSB1\n', 'ascii')
export const STORE_BACKUP_PREFIX = 'store-backups/'
export const STORE_BACKUP_LATEST = `${STORE_BACKUP_PREFIX}latest.pssb`

type Env = Record<string, string | undefined>

/** The sealing key, or null when unset or not 32 bytes of base64. */
export function storeBackupKey(env: Env = process.env): Buffer | null {
  const raw = (env.STORE_BACKUP_KEY || '').trim()
  if (!raw) return null
  try {
    const key = Buffer.from(raw, 'base64')
    return key.length === 32 ? key : null
  } catch {
    return null
  }
}

export function storeBackupIntervalHours(env: Env = process.env): number {
  const raw = (env.STORE_BACKUP_INTERVAL_HOURS ?? '').trim()
  if (raw === '') return 24
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 24 * 30) : 24
}

export function storeBackupKeep(env: Env = process.env): number {
  const n = Number(env.STORE_BACKUP_KEEP || 30)
  return Number.isInteger(n) && n >= 1 ? Math.min(n, 365) : 30
}

/** Seal `plain` (AES-256-GCM, random IV, the magic as additional data). */
export function sealStoreBackup(plain: Buffer, key: Buffer): Buffer {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(STORE_BACKUP_MAGIC)
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([STORE_BACKUP_MAGIC, iv, body, cipher.getAuthTag()])
}

/** Open a sealed archive; throws on a wrong key, a damaged file or another format. */
export function openStoreBackup(sealed: Buffer, key: Buffer): Buffer {
  const m = STORE_BACKUP_MAGIC.length
  if (sealed.length < m + 12 + 16 || !sealed.subarray(0, m).equals(STORE_BACKUP_MAGIC)) throw new Error('not a store backup (PSSB1)')
  const iv = sealed.subarray(m, m + 12)
  const tag = sealed.subarray(sealed.length - 16)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAAD(STORE_BACKUP_MAGIC)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(sealed.subarray(m + 12, sealed.length - 16)), decipher.final()])
}

export type StoreName = 'auth' | 'audit' | 'ai' | 'analytics'

export type StoreBackupManifest = {
  version: 1
  createdAt: string
  release: string | null
  stores: Array<{ name: StoreName; file: string; bytes: number; sha256: string; schemaVersion: number | null }>
}

const STORES: Array<{ name: StoreName; file: () => string; open: () => Database.Database }> = [
  { name: 'auth', file: authDbPath, open: getAuthDb },
  { name: 'audit', file: auditDbPath, open: getAuditDb },
  { name: 'ai', file: aiDbPath, open: getAiDb },
  { name: 'analytics', file: analyticsDbPath, open: getAnalyticsDb },
]

const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex')

/** tar.gz of `entries` (in order), in memory. */
async function packTarGz(entries: Array<{ name: string; body: Buffer }>): Promise<Buffer> {
  const pack = tarStream.pack()
  const chunks: Buffer[] = []
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk)
      cb()
    },
  })
  const piped = pipeline(pack, zlib.createGzip({ level: 6 }), sink)
  for (const e of entries)
    await new Promise<void>((resolve, reject) => pack.entry({ name: e.name, size: e.body.length }, e.body, (err: Error | null) => (err ? reject(err) : resolve())))
  pack.finalize()
  await piped
  return Buffer.concat(chunks)
}

/** The entries of a tar.gz (regular files only, no path tricks), in memory. */
export async function unpackTarGz(buf: Buffer): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>()
  const extract = tarStream.extract()
  extract.on('entry', (header: { name?: string; type?: string }, stream: NodeJS.ReadableStream, next: (err?: unknown) => void) => {
    const parts: Buffer[] = []
    stream.on('data', (c: Buffer) => parts.push(c))
    stream.on('error', next)
    stream.on('end', () => {
      const name = String(header.name || '')
      if (header.type === 'file' && /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)?$/.test(name) && !name.split('/').includes('..')) out.set(name, Buffer.concat(parts))
      next()
    })
    stream.resume()
  })
  await pipeline(Readable.from(buf), zlib.createGunzip(), extract)
  return out
}

/**
 * The files the owner gave the assistant (ai.db `ai_media`: photos, screen
 * captures, voice, PDFs) never leave the server in this backup: their rows go
 * from the copy before it is packed, and VACUUM gives the space back, so the
 * archive stays small enough to build in memory on a 1 GB container.
 */
export function withoutAttachedFiles(file: string): void {
  const db = new Database(file, { fileMustExist: true })
  try {
    const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ai_media'").get()
    if (!has) return
    db.exec('DELETE FROM ai_media')
    db.exec('VACUUM')
  } finally {
    db.close()
  }
}

/** Online copies of the four stores, packed (not yet sealed). */
export async function buildStoreBundle(now = Date.now()): Promise<{ bundle: Buffer; manifest: StoreBackupManifest }> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'store-backup-'))
  try {
    const entries: Array<{ name: string; body: Buffer }> = []
    const stores: StoreBackupManifest['stores'] = []
    for (const s of STORES) {
      if (!fs.existsSync(s.file())) continue
      const dest = path.join(tmp, `${s.name}.db`)
      await s.open().backup(dest)
      if (s.name === 'ai') withoutAttachedFiles(dest)
      let schemaVersion: number | null = null
      try {
        const db = new Database(dest, { readonly: true, fileMustExist: true })
        try {
          schemaVersion = currentVersion(db)
        } finally {
          db.close()
        }
      } catch {
        schemaVersion = null
      }
      const body = fs.readFileSync(dest)
      entries.push({ name: `db/${s.name}.db`, body })
      stores.push({ name: s.name, file: `db/${s.name}.db`, bytes: body.length, sha256: sha256(body), schemaVersion })
    }
    const manifest: StoreBackupManifest = {
      version: 1,
      createdAt: new Date(now).toISOString(),
      release: process.env.NEXT_PUBLIC_BUILD_SHA || null,
      stores,
    }
    const bundle = await packTarGz([{ name: 'MANIFEST.json', body: Buffer.from(JSON.stringify(manifest, null, 2)) }, ...entries])
    return { bundle, manifest }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

/** Open, unpack and check an archive: every store's bytes and SHA-256 against the manifest. */
export async function readStoreBackup(sealed: Buffer, key: Buffer): Promise<{ manifest: StoreBackupManifest; files: Map<string, Buffer> }> {
  const files = await unpackTarGz(openStoreBackup(sealed, key))
  const raw = files.get('MANIFEST.json')
  if (!raw) throw new Error('the archive has no MANIFEST.json')
  const manifest = JSON.parse(raw.toString('utf8')) as StoreBackupManifest
  for (const s of manifest.stores) {
    const body = files.get(s.file)
    if (!body) throw new Error(`${s.file} is missing`)
    if (body.length !== s.bytes || sha256(body) !== s.sha256) throw new Error(`${s.file} does not match its checksum`)
  }
  return { manifest, files }
}

// ── Where archives go ─────────────────────────────────────────────────────

export type Target = { client: Pick<S3Client, 'send'>; bucket: string; own: boolean }

let cachedTarget: { sig: string; target: Target } | null = null

/** STORE_BACKUP_R2_* when set (a bucket of its own), else the content mirror's R2; null without R2. */
export function storeBackupTarget(env: Env = process.env): Target | null {
  const own = !!(env.STORE_BACKUP_R2_BUCKET || '').trim()
  const endpoint = (own ? env.STORE_BACKUP_R2_ENDPOINT || env.R2_ENDPOINT : env.R2_ENDPOINT) || ''
  const bucket = (own ? env.STORE_BACKUP_R2_BUCKET : env.R2_BUCKET) || ''
  const accessKeyId = (own ? env.STORE_BACKUP_R2_ACCESS_KEY_ID || env.R2_ACCESS_KEY_ID : env.R2_ACCESS_KEY_ID) || ''
  const secretAccessKey = (own ? env.STORE_BACKUP_R2_SECRET_ACCESS_KEY || env.R2_SECRET_ACCESS_KEY : env.R2_SECRET_ACCESS_KEY) || ''
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null
  const sig = [endpoint, bucket, accessKeyId, crypto.createHash('sha256').update(secretAccessKey).digest('hex')].join('|')
  if (cachedTarget?.sig === sig) return cachedTarget.target
  const client = new S3Client({
    region: 'auto',
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    maxAttempts: R2_TIMEOUTS.maxAttempts,
    retryMode: 'standard',
    requestHandler: { connectionTimeout: R2_TIMEOUTS.connectionMs, requestTimeout: 60_000 },
  })
  cachedTarget = { sig, target: { client, bucket, own } }
  return cachedTarget.target
}

export function storeBackupKeyName(now: number): string {
  return `${STORE_BACKUP_PREFIX}${new Date(now).toISOString().replace(/[:.]/g, '-')}.pssb`
}

// ── State and the run ─────────────────────────────────────────────────────

export type StoreBackupRecord = {
  lastRunAt: number | null
  lastOkAt: number | null
  lastOk: boolean | null
  lastError: string | null
  lastKey: string | null
  lastBytes: number | null
  stores: StoreName[]
}

const EMPTY: StoreBackupRecord = { lastRunAt: null, lastOkAt: null, lastOk: null, lastError: null, lastKey: null, lastBytes: null, stores: [] }

function recordFile(): string {
  return path.join(path.dirname(CONTENT_DB_PATH), 'backups', 'store-backup.json')
}

export function readStoreBackupRecord(): StoreBackupRecord {
  try {
    return { ...EMPTY, ...JSON.parse(fs.readFileSync(recordFile(), 'utf8')) }
  } catch {
    return { ...EMPTY }
  }
}

function writeRecord(r: StoreBackupRecord): void {
  try {
    fs.mkdirSync(path.dirname(recordFile()), { recursive: true })
    fs.writeFileSync(recordFile(), JSON.stringify(r, null, 2))
  } catch (err) {
    log.warn('store backup: could not write its record', { err })
  }
}

export type StoreBackupResult = { result: 'off' | 'created' | 'failed'; key?: string; bytes?: number; error?: string; pruned?: number }

let running = false

/** One run: copy, pack, seal, upload, prune. Never throws; a failure becomes an owner notice. */
export async function runStoreBackup(opts: { now?: () => number; env?: Env; target?: Target } = {}): Promise<StoreBackupResult> {
  const now = opts.now ?? Date.now
  const env = opts.env ?? process.env
  const key = storeBackupKey(env)
  const target = opts.target ?? storeBackupTarget(env)
  if (!key || !target) return { result: 'off' }
  if (running) return { result: 'failed', error: 'another store backup is running' }
  running = true
  const startedAt = now()
  try {
    const { bundle, manifest } = await buildStoreBundle(startedAt)
    const sealed = sealStoreBackup(bundle, key)
    const objectKey = storeBackupKeyName(startedAt)
    for (const k of [objectKey, STORE_BACKUP_LATEST])
      await target.client.send(new PutObjectCommand({ Bucket: target.bucket, Key: k, Body: sealed, ContentType: 'application/octet-stream' }))
    const pruned = await pruneStoreBackups(target, storeBackupKeep(env))
    writeRecord({ lastRunAt: startedAt, lastOkAt: now(), lastOk: true, lastError: null, lastKey: objectKey, lastBytes: sealed.length, stores: manifest.stores.map((s) => s.name) })
    log.info('store backup uploaded', { key: objectKey, bytes: sealed.length, stores: manifest.stores.length, pruned })
    return { result: 'created', key: objectKey, bytes: sealed.length, pruned }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    writeRecord({ ...readStoreBackupRecord(), lastRunAt: startedAt, lastOk: false, lastError: error })
    log.error('store backup failed', { err })
    opsAlert({ type: 'store-backup-failed', error })
    return { result: 'failed', error }
  } finally {
    running = false
  }
}

/** Delete dated archives beyond the newest `keep`; 0 when the key may not list or delete (lifecycle rules then do it). */
async function pruneStoreBackups(target: Target, keep: number): Promise<number> {
  try {
    const keys: string[] = []
    let token: string | undefined
    do {
      const out = await target.client.send(new ListObjectsV2Command({ Bucket: target.bucket, Prefix: STORE_BACKUP_PREFIX, ContinuationToken: token }))
      for (const o of out.Contents || []) if (o.Key && o.Key !== STORE_BACKUP_LATEST && o.Key.endsWith('.pssb')) keys.push(o.Key)
      token = out.IsTruncated ? out.NextContinuationToken : undefined
    } while (token)
    const victims = keys.sort().reverse().slice(keep)
    for (const k of victims) await target.client.send(new DeleteObjectCommand({ Bucket: target.bucket, Key: k }))
    return victims.length
  } catch (err) {
    log.info('store backup: old archives not pruned (a write-only key? use the bucket lifecycle rules)', { err: err instanceof Error ? err.name : String(err) })
    return 0
  }
}

/** Health warnings (Admin → System → Health and the /api/health detail). */
export function storeBackupWarnings(env: Env = process.env, record: StoreBackupRecord = readStoreBackupRecord(), now = Date.now()): string[] {
  const interval = storeBackupIntervalHours(env)
  if (interval === 0) return []
  if (!storeBackupTarget(env)) return []
  if (!storeBackupKey(env))
    return ['The auth, audit, AI and analytics stores have no copy off this server: set STORE_BACKUP_KEY (and keep it in a password manager too).']
  if (record.lastOk === false) return ['The last encrypted backup of the auth, audit, AI and analytics stores failed; see the server log.']
  if (record.lastOkAt && now - record.lastOkAt > 2 * interval * 3_600_000)
    return [`The encrypted backup of the auth, audit, AI and analytics stores is ${Math.round((now - record.lastOkAt) / 3_600_000)} h old (schedule: every ${interval} h).`]
  return []
}

// ── Schedule ──────────────────────────────────────────────────────────────

type ScheduleGlobal = typeof globalThis & { __storeBackupTimer?: ReturnType<typeof setTimeout> | null }

/** Start the schedule: the first run 15–25 minutes after start (or at the interval, if the last run is recent), then every interval. */
export function startStoreBackupSchedule(env: Env = process.env): void {
  const g = globalThis as ScheduleGlobal
  const hours = storeBackupIntervalHours(env)
  if (g.__storeBackupTimer || hours === 0) return
  const every = hours * 3_600_000
  const last = readStoreBackupRecord().lastOkAt
  const first = Math.max(15 * 60_000 + Math.floor(Math.random() * 10 * 60_000), last ? last + every - Date.now() : 0)
  const tick = (delay: number) => {
    g.__storeBackupTimer = setTimeout(async () => {
      await runStoreBackup()
      tick(every)
    }, delay)
    ;(g.__storeBackupTimer as { unref?: () => void }).unref?.()
  }
  tick(first)
}
