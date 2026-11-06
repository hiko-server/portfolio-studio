import crypto from 'node:crypto'
import { currentSessionVersion } from '../admin'
import { liveSession } from '../adminAuth/sessions'
import { stableStringify } from '../contentStore'
import { createDraftItem, saveDraftEdit, type DraftProblem } from '../contentOps/drafts'
import { saveMediaText } from '../contentOps/media'
import { log as baseLog, type Logger } from '../log'
import { isDraftFrontmatter, readOne } from '../mdx-admin'
import { liveGrant } from './access'
import { beginAiWrite, type AiActor } from './audit'
import { BUDGET_ALERT_SHARE, persistedUsage, takeMemory, takePersisted, QUERY_BUDGETS, type BudgetEvent } from './budgets'
import { beginAppliedChange, createdDraftTargets, dropAppliedChange, finishAppliedChange, newChangeId, pruneChanges } from './changes'
import { getAiDb } from './db'
import { draftRefusal } from './plans/items'
import type { Preview, WritePlan } from './plans/types'
import { TOOL_LIST_HASH, toolByName, type RegisteredTool } from './registry'
import { aiAccess } from './settings'
import { isWriteTool, RESULT_MAX_BYTES, type Scope, type ToolCode, type ToolContext, type ToolOutcome, type ToolRefusal, type WriteToolDef } from './toolTypes'
import { validateAiWrite } from './validate'

/**
 * executeTool (SERVER-ONLY, design §4.1): the only way any surface — the
 * MCP endpoint, the admin assistant — reaches a tool. Every call, in this
 * order:
 *
 *   1. aiAccess() from auth.db, uncached: off refuses;
 *   2. authority: the grant row (not revoked, not expired, the current
 *      session version), or the assistant's browser session, still live;
 *   3. scope (MCP already answered 403; this is the second check);
 *   4. budgets: tool calls per actor, and the site-wide budget of the
 *      expensive reads (whose results are cached 60 s per access level);
 *   5. the tool's Zod input (unknown keys, `__proto__` among them, refused);
 *   6. the loop guard of an assistant run;
 *   7. a read tool runs;
 *   8. a write tool plans (pure, nothing written), validateAiWrite checks
 *      the planned write (lib/ai/validate), and one sink takes it, under the
 *      single AI-write queue: applied at once through lib/contentOps
 *      (drafts and pending rows only) with its change row, budgets and
 *      fail-closed activity-log row — or refused when the item would reach
 *      someone without the owner's approval (§4.6: scheduled, or shown by
 *      review links) or the owner wants to approve drafts too;
 *   9. the result: TAG characters and bidi controls stripped, at most
 *      64 KiB, and one row in ai.db's call log (`ai_tool_calls`, kept 30
 *      days) plus the grant's daily roll-up (400 days). Reads and refusals
 *      live there, never in the activity log.
 *
 * Arguments, results and prompts are never logged; the call log keeps the
 * tool, the target's slug, the outcome, sizes and the arguments' SHA-256.
 */

export type ExecuteContext = {
  actor: AiActor
  scopes: ReadonlySet<Scope>
  /** The caller's network: the MCP client's, or the owner's browser for the assistant. */
  origin: { ipPrefix: string | null; country: string | null }
  /** MCP protocol era of the request (null for the assistant). */
  era: 'legacy' | 'modern' | null
  requestId: string | null
  signal: AbortSignal
  /** A scrubbing logger (lib/ai/scrub) that knows this request's secrets. */
  log?: Logger
  /** The assistant run's loop guard (none on MCP: a request is not a run). */
  loop?: LoopGuard
  now?: () => number
  /**
   * Hears budget events of a connected app (the MCP route passes the owner
   * alerts, lib/ai/alerts): the tool layer itself never reaches the mailer.
   */
  onEvent?: (event: BudgetEvent) => void
}

export type ToolResult = {
  /** False for every refusal and failure: MCP sends it as `isError: true`. */
  ok: boolean
  /** The result as JSON text: what both surfaces send, byte for byte. */
  text: string
  code: string | null
}

// ── The loop guard (§4.1 step 6) ─────────────────────────────────────────

/**
 * Stops a run that repeats itself: the same tool with the same arguments a
 * third time (a second time for a write). One per assistant run.
 */
export type LoopGuard = { note(tool: string, argsSha256: string, write: boolean): boolean }

