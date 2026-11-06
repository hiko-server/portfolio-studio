import { getAuditDb } from './db'
import type { AuditDescription } from './describe'
import type { SnapshotKind } from './context'

/**
 * Reads and writes of the activity log (data/audit.db, lib/audit/db.ts).
 *
 * Retention: entries older than AUDIT_KEEP_DAYS are deleted, and at most
 * AUDIT_KEEP_ROWS are kept (oldest first out); pruning runs at most once an
 * hour, from a write. Nothing here may throw into an admin action — the
 * capture wraps every call.
 *
 * AI writes (lib/ai/audit) are recorded the other way round, fail closed: an
 * intent row with status 0 BEFORE the write runs (it refuses when that row
 * cannot be written), then the write's status, or the row is removed when
 * the write was refused before it changed anything. A status-0 row younger
 * than INTENT_GRACE_MS is a write still running and is not listed; an older
 * one is a write that never finished (the process stopped) and reads as
 * interrupted. AI rows carry the AI columns (actor kind, grant or run, tool,
 * argument hash, …); a person's own writes leave them empty.
 */

export const AUDIT_KEEP_DAYS = 400
export const AUDIT_KEEP_ROWS = 20_000
export const AUDIT_PAGE_MAX = 200
const PRUNE_EVERY_MS = 60 * 60_000
/** How long a status-0 (in flight) AI write stays hidden before it reads as interrupted. */
export const INTENT_GRACE_MS = 60_000

export type AuditActor = {
  sessionId: string | null
  device: string | null
  ipPrefix: string | null
  country: string | null
}

export type AuditActorKind = 'mcp' | 'assistant'

/** The AI columns of an entry (audit.db v2); only AI writes have them. */
export type AuditAiColumns = {
  actorKind: AuditActorKind
  /** The connected app as the owner labelled it, or its verified host; never a self-reported name. */
  client: string | null
  grantId: string | null
  provider: string | null
  model: string | null
  runId: string | null
  tool: string | null
  argsSha256: string | null
  toolListHash: string | null
  changeId: string | null
  approvedBySession: string | null
  approvedAt: number | null
}

export type AuditInput = AuditDescription &
  AuditActor & {
    method: string
    route: string
    status: number
    requestId: string | null
    snapshots?: Array<{ kind: SnapshotKind; file: string }>
    ai?: AuditAiColumns | null
  }

export type AuditEntry = AuditDescription &
  AuditActor & {
    id: number
    ts: number
    method: string
    route: string
    status: number
    /** 'mcp' or 'assistant' for an AI write, null for a person's own. */
    actorKind: AuditActorKind | null
    /** An AI write that started and never finished (status 0, older than INTENT_GRACE_MS). */
    interrupted: boolean
  }

type Row = {
  id: number
  ts: number
  action: string
  area: string
  target: string | null
  summary: string
  method: string
  route: string
  status: number
  session_id: string | null
  device: string | null
  ip_prefix: string | null
  country: string | null
  actor_kind: string | null
}

type PruneGlobal = typeof globalThis & { __auditPrunedAt?: number }

function toEntry(r: Row): AuditEntry {
  return {
    id: r.id,
    ts: r.ts,
    action: r.action,
    area: r.area as AuditEntry['area'],
    target: r.target,
    summary: r.summary,
    method: r.method,
    route: r.route,
    status: r.status,
    sessionId: r.session_id,
    device: r.device,
    ipPrefix: r.ip_prefix,
    country: r.country,
    actorKind: r.actor_kind === 'mcp' || r.actor_kind === 'assistant' ? r.actor_kind : null,
    interrupted: r.status === 0,
  }
}

