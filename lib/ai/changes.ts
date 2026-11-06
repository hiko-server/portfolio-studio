import crypto from 'node:crypto'
import zlib from 'node:zlib'
import type { AiActor } from './audit'
import { getAiDb } from './db'
import { canonicalJson, previewSha256, sha256Hex, type BeforeState, type Preview } from './plans/types'
import type { Risk } from './toolTypes'

/**
 * AI changes (SERVER-ONLY, design §3.2 `ai_changes`, §5.3): every AI write,
 * as a row in ai.db with a state.
 *
 * An applied draft (stage M2) is recorded fail-closed around its write:
 * the row goes in as `applying` — with the canonical arguments, the
 * preview and the complete state the write replaces (`before_gz`, what an
 * undo restores) — before anything is written; it becomes `applied` with
 * the result once the write succeeded, and is removed when the write was
 * refused before changing anything. A row that cannot be stored stops the
 * write. A process that dies between the two leaves `applying`, which reads
 * as `failed` after five minutes (lib/ai/tools/changes stateAt).
 *
 * Retention (§3.2), pruned on every recorded write: rows 400 days; the
 * arguments, preview and before-state of a finished row 90 days; and all of
 * those together at most 256 MB — past it the oldest finished rows lose them
 * first, except the earliest before-state of each target (the state before
 * AI first touched it), which stays for its 90 days.
 *
 * The withdrawal of what is still open when access ends: a
 * change is "open" while it waits for the owner (`waiting`) or sits in an
 * editor (`in_editor`); once the app that asked loses access, or AI access is
 * turned off, nothing it asked for may still be applied, so those rows
 * become `voided` with the reason in `error_code`:
 *
 *   ACCESS_OFF      AI access was turned off (§5.2)
 *   ISSUER_ENDED    the connected app was revoked, or the browser that made
 *                   it was signed out (§5.4)
 *
 * The approve route checks the issuer again in any case (§5.3 step 4), so a
 * row this could not reach (ai.db unreadable at that moment) still cannot be
 * applied.
 */

export type VoidReason = 'ACCESS_OFF' | 'ISSUER_ENDED'

const OPEN_STATES = ['waiting', 'in_editor'] as const

/**
 * Void every open change — of the given actors (grant ids, or run ids for
 * the assistant), or all of them. Returns how many rows changed.
 */
export function voidOpenChanges(which: { all: true } | { actorIds: readonly string[] }, reason: VoidReason, now = Date.now()): number {
  const states = OPEN_STATES.map(() => '?').join(', ')
  const db = getAiDb()
  if ('all' in which) {
    return db.prepare(`UPDATE ai_changes SET state = 'voided', error_code = ?, decided_at = ? WHERE state IN (${states})`).run(reason, now, ...OPEN_STATES).changes
  }
  const ids = Array.from(new Set(which.actorIds.filter((id) => typeof id === 'string' && id)))
  if (!ids.length) return 0
  return db
    .prepare(`UPDATE ai_changes SET state = 'voided', error_code = ?, decided_at = ? WHERE state IN (${states}) AND actor_id IN (${ids.map(() => '?').join(', ')})`)
    .run(reason, now, ...OPEN_STATES, ...ids).changes
}

/** Changes waiting for the owner's decision (the status strip's count; read-only). */
export function waitingCount(now = Date.now()): number {
  const row = getAiDb()
    .prepare(`SELECT count(*) AS n FROM ai_changes WHERE state = 'waiting' AND (expires_at IS NULL OR expires_at > ?)`)
    .get(now) as { n: number }
  return Number(row.n) || 0
}

// ── Applied drafts (stage M2) ────────────────────────────────────────────

const DAY = 86_400_000

export const CHANGE_RETENTION = Object.freeze({
  /** Rows are kept this long. */
  rowsMs: 400 * DAY,
  /** The arguments, preview and before-state of a finished row, this long. */
  blobsMs: 90 * DAY,
  /** The arguments, previews and before-states of all rows together. */
  capBytes: 256 * 1024 * 1024,
})

/** States a row can still leave by itself or by the owner: their stored data is never evicted early. */
const LIVE_STATES = ['waiting', 'applying', 'in_editor'] as const

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

/** A change id: `ch_` and 16 random base32 letters (80 bits). A name, not a capability. */
export function newChangeId(): string {
  const bytes = crypto.randomBytes(10)
  let bits = 0
  let value = 0
  let out = ''
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  return `ch_${out}`
}

