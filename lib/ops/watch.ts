import fs from 'fs'
import path from 'path'
import { getAiDb } from '../ai/db'
import { CONTENT_DB_PATH } from '../db'
import { log } from '../log'
import { diskInfo, type DiskInfo } from '../systemHealth'
import { opsAlert } from './alerts'

/**
 * The checks nobody runs by hand (SERVER-ONLY), started once per process
 * from instrumentation.ts:
 *
 *   - at start: did docker-entrypoint.sh serve the local content because the
 *     R2 sync failed? (it exports R2_BOOT_SYNC_FAILED=1 to the server)
 *   - hourly: is the data disk under 10 % or 1 GB free? (the same rule as
 *     Admin → System → Health, lib/systemHealth diskWarnings)
 *   - every 5 minutes: has a connected app (MCP) proposed a change that
 *     waits for the owner? Read from ai.db here, outside the AI tool layer,
 *     which never reaches the owner's mail or phone (tests/ai-boundary).
 *     The assistant's own proposals are not announced: the owner is in the
 *     admin watching it.
 *
 * Each finding becomes an owner notice through lib/ops/alerts (at most one
 * a day per kind). Never throws.
 */

const HOUR_MS = 3_600_000
const FIRST_CHECK_MS = 2 * 60_000

/** The disk notice for `disk`, or null when there is enough room (pure; unit tested). */
export function diskAlert(disk: DiskInfo): { freeGb: number; freePct: number } | null {
  if (!disk || !disk.totalBytes) return null
  const freePct = (disk.freeBytes / disk.totalBytes) * 100
  if (freePct >= 10 && disk.freeBytes >= 1024 ** 3) return null
  return { freeGb: disk.freeBytes / 1024 ** 3, freePct }
}

/** One round of the hourly checks. */
export function runOpsChecks(now = Date.now()): void {
  try {
    const dataDir = path.dirname(CONTENT_DB_PATH)
    const low = diskAlert(diskInfo(fs.existsSync(dataDir) ? dataDir : process.cwd()))
    if (low) opsAlert({ type: 'disk-low', ...low }, now)
  } catch (err) {
    log.warn('ops checks failed', { err })
  }
}

const CHANGES_EVERY_MS = 5 * 60_000

/**
 * New waiting proposals of connected apps since `since` (epoch ms), oldest
 * first; at most 20 a round (the daily cap of lib/ops/alerts applies too).
 */
export function newWaitingChanges(since: number, now = Date.now()): Array<{ id: string; title: string; createdAt: number }> {
  return (
    getAiDb()
      .prepare(
        `SELECT id, title, created_at AS createdAt FROM ai_changes
         WHERE state = 'waiting' AND actor_kind = 'mcp' AND created_at > ? AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY created_at ASC LIMIT 20`,
      )
      .all(since, now) as Array<{ id: string; title: string; createdAt: number }>
  )
}

let changesSince = 0

/** One round of the proposal check: announce what arrived since the last round. */
export function runChangeCheck(now = Date.now()): void {
  try {
    if (!changesSince) changesSince = now
    const fresh = newWaitingChanges(changesSince, now)
    for (const c of fresh) {
      opsAlert({ type: 'ai-change', id: c.id, title: c.title }, now)
      changesSince = Math.max(changesSince, c.createdAt)
    }
  } catch (err) {
    log.warn('AI change check failed', { err })
  }
}

/** Test seam: where the next proposal check starts. */
export function setChangeCheckCursor(ms: number): void {
  changesSince = ms
}

type WatchGlobal = typeof globalThis & { __opsWatchTimer?: ReturnType<typeof setInterval> | null }

export function startOpsWatch(env: Record<string, string | undefined> = process.env): void {
  const g = globalThis as WatchGlobal
  if (g.__opsWatchTimer) return
  if (env.R2_BOOT_SYNC_FAILED === '1') opsAlert({ type: 'r2-boot-sync-failed' })
  // Proposals made before this start were the previous process's to announce.
  changesSince = Date.now()
  const first = setTimeout(() => runOpsChecks(), FIRST_CHECK_MS)
  g.__opsWatchTimer = setInterval(() => runOpsChecks(), HOUR_MS)
  const changes = setInterval(() => runChangeCheck(), CHANGES_EVERY_MS)
  for (const t of [first, g.__opsWatchTimer, changes]) (t as { unref?: () => void }).unref?.()
}
