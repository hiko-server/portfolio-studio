import { currentSessionVersion } from '../admin'
import { liveSession } from '../adminAuth/sessions'
import { log as baseLog } from '../log'
import * as bus from './bus'
import {
  appendTurn,
  createConversation,
  finishRun,
  getConversation,
  getRun,
  insertRun,
  interruptOrphans,
  lastUserTurnAt,
  loadNative,
  newId,
  pruneConversations,
  runsOf,
  titleFrom,
  type Conversation,
  type RequestProfile,
  type RunRow,
} from './conversations'
import { getAiDb } from './db'
import { createLoopGuard, executeTool } from './execute'
import { runLoop, type RunEnd, type StopCause } from './loop'
import { anthropicEnvProblem } from './providers/env'
import { createAdapter, type AdapterSpec } from './providers/factory'
import { defaultProviderId, getProvider, openRowKey, quirksOf, touchProvider, type ProviderRow } from './providers/keys'
import { ProviderError, type FrozenTool, type ModelAdapter } from './providers/types'
import { wireToolsFor } from './registry'
import { RunBudget } from './runBudget'
import { scrubbingLogger } from './scrub'
import { aiAccess, readAiSettings } from './settings'
import { CHAT_ONLY_NOTE, composeUserTurn, SYSTEM_PROMPT, type AttachmentRef, type Decision } from './systemPrompt'
import { SCOPES } from './toolTypes'
import { aiHomeView } from './views'

/**
 * Assistant runs (SERVER-ONLY, design §7.5, §7.7). A run lives on the
 * server; the HTTP response that started it is only a view of it (bus.ts),
 * so a dropped browser never cancels anything — Stop does.
 *
 *   - ONE run per process: a second start answers RUN_ACTIVE with the
 *     running conversation.
 *   - Stop, the kill switch and the end of the browser session that started
 *     the run all abort it through the AbortController registry on
 *     globalThis. A watchdog re-reads AI access and the session every second,
 *     so `AI_DISABLED`, a database flip, a sign-out from another browser or
 *     "Sign out everywhere" stop a run even when no route told it to.
 *   - A `running` row this process does not drive (a restart) reads
 *     `interrupted`.
 *
 * The assistant acts inside the owner's session with all three scopes
 * (§5.1); every tool call goes through executeTool like any connected app's,
 * re-checking access and the session on each call.
 */

export const MESSAGE_MAX = 100_000
const WATCHDOG_MS = 1_000
const ALL_SCOPES = new Set(SCOPES)

export type RunHandle = {
  id: string
  conversationId: string
  sessionId: string
  startedAt: number
  controller: AbortController
  cause: StopCause | null
  done: Promise<RunEnd>
}

type RunsGlobal = typeof globalThis & { __aiRuns?: { current: RunHandle | null } }
const g = globalThis as RunsGlobal
const registry = () => (g.__aiRuns ??= { current: null })

/** The run this process is driving, if any. */
export function activeRun(): RunHandle | null {
  return registry().current
}

/** Stop one run (the owner's Stop). Returns false when this process is not driving it. */
export function stopRun(runId: string, cause: StopCause = 'stopped'): boolean {
  const h = registry().current
  if (!h || h.id !== runId) return false
  if (!h.cause) h.cause = cause
  h.controller.abort()
  return true
}

/** Stop every run (AI access turned off, a session ended). Returns how many were running. */
export function stopAllRuns(cause: StopCause): number {
  const h = registry().current
  if (!h) return 0
  if (!h.cause) h.cause = cause
  h.controller.abort()
  return 1
}

export type SessionRef = { id: string; ipPrefix: string | null; country: string | null }

export type StartInput = {
  session: SessionRef
  conversationId?: string | null
  providerId?: string | null
  model?: string | null
  message?: string | null
  /** No new message: carry on from the history as it is (Continue, Retry). */
  continue?: boolean
  attachments?: AttachmentRef[]
}

export type StartDeps = {
  /** How an adapter is built for a provider row and its opened key (tests pass one that points Claude at a local stub). */
  adapter?: (spec: AdapterSpec) => ModelAdapter
  now?: () => number
}

