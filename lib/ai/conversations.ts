import crypto from 'node:crypto'
import { stableStringify } from '../contentStore'
import { getAiDb } from './db'
import type { ConversationSnapshot, FrozenTool, NativeTurn, Usage, Wire } from './providers/types'

/**
 * The assistant's conversations (SERVER-ONLY, design §3.2, §7.1, §7.5), in
 * ai.db: `ai_conversations`, `ai_turns`, `ai_runs`, `ai_usage`.
 *
 * A conversation pins provider, model, wire, system text and tool list when
 * it starts; they are sent byte-identical on every request. History is the
 * provider's own replay format (`native_json`, verbatim, read only by the
 * adapter that wrote it); `display_json` is what the admin renders. Only
 * COMPLETE turns are stored — an orphan tool call breaks every later
 * request. A row whose native_json is JSON `null` is display-only: text the
 * owner saw (a stopped answer, a declined turn) that the model never sees.
 *
 * `tools_json` holds the frozen tool list and, beside it, the frozen request
 * profile (Claude's thinking display and the optional parameters the Models
 * API allowed when the conversation began): there is no other column for it,
 * and it is as much part of the frozen prefix as the tools.
 */

export const CONVERSATION_ID_RE = /^c_[A-Za-z0-9_-]{16,40}$/
export const RUN_ID_RE = /^r_[A-Za-z0-9_-]{16,40}$/
export const TITLE_MAX = 80

export type RequestProfile = {
  display: 'updates' | 'omitted'
  claude: { adaptiveThinking: boolean; fallbacks: boolean } | null
  /** The model's output cap from the provider's Models API when it began (Claude), else null. */
  maxOutputCap: number | null
  /** Tools were withheld because the model's Test made no tool call. */
  chatOnly: boolean
}

type FrozenJson = { tools: FrozenTool[]; request: RequestProfile }

export type Conversation = {
  id: string
  title: string
  providerId: string
  providerLabel: string
  wire: Wire
  model: string
  effort: string | null
  systemText: string
  tools: FrozenTool[]
  request: RequestProfile
  toolListHash: string
  tokensWeighted: number
  createdAt: number
  updatedAt: number
}

type ConvRow = {
  id: string
  title: string
  provider_id: string
  provider_label: string
  wire: Wire
  model: string
  effort: string | null
  system_text: string
  tools_json: string
  tool_list_hash: string
  tokens_weighted: number
  created_at: number
  updated_at: number
}

const DEFAULT_PROFILE: RequestProfile = { display: 'omitted', claude: null, maxOutputCap: null, chatOnly: false }