function insertEntry(e: AuditInput, now: number): number {
  const db = getAuditDb()
  return db.transaction(() => {
    const a = e.ai ?? null
    const info = db
      .prepare(
        `INSERT INTO audit_log (ts, action, area, target, summary, method, route, status, session_id, device, ip_prefix, country, request_id,
                                actor_kind, ai_client, ai_grant_id, ai_provider, ai_model, ai_run_id, tool, args_sha256, tool_list_hash, change_id,
                                approved_by_session, approved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        now,
        e.action,
        e.area,
        e.target,
        e.summary,
        e.method,
        e.route,
        e.status,
        e.sessionId,
        e.device,
        e.ipPrefix,
        e.country,
        e.requestId,
        a?.actorKind ?? null,
        a?.client ?? null,
        a?.grantId ?? null,
        a?.provider ?? null,
        a?.model ?? null,
        a?.runId ?? null,
        a?.tool ?? null,
        a?.argsSha256 ?? null,
        a?.toolListHash ?? null,
        a?.changeId ?? null,
        a?.approvedBySession ?? null,
        a?.approvedAt ?? null,
      )
    const rowId = Number(info.lastInsertRowid)
    const link = db.prepare('INSERT OR REPLACE INTO audit_snapshots (audit_id, kind, file) VALUES (?, ?, ?)')
    for (const s of e.snapshots || []) link.run(rowId, s.kind, s.file)
    return rowId
  })()
}

function pruneHourly(now: number): void {
  const g = globalThis as PruneGlobal
  if (!g.__auditPrunedAt || now - g.__auditPrunedAt > PRUNE_EVERY_MS) {
    g.__auditPrunedAt = now
    pruneAudit(now)
  }
}

/** Store one entry (and its snapshot links); returns its id. */
export function recordAudit(e: AuditInput, now = Date.now()): number {
  const id = insertEntry(e, now)
  pruneHourly(now)
  return id
}

/**
 * The intent row of an AI write, before the write runs: status 0, no
 * snapshot links yet. Throws when it cannot be written — the caller then
 * refuses the write (fail closed, design §5.6).
 */
export function recordAuditIntent(e: Omit<AuditInput, 'status' | 'snapshots'> & { ai: AuditAiColumns }, now = Date.now()): number {
  const id = insertEntry({ ...e, status: 0, snapshots: [] }, now)
  try {
    pruneHourly(now)
  } catch {
    // Pruning is housekeeping: the intent row is written, which is what counts.
  }
  return id
}

/** The AI write finished: its status and the version files it took. False when the row is gone. */
export function finishAuditIntent(id: number, status: number, snapshots: ReadonlyArray<{ kind: SnapshotKind; file: string }> = []): boolean {
  const db = getAuditDb()
  return db.transaction(() => {
    const changed = db.prepare('UPDATE audit_log SET status = ? WHERE id = ? AND status = 0').run(status, id).changes
    if (!changed) return false
    const link = db.prepare('INSERT OR REPLACE INTO audit_snapshots (audit_id, kind, file) VALUES (?, ?, ?)')
    for (const s of snapshots) link.run(id, s.kind, s.file)
    return true
  })()
}

/** The AI write was refused before it changed anything: its intent row goes. */
export function discardAuditIntent(id: number): void {
  getAuditDb().prepare('DELETE FROM audit_log WHERE id = ? AND status = 0').run(id)
}

/** Delete entries past the retention period or beyond the row cap; returns how many went. */
export function pruneAudit(now = Date.now(), keepDays = AUDIT_KEEP_DAYS, keepRows = AUDIT_KEEP_ROWS): number {
  const db = getAuditDb()
  return db.transaction(() => {
    const cutoff = now - keepDays * 86_400_000
    const byAge = db.prepare('DELETE FROM audit_log WHERE ts < ?').run(cutoff).changes
    const byCount = db
      .prepare('DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log ORDER BY ts DESC, id DESC LIMIT -1 OFFSET ?)')
      .run(Math.max(0, keepRows)).changes
    db.prepare('DELETE FROM audit_snapshots WHERE audit_id NOT IN (SELECT id FROM audit_log)').run()
    return byAge + byCount
  })()
}

export type AuditQuery = {
  area?: string | null
  /** 'ai': only writes an AI actor made (connected apps and the assistant, approved or not). */
  actor?: 'ai' | null
  /** Case-insensitive text found in the summary, the target or the device. */
  q?: string | null
  /** Only entries older than this time in ms (pagination cursor). */
  before?: number | null
  /** Only entries at or after this time (ms). */
  since?: number | null
  limit?: number
  /** The clock (tests); in-flight AI writes younger than INTENT_GRACE_MS are left out. */
  now?: number
}

/** Newest first. `nextBefore` is the cursor for the following page (null at the end). */
export function listAudit(query: AuditQuery = {}): { entries: AuditEntry[]; nextBefore: number | null } {
  const db = getAuditDb()
  const limit = Math.min(AUDIT_PAGE_MAX, Math.max(1, Math.trunc(query.limit ?? 50)))
  const where: string[] = ['NOT (status = 0 AND ts > ?)']
  const params: unknown[] = [(query.now ?? Date.now()) - INTENT_GRACE_MS]
  if (query.actor === 'ai') where.push('actor_kind IS NOT NULL')
  if (query.area) {
    where.push('area = ?')
    params.push(query.area)
  }
  if (query.before && Number.isFinite(query.before)) {
    where.push('ts < ?')
    params.push(Math.trunc(query.before))
  }
  if (query.since && Number.isFinite(query.since)) {
    where.push('ts >= ?')
    params.push(Math.trunc(query.since))
  }
  const q = (query.q || '').trim().toLowerCase().slice(0, 80)
  if (q) {
    where.push("(lower(summary) LIKE ? ESCAPE '\\' OR lower(coalesce(target, '')) LIKE ? ESCAPE '\\' OR lower(coalesce(device, '')) LIKE ? ESCAPE '\\')")
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    params.push(like, like, like)
  }
  const rows = db
    .prepare(
      `SELECT id, ts, action, area, target, summary, method, route, status, session_id, device, ip_prefix, country, actor_kind
       FROM audit_log WHERE ${where.join(' AND ')} ORDER BY ts DESC, id DESC LIMIT ?`,
    )
    .all(...params, limit + 1) as Row[]
  const more = rows.length > limit
  const entries = rows.slice(0, limit).map(toEntry)
  return { entries, nextBefore: more ? entries[entries.length - 1].ts : null }
}

export type VersionNote = { summary: string; ts: number; device: string | null }

/**
 * For each snapshot file of `kind`, the change that took it — the write
 * whose previous state the file holds. Files without an entry (taken before
 * the log existed, or by a restore drill or scheduled job) are absent.
 */
export function versionNotes(kind: SnapshotKind, files: readonly string[]): Map<string, VersionNote> {
  const out = new Map<string, VersionNote>()
  if (!files.length) return out
  const db = getAuditDb()
  const stmt = db.prepare(
    `SELECT s.file, a.summary, a.ts, a.device FROM audit_snapshots s JOIN audit_log a ON a.id = s.audit_id WHERE s.kind = ? AND s.file = ?`,
  )
  for (const file of files.slice(0, 500)) {
    const row = stmt.get(kind, file) as { file: string; summary: string; ts: number; device: string | null } | undefined
    if (row) out.set(file, { summary: row.summary, ts: row.ts, device: row.device })
  }
  return out
}

/**
 * For each snapshot file of `kind`, the action code (post.save, home.restore
 * …) and time of the change that took it — versionNotes without the summary
 * and the device. The AI tools list versions with this: a summary can quote
 * a title a model wrote, and a device names the owner's browsers.
 */
export function versionActions(kind: SnapshotKind, files: readonly string[]): Map<string, { action: string; ts: number }> {
  const out = new Map<string, { action: string; ts: number }>()
  if (!files.length) return out
  const stmt = getAuditDb().prepare(
    `SELECT a.action, a.ts FROM audit_snapshots s JOIN audit_log a ON a.id = s.audit_id WHERE s.kind = ? AND s.file = ?`,
  )
  for (const file of files.slice(0, 500)) {
    const row = stmt.get(kind, file) as { action: string; ts: number } | undefined
    if (row) out.set(file, { action: row.action, ts: row.ts })
  }
  return out
}

/** Entry counts per area over the last `days` days (the Activity view's filter chips). */
export function auditAreaCounts(now = Date.now(), days = 30): Record<string, number> {
  const rows = getAuditDb()
    .prepare('SELECT area, count(*) AS n FROM audit_log WHERE ts >= ? AND NOT (status = 0 AND ts > ?) GROUP BY area')
    .all(now - days * 86_400_000, now - INTENT_GRACE_MS) as Array<{ area: string; n: number }>
  return Object.fromEntries(rows.map((r) => [r.area, Number(r.n) || 0]))
}

/** Writes an AI actor made over the last `days` days (the count beside the Activity view's AI filter). */
export function auditAiCount(now = Date.now(), days = 30): number {
  const row = getAuditDb()
    .prepare('SELECT count(*) AS n FROM audit_log WHERE actor_kind IS NOT NULL AND ts >= ? AND NOT (status = 0 AND ts > ?)')
    .get(now - days * 86_400_000, now - INTENT_GRACE_MS) as { n: number }
  return Number(row.n) || 0
}

/**
 * Whether the kept log (AUDIT_KEEP_DAYS) holds any write an AI actor made,
 * and any entry of the "ai" area: the Activity view offers its AI filters
 * whenever there is something they would show, however old.
 */
export function auditAiRetained(now = Date.now(), keepDays = AUDIT_KEEP_DAYS): { writes: boolean; area: boolean } {
  const db = getAuditDb()
  const since = now - keepDays * 86_400_000
  const young = now - INTENT_GRACE_MS
  const writes = db.prepare('SELECT 1 FROM audit_log WHERE actor_kind IS NOT NULL AND ts >= ? AND NOT (status = 0 AND ts > ?) LIMIT 1').get(since, young)
  const area = db.prepare("SELECT 1 FROM audit_log WHERE area = 'ai' AND ts >= ? AND NOT (status = 0 AND ts > ?) LIMIT 1").get(since, young)
  return { writes: !!writes, area: !!area }
}
