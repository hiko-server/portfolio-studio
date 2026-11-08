#!/usr/bin/env node
/**
 * Open an encrypted store backup (lib/storeBackup.ts) into a folder:
 * auth.db, audit.db, ai.db and analytics.db plus MANIFEST.json, every file
 * checked against the manifest's size and SHA-256. Writes ONLY to --out;
 * never touches a live store.
 *
 *   STORE_BACKUP_KEY=… node scripts/restore-stores.mjs --in store-2026-11-08T03-00-00-000Z.pssb --out ./restored
 *   node --env-file=.env scripts/restore-stores.mjs --r2 [--key store-backups/<name>.pssb] --out ./restored
 *
 * --r2 downloads `store-backups/latest.pssb` (or --key) with the
 * STORE_BACKUP_R2_* settings, else the R2_* ones. The key comes from
 * STORE_BACKUP_KEY (32 bytes, base64) — the copy you kept off the server.
 *
 * Putting the files back (docs/operations.md → Encrypted store backups):
 * stop the container, copy the wanted *.db into data/ (owner uid 1001, mode
 * 0600 for auth, audit and ai), remove any stale *.db-wal / *.db-shm next
 * to them, start the container. Exit codes: 0 ok, 1 failed, 2 bad arguments.
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import tarStream from 'tar-stream'

export const MAGIC = Buffer.from('PSSB1\n', 'ascii')

export function keyFromEnv(env = process.env) {
  const raw = (env.STORE_BACKUP_KEY || '').trim()
  const key = raw ? Buffer.from(raw, 'base64') : Buffer.alloc(0)
  if (key.length !== 32) throw new Error('STORE_BACKUP_KEY must be 32 bytes of base64 (openssl rand -base64 32)')
  return key
}

export function openSealed(sealed, key) {
  const m = MAGIC.length
  if (sealed.length < m + 28 || !sealed.subarray(0, m).equals(MAGIC)) throw new Error('not a store backup (PSSB1)')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, sealed.subarray(m, m + 12))
  decipher.setAAD(MAGIC)
  decipher.setAuthTag(sealed.subarray(sealed.length - 16))
  try {
    return Buffer.concat([decipher.update(sealed.subarray(m + 12, sealed.length - 16)), decipher.final()])
  } catch {
    throw new Error('cannot open the archive: wrong STORE_BACKUP_KEY, or the file is damaged')
  }
}

export async function unpack(tgz) {
  const out = new Map()
  const extract = tarStream.extract()
  extract.on('entry', (header, stream, next) => {
    const parts = []
    stream.on('data', (c) => parts.push(c))
    stream.on('error', next)
    stream.on('end', () => {
      const name = String(header.name || '')
      if (header.type === 'file' && /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)?$/.test(name) && !name.split('/').includes('..')) out.set(name, Buffer.concat(parts))
      next()
    })
    stream.resume()
  })
  await pipeline(Readable.from(tgz), zlib.createGunzip(), extract)
  return out
}

/** Open, check and write an archive's stores into `outDir`; returns the manifest. */
export async function restoreTo(sealed, key, outDir) {
  const files = await unpack(openSealed(sealed, key))
  const raw = files.get('MANIFEST.json')
  if (!raw) throw new Error('the archive has no MANIFEST.json')
  const manifest = JSON.parse(raw.toString('utf8'))
  fs.mkdirSync(outDir, { recursive: true })
  for (const s of manifest.stores || []) {
    const body = files.get(s.file)
    if (!body) throw new Error(`${s.file} is missing`)
    const sum = crypto.createHash('sha256').update(body).digest('hex')
    if (body.length !== s.bytes || sum !== s.sha256) throw new Error(`${s.file} does not match its checksum`)
    fs.writeFileSync(path.join(outDir, `${s.name}.db`), body, { mode: 0o600 })
  }
  fs.writeFileSync(path.join(outDir, 'MANIFEST.json'), raw)
  return manifest
}

async function fromR2(objectKey, env = process.env) {
  const own = !!(env.STORE_BACKUP_R2_BUCKET || '').trim()
  const endpoint = (own ? env.STORE_BACKUP_R2_ENDPOINT || env.R2_ENDPOINT : env.R2_ENDPOINT) || ''
  const bucket = (own ? env.STORE_BACKUP_R2_BUCKET : env.R2_BUCKET) || ''
  const accessKeyId = (own ? env.STORE_BACKUP_R2_ACCESS_KEY_ID || env.R2_ACCESS_KEY_ID : env.R2_ACCESS_KEY_ID) || ''
  const secretAccessKey = (own ? env.STORE_BACKUP_R2_SECRET_ACCESS_KEY || env.R2_SECRET_ACCESS_KEY : env.R2_SECRET_ACCESS_KEY) || ''
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) throw new Error('R2 is not configured (STORE_BACKUP_R2_* or R2_*)')
  const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3')
  const client = new S3Client({ region: 'auto', endpoint, credentials: { accessKeyId, secretAccessKey } })
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }))
  const chunks = []
  for await (const c of res.Body) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
  return Buffer.concat(chunks)
}

function parseArgs(argv) {
  const a = { in: null, out: null, r2: false, key: 'store-backups/latest.pssb' }
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]
    if (v === '--in') a.in = argv[++i]
    else if (v === '--out') a.out = argv[++i]
    else if (v === '--r2') a.r2 = true
    else if (v === '--key') a.key = argv[++i]
    else return null
  }
  if (!a.out || (!a.in && !a.r2) || (a.in && a.r2)) return null
  return a
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args) {
    console.error('usage: restore-stores.mjs (--in <file.pssb> | --r2 [--key store-backups/<name>.pssb]) --out <dir>')
    process.exit(2)
  }
  try {
    const key = keyFromEnv()
    const sealed = args.r2 ? await fromR2(args.key) : fs.readFileSync(args.in)
    const manifest = await restoreTo(sealed, key, args.out)
    console.log(`Opened a store backup made ${manifest.createdAt}${manifest.release ? ` (build ${manifest.release})` : ''}:`)
    for (const s of manifest.stores) console.log(`  ${s.name}.db  ${s.bytes} bytes  schema v${s.schemaVersion ?? '?'}  checksum ok`)
    console.log(`Written to ${path.resolve(args.out)}. Nothing live was changed.`)
  } catch (err) {
    console.error(`restore-stores: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main()
