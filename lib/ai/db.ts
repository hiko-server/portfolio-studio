import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'
import {
  backupBeforeMigration,
  ensureWal,
  PRIVATE_FILE_MODE,
  preparePrivateDbFile,
  restrictPrivateDbFiles,
  runMigrations,
  type MigrationReport,
} from '../../scripts/db/migrate.mjs'
import { AI_MIGRATIONS } from '../../scripts/db/ai/index.mjs'
import { logMigrationReport } from '../dbMigrations'
import { log } from '../log'

/**
 * The AI feature's bulk data: data/ai.db (schema: scripts/db/ai) —
 * conversations, model usage, the tool-call log, AI writes ("changes") and
 * persisted budget counters. Credentials and switches are NOT here: they live
 * in auth.db (lib/ai/settings), so a problem with this store (size, a broken
 * file, a full disk) can never touch sign-in or re-enable anything.
 *
 * Never packed into a content snapshot (lib/backup.ts handles content.db
 * only), never mirrored to R2, never replaced by a restore; scripts/deploy.sh
 * takes an online copy of it into its owner-only backup directory with the
 * other stores.
 *
 * Owner-only on disk like auth.db: created 0600 before SQLite opens it (so
 * the -wal and -shm files start 0600 too) and chmodded again after every
 * open, the pre-migration copy included. `secure_delete` makes SQLite
 * overwrite what a delete frees, so pruned draft text and before-states do
 * not linger in free pages. Foreign keys are on: a deleted conversation takes
 * its turns and runs with it.
 *
 * The connection lives on globalThis (one per process across Next's webpack
 * runtimes); the path is resolved when it is first opened, so tests can chdir
 * into a temp directory first.
 */

export function aiDbPath(): string {
  return path.join(process.cwd(), 'data', 'ai.db')
}

type AiGlobal = typeof globalThis & { __aiDb?: Database.Database | null }
const g = globalThis as AiGlobal

export function migrateAiDb(db: Database.Database, backupDir?: string): MigrationReport {
  const dir = backupDir ?? path.join(path.dirname(db.name), 'backups', 'pre-migration')
  const report = runMigrations(db, AI_MIGRATIONS, {
    label: 'ai',
    beforeMigrate: ({ from }) => {
      const copy = backupBeforeMigration(db, { dir, label: 'ai', from })
      if (!copy) return
      try {
        fs.chmodSync(copy, PRIVATE_FILE_MODE)
      } catch {
        // Not the owner: the pre-migration directory itself is 0700.
      }
      log.info('ai.db copied before migrating', { file: copy, from })
    },
  })
  logMigrationReport(report)
  return report
}

export function getAiDb(): Database.Database {
  const cached = g.__aiDb
  if (cached && cached.open) return cached
  const file = aiDbPath()
  preparePrivateDbFile(file)
  const db = new Database(file, { timeout: 5000 })
  try {
    ensureWal(db, 5000)
    db.pragma('synchronous = NORMAL')
    db.pragma('secure_delete = ON')
    db.pragma('foreign_keys = ON')
    migrateAiDb(db)
    // Files this process does not own (a bind mount) are skipped quietly.
    for (const f of restrictPrivateDbFiles(file))
      log.warn('could not make an ai.db file owner-only', { file: f.path, code: f.code })
  } catch (err) {
    db.close()
    throw err
  }
  g.__aiDb = db
  return db
}

export function closeAiDb(): void {
  const db = g.__aiDb
  g.__aiDb = null
  if (db && db.open) db.close()
}