const gzip = (value: unknown) => zlib.gzipSync(Buffer.from(canonicalJson(value), 'utf8'))
const gunzipJson = <T>(blob: unknown): T | null => {
  if (!blob || !(blob instanceof Uint8Array)) return null
  try {
    return JSON.parse(zlib.gunzipSync(blob).toString('utf8')) as T
  } catch {
    return null
  }
}

export type NewChange = {
  id: string
  risk: Exclude<Risk, 'read'>
  tool: string
  kind: string
  actor: AiActor
  /** The session version when the change was made (an approval refuses an older one). */
  issuerVersion: number
  target: { kind: string; ref: string }
  title: string
  baseVersion: string | null
  args: Record<string, unknown>
  preview: Preview
  before: BeforeState
  rationale: string | null
}

const actorId = (a: AiActor) => (a.kind === 'mcp' ? a.grantId : a.runId)
const actorLabel = (a: AiActor) => (a.kind === 'mcp' ? a.label : `${a.provider} · ${a.model}`).slice(0, 120)

/** Store a change about to be applied (`applying`). Throws when it cannot be stored: the write must not run. */
export function beginAppliedChange(c: NewChange, now = Date.now()): void {
  getAiDb()
    .prepare(
      `INSERT INTO ai_changes (id, state, risk, tool, kind, actor_kind, actor_id, actor_label, issuer_version, provider, model, conversation_id,
         target_kind, target_ref, title, base_version, args_json, args_sha256, preview_gz, preview_sha256, before_gz, rationale, created_at)
       VALUES (?, 'applying', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      c.id,
      c.risk,
      c.tool,
      c.kind,
      c.actor.kind,
      actorId(c.actor),
      actorLabel(c.actor),
      c.issuerVersion,
      c.actor.kind === 'assistant' ? c.actor.provider.slice(0, 64) : null,
      c.actor.kind === 'assistant' ? c.actor.model.slice(0, 128) : null,
      c.target.kind,
      c.target.ref.slice(0, 200),
      c.title.slice(0, 300),
      c.baseVersion,
      canonicalJson(c.args),
      sha256Hex(canonicalJson(c.args)),
      gzip(c.preview),
      previewSha256(c.preview),
      gzip(c.before),
      c.rationale ? c.rationale.slice(0, 500) : null,
      now,
    )
}

/** The write succeeded: the row becomes `applied`, with what it produced. False when the row could not be updated. */
export function finishAppliedChange(id: string, result: Record<string, unknown>, now = Date.now()): boolean {
  return getAiDb().prepare(`UPDATE ai_changes SET state = 'applied', result_json = ?, applied_at = ? WHERE id = ? AND state = 'applying'`).run(canonicalJson(result), now, id).changes === 1
}

/** The write was refused before anything changed: the row goes. */
export function dropAppliedChange(id: string): void {
  getAiDb().prepare(`DELETE FROM ai_changes WHERE id = ? AND state = 'applying'`).run(id)
}

/** The complete state a change replaced (undo), or null once it was pruned. */
export function beforeStateOf(id: string): BeforeState | null {
  const row = getAiDb().prepare('SELECT before_gz FROM ai_changes WHERE id = ?').get(id) as { before_gz: unknown } | undefined
  return row ? gunzipJson<BeforeState>(row.before_gz) : null
}

/** The preview a change was recorded with, or null once it was pruned. */
export function previewOf(id: string): Preview | null {
  const row = getAiDb().prepare('SELECT preview_gz FROM ai_changes WHERE id = ?').get(id) as { preview_gz: unknown } | undefined
  return row ? gunzipJson<Preview>(row.preview_gz) : null
}

/** Items an actor created as drafts that were not undone (the per-grant cap counts those still existing). */
export function createdDraftTargets(actor: AiActor): Array<{ collection: string; slug: string }> {
  const rows = getAiDb()
    .prepare(`SELECT DISTINCT target_kind, target_ref FROM ai_changes WHERE actor_kind = ? AND actor_id = ? AND kind = 'item.create' AND state = 'applied'`)
    .all(actor.kind, actorId(actor)) as Array<{ target_kind: string; target_ref: string }>
  return rows.map((r) => ({ collection: r.target_kind, slug: r.target_ref }))
}

/** Bytes the arguments, previews and before-states take together. */
export function changeStorageBytes(): number {
  const row = getAiDb()
    .prepare('SELECT coalesce(sum(coalesce(length(args_json), 0) + coalesce(length(preview_gz), 0) + coalesce(length(before_gz), 0)), 0) AS n FROM ai_changes')
    .get() as { n: number }
  return Number(row.n) || 0
}

export type PruneReport = { deleted: number; expired: number; evicted: number }

/** Apply the retention rules of §3.2. Never throws (a failed prune is retried on the next write). */
export function pruneChanges(now = Date.now(), capBytes: number = CHANGE_RETENTION.capBytes): PruneReport {
  const report: PruneReport = { deleted: 0, expired: 0, evicted: 0 }
  const db = getAiDb()
  const live = LIVE_STATES.map(() => '?').join(', ')
  try {
    db.transaction(() => {
      report.deleted = db.prepare('DELETE FROM ai_changes WHERE created_at < ?').run(now - CHANGE_RETENTION.rowsMs).changes
      report.expired = db
        .prepare(
          `UPDATE ai_changes SET args_json = NULL, preview_gz = NULL, before_gz = NULL
           WHERE created_at < ? AND state NOT IN (${live}) AND (args_json IS NOT NULL OR preview_gz IS NOT NULL OR before_gz IS NOT NULL)`,
        )
        .run(now - CHANGE_RETENTION.blobsMs, ...LIVE_STATES).changes
      let total = changeStorageBytes()
      if (total <= capBytes) return
      // The earliest before-state of each target: the state before AI first touched it.
      const kept = new Set(
        (
          db
            .prepare(
              `SELECT c.id AS id FROM ai_changes c WHERE c.before_gz IS NOT NULL AND c.id = (
                 SELECT d.id FROM ai_changes d WHERE d.target_kind = c.target_kind AND d.target_ref = c.target_ref AND d.before_gz IS NOT NULL
                 ORDER BY d.created_at ASC, d.id ASC LIMIT 1)`,
            )
            .all() as Array<{ id: string }>
        ).map((r) => r.id),
      )
      const rows = db
        .prepare(
          `SELECT id, coalesce(length(args_json), 0) AS a, coalesce(length(preview_gz), 0) AS p, coalesce(length(before_gz), 0) AS b FROM ai_changes
           WHERE state NOT IN (${live}) AND (args_json IS NOT NULL OR preview_gz IS NOT NULL OR before_gz IS NOT NULL) ORDER BY created_at ASC, id ASC`,
        )
        .all(...LIVE_STATES) as Array<{ id: string; a: number; p: number; b: number }>
      const stripAll = db.prepare('UPDATE ai_changes SET args_json = NULL, preview_gz = NULL, before_gz = NULL WHERE id = ?')
      const stripKeep = db.prepare('UPDATE ai_changes SET args_json = NULL, preview_gz = NULL WHERE id = ?')
      for (const r of rows) {
        if (total <= capBytes) break
        const keepBefore = kept.has(r.id)
        const freed = r.a + r.p + (keepBefore ? 0 : r.b)
        if (freed === 0) continue
        ;(keepBefore ? stripKeep : stripAll).run(r.id)
        total -= freed
        report.evicted++
      }
    })()
  } catch {
    // ai.db unwritable right now: the next write prunes.
  }
  return report
}

// ── Waiting changes: proposals, held edits, drafts the owner approves (stage M3) ─

/** How long a change waits for the owner (§5.3): the version check and the preview hash stop a stale approval anyway. */
export const WAITING_MS = 7 * DAY
/** An approval stuck in `applying` this long reads as failed (lib/ai/tools/changes stateAt). */
export const APPLYING_STALE_MS = 5 * 60_000

/** Store a change that waits for the owner (`waiting`, expires in 7 days). Throws when it cannot be stored. */
export function insertWaitingChange(c: NewChange, now = Date.now()): void {
  getAiDb()
    .prepare(
      `INSERT INTO ai_changes (id, state, risk, tool, kind, actor_kind, actor_id, actor_label, issuer_version, provider, model, conversation_id,
         target_kind, target_ref, title, base_version, args_json, args_sha256, preview_gz, preview_sha256, before_gz, rationale, created_at, expires_at)
       VALUES (?, 'waiting', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      c.id,
      c.risk,
      c.tool,
      c.kind,
      c.actor.kind,
      actorId(c.actor),
      actorLabel(c.actor),
      c.issuerVersion,
      c.actor.kind === 'assistant' ? c.actor.provider.slice(0, 64) : null,
      c.actor.kind === 'assistant' ? c.actor.model.slice(0, 128) : null,
      c.target.kind,
      c.target.ref.slice(0, 200),
      c.title.slice(0, 300),
      c.baseVersion,
      canonicalJson(c.args),
      sha256Hex(canonicalJson(c.args)),
      gzip(c.preview),
      previewSha256(c.preview),
      gzip(c.before),
      c.rationale ? c.rationale.slice(0, 500) : null,
      now,
      now + WAITING_MS,
    )
}

/** Changes still waiting that one actor (a grant, or an assistant run) made. */
export function waitingCountOf(actor: AiActor, now = Date.now()): number {
  const row = getAiDb()
    .prepare(`SELECT count(*) AS n FROM ai_changes WHERE state = 'waiting' AND actor_kind = ? AND actor_id = ? AND (expires_at IS NULL OR expires_at > ?)`)
    .get(actor.kind, actorId(actor), now) as { n: number }
  return Number(row.n) || 0
}

export type ChangeRow = {
  id: string
  state: string
  risk: 'draft' | 'live' | 'destructive'
  tool: string
  kind: string
  actor_kind: 'mcp' | 'assistant'
  actor_id: string
  actor_label: string
  issuer_version: number
  provider: string | null
  model: string | null
  conversation_id: string | null
  target_kind: string
  target_ref: string
  title: string
  base_version: string | null
  args_json: string | null
  args_sha256: string
  preview_sha256: string
  rationale: string | null
  reject_note: string | null
  result_json: string | null
  error_code: string | null
  decided_session: string | null
  created_at: number
  expires_at: number | null
  decided_at: number | null
  applied_at: number | null
  undone_at: number | null
}

const ROW_COLUMNS =
  'id, state, risk, tool, kind, actor_kind, actor_id, actor_label, issuer_version, provider, model, conversation_id, target_kind, target_ref, title, base_version, args_json, args_sha256, preview_sha256, rationale, reject_note, result_json, error_code, decided_session, created_at, expires_at, decided_at, applied_at, undone_at'

/** One change, as stored (no blobs), or null. */
export function changeRow(id: string): ChangeRow | null {
  return (getAiDb().prepare(`SELECT ${ROW_COLUMNS} FROM ai_changes WHERE id = ?`).get(id) as ChangeRow | undefined) ?? null
}

/** The state a row reads as at `now`: a waiting or in-editor row past its expiry is expired, a stuck approval failed. */
export function stateAt(row: Pick<ChangeRow, 'state' | 'expires_at' | 'decided_at' | 'created_at'>, now: number): string {
  if ((row.state === 'waiting' || row.state === 'in_editor') && row.expires_at !== null && row.expires_at <= now) return 'expired'
  if (row.state === 'applying' && (row.decided_at ?? row.created_at) + APPLYING_STALE_MS <= now) return 'failed'
  return row.state
}

/** Make an expired waiting row `expired` in the store (lazy expiry, §5.3 step 2). True when it was. */
export function expireIfDue(id: string, now = Date.now()): boolean {
  return (
    getAiDb()
      .prepare(`UPDATE ai_changes SET state = 'expired', decided_at = ? WHERE id = ? AND state IN ('waiting', 'in_editor') AND expires_at IS NOT NULL AND expires_at <= ?`)
      .run(now, id, now).changes === 1
  )
}

/** A terminal decision on a waiting row (voided, failed): true when this call made it. */
export function settleWaiting(id: string, state: 'voided' | 'failed', code: string, now = Date.now()): boolean {
  return getAiDb().prepare(`UPDATE ai_changes SET state = ?, error_code = ?, decided_at = ? WHERE id = ? AND state = 'waiting'`).run(state, code, now, id).changes === 1
}

/** The single-use claim of an approval (§5.3 step 6): exactly one caller moves a waiting row to `applying`. */
export function claimForApply(id: string, sessionId: string, now = Date.now()): boolean {
  return getAiDb()
    .prepare(`UPDATE ai_changes SET state = 'applying', decided_session = ?, decided_at = ? WHERE id = ? AND state = 'waiting' AND (expires_at IS NULL OR expires_at > ?)`)
    .run(sessionId, now, id, now).changes === 1
}

/** Nothing was written and nothing went wrong on our side (the activity log was unavailable): the change waits again. */
export function releaseClaim(id: string): boolean {
  return getAiDb().prepare(`UPDATE ai_changes SET state = 'waiting', decided_session = NULL, decided_at = NULL WHERE id = ? AND state = 'applying'`).run(id).changes === 1
}

/** An approval that did not write: `conflict` (the content changed after the proposal) or `failed`. */
export function finishClaim(id: string, state: 'conflict' | 'failed', code: string, now = Date.now()): boolean {
  return getAiDb().prepare(`UPDATE ai_changes SET state = ?, error_code = ?, decided_at = ? WHERE id = ? AND state = 'applying'`).run(state, code, now, id).changes === 1
}

/** The approval wrote: `applied`, with what it produced. */
export function markApplied(id: string, result: Record<string, unknown>, now = Date.now()): boolean {
  return getAiDb().prepare(`UPDATE ai_changes SET state = 'applied', result_json = ?, applied_at = ? WHERE id = ? AND state = 'applying'`).run(canonicalJson(result), now, id).changes === 1
}

/** The owner rejected a waiting change, optionally saying why (returned by get_change). */
export function markRejected(id: string, note: string | null, sessionId: string, now = Date.now()): boolean {
  return (
    getAiDb()
      .prepare(`UPDATE ai_changes SET state = 'rejected', reject_note = ?, decided_session = ?, decided_at = ? WHERE id = ? AND state = 'waiting' AND (expires_at IS NULL OR expires_at > ?)`)
      .run(note, sessionId, now, id, now).changes === 1
  )
}

/** An applied change was undone. */
export function markUndone(id: string, now = Date.now()): boolean {
  return getAiDb().prepare(`UPDATE ai_changes SET state = 'undone', undone_at = ? WHERE id = ? AND state = 'applied'`).run(now, id).changes === 1
}

/** The stored arguments of a change, parsed, or null once pruned (or unreadable). */
export function argsOf(row: Pick<ChangeRow, 'args_json'>): Record<string, unknown> | null {
  if (!row.args_json) return null
  try {
    const v = JSON.parse(row.args_json)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** What an applied change produced (result_json), or {}. */
export function resultOf(row: Pick<ChangeRow, 'result_json'>): Record<string, any> {
  if (!row.result_json) return {}
  try {
    const v = JSON.parse(row.result_json)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

/**
 * The approved held edit that wrote exactly this version of an item, if any:
 * the scheduler's log line names it when it publishes that revision (§4.6;
 * pages/api/internal/scheduled-publish supplies it through deps.record).
 */
export function approvedHeldEditAt(collection: string, slug: string, version: string): { id: string; approvedOn: string | null } | null {
  const rows = getAiDb()
    .prepare(`SELECT id, result_json FROM ai_changes WHERE target_kind = ? AND target_ref = ? AND kind = 'item.edit-held' AND state = 'applied' ORDER BY applied_at DESC LIMIT 20`)
    .all(collection, slug) as Array<{ id: string; result_json: string | null }>
  for (const r of rows) {
    const result = resultOf(r)
    if (result.version === version) return { id: r.id, approvedOn: typeof result.approvedOn === 'string' ? result.approvedOn : null }
  }
  return null
}

/** An earlier AI change applied to the same target (the card's display-only "AI-written earlier" flag). */
export function earlierAiChange(targetKind: string, targetRef: string, beforeAt: number, exceptId: string): string | null {
  const row = getAiDb()
    .prepare(`SELECT id FROM ai_changes WHERE target_kind = ? AND target_ref = ? AND state IN ('applied', 'undone') AND id != ? AND created_at <= ? ORDER BY created_at DESC LIMIT 1`)
    .get(targetKind, targetRef, exceptId, beforeAt) as { id: string } | undefined
  return row?.id ?? null
}

/**
 * Applied AI schedules (§5.2, §5.4): items an approved `item.schedule`
 * change scheduled — of some actors, or all — so turning AI off or revoking
 * an app can offer to clear them (R17).
 */
export function appliedSchedules(which: { all: true } | { actorIds: readonly string[] }): Array<{ changeId: string; collection: string; slug: string; appliedAt: number }> {
  const db = getAiDb()
  const base = `SELECT id, target_kind, target_ref, applied_at FROM ai_changes WHERE kind = 'item.schedule' AND state = 'applied'`
  const rows = (
    'all' in which
      ? db.prepare(`${base} ORDER BY applied_at DESC LIMIT 200`).all()
      : which.actorIds.length
        ? db.prepare(`${base} AND actor_id IN (${which.actorIds.map(() => '?').join(', ')}) ORDER BY applied_at DESC LIMIT 200`).all(...which.actorIds)
        : []
  ) as Array<{ id: string; target_kind: string; target_ref: string; applied_at: number }>
  return rows.map((r) => ({ changeId: r.id, collection: r.target_kind, slug: r.target_ref, appliedAt: r.applied_at }))
}