function fromRow(r: ConvRow): Conversation {
  let frozen: FrozenJson = { tools: [], request: DEFAULT_PROFILE }
  try {
    const parsed = JSON.parse(r.tools_json) as Partial<FrozenJson>
    frozen = { tools: Array.isArray(parsed.tools) ? parsed.tools : [], request: { ...DEFAULT_PROFILE, ...(parsed.request ?? {}) } }
  } catch {
    // An unreadable frozen list: the conversation still shows, and a run on it refuses (no tools to send unchanged).
  }
  return {
    id: r.id,
    title: r.title,
    providerId: r.provider_id,
    providerLabel: r.provider_label,
    wire: r.wire,
    model: r.model,
    effort: r.effort,
    systemText: r.system_text,
    tools: frozen.tools,
    request: frozen.request,
    toolListHash: r.tool_list_hash,
    tokensWeighted: Number(r.tokens_weighted) || 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export function snapshotOf(c: Conversation): ConversationSnapshot {
  return { model: c.model, systemText: c.systemText, tools: c.tools, effort: c.effort, display: c.request.display, claude: c.request.claude }
}

/** SHA-256 of the frozen tool list (what audit rows of this conversation's writes name). */
export function toolListHashOf(tools: readonly FrozenTool[]): string {
  return crypto.createHash('sha256').update(stableStringify(tools)).digest('hex')
}

/** The first line of the first message, the conversation's title: no model call names it. */
export function titleFrom(message: string): string {
  // eslint-disable-next-line no-control-regex
  const line = (message.split(/\r?\n/).find((l) => l.trim()) ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim()
  const chars = Array.from(line)
  return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX - 1).join('')}…` : line || 'New conversation'
}

export const newId = (prefix: 'c' | 'r') => `${prefix}_${crypto.randomBytes(16).toString('base64url')}`

export type NewConversation = {
  title: string
  providerId: string
  providerLabel: string
  wire: Wire
  model: string
  effort: string | null
  systemText: string
  tools: readonly FrozenTool[]
  request: RequestProfile
}

export function createConversation(input: NewConversation, now = Date.now()): Conversation {
  const id = newId('c')
  const frozen: FrozenJson = { tools: [...input.tools], request: input.request }
  getAiDb()
    .prepare(
      `INSERT INTO ai_conversations (id, title, provider_id, provider_label, wire, model, effort, system_text, tools_json, tool_list_hash, tokens_weighted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .run(id, input.title, input.providerId, input.providerLabel, input.wire, input.model, input.effort, input.systemText, JSON.stringify(frozen), toolListHashOf(input.tools), now, now)
  return getConversation(id) as Conversation
}

export function getConversation(id: unknown): Conversation | null {
  if (typeof id !== 'string' || !CONVERSATION_ID_RE.test(id)) return null
  const r = getAiDb().prepare('SELECT * FROM ai_conversations WHERE id = ?').get(id) as ConvRow | undefined
  return r ? fromRow(r) : null
}

export type ConversationListItem = Pick<Conversation, 'id' | 'title' | 'providerLabel' | 'wire' | 'model' | 'tokensWeighted' | 'createdAt' | 'updatedAt'>

export function listConversations(limit = 100, before?: number): ConversationListItem[] {
  const rows = (
    before
      ? getAiDb().prepare('SELECT * FROM ai_conversations WHERE updated_at < ? ORDER BY updated_at DESC LIMIT ?').all(before, limit)
      : getAiDb().prepare('SELECT * FROM ai_conversations ORDER BY updated_at DESC LIMIT ?').all(limit)
  ) as ConvRow[]
  return rows.map(fromRow).map(({ id, title, providerLabel, wire, model, tokensWeighted, createdAt, updatedAt }) => ({ id, title, providerLabel, wire, model, tokensWeighted, createdAt, updatedAt }))
}

/** Delete a conversation with its turns, runs and model-call rows' links (usage rows stay as counts). */
export function deleteConversation(id: string): boolean {
  const db = getAiDb()
  return db.transaction(() => {
    db.prepare('UPDATE ai_usage SET conversation_id = NULL WHERE conversation_id = ?').run(id)
    return db.prepare('DELETE FROM ai_conversations WHERE id = ?').run(id).changes > 0
  })()
}

// ── Turns ─────────────────────────────────────────────────────────────────

export type TurnRole = 'user' | 'assistant' | 'tool'

export type StoredTurn = { seq: number; role: TurnRole; native: NativeTurn | null; display: unknown; runId: string | null; createdAt: number }

/** Append one complete turn (`native` null: display-only). Returns its seq. */
export function appendTurn(conversationId: string, role: TurnRole, native: NativeTurn | null, display: unknown, runId: string | null, now = Date.now()): number {
  const db = getAiDb()
  return db.transaction(() => {
    const next = (db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM ai_turns WHERE conversation_id = ?').get(conversationId) as { n: number }).n
    db.prepare('INSERT INTO ai_turns (conversation_id, seq, role, native_json, display_json, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      conversationId,
      next,
      role,
      JSON.stringify(native ?? null),
      JSON.stringify(display ?? null),
      runId,
      now,
    )
    db.prepare('UPDATE ai_conversations SET updated_at = ? WHERE id = ?').run(now, conversationId)
    return Number(next)
  })()
}

/** Turn a stored turn into a display-only one, marking its display (a message declined at once leaves the history). */
export function retireTurn(conversationId: string, seq: number, mark: Record<string, unknown>): void {
  const db = getAiDb()
  db.transaction(() => {
    const row = db.prepare('SELECT display_json FROM ai_turns WHERE conversation_id = ? AND seq = ?').get(conversationId, seq) as { display_json: string } | undefined
    if (!row) return
    let display: unknown = null
    try {
      display = JSON.parse(row.display_json)
    } catch {
      display = null
    }
    const merged = display && typeof display === 'object' && !Array.isArray(display) ? { ...(display as Record<string, unknown>), ...mark } : { ...mark }
    db.prepare("UPDATE ai_turns SET native_json = 'null', display_json = ? WHERE conversation_id = ? AND seq = ?").run(JSON.stringify(merged), conversationId, seq)
  })()
}

/** Replace the native form of stored turns (Claude's signature recovery only). */
export function rewriteNative(conversationId: string, turns: ReadonlyArray<{ seq: number; native: NativeTurn }>): void {
  const db = getAiDb()
  const stmt = db.prepare('UPDATE ai_turns SET native_json = ? WHERE conversation_id = ? AND seq = ?')
  db.transaction(() => {
    for (const t of turns) stmt.run(JSON.stringify(t.native), conversationId, t.seq)
  })()
}

export function loadTurns(conversationId: string): StoredTurn[] {
  const rows = getAiDb().prepare('SELECT seq, role, native_json, display_json, run_id, created_at FROM ai_turns WHERE conversation_id = ? ORDER BY seq').all(conversationId) as Array<{
    seq: number
    role: TurnRole
    native_json: string
    display_json: string
    run_id: string | null
    created_at: number
  }>
  return rows.map((r) => ({
    seq: r.seq,
    role: r.role,
    native: JSON.parse(r.native_json) as NativeTurn | null,
    display: JSON.parse(r.display_json) as unknown,
    runId: r.run_id,
    createdAt: r.created_at,
  }))
}

/** The history the model sees: the native turns in order, display-only rows left out. */
export function loadNative(conversationId: string): Array<{ seq: number; native: NativeTurn }> {
  return loadTurns(conversationId)
    .filter((t) => t.native !== null)
    .map((t) => ({ seq: t.seq, native: t.native as NativeTurn }))
}

/** The time the owner last wrote in this conversation (decisions after it go into the next user turn). */
export function lastUserTurnAt(conversationId: string): number | null {
  const r = getAiDb().prepare("SELECT MAX(created_at) AS at FROM ai_turns WHERE conversation_id = ? AND role = 'user' AND native_json != 'null'").get(conversationId) as { at: number | null }
  return r.at ?? null
}

/** Add `delta` weighted tokens to a conversation (a reservation, a refund, or the real count). */
export function addConversationTokens(conversationId: string, delta: number): void {
  if (!delta) return
  getAiDb().prepare('UPDATE ai_conversations SET tokens_weighted = MAX(0, tokens_weighted + ?) WHERE id = ?').run(Math.round(delta), conversationId)
}

// ── Runs ──────────────────────────────────────────────────────────────────

export type RunState = 'running' | 'finished' | 'stopped' | 'limit' | 'failed' | 'interrupted'

export type RunRow = {
  id: string
  conversationId: string
  sessionId: string
  state: RunState
  reason: string | null
  modelTurns: number
  toolCalls: number
  startedAt: number
  finishedAt: number | null
}

type RunDbRow = { id: string; conversation_id: string; session_id: string; state: RunState; reason: string | null; model_turns: number; tool_calls: number; started_at: number; finished_at: number | null }

const runFrom = (r: RunDbRow): RunRow => ({
  id: r.id,
  conversationId: r.conversation_id,
  sessionId: r.session_id,
  state: r.state,
  reason: r.reason,
  modelTurns: r.model_turns,
  toolCalls: r.tool_calls,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
})

export function insertRun(input: { id: string; conversationId: string; sessionId: string }, now = Date.now()): void {
  getAiDb().prepare("INSERT INTO ai_runs (id, conversation_id, session_id, state, model_turns, tool_calls, started_at) VALUES (?, ?, ?, 'running', 0, 0, ?)").run(input.id, input.conversationId, input.sessionId, now)
}

export function getRun(id: unknown): RunRow | null {
  if (typeof id !== 'string' || !RUN_ID_RE.test(id)) return null
  const r = getAiDb().prepare('SELECT * FROM ai_runs WHERE id = ?').get(id) as RunDbRow | undefined
  return r ? runFrom(r) : null
}

export function runsOf(conversationId: string): RunRow[] {
  return (getAiDb().prepare('SELECT * FROM ai_runs WHERE conversation_id = ? ORDER BY started_at').all(conversationId) as RunDbRow[]).map(runFrom)
}

export function countRun(id: string, what: { modelTurns?: number; toolCalls?: number }): void {
  getAiDb().prepare('UPDATE ai_runs SET model_turns = model_turns + ?, tool_calls = tool_calls + ? WHERE id = ?').run(what.modelTurns ?? 0, what.toolCalls ?? 0, id)
}

export function finishRun(id: string, state: Exclude<RunState, 'running'>, reason: string | null, now = Date.now()): void {
  getAiDb().prepare("UPDATE ai_runs SET state = ?, reason = ?, finished_at = ? WHERE id = ? AND state = 'running'").run(state, reason, now, id)
}

/** Runs still marked running that no process is driving (a restart): they read as interrupted. */
export function interruptOrphans(alive: ReadonlySet<string>, now = Date.now()): number {
  const rows = getAiDb().prepare("SELECT id FROM ai_runs WHERE state = 'running'").all() as Array<{ id: string }>
  let n = 0
  for (const r of rows) {
    if (alive.has(r.id)) continue
    n += getAiDb().prepare("UPDATE ai_runs SET state = 'interrupted', reason = 'restart', finished_at = ? WHERE id = ? AND state = 'running'").run(now, r.id).changes
  }
  return n
}

// ── Model calls ───────────────────────────────────────────────────────────

export type UsageRecord = {
  providerId: string
  model: string
  conversationId: string | null
  runId: string | null
  usage: Usage
  weighted: number
  estimated: boolean
  at: number
}

export function recordUsage(rec: UsageRecord): void {
  getAiDb()
    .prepare(
      `INSERT INTO ai_usage (day, provider_id, model, conversation_id, run_id, usage_in, cached_read, cache_write, usage_out, reasoning, weighted, reported_micro_usd, estimated, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      new Date(rec.at).toISOString().slice(0, 10),
      rec.providerId,
      rec.model.slice(0, 200),
      rec.conversationId,
      rec.runId,
      Math.max(0, Math.round(rec.usage.input)),
      Math.max(0, Math.round(rec.usage.cachedRead)),
      Math.max(0, Math.round(rec.usage.cacheWrite)),
      Math.max(0, Math.round(rec.usage.output)),
      Math.max(0, Math.round(rec.usage.reasoning)),
      Math.max(0, Math.round(rec.weighted)),
      rec.usage.reportedMicroUsd,
      rec.estimated ? 1 : 0,
      rec.at,
    )
}

export type UsageDayRow = {
  day: string
  providerId: string
  model: string
  calls: number
  usageIn: number
  cachedRead: number
  cacheWrite: number
  usageOut: number
  reasoning: number
  weighted: number
  /** Null unless every call of the group reported its cost. */
  reportedMicroUsd: number | null
  estimatedCalls: number
}

/** Usage per UTC day, provider and model, newest first (the Models view's table). */
export function usageByDay(sinceDay: string): UsageDayRow[] {
  const rows = getAiDb()
    .prepare(
      `SELECT day, provider_id, model, COUNT(*) AS calls, SUM(usage_in) AS usage_in, SUM(cached_read) AS cached_read, SUM(cache_write) AS cache_write,
              SUM(usage_out) AS usage_out, SUM(reasoning) AS reasoning, SUM(weighted) AS weighted,
              CASE WHEN COUNT(reported_micro_usd) = COUNT(*) THEN SUM(reported_micro_usd) ELSE NULL END AS cost, SUM(estimated) AS estimated
       FROM ai_usage WHERE day >= ? GROUP BY day, provider_id, model ORDER BY day DESC, weighted DESC`,
    )
    .all(sinceDay) as Array<Record<string, number | string | null>>
  return rows.map((r) => ({
    day: String(r.day),
    providerId: String(r.provider_id),
    model: String(r.model),
    calls: Number(r.calls) || 0,
    usageIn: Number(r.usage_in) || 0,
    cachedRead: Number(r.cached_read) || 0,
    cacheWrite: Number(r.cache_write) || 0,
    usageOut: Number(r.usage_out) || 0,
    reasoning: Number(r.reasoning) || 0,
    weighted: Number(r.weighted) || 0,
    reportedMicroUsd: r.cost === null ? null : Number(r.cost),
    estimatedCalls: Number(r.estimated) || 0,
  }))
}

// ── Retention (pruned at run start, design §3.2) ─────────────────────────

const DAY = 86_400_000

/**
 * Apply the conversation retention: 0 = don't keep (every conversation but
 * `keep` goes), -1 = until deleted, n = conversations idle for n days go.
 * Usage rows lose their link and stay as counts for 400 days.
 */
export function pruneConversations(keepDays: number, keep: string | null, now = Date.now()): number {
  const db = getAiDb()
  return db.transaction(() => {
    let ids: string[] = []
    if (keepDays === 0) ids = (db.prepare('SELECT id FROM ai_conversations').all() as Array<{ id: string }>).map((r) => r.id)
    else if (keepDays > 0) ids = (db.prepare('SELECT id FROM ai_conversations WHERE updated_at < ?').all(now - keepDays * DAY) as Array<{ id: string }>).map((r) => r.id)
    ids = ids.filter((id) => id !== keep && !(db.prepare("SELECT 1 FROM ai_runs WHERE conversation_id = ? AND state = 'running'").get(id)))
    for (const id of ids) {
      db.prepare('UPDATE ai_usage SET conversation_id = NULL WHERE conversation_id = ?').run(id)
      db.prepare('DELETE FROM ai_conversations WHERE id = ?').run(id)
    }
    db.prepare('DELETE FROM ai_usage WHERE at < ?').run(now - 400 * DAY)
    return ids.length
  })()
}
