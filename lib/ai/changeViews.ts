import { earlierAiChange, previewOf, resultOf, stateAt, type ChangeRow } from './changes'
import { getAiDb } from './db'
import { undoAvailability } from './apply'

/**
 * What the owner's pages show of AI changes (SERVER-ONLY): the Changes list
 * and one change's card (pages/api/admin/ai/changes). Admin only — the
 * issuer reads its own rows through get_change and list_my_changes, which
 * never return the preview, flags or the before-state. The before-state is
 * never sent to a browser at all (§3.2).
 */

const iso = (ms: number | null) => (typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : null)

/** One row as a list item: no preview, no arguments. The model's rationale is labelled as its words. */
export function changeListItem(row: ChangeRow, now: number) {
  const state = stateAt(row, now)
  return {
    id: row.id,
    state,
    risk: row.risk,
    kind: row.kind,
    tool: row.tool,
    title: row.title,
    target: { kind: row.target_kind, ref: row.target_ref },
    actor: { kind: row.actor_kind, id: row.actor_id, label: row.actor_label, provider: row.provider, model: row.model },
    rationale: row.rationale,
    created_at: iso(row.created_at),
    expires_at: state === 'waiting' ? iso(row.expires_at) : null,
    decided_at: iso(row.decided_at),
    applied_at: iso(row.applied_at),
    undone_at: iso(row.undone_at),
    code: row.error_code,
    reject_note: row.reject_note,
  }
}

const COLUMNS =
  'id, state, risk, tool, kind, actor_kind, actor_id, actor_label, issuer_version, provider, model, conversation_id, target_kind, target_ref, title, base_version, args_json, args_sha256, preview_sha256, rationale, reject_note, result_json, error_code, decided_session, created_at, expires_at, decided_at, applied_at, undone_at'

export type ChangeListFilter = { state: 'waiting' | 'done' | 'all'; actorId?: string; area?: string; cursor?: string; limit?: number }

/** The Changes view: waiting first (oldest first, the queue), or decided ones newest first, or all. */
export function listChanges(filter: ChangeListFilter, now = Date.now()) {
  const where: string[] = []
  const params: unknown[] = []
  if (filter.state === 'waiting') {
    where.push(`state = 'waiting' AND (expires_at IS NULL OR expires_at > ?)`)
    params.push(now)
  } else if (filter.state === 'done') {
    where.push(`NOT (state = 'waiting' AND (expires_at IS NULL OR expires_at > ?))`)
    params.push(now)
  }
  if (filter.actorId) {
    where.push('actor_id = ?')
    params.push(filter.actorId)
  }
  if (filter.area) {
    where.push('target_kind = ?')
    params.push(filter.area)
  }
  const offset = /^o\d{1,6}$/.test(filter.cursor ?? '') ? Number(String(filter.cursor).slice(1)) : 0
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 100)
  const order = filter.state === 'waiting' ? 'created_at ASC, id' : 'created_at DESC, id'
  const rows = getAiDb()
    .prepare(`SELECT ${COLUMNS} FROM ai_changes ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...params, limit + 1, offset) as ChangeRow[]
  const more = rows.length > limit
  return { items: rows.slice(0, limit).map((r) => changeListItem(r, now)), next_cursor: more ? `o${offset + limit}` : null }
}

/**
 * One change as its card shows it: the stored preview and its hash (the
 * browser sends the hash back to approve exactly this), what the change
 * produced, whether it can be undone now, and display-only notes computed
 * on load and never hashed (an earlier AI change to the same target).
 */
export function changeDetail(row: ChangeRow, now = Date.now()) {
  const result = row.state === 'applied' || row.state === 'undone' ? resultOf(row) : null
  const undo = undoAvailability(row)
  return {
    ...changeListItem(row, now),
    preview: previewOf(row.id),
    preview_sha256: row.preview_sha256,
    base_version: row.base_version,
    result,
    undo: undo.ok ? { available: true } : { available: false, code: undo.code, message: undo.message },
    notes: { ai_written_earlier: earlierAiChange(row.target_kind, row.target_ref, row.created_at, row.id) },
  }
}

/** The All calls view (ai_tool_calls, 30 days): newest first, never arguments or results. */
export function listCalls(filter: { actorId?: string; cursor?: string; limit?: number }) {
  const offset = /^o\d{1,6}$/.test(filter.cursor ?? '') ? Number(String(filter.cursor).slice(1)) : 0
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 200)
  const rows = getAiDb()
    .prepare(
      `SELECT id, at, actor_kind, actor_id, actor_label, tool, target, risk, outcome, code, ms, bytes_out, ip_prefix, country, era FROM ai_tool_calls
       ${filter.actorId ? 'WHERE actor_id = ?' : ''} ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(...(filter.actorId ? [filter.actorId] : []), limit + 1, offset) as Array<Record<string, unknown>>
  const more = rows.length > limit
  return {
    items: rows.slice(0, limit).map((r) => ({ ...r, at: iso(Number(r.at)) })),
    next_cursor: more ? `o${offset + limit}` : null,
  }
}
