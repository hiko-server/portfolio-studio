import crypto from 'node:crypto'
import { liveSession } from '../adminAuth/sessions'
import { stableStringify } from '../contentStore'
import { log as baseLog, type Logger } from '../log'
import { liveGrant } from './access'
import type { AiActor } from './audit'
import { takeMemory } from './budgets'
import { getAiDb } from './db'
import { toolByName, type RegisteredTool } from './registry'
import { aiAccess } from './settings'
import { RESULT_MAX_BYTES, type Scope, type ToolCode, type ToolContext, type ToolOutcome } from './toolTypes'

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
 *   7. the tool (reads in stage M1);
 *   8. the result: TAG characters and bidi controls stripped, at most
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
          `INSERT INTO ai_grant_daily (grant_id, day, country, calls, writes, refused, bytes_in) VALUES (?, ?, ?, 1, 0, ?, ?)
           ON CONFLICT (grant_id, day, country) DO UPDATE SET calls = calls + 1, refused = refused + excluded.refused, bytes_in = bytes_in + excluded.bytes_in`,
        ).run(rec.actor.grantId, new Date(rec.at).toISOString().slice(0, 10), rec.origin.country ?? '', rec.outcome === 'refused' ? 1 : 0, rec.bytesIn)
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

  /** Log the call (never its arguments or result) and hand the result back. */
  const logged = (result: ToolResult, kind: 'ok' | 'error' | 'refused'): ToolResult => {
    recordCall({
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
