import * as z from 'zod'
import { ownedBy, stateAt } from '../changes'
import { getAiDb } from '../db'
import { siteUrl } from '../../mcp/http'
import { READ_ANNOTATIONS, defineTool, ok, pageOf, refuse } from '../toolTypes'

/**
 * get_change and list_my_changes (design §4.2): what became of the changes
 * this caller made — a connected app sees the rows of its own grant, the
 * assistant those of its conversation, whichever run of it made them
 * (lib/ai/changes ownedBy) — read from ai.db `ai_changes`. Any other
 * row answers exactly like an unknown id. The owner's reject note is
 * returned; review flags never are.
 *
 * Rows are written by the write tools (an applied draft: the version it
 * wrote and where the owner edits it; a waiting change: where the owner
 * reviews it) and the approval routes (lib/ai/apply);
 * a state that has run out is shown as it reads now (a waiting change
 * past its expiry is `expired`, an approval stuck in `applying` for five
 * minutes is `failed`) without writing anything here.
 */

export const CHANGE_ID_RE = /^ch_[a-z2-7]{16}$/
const CHANGE_STATES = ['waiting', 'applying', 'applied', 'rejected', 'expired', 'conflict', 'failed', 'undone', 'voided', 'in_editor'] as const

type Row = {
  id: string
  state: string
  risk: string
  kind: string
  title: string
  target_kind: string
  target_ref: string
  reject_note: string | null
  result_json: string | null
  error_code: string | null
  created_at: number
  expires_at: number | null
  decided_at: number | null
  applied_at: number | null
  undone_at: number | null
}

const COLUMNS = 'id, state, risk, kind, title, target_kind, target_ref, reject_note, result_json, error_code, created_at, expires_at, decided_at, applied_at, undone_at'

/** The state as it reads at `now` (lib/ai/changes stateAt). */
export { stateAt }

const iso = (ms: number | null) => (typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : null)

/** What an applied change produced: its public addresses, the version it wrote and where the owner edits it. */
function resultOf(resultJson: string | null): { publicUrls: string[]; version: string | null; editUrl: string | null } {
  const none = { publicUrls: [], version: null, editUrl: null }
  if (!resultJson) return none
  try {
    const parsed = JSON.parse(resultJson) as { publicUrls?: unknown; version?: unknown; editUrl?: unknown }
    return {
      publicUrls: Array.isArray(parsed.publicUrls) ? parsed.publicUrls.filter((u): u is string => typeof u === 'string').slice(0, 50) : [],
      version: typeof parsed.version === 'string' ? parsed.version.slice(0, 64) : null,
      editUrl: typeof parsed.editUrl === 'string' && parsed.editUrl.startsWith('/admin/') ? parsed.editUrl.slice(0, 300) : null,
    }
  } catch {
    return none
  }
}

/** Where the owner reviews a waiting change (the same address a proposal returned). */
function reviewUrl(actorKind: string, id: string): string {
  const site = actorKind === 'mcp' ? siteUrl() : null
  return site ? `${site.origin}/ai/review/${id}` : `/admin/ai/change/${id}`
}

function view(row: Row, now: number, actorKind: string) {
  const state = stateAt(row, now)
  const result = state === 'applied' ? resultOf(row.result_json) : null
  return {
    change_id: row.id,
    state,
    action: row.kind,
    risk: row.risk,
    title: row.title,
    target: { kind: row.target_kind, ref: row.target_ref },
    created_at: iso(row.created_at),
    expires_at: state === 'waiting' || state === 'in_editor' ? iso(row.expires_at) : null,
    ...(state === 'waiting' ? { review_url: reviewUrl(actorKind, row.id) } : {}),
    decided_at: iso(row.decided_at),
    applied_at: iso(row.applied_at),
    undone_at: iso(row.undone_at),
    ...(result ? { public_urls: result.publicUrls, ...(result.version ? { version: result.version } : {}), ...(result.editUrl ? { edit_url: result.editUrl } : {}) } : {}),
    ...(row.reject_note ? { owner_note: row.reject_note } : {}),
    ...(row.error_code ? { code: row.error_code } : {}),
  }
}

const UNKNOWN = 'No change with that id was made through this connection.'

export const getChange = defineTool({
  name: 'get_change',
  title: 'Check a change',
  description:
    'What became of a change this connection made: waiting for the owner, applied (with the version it wrote, its public addresses and edit_url), rejected (with the owner\'s note), ' +
    'expired, conflict (the content changed after it was proposed: read again and propose again), and so on. change_id is ch_ and 16 letters or digits.',
  scope: 'content:draft',
  cost: 'cheap',
  risk: 'read',
  annotations: READ_ANNOTATIONS,
  tags: { readsPrivate: true, untrustedOutput: false, publicEffect: false, egress: false },
  input: z.strictObject({
    change_id: z.string().max(64).describe('The change_id a write returned.'),
  }),
  targetOf: () => null,
  read(args, ctx) {
    if (!CHANGE_ID_RE.test(args.change_id)) return refuse('NOT_FOUND', UNKNOWN)
    const own = ownedBy(ctx.actor)
    const row = getAiDb()
      .prepare(`SELECT ${COLUMNS} FROM ai_changes WHERE id = ? AND ${own.where}`)
      .get(args.change_id, ...own.params) as Row | undefined
    if (!row) return refuse('NOT_FOUND', UNKNOWN)
    return ok(view(row, ctx.now, ctx.actor.kind))
  },
})

export const listMyChanges = defineTool({
  name: 'list_my_changes',
  title: 'List my changes',
  description:
    'The changes this connection made, newest first, with their state (see get_change). state limits the list to one state. ' +
    'limit is 1 to 50 (default 20); pass next_cursor back as cursor.',
  scope: 'content:draft',
  cost: 'cheap',
  risk: 'read',
  annotations: READ_ANNOTATIONS,
  tags: { readsPrivate: true, untrustedOutput: false, publicEffect: false, egress: false },
  input: z.strictObject({
    state: z.enum(CHANGE_STATES).optional().describe('Only changes in this state.'),
    limit: z.number().int().min(1).max(50).optional().describe('Rows per page, 1 to 50. Default 20.'),
    cursor: z.string().max(32).optional().describe('next_cursor of the previous page.'),
  }),
  targetOf: () => null,
  read(args, ctx) {
    const own = ownedBy(ctx.actor)
    // Bounded: ai_changes keeps a grant's (or a conversation's) rows for 400 days, at most a few thousand.
    const rows = getAiDb()
      .prepare(`SELECT ${COLUMNS} FROM ai_changes WHERE ${own.where} ORDER BY created_at DESC, id LIMIT 5000`)
      .all(...own.params) as Row[]
    const views = rows.map((r) => view(r, ctx.now, ctx.actor.kind)).filter((v) => !args.state || v.state === args.state)
    const page = pageOf(views, args.cursor, args.limit ?? 20)
    if (!page) return refuse('INVALID_INPUT', 'cursor: pass next_cursor from the previous page, unchanged.')
    return ok(page)
  },
})