export type StartFailure = {
  ok: false
  status: number
  code:
    | 'ACCESS_OFF'
    | 'RUN_ACTIVE'
    | 'INVALID'
    | 'NOT_FOUND'
    | 'NO_PROVIDER'
    | 'PROVIDER_GONE'
    | 'PROVIDER_CHANGED'
    | 'NO_MODEL'
    | 'KEY_REENTER'
    | 'NO_SECRET'
    | 'PROVIDER_ENV'
    | 'PROVIDER_ERROR'
    | 'NOTHING_TO_CONTINUE'
  error: string
  field?: string
  runId?: string
  conversationId?: string
}

export type StartResult = { ok: true; run: RunHandle; conversation: Conversation } | StartFailure

const fail = (status: number, code: StartFailure['code'], error: string, extra: Partial<StartFailure> = {}): StartFailure => ({ ok: false, status, code, error, ...extra })

/** The tools every assistant conversation freezes: the whole catalogue (the assistant holds all three scopes). */
export function assistantTools(): FrozenTool[] {
  return wireToolsFor(ALL_SCOPES).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as unknown as Record<string, unknown> }))
}

/** What the conversation freezes about the request, from the model's last Test or, failing that, the live Models API. */
async function requestProfileFor(row: ProviderRow, model: string, adapter: ModelAdapter): Promise<{ ok: true; profile: RequestProfile; effortAllowed: boolean } | StartFailure> {
  const test = row.tests[model]
  const chatOnly = test?.status === 'chat-only'
  if (row.wire !== 'anthropic') return { ok: true, profile: { display: 'omitted', claude: null, maxOutputCap: null, chatOnly }, effortAllowed: true }
  let caps = test?.claude ?? null
  if (!caps) {
    try {
      const info = (await adapter.listModels(AbortSignal.timeout(30_000))).find((m) => m.id === model)
      caps = info?.claude ? { ...info.claude, maxOutputTokens: info.maxOutputTokens } : null
    } catch (err) {
      const e = err instanceof ProviderError ? err : null
      return fail(502, 'PROVIDER_ERROR', e ? e.message : 'Claude’s model list could not be read.')
    }
  }
  const claude = caps ? { adaptiveThinking: caps.adaptiveThinking, fallbacks: caps.fallbacks } : { adaptiveThinking: false, fallbacks: false }
  return {
    ok: true,
    profile: { display: claude.adaptiveThinking && test?.display === 'updates' ? 'updates' : 'omitted', claude, maxOutputCap: caps?.maxOutputTokens ?? null, chatOnly },
    effortAllowed: caps?.effort ?? false,
  }
}

const DECIDED = ['applied', 'rejected', 'conflict', 'failed', 'voided'] as const

/** Changes of this conversation decided after `since` (one line each in the next user turn). */
export function decisionsSince(conversationId: string, since: number, now = Date.now()): Decision[] {
  const runIds = runsOf(conversationId).map((r) => r.id)
  const actor = runIds.length ? ` OR actor_id IN (${runIds.map(() => '?').join(', ')})` : ''
  const rows = getAiDb()
    .prepare(
      `SELECT id, title, state, reject_note, decided_at, undone_at, expires_at FROM ai_changes
       WHERE (conversation_id = ?${actor})
         AND ((state IN (${DECIDED.map(() => '?').join(', ')}) AND decided_at > ?)
              OR (state = 'undone' AND undone_at > ?)
              OR (state IN ('waiting', 'in_editor') AND expires_at IS NOT NULL AND expires_at <= ? AND expires_at > ?))
       ORDER BY COALESCE(undone_at, decided_at, expires_at) LIMIT 20`,
    )
    .all(conversationId, ...runIds, ...DECIDED, since, since, now, since) as Array<{ id: string; title: string; state: string; reject_note: string | null }>
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    state: (r.state === 'waiting' || r.state === 'in_editor' ? 'expired' : r.state) as Decision['state'],
    note: r.state === 'rejected' ? r.reject_note : null,
  }))
}

function siteName(): string {
  try {
    const name = aiHomeView().home?.site?.name
    if (typeof name === 'string' && name.trim()) return name.trim()
  } catch {
    // The home document cannot be read: the address names the site instead.
  }
  try {
    return new URL(String(process.env.SITE_URL)).host
  } catch {
    return 'this site'
  }
}

function sessionVersionNow(): number | null {
  try {
    return currentSessionVersion()
  } catch {
    return null
  }
}

