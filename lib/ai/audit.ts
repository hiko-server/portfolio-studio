import { factsFor } from '../audit/capture'
import { runInAuditScope, type AuditScope } from '../audit/context'
import { describeAdminWrite, type AuditDescription, type AuditRequest } from '../audit/describe'
import { cleanAuditEntry, type AdminAuditEntry } from '../audit/record'
import { discardAuditIntent, finishAuditIntent, recordAuditIntent, type AuditAiColumns } from '../audit/store'
import { log } from '../log'

/**
 * The activity log for AI writes (SERVER-ONLY, design §5.6). The opposite of
 * the browser capture (lib/audit/capture), on purpose: it fails CLOSED.
 *
 *   const begun = beginAiWrite({ actor, origin, surfaceRoute: 'mcp', tool, argsSha256, toolListHash, requestId,
 *                                write: { route: 'admin/posts', method: 'PUT', body } })
 *   if (!begun.ok) return refuse('AUDIT_UNAVAILABLE')     // nothing written
 *   const result = begun.intent.run(() => saveDraftEdit(...))   // snapshots noted in the scope
 *   if (result.ok) begun.intent.finish(200)
 *   else begun.intent.discard()                             // refused before anything changed
 *
 * 1. Before the write: an audit_log row with status 0, carrying the network
 *    prefix and country of the client (an MCP client's network, the owner's
 *    browser for the assistant). If it cannot be written, the write must not
 *    run. The Activity view hides it for a minute, then shows it as
 *    interrupted (the process stopped mid-write).
 * 2. After: the write's status and the version files it took — or the row
 *    goes, when the write was refused before it changed anything.
 *
 * Labels reuse describeAdminWrite with the canonical route, so an AI save
 * reads like the same save from the browser — except that the frontmatter
 * title is removed first: a model-written title ("Typo fix only, safe to
 * approve") must never become the headline of a log line, so the label
 * names the slug. Titles appear only inside the diff.
 *
 * Who: the `device` column carries the actor ("AI · laptop token", "AI ·
 * claude.ai", "AI · DeepSeek · deepseek-v4-pro", and for an approval "AI ·
 * claude.ai · approved on Chrome on macOS"), so Activity and version history
 * show it with no change to either. The name is the owner's label or the
 * verified client host, never what a client reports about itself. A change
 * the owner approved is recorded as approved by that browser (session and
 * time), never as something AI did on its own.
 *
 * Reads and refusals never come here: they go to ai.db's ai_tool_calls, so
 * read noise can never push writes out of the activity log's row cap.
 */

export type AiActor =
  /** A connected app: `label` is the owner's name for the grant or the verified client host. */
  | { kind: 'mcp'; grantId: string; label: string }
  /** The owner's assistant: the signed-in session that started the run, the provider's label and the model. */
  | { kind: 'assistant'; runId: string; sessionId: string | null; provider: string; model: string }

/** An approval of an AI proposal by the owner's browser (lib/ai/apply, stage M3). */
export type AiApproval = { sessionId: string; device: string | null; at: number }

/** The write, as the route twin would see it (labelled by describeAdminWrite), or a ready entry. */
export type AiWrite = { route: string; method: string; query?: AuditRequest['query']; body?: unknown } | { entry: AdminAuditEntry }

export type AiWriteRecord = {
  actor: AiActor
  /** Network of the request: the MCP client's, or the owner's browser for the assistant. */
  origin: { ipPrefix: string | null; country: string | null }
  /** The route the AI request came through ('mcp', 'admin/ai/runs', 'admin/ai/changes'). */
  surfaceRoute: string
  tool: string
  argsSha256: string
  toolListHash: string | null
  requestId: string | null
  changeId?: string | null
  approval?: AiApproval | null
  write: AiWrite
}

export type AiAuditIntent = {
  readonly id: number
  /** Run the write inside the audit scope, so the version files it takes are linked to this row. */
  run<T>(fn: () => T): T
  /** The write finished with `status` (default 200): the row takes it, with its snapshot links. */
  finish(status?: number): boolean
  /** The write was refused before changing anything: the row goes. */
  discard(): void
}

export type AiAuditBegin = { ok: true; intent: AiAuditIntent } | { ok: false; code: 'AUDIT_UNAVAILABLE' }

const PART_MAX = { label: 48, provider: 32, model: 64, approvedOn: 48 } as const

/** One line, no control, bidi or zero-width characters, capped. */
export function cleanLabelPart(v: unknown, max: number): string {
  if (typeof v !== 'string') return ''
  const flat = v
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]|[\u{e0000}-\u{e007f}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return Array.from(flat).slice(0, max).join('').trim()
}

