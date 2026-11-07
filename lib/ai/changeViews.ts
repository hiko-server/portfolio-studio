import { runPublishChecks } from '../../components/Admin/shell/publishChecks'
import { listItems } from '../contentStore'
import { getPublicHost } from '../env'
import { isSafeSlug, readOne } from '../mdx-admin'
import { getPendingRevision } from '../pendingRevisions'
import { editorBaseText } from '../../components/Admin/ai/editorBase'
import { argsOf, beforeStateOf, earlierAiChange, previewOf, resultOf, stateAt, type ChangeRow } from './changes'
import { getAiDb } from './db'
import { currentVersionFor, EDITOR_SAVE_KINDS, undoAvailability } from './apply'
import { sha256Hex } from './plans/types'

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
  'id, state, risk, tool, kind, actor_kind, actor_id, actor_label, issuer_version, issuer_session, provider, model, conversation_id, target_kind, target_ref, title, base_version, args_json, args_sha256, preview_sha256, rationale, reject_note, result_json, error_code, decided_session, created_at, expires_at, decided_at, applied_at, undone_at'

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
 * The editor's pre-publish checklist (components/Admin/shell/publishChecks)
 * on the version a waiting publish would make live — its unpublished
 * changes, or the draft itself. Display-only (§5.3): computed when the card
 * loads, never hashed; the card's diff is what is approved. Null when the
 * item cannot be read.
 */
export function publishChecksOf(row: Pick<ChangeRow, 'kind' | 'target_kind' | 'target_ref'>) {
  if (row.kind !== 'item.publish' || (row.target_kind !== 'blog' && row.target_kind !== 'work') || !isSafeSlug(row.target_ref)) return null
  const c = row.target_kind
  const item = readOne(c, row.target_ref)
  if (!item) return null
  const pending = getPendingRevision(c, row.target_ref)
  const fm = (pending?.frontmatter ?? item.frontmatter) as Record<string, any>
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const slugs = (col: 'blog' | 'work') => listItems(col).map((i) => i.slug)
  const checks = runPublishChecks({
    title: str(fm.title),
    description: str(fm.description),
    body: pending?.body ?? item.body,
    slug: row.target_ref,
    cover: str(fm.cover),
    collection: c,
    knownSlugs: { blog: slugs('blog'), work: slugs('work') },
    siteHost: getPublicHost() ?? undefined,
    ...(c === 'work' ? { summary: str(fm.summary), outcomes: Array.isArray(fm.outcomes) ? fm.outcomes : [] } : {}),
  })
  return checks.map((k) => ({ id: k.id, level: k.level, label: k.label, ...(k.detail ? { detail: k.detail } : {}) }))
}

/** A display-only part of the card that must not stop the card from loading. */
function quietly<T>(read: () => T): T | null {
  try {
    return read()
  } catch {
    return null
  }
}

/**
 * What an editor needs to put a change in front of the owner (§7.8, §8.2
 * Open in editor): the body after the change, the fields it sets and
 * removes, and the hash of the editor text it was computed from
 * (components/Admin/ai/editorBase). A suggestion sent to an open editor
 * carries its own; a waiting post, case-study or page edit is bound to the
 * stored text it was proposed from. Only while the change is still open
 * (in the editor, or waiting); null otherwise.
 */
export function editorPayloadOf(row: ChangeRow, now = Date.now()) {
  if (!EDITOR_SAVE_KINDS.has(row.kind)) return null
  const state = stateAt(row, now)
  if (state !== 'in_editor' && state !== 'waiting') return null
  const args = argsOf(row)
  if (!args || typeof args.body !== 'string') return null
  const patch = args.frontmatter_patch && typeof args.frontmatter_patch === 'object' && !Array.isArray(args.frontmatter_patch) ? (args.frontmatter_patch as Record<string, unknown>) : null
  const removed = Array.isArray(args.remove_frontmatter) ? args.remove_frontmatter.filter((k): k is string => typeof k === 'string') : []
  const keys = Array.from(new Set([...Object.keys(patch ?? {}), ...removed])).sort()
  let baseHash: string | null = typeof args.base_hash === 'string' ? args.base_hash : null
  if (!baseHash) {
    const before = beforeStateOf(row.id)
    const shown = before?.kind === 'item' ? (before.pending ?? before.live) : before?.kind === 'page' ? before.page : null
    if (!shown) return null
    baseHash = sha256Hex(editorBaseText({ frontmatter: shown.frontmatter, body: shown.body }, keys))
  }
  return { base_hash: baseHash, after_body: args.body, frontmatter_patch: patch, remove_frontmatter: removed, keys }
}

/**
 * The AI change the target's current version came from, if any — what
 * "Contains AI edits" names in the publish sheet and the schedule dialog
 * (§4.6): the latest applied change of the target whose result version is
 * the target's version now. Null when it holds none, or cannot be read.
 */
export function aiTouchOf(targetKind: string, targetRef: string) {
  const row = getAiDb()
    .prepare(
      `SELECT id, title, kind, actor_kind, actor_label, provider, model, applied_at, result_json FROM ai_changes
       WHERE target_kind = ? AND target_ref = ? AND state = 'applied' ORDER BY applied_at DESC, id DESC LIMIT 1`,
    )
    .get(targetKind, targetRef) as
    | { id: string; title: string; kind: string; actor_kind: string; actor_label: string; provider: string | null; model: string | null; applied_at: number | null; result_json: string | null }
    | undefined
  if (!row) return null
  const version = resultOf(row).version
  if (typeof version !== 'string' || version !== currentVersionFor(targetKind, targetRef)) return null
  return { id: row.id, title: row.title, kind: row.kind, actor: { kind: row.actor_kind, label: row.actor_label, provider: row.provider, model: row.model }, applied_at: iso(row.applied_at) }
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
    notes: {
      ai_written_earlier: earlierAiChange(row.target_kind, row.target_ref, row.created_at, row.id),
      publish_checks: stateAt(row, now) === 'waiting' ? quietly(() => publishChecksOf(row)) : null,
    },
    editor: quietly(() => editorPayloadOf(row, now)),
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