/**
 * Start a run: check, pick or create the conversation, store the owner's
 * message, and set the loop going. Resolves as soon as the run exists; its
 * events go to bus.ts.
 */
export async function startRun(input: StartInput, deps: StartDeps = {}): Promise<StartResult> {
  const clock = deps.now ?? Date.now
  const access = aiAccess()
  if (!access.on) return fail(409, 'ACCESS_OFF', 'AI access is turned off.')
  const current = registry().current
  if (current) return fail(409, 'RUN_ACTIVE', 'Another answer is still being written.', { runId: current.id, conversationId: current.conversationId })
  // Rows a previous process left running are not running any more.
  interruptOrphans(new Set(), clock())

  const message = typeof input.message === 'string' ? input.message.trim() : ''
  if (input.message !== undefined && input.message !== null && typeof input.message !== 'string') return fail(400, 'INVALID', 'The message is text.', { field: 'message' })
  if (message.length > MESSAGE_MAX) return fail(400, 'INVALID', `Keep a message under ${MESSAGE_MAX.toLocaleString('en')} characters.`, { field: 'message' })
  if (!message && !input.continue) return fail(400, 'INVALID', 'Write a message.', { field: 'message' })

  // The conversation: an existing one, pinned to its provider and model, or a new one.
  let conversation: Conversation | null = null
  let row: ProviderRow | null
  if (input.conversationId) {
    conversation = getConversation(input.conversationId)
    if (!conversation) return fail(404, 'NOT_FOUND', 'No such conversation.')
    row = getProvider(conversation.providerId)
    if (!row) return fail(409, 'PROVIDER_GONE', 'The model of this conversation was removed. Start a new conversation.')
    if (row.wire !== conversation.wire) return fail(409, 'PROVIDER_CHANGED', 'This provider changed since the conversation began. Start a new conversation.')
  } else {
    if (input.continue && !message) return fail(400, 'INVALID', 'Continue needs a conversation.', { field: 'conversationId' })
    const pid = input.providerId ?? defaultProviderId()
    row = pid ? getProvider(pid) : null
    if (!row) return fail(409, 'NO_PROVIDER', pid ? 'No such model provider.' : 'Add a model in Models first.')
  }
  const model = conversation ? conversation.model : (input.model ?? row.defaultModel)
  if (!model) return fail(400, 'NO_MODEL', 'Choose a model for this provider in Models.', { field: 'model' })
  if (row.wire === 'anthropic') {
    const problem = anthropicEnvProblem()
    if (problem) return fail(409, 'PROVIDER_ENV', problem)
  }
  const opened = openRowKey(row)
  if (!opened.ok) {
    return opened.reason === 'no-secret'
      ? fail(409, 'NO_SECRET', 'This server cannot open stored keys: its key-encryption secret is not set.')
      : fail(409, 'KEY_REENTER', 'This provider’s key has to be entered again in Models.')
  }
  const apiKey = opened.apiKey
  const quirks = quirksOf(row)
  const build = deps.adapter ?? createAdapter
  const adapter = build({ wire: row.wire, baseUrl: row.baseUrl, apiKey, quirks })

  if (!conversation) {
    const profile = await requestProfileFor(row, model, adapter)
    if (!profile.ok) return profile
    // The gap above awaited the network: re-check the one-run rule before anything is written.
    if (registry().current) return fail(409, 'RUN_ACTIVE', 'Another answer is still being written.', { runId: registry().current?.id, conversationId: registry().current?.conversationId })
    const tools = profile.profile.chatOnly ? [] : assistantTools()
    conversation = createConversation(
      {
        title: titleFrom(message),
        providerId: row.id,
        providerLabel: row.label,
        wire: row.wire,
        model,
        effort: profile.effortAllowed ? row.effort : null,
        systemText: profile.profile.chatOnly ? SYSTEM_PROMPT + CHAT_ONLY_NOTE : SYSTEM_PROMPT,
        tools,
        request: profile.profile,
      },
      clock(),
    )
  } else if (conversation.tools.length === 0 && !conversation.request.chatOnly) {
    return fail(409, 'PROVIDER_CHANGED', 'This conversation’s frozen tool list cannot be read. Start a new conversation.')
  }

  // Retention, at run start (no background job).
  try {
    pruneConversations(access.settings.keepConversationsDays, conversation.id, clock())
  } catch (err) {
    baseLog.warn('AI conversations could not be pruned', { err })
  }

  // The owner's message, with the server's facts in front of it.
  const runId = newId('r')
  let userTurnSeq: number | null = null
  const history = loadNative(conversation.id)
  const needsMessage = !!message || history.length === 0 || lastRoleIsAssistant(conversation.id)
  if (!message && input.continue && history.length === 0) return fail(409, 'NOTHING_TO_CONTINUE', 'There is nothing to continue.')
  insertRun({ id: runId, conversationId: conversation.id, sessionId: input.session.id }, clock())
  if (needsMessage) {
    const text = message || 'Continue.'
    const since = lastUserTurnAt(conversation.id) ?? conversation.createdAt
    let decisions: Decision[] = []
    try {
      decisions = decisionsSince(conversation.id, since, clock())
    } catch (err) {
      baseLog.warn('AI decisions could not be read for the next turn', { err })
    }
    const composed = composeUserTurn(text, { now: clock(), siteName: siteName(), languages: ['en', 'zh'], attachments: input.attachments ?? [], decisions })
    userTurnSeq = appendTurn(conversation.id, 'user', adapter.userTurn(composed), { kind: 'user', text: message || null, continued: !message, attachments: input.attachments ?? [] }, runId, clock())
  }

  const sessionVersion = sessionVersionNow()
  const controller = new AbortController()
  const handle: RunHandle = { id: runId, conversationId: conversation.id, sessionId: input.session.id, startedAt: clock(), controller, cause: null, done: Promise.resolve(null as unknown as RunEnd) }
  registry().current = handle
  bus.openChannel(runId, clock())
  bus.emit(runId, 'run', { runId, conversationId: conversation.id, title: conversation.title, provider: conversation.providerLabel, model: conversation.model, startedAt: handle.startedAt, userTurnSeq })
  if (userTurnSeq !== null) bus.emit(runId, 'turn', { seq: userTurnSeq, role: 'user', display: { kind: 'user', text: message || null, continued: !message, attachments: input.attachments ?? [] } })

  const authority = (): StopCause | null => {
    if (!aiAccess().on) return 'access-off'
    if (!liveSession(input.session.id, clock())) return 'session-ended'
    if (sessionVersion === null || sessionVersionNow() !== sessionVersion) return 'session-ended'
    return null
  }
  const watchdog = setInterval(() => {
    if (controller.signal.aborted) return
    const cause = authority()
    if (cause) stopRun(runId, cause)
  }, WATCHDOG_MS)
  watchdog.unref?.()

  const scrubLog = scrubbingLogger(baseLog, () => [apiKey])
  const actor = { kind: 'assistant' as const, runId, sessionId: input.session.id, provider: row.label, model: conversation.model }
  const guard = createLoopGuard()
  // A tool call that started finishes atomically: Stop never aborts it half-way (§7.5).
  const toolSignal = new AbortController().signal
  const settings = readAiSettings()
  const budget = new RunBudget({
    conversationId: conversation.id,
    conversationUsed: conversation.tokensWeighted,
    dayLimit: settings.dailyTokenLimit,
    wire: conversation.wire,
    maxOutputTokens: quirks.maxOutputTokens,
    modelCap: conversation.request.maxOutputCap,
    now: clock,
  })
  const conv = conversation
  const providerRow = row
  handle.done = (async (): Promise<RunEnd> => {
    let end: RunEnd
    try {
      end = await runLoop({
        runId,
        conversation: conv,
        adapter,
        budget,
        providerId: providerRow.id,
        userTurnSeq,
        signal: controller.signal,
        stopCause: () => handle.cause,
        authority,
        runTool: (name, args) => executeTool(name, args, { actor, scopes: ALL_SCOPES, origin: { ipPrefix: input.session.ipPrefix, country: input.session.country }, era: null, requestId: runId, signal: toolSignal, log: scrubLog, loop: guard }),
        emit: (type, data) => bus.emit(runId, type, data),
        log: scrubLog,
        now: clock,
      })
    } catch (err) {
      // A bug, never a provider answer: nothing of the conversation is logged.
      scrubLog.error('AI run failed unexpectedly', { runId, err })
      end = { state: 'failed', reason: 'internal', message: 'The assistant failed unexpectedly. The conversation is kept as it was.' }
    } finally {
      clearInterval(watchdog)
    }
    try {
      finishRun(runId, end.state, end.reason, clock())
    } catch (err) {
      scrubLog.error('AI run end could not be stored', { runId, err })
    }
    try {
      touchProvider(providerRow.id, clock())
    } catch {
      // last_used_at is informational.
    }
    if (registry().current === handle) registry().current = null
    bus.emit(runId, 'run_end', { state: end.state, reason: end.reason, message: end.message, ...(end.detail ? { detail: end.detail } : {}) }, clock())
    return end
  })()
  return { ok: true, run: handle, conversation: conv }
}