export function createLoopGuard(): LoopGuard {
  const seen = new Map<string, number>()
  return {
    note(tool, argsSha256, write) {
      const key = `${tool}|${argsSha256}`
      const n = (seen.get(key) ?? 0) + 1
      seen.set(key, n)
      return n < (write ? 2 : 3)
    },
  }
}

// ── Output hygiene ───────────────────────────────────────────────────────

/** TAG block characters and bidi controls: invisible, and a known way to hide instructions in text (R19). */
const INVISIBLE_RE = /[‪-‮⁦-⁩]|\udb40[\udc00-\udc7f]/g

export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE_RE, '')
}

export function argsSha256(raw: unknown): string {
  let canonical: string
  try {
    canonical = stableStringify(raw ?? {})
  } catch {
    canonical = String(raw)
  }
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex')
}

// ── Expensive reads: one cache for everyone at the same access level ─────

const CACHE_TTL_MS = 60_000
const CACHE_MAX = 200
type Cached = { at: number; result: ToolResult }
const g = globalThis as typeof globalThis & { __aiReadCache?: Map<string, Cached> }
const cache = () => (g.__aiReadCache ??= new Map())

function cacheKey(def: RegisteredTool, scopes: ReadonlySet<Scope>, sha: string) {
  return `${def.name}|${[...scopes].sort().join(' ')}|${sha}`
}

function cached(key: string, now: number): ToolResult | null {
  const hit = cache().get(key)
  if (!hit) return null
  if (now - hit.at > CACHE_TTL_MS) {
    cache().delete(key)
    return null
  }
  return hit.result
}

function remember(key: string, result: ToolResult, now: number) {
  const c = cache()
  if (c.size >= CACHE_MAX) {
    for (const [k, v] of c) if (now - v.at > CACHE_TTL_MS) c.delete(k)
    if (c.size >= CACHE_MAX) c.delete(c.keys().next().value as string)
  }
  c.set(key, { at: now, result })
}

/** Forget every cached read (tests, and stage M2's writes once content changes). */
export function clearReadCache(): void {
  cache().clear()
}

// ── The call log (ai.db) ─────────────────────────────────────────────────

const PRUNE_EVERY_MS = 10 * 60_000
let lastPrune = 0

export type CallRecord = {
  at: number
  actor: AiActor
  tool: string
  target: string | null
  risk: string
  outcome: 'ok' | 'error' | 'refused'
  code: string | null
  ms: number
  bytesOut: number
  bytesIn: number
  /** A write that changed content (the grant's daily roll-up counts it). */
  wrote?: boolean
  argsSha256: string
  origin: { ipPrefix: string | null; country: string | null }
  era: string | null
  requestId: string | null
}

const actorId = (a: AiActor) => (a.kind === 'mcp' ? a.grantId : a.runId)
const actorLabel = (a: AiActor) => (a.kind === 'mcp' ? a.label : `${a.provider} · ${a.model}`)