/** The `device` text of an AI row: "AI · <who>[ · approved on <browser>]". */
export function aiDeviceLabel(actor: AiActor, approvedOn?: string | null): string {
  const parts =
    actor.kind === 'mcp'
      ? [cleanLabelPart(actor.label, PART_MAX.label) || 'connected app']
      : [cleanLabelPart(actor.provider, PART_MAX.provider) || 'assistant', cleanLabelPart(actor.model, PART_MAX.model)].filter(Boolean)
  const approved = approvedOn === undefined || approvedOn === null ? null : cleanLabelPart(approvedOn, PART_MAX.approvedOn) || 'this browser'
  return ['AI', ...parts, ...(approved ? [`approved on ${approved}`] : [])].join(' · ')
}

/** A copy of a collection-route body without the frontmatter title (labels then name the slug). */
function withoutTitle(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body
  const b = body as Record<string, unknown>
  const fm = b.frontmatter
  if (!fm || typeof fm !== 'object' || Array.isArray(fm) || !('title' in fm)) return body
  const rest: Record<string, unknown> = { ...(fm as Record<string, unknown>) }
  delete rest.title
  return { ...b, frontmatter: rest }
}

/** How the activity log names an AI write: the route twin's label, with the slug in place of any title. */
export function describeAiWrite(write: AiWrite): AuditDescription | null {
  if ('entry' in write) return cleanAuditEntry(write.entry)
  const method = String(write.method || '').toUpperCase()
  return describeAdminWrite(write.route, { method, query: write.query || {}, body: withoutTitle(write.body) }, factsFor(write.route, { method, body: write.body }))
}

function aiColumns(rec: AiWriteRecord): AuditAiColumns {
  const a = rec.actor
  return {
    actorKind: a.kind,
    client: a.kind === 'mcp' ? cleanLabelPart(a.label, PART_MAX.label) || null : null,
    grantId: a.kind === 'mcp' ? a.grantId : null,
    provider: a.kind === 'assistant' ? cleanLabelPart(a.provider, PART_MAX.provider) || null : null,
    model: a.kind === 'assistant' ? cleanLabelPart(a.model, PART_MAX.model) || null : null,
    runId: a.kind === 'assistant' ? a.runId : null,
    tool: rec.tool,
    argsSha256: rec.argsSha256,
    toolListHash: rec.toolListHash,
    changeId: rec.changeId ?? null,
    approvedBySession: rec.approval?.sessionId ?? null,
    approvedAt: rec.approval?.at ?? null,
  }
}

/**
 * Write the intent row of an AI write. `AUDIT_UNAVAILABLE` (nothing was
 * written; the caller must not perform the write) when the write cannot be
 * labelled or the row cannot be stored.
 */
export function beginAiWrite(rec: AiWriteRecord, now = Date.now()): AiAuditBegin {
  let id: number
  try {
    const what = describeAiWrite(rec.write)
    if (!what) {
      log.warn('activity log: an AI write has no label; refused', { tool: rec.tool, route: 'entry' in rec.write ? 'entry' : rec.write.route })
      return { ok: false, code: 'AUDIT_UNAVAILABLE' }
    }
    const sessionId = rec.approval?.sessionId ?? (rec.actor.kind === 'assistant' ? rec.actor.sessionId : null)
    id = recordAuditIntent(
      {
        ...what,
        sessionId,
        device: aiDeviceLabel(rec.actor, rec.approval ? (rec.approval.device ?? null) : undefined),
        ipPrefix: rec.origin.ipPrefix,
        country: rec.origin.country,
        method: 'entry' in rec.write ? 'POST' : String(rec.write.method || '').toUpperCase(),
        route: rec.surfaceRoute,
        requestId: rec.requestId,
        ai: aiColumns(rec),
      },
      now,
    )
  } catch (err) {
    log.warn('activity log: the intent row of an AI write could not be written; refused', { tool: rec.tool, err })
    return { ok: false, code: 'AUDIT_UNAVAILABLE' }
  }
  const scope: AuditScope = { snapshots: [] }
  let settled = false
  return {
    ok: true,
    intent: {
      id,
      run: (fn) => runInAuditScope(scope, fn),
      finish: (status = 200) => {
        if (settled) return false
        settled = true
        try {
          return finishAuditIntent(id, status, scope.snapshots)
        } catch (err) {
          // The write happened: the row stays at status 0 and reads as interrupted, never as nothing.
          log.warn('activity log: an AI write could not be marked finished', { tool: rec.tool, id, err })
          return false
        }
      },
      discard: () => {
        if (settled) return
        settled = true
        try {
          discardAuditIntent(id)
        } catch (err) {
          log.warn('activity log: an AI intent row could not be removed', { tool: rec.tool, id, err })
        }
      },
    },
  }
}