function lastRoleIsAssistant(conversationId: string): boolean {
  const rows = getAiDb().prepare("SELECT role FROM ai_turns WHERE conversation_id = ? AND native_json != 'null' ORDER BY seq DESC LIMIT 1").get(conversationId) as { role: string } | undefined
  return rows?.role === 'assistant'
}

// ── The browser's view of a run: server-sent events ──────────────────────

/** A ping every 15 s keeps the stream inside Cloudflare's 125 s proxy read timeout (§7.7). */
export const HEARTBEAT_MS = 15_000

type Writable = {
  writeHead(status: number, headers: Record<string, string>): unknown
  write(chunk: string): boolean
  end(): unknown
  flushHeaders?: () => void
  destroyed?: boolean
  writableEnded?: boolean
  on(event: 'close', fn: () => void): unknown
}

function frame(e: { seq: number; type: string; data: unknown }): string {
  return `id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`
}

/**
 * Stream a run's events from `after` to `res`, until the run ends or the
 * browser goes away — which stops only this view, never the run. Same-origin
 * `fetch` reads it (CSP `connect-src 'self'`); `no-transform` keeps any
 * compression or proxy from buffering it.
 */
export function pipeRun(res: Writable, runId: string, after: number): Promise<void> {
  return new Promise((resolve) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    })
    res.flushHeaders?.()
    let closed = false
    const live: { ping?: ReturnType<typeof setInterval>; stop?: () => void } = {}
    const finish = () => {
      if (closed) return
      closed = true
      clearInterval(live.ping)
      live.stop?.()
      if (!res.writableEnded) res.end()
      resolve()
    }
    const write = (text: string) => {
      if (closed || res.destroyed) return
      res.write(text)
    }
    // The response's close, not the request's: a request emits `close` once its body was read.
    res.on('close', finish)

    const sub = bus.subscribe(runId, after, (e) => {
      write(frame(e))
      if (e.type === 'run_end') finish()
    })
    if (!sub) {
      // Not driven by this process (ended long ago, or before a restart): its stored end is the whole story.
      const view = runView(runId)
      write(frame({ seq: after + 1, type: 'run_end', data: { state: view?.state ?? 'interrupted', reason: view?.reason ?? null, message: view?.state === 'interrupted' ? 'This run was interrupted when the server restarted.' : null, stored: true } }))
      finish()
      return
    }
    live.stop = sub.stop
    for (const e of sub.replay) write(frame(e))
    if (sub.ended && sub.replay.some((e) => e.type === 'run_end')) return finish()
    if (sub.ended) {
      // Ended before `after`: say so once more, so the viewer knows it is over.
      const view = runView(runId)
      write(frame({ seq: bus.lastSeq(runId), type: 'run_end', data: { state: view?.state ?? 'finished', reason: view?.reason ?? null, message: null, stored: true } }))
      return finish()
    }
    live.ping = setInterval(() => write(`event: ping\ndata: {}\n\n`), HEARTBEAT_MS)
    live.ping.unref?.()
  })
}

export type RunView = { id: string; conversationId: string; state: RunRow['state']; reason: string | null; startedAt: number; finishedAt: number | null; live: boolean; lastSeq: number }

/** A run as the admin sees it; a `running` row no process drives reads `interrupted` (and is stored so). */
export function runView(runId: string): RunView | null {
  const live = registry().current?.id === runId
  if (!live) interruptOrphans(new Set(registry().current ? [registry().current!.id] : []))
  const row = getRun(runId)
  if (!row) return null
  return { id: row.id, conversationId: row.conversationId, state: row.state, reason: row.reason, startedAt: row.startedAt, finishedAt: row.finishedAt, live, lastSeq: bus.lastSeq(runId) }
}