/** Write one call to ai_tool_calls and, for a connected app, its daily roll-up. Never throws. */
export function recordCall(rec: CallRecord): void {
  try {
    const db = getAiDb()
    db.transaction(() => {
      db.prepare(
        `INSERT INTO ai_tool_calls (at, actor_kind, actor_id, actor_label, tool, target, risk, outcome, code, ms, bytes_out, args_sha256, ip_prefix, country, era, request_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        rec.at,
        rec.actor.kind,
        actorId(rec.actor),
        actorLabel(rec.actor).slice(0, 120),
        rec.tool.slice(0, 64),
        rec.target ? rec.target.slice(0, 128) : null,
        rec.risk,
        rec.outcome,
        rec.code,
        Math.max(0, Math.round(rec.ms)),
        rec.bytesOut,
        rec.argsSha256,
        rec.origin.ipPrefix,
        rec.origin.country,
        rec.era,
        rec.requestId,
      )
      if (rec.actor.kind === 'mcp') {
        db.prepare(
          `INSERT INTO ai_grant_daily (grant_id, day, country, calls, writes, refused, bytes_in) VALUES (?, ?, ?, 1, ?, ?, ?)
           ON CONFLICT (grant_id, day, country) DO UPDATE SET calls = calls + 1, writes = writes + excluded.writes, refused = refused + excluded.refused, bytes_in = bytes_in + excluded.bytes_in`,
        ).run(rec.actor.grantId, new Date(rec.at).toISOString().slice(0, 10), rec.origin.country ?? '', rec.wrote ? 1 : 0, rec.outcome === 'refused' ? 1 : 0, rec.bytesIn)
      }
    })()
    if (rec.at - lastPrune > PRUNE_EVERY_MS) {
      lastPrune = rec.at
      db.prepare('DELETE FROM ai_tool_calls WHERE at < ?').run(rec.at - 30 * 86_400_000)
      db.prepare('DELETE FROM ai_grant_daily WHERE day < ?').run(new Date(rec.at - 400 * 86_400_000).toISOString().slice(0, 10))
    }
  } catch (err) {
    baseLog.warn('AI call log: a row could not be written', { tool: rec.tool, err })
  }
}

/**
 * A token with a valid tag that was refused (revoked, expired, an old
 * session version, another resource): a row with tool `(http)`, so the owner
 * sees a copied token still in use. A token with a bad tag writes nothing,
 * so strangers cannot fill the log.
 */
export function recordRefusedToken(input: {
  grant: { id: string; name: string } | null
  reason: string
  origin: { ipPrefix: string | null; country: string | null }
  era: string | null
  requestId: string | null
  now?: number
}): void {
  const at = input.now ?? Date.now()
  recordCall({
    at,
    actor: { kind: 'mcp', grantId: input.grant?.id ?? '(unknown)', label: input.grant?.name ?? 'unknown token' },
    tool: '(http)',
    target: null,
    risk: 'read',
    outcome: 'refused',
    code: input.reason,
    ms: 0,
    bytesOut: 0,
    bytesIn: 0,
    argsSha256: argsSha256(null),
    origin: input.origin,
    era: input.era,
    requestId: input.requestId,
  })
}

// ── executeTool ──────────────────────────────────────────────────────────

/** Is the actor still allowed to act: a live grant, or a live owner session? */
function authorityHolds(actor: AiActor, now: number): boolean {
  if (actor.kind === 'mcp') return liveGrant(actor.grantId, now) !== null
  return actor.sessionId !== null && liveSession(actor.sessionId, now) !== null
}

function issuePath(path: readonly PropertyKey[]): string {
  return path.length ? path.map((p) => (typeof p === 'number' ? `[${p}]` : String(p))).join('.').replace(/\.\[/g, '[') : '(arguments)'
}

/**
 * Run tool `name` with `rawArgs` for a verified caller. Unknown tools are
 * the surface's to answer (MCP: a JSON-RPC error); here they are refused.
 */
export async function executeTool(name: string, rawArgs: unknown, ctx: ExecuteContext): Promise<ToolResult> {
  const now = ctx.now ?? Date.now
  const started = now()
  const def = toolByName(name)
  const sha = argsSha256(rawArgs)
  const bytesIn = (() => {
    try {
      return Buffer.byteLength(JSON.stringify(rawArgs ?? {}) ?? '', 'utf8')
    } catch {
      return 0
    }
  })()
  let target: string | null = null

  let wrote = false

  /** Log the call (never its arguments or result) and hand the result back. */
  const logged = (result: ToolResult, kind: 'ok' | 'error' | 'refused'): ToolResult => {
    recordCall({
      wrote,
      at: started,
      actor: ctx.actor,
      tool: def ? def.name : name,
      target,
      risk: def?.risk ?? 'read',
      outcome: kind,
      code: result.code,
      ms: now() - started,
      bytesOut: Buffer.byteLength(result.text, 'utf8'),
      bytesIn,
      argsSha256: sha,
      origin: ctx.origin,
      era: ctx.era,
      requestId: ctx.requestId,
    })
    return result
  }
  /** The outcome as the text both surfaces send: invisible characters stripped, at most 64 KiB. */
  const finish = (outcome: ToolOutcome, kind: 'ok' | 'error' | 'refused'): ToolResult => {
    const text = stripInvisible(JSON.stringify(outcome.ok ? outcome.data : { error: { code: outcome.code, message: outcome.message, ...(outcome.data ?? {}) } }))
    if (Buffer.byteLength(text, 'utf8') > RESULT_MAX_BYTES) {
      const message = 'The result would be larger than 64 KiB: ask for less (one section, a smaller limit, or the next part).'
      return logged({ ok: false, text: JSON.stringify({ error: { code: 'INVALID_INPUT', message } }), code: 'INVALID_INPUT' }, 'error')
    }
    return logged({ ok: outcome.ok, text, code: outcome.ok ? null : outcome.code }, kind)
  }
  const refused = (code: ToolCode, message: string, data?: Record<string, unknown>) => finish({ ok: false, code, message, ...(data ? { data } : {}) }, 'refused')

  if (!def) return { ok: false, text: JSON.stringify({ error: { code: 'NOT_FOUND', message: `There is no tool named ${JSON.stringify(String(name).slice(0, 64))}.` } }), code: 'NOT_FOUND' }

  // 1. The switches.
  if (!aiAccess().on) return refused('ACCESS_OFF', 'AI access is turned off on this site.')
  // 2. Authority, re-checked on every call: a revoked grant or a signed-out browser stops here.
  if (!authorityHolds(ctx.actor, started)) return refused('ACCESS_OFF', 'This connection no longer has access.')
  // 3. Scope.
  if (!ctx.scopes.has(def.scope)) return refused('INSUFFICIENT_SCOPE', `${def.name} needs the ${def.scope} scope, which this connection does not have.`)
  // 4. Budgets: per call (a batch can never multiply it), then the expensive reads' cache and site budget.
  const calls = takeMemory('toolCallsPerGrant', `${ctx.actor.kind}:${actorId(ctx.actor)}`, started)
  if (!calls.ok) return refused('BUDGET', `Too many tool calls: try again in ${calls.retryAfterS} s.`, { retry_after_s: calls.retryAfterS })
  // 5. Input.
  const parsed = def.input.safeParse(rawArgs ?? {})
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const field = issue ? issuePath(issue.path) : '(arguments)'
    const notEditable = isWriteTool(def) ? fieldNotEditable(def, issue, rawArgs) : null
    if (notEditable) return refused('FIELD_NOT_EDITABLE', `${notEditable} is not a field a change may set (see get_authoring_guide topic frontmatter).`, { field: notEditable })
    const keys = issue && 'keys' in issue && Array.isArray(issue.keys) ? ` (${issue.keys.slice(0, 5).join(', ')})` : ''
    return refused('INVALID_INPUT', `${field}: ${issue?.message ?? 'invalid'}${keys}`.slice(0, 300), { field })
  }
  const args = parsed.data
  try {
    const t = def.targetOf(args)
    target = t ? t.ref : null
  } catch {
    target = null
  }
  // 6. The loop guard of an assistant run.
  if (ctx.loop && !ctx.loop.note(def.name, sha, def.risk !== 'read')) {
    return refused('LOOP_STOPPED', `${def.name} was called with the same arguments too many times in this run.`)
  }

  const key = def.cost === 'expensive' ? cacheKey(def, ctx.scopes, sha) : null
  if (key) {
    const hit = cached(key, started)
    if (hit) return logged(hit, 'ok')
    const site = takeMemory('expensiveReadsSite', 'site', started)
    if (!site.ok) return refused('BUDGET', `This read is busy site-wide: try again in ${site.retryAfterS} s.`, { retry_after_s: site.retryAfterS })
  }

  // 7. The tool.
  const toolCtx: ToolContext = { actor: ctx.actor, scopes: ctx.scopes, log: ctx.log ?? baseLog, signal: ctx.signal, requestId: ctx.requestId, now: started }
  let outcome: ToolOutcome
  try {
    if (isWriteTool(def)) {
      // 8. A write: plan, check, one sink.
      const written = await runWrite(def, args, toolCtx, ctx, { sha, bytesIn, now })
      wrote = written.wrote
      return finish(written.outcome, written.outcome.ok ? 'ok' : written.kind)
    }
    outcome = await def.read(args, toolCtx)
  } catch (err) {
    const failLog = ctx.log ?? baseLog
    failLog.error('AI tool failed', { tool: def.name, requestId: ctx.requestId, err })
    return finish({ ok: false, code: 'UNAVAILABLE', message: 'The site could not answer this request. Try again later.' }, 'error')
  }
  const result = finish(outcome, outcome.ok ? 'ok' : 'error')
  if (key && result.ok) remember(key, result, started)
  return result
}

// ── Writes (§4.1 steps 8 to 10) ──────────────────────────────────────────

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

type ZodIssueLike = { code?: string; path?: readonly PropertyKey[]; keys?: unknown }

/**
 * A key outside a field map's schema (frontmatter) is FIELD_NOT_EDITABLE,
 * naming it: `draft`, the schedule keys, `translationKey`, anything not
 * allow-listed. Keys that reach an object's prototype stay INVALID_INPUT.
 */
function fieldNotEditable(def: WriteToolDef<unknown>, issue: ZodIssueLike | undefined, raw: unknown): string | null {
  const maps = def.fieldMaps ?? []
  const path = issue?.path ?? []
  const root = typeof path[0] === 'string' ? path[0] : null
  if (!issue || !root || !maps.includes(root)) return null
  if (issue.code === 'unrecognized_keys' && path.length === 1 && Array.isArray(issue.keys)) {
    const keys = issue.keys.filter((k): k is string => typeof k === 'string')
    if (!keys.length || keys.some((k) => UNSAFE_KEYS.has(k))) return null
    return `${root}.${keys[0]}`.slice(0, 120)
  }
  if (issue.code === 'invalid_value' && path.length === 2 && typeof path[1] === 'number') {
    const list = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[root] : null
    const value = Array.isArray(list) ? list[path[1]] : null
    if (typeof value === 'string' && !UNSAFE_KEYS.has(value)) return `${root}: ${value}`.slice(0, 120)
  }
  return null
}

const gw = globalThis as typeof globalThis & { __aiWriteQueue?: Promise<unknown> }

/**
 * The single AI-write queue (§4.1 step 10): one AI write at a time in this
 * process, so its budgets, change row, activity row and content write are
 * never interleaved with another AI write's.
 */
function inWriteQueue<T>(fn: () => Promise<T>): Promise<T> {
  const before = gw.__aiWriteQueue ?? Promise.resolve()
  const run = before.then(fn, fn)
  gw.__aiWriteQueue = run.catch(() => undefined)
  return run
}

type WriteRun = { outcome: ToolOutcome; kind: 'error' | 'refused'; wrote: boolean }

const refusal = (code: ToolCode, message: string, data?: Record<string, unknown>): ToolRefusal => ({ ok: false, code, message, ...(data ? { data } : {}) })
const failed = (outcome: ToolRefusal, kind: 'error' | 'refused' = 'error'): WriteRun => ({ outcome, kind, wrote: false })

/** The held refusal (§4.6): the item would reach someone without the owner's approval. */
function heldRefusal(plan: WritePlan): ToolRefusal {
  const held = plan.held as NonNullable<WritePlan['held']>
  if (held.reason === 'scheduled') {
    return refusal(
      'ITEM_SCHEDULED',
      'This item is scheduled to go live, so changing it needs the owner\'s approval. Ask the owner to make this change, or to unschedule the item first. Nothing was saved.',
      { scheduled_at: new Date(held.publishAt).toISOString(), edit_url: plan.editUrl },
    )
  }
  return refusal(
    'ITEM_IN_REVIEW',
    'Active review links show this item, so changing it needs the owner\'s approval. Ask the owner to make this change, or to end the review links first. Nothing was saved.',
    { active_review_links: held.activeLinks, edit_url: plan.editUrl },
  )
}

const actorIdOf = (a: AiActor) => (a.kind === 'mcp' ? a.grantId : a.runId)

type Applied = { ok: true; version: string; savedAs: 'draft' | 'unpublished_changes' | 'texts' }

/** The draft sink: lib/contentOps, draft and pending rows only. */
async function applyDraft(plan: WritePlan, now: number): Promise<Applied | ToolRefusal> {
  const a = plan.args as Record<string, any>
  switch (plan.kind) {
    case 'item.create': {
      const out = await createDraftItem(a.collection, { slug: a.slug, frontmatter: a.frontmatter, body: a.body }, { now })
      return out.ok ? { ok: true, version: out.version, savedAs: 'draft' } : draftRefusal(out as DraftProblem)
    }
    case 'item.edit-draft':
    case 'item.edit-pending': {
      const out = await saveDraftEdit(
        a.collection,
        { slug: a.slug, baseVersion: a.base_version, body: a.body, frontmatterPatch: a.frontmatter_patch, removeFrontmatter: a.remove_frontmatter },
        { now },
      )
      if (!out.ok) return draftRefusal(out as DraftProblem)
      if (!out.changed) return refusal('NO_VISIBLE_CHANGE', 'The change leaves the item exactly as it is. Nothing was saved.')
      return { ok: true, version: out.version, savedAs: out.target === 'pending' ? 'unpublished_changes' : 'draft' }
    }
    case 'media.texts': {
      const out = await saveMediaText({ name: a.name, texts: a.texts, expectedUpdatedAt: a.expected_updated_at })
      if (out.ok) return { ok: true, version: String(out.meta?.updatedAt ?? 0), savedAs: 'texts' }
      if (out.code === 'CONFLICT') return refusal('VERSION_CONFLICT', 'These texts changed since they were read: read them again with list_media.', { current_version: out.current?.updatedAt ?? 0 })
      if (out.code === 'NOT_FOUND' || out.code === 'INVALID_NAME') return refusal('NOT_FOUND', 'There is no image with that name. Find names with list_media.')
      if (out.code === 'INVALID_TEXT') return refusal('INVALID_INPUT', `${out.error}.`)
      return refusal('UNAVAILABLE', 'The site could not save this just now. Try again later.')
    }
    default:
      return refusal('UNAVAILABLE', 'This change cannot be applied.')
  }
}

const SAVED_MESSAGE: Record<Applied['savedAs'], string> = {
  draft: 'Saved as a draft: only the owner sees it until they publish it.',
  unpublished_changes: 'Saved as unpublished changes: visitors still see the published version until the owner publishes.',
  texts: 'Saved: the editors offer these texts when the image is inserted. Pages that already show it are unchanged.',
}

/** Is a created item still a draft (the per-grant cap counts those)? */
function stillDraft(collection: string, slug: string): boolean {
  if (collection !== 'blog' && collection !== 'work') return false
  const item = readOne(collection, slug)
  return item !== null && isDraftFrontmatter(item.frontmatter)
}

/** After a charge: tell the owner once a day when a connected app passed 80 % of a daily write budget. */
function budgetAlerts(ctx: ExecuteContext, now: number) {
  if (ctx.actor.kind !== 'mcp' || !ctx.onEvent) return
  for (const [budget, name] of [
    ['grantWritesDay', 'writes'],
    ['grantBytesDay', 'bytes'],
  ] as const) {
    const u = persistedUsage(budget, ctx.actor.grantId, now)
    if (u.used >= u.limit * BUDGET_ALERT_SHARE) {
      try {
        ctx.onEvent({ type: 'write-budget', grantId: ctx.actor.grantId, label: ctx.actor.label, budget: name })
      } catch {
        // An alert never changes the answer.
      }
    }
  }
}

async function runWrite(def: WriteToolDef<unknown>, args: unknown, toolCtx: ToolContext, ctx: ExecuteContext, call: { sha: string; bytesIn: number; now: () => number }): Promise<WriteRun> {
  const logger = ctx.log ?? baseLog
  const planned = await def.plan(args, toolCtx)
  if ('ok' in planned) return failed(planned)
  const plan = planned
  const checked = await validateAiWrite(plan.check, { signal: ctx.signal })
  if (!checked.ok) return failed(checked)
  // M2: no approval queue exists yet, so a held item is refused at every level (§4.6).
  if (plan.held) return failed(heldRefusal(plan))
  const preview: Preview = { ...plan.preview, newLinks: checked.newLinks, newEmbeds: checked.newEmbeds, zeroWidth: checked.zeroWidth }

  return inWriteQueue(async (): Promise<WriteRun> => {
    const now = call.now()
    // Access and authority again: a switch turned off or a grant revoked while the body was checked stops here.
    const access = aiAccess()
    if (!access.on || !authorityHolds(ctx.actor, now)) return failed(refusal('ACCESS_OFF', 'This connection no longer has access. Nothing was saved.'), 'refused')
    if (!access.settings.autoApplyDrafts) {
      return failed(
        refusal('APPROVAL_REQUIRED', 'The owner asks to approve AI drafts on this site, and this connection cannot queue one for approval. Nothing was saved: ask the owner.'),
        'refused',
      )
    }
    const who = actorIdOf(ctx.actor)
    if (plan.kind === 'item.create') {
      const existing = createdDraftTargets(ctx.actor).filter((t) => stillDraft(t.collection, t.slug)).length
      if (existing >= QUERY_BUDGETS.aiDraftsPerGrant) {
        return failed(refusal('BUDGET', `This connection already created ${QUERY_BUDGETS.aiDraftsPerGrant} drafts that still exist. Ask the owner to publish or delete some first.`, { budget: 'aiDraftsPerGrant' }), 'refused')
      }
    }
    const site = takeMemory('aiWritesSite', 'site', now)
    if (!site.ok) return failed(refusal('BUDGET', `Too many AI writes on this site right now: try again in ${site.retryAfterS} s.`, { retry_after_s: site.retryAfterS, budget: 'aiWritesSite' }), 'refused')
    const item = `${plan.target.kind}/${plan.target.ref}`
    const charged = takePersisted(
      [
        { budget: 'grantWritesHour', subject: who },
        { budget: 'grantWritesDay', subject: who },
        { budget: 'grantBytesDay', subject: who, amount: call.bytesIn },
        { budget: 'itemWritesHour', subject: item },
        { budget: 'itemWritesDay', subject: item },
      ],
      now,
    )
    if (!charged.ok) return failed(refusal('BUDGET', `A write budget is spent (${charged.budget}): try again in ${charged.retryAfterS} s.`, { retry_after_s: charged.retryAfterS, budget: charged.budget }), 'refused')
    budgetAlerts(ctx, now)

    // The change row first, fail closed: no row, no write.
    const id = newChangeId()
    try {
      beginAppliedChange(
        {
          id,
          risk: 'draft',
          tool: def.name,
          kind: plan.kind,
          actor: ctx.actor,
          issuerVersion: currentSessionVersion(),
          target: plan.target,
          title: preview.title,
          baseVersion: plan.baseVersion,
          args: plan.args,
          preview,
          before: plan.before,
          rationale: plan.rationale,
        },
        now,
      )
    } catch (err) {
      logger.warn('AI change row could not be stored; write refused', { tool: def.name, requestId: ctx.requestId, err })
      return failed(refusal('UNAVAILABLE', 'The site could not record this change, so nothing was saved. Try again later.'))
    }
    // The activity log, fail closed (§5.6).
    const begun = beginAiWrite(
      {
        actor: ctx.actor,
        origin: ctx.origin,
        surfaceRoute: ctx.actor.kind === 'mcp' ? 'mcp' : 'admin/ai/runs',
        tool: def.name,
        argsSha256: call.sha,
        toolListHash: TOOL_LIST_HASH,
        requestId: ctx.requestId,
        changeId: id,
        write: plan.audit,
      },
      now,
    )
    if (!begun.ok) {
      dropAppliedChange(id)
      return failed(refusal('AUDIT_UNAVAILABLE', 'The activity log could not record this change, so nothing was saved. Try again later.'))
    }
    let applied: Applied | ToolRefusal
    try {
      applied = await begun.intent.run(() => applyDraft(plan, now))
    } catch (err) {
      // The write threw part-way: the activity row stays (status 0 reads as interrupted), and so does the change row.
      logger.error('AI write failed', { tool: def.name, requestId: ctx.requestId, err })
      return failed(refusal('UNAVAILABLE', 'The site could not save this. Check the item before trying again.'))
    }
    if (!applied.ok) {
      begun.intent.discard()
      dropAppliedChange(id)
      return failed(applied)
    }
    begun.intent.finish(200)
    const publicUrl = plan.kind === 'item.edit-pending' ? `/${plan.target.kind}/${plan.target.ref}` : null
    finishAppliedChange(id, { version: applied.version, savedAs: applied.savedAs, publicUrls: [], editUrl: plan.editUrl }, now)
    clearReadCache()
    pruneChanges(now)
    const target = plan.target.kind === 'media' ? { name: plan.target.ref } : { collection: plan.target.kind, slug: plan.target.ref }
    return {
      wrote: true,
      kind: 'error',
      outcome: {
        ok: true,
        data: {
          status: 'saved',
          saved_as: applied.savedAs,
          change_id: id,
          ...target,
          ...(applied.savedAs === 'texts' ? { texts_version: Number(applied.version) } : { version: applied.version }),
          edit_url: plan.editUrl,
          ...(applied.savedAs === 'texts' ? {} : { public_url: publicUrl }),
          ...(preview.newLinks.length ? { new_links: preview.newLinks.length } : {}),
          message: SAVED_MESSAGE[applied.savedAs],
        },
      },
    }
  })
}
