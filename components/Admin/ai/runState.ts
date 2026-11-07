import type { ConversationDetail, DisplayTurn, RunEnd, ToolsDisplay } from './types'

/**
 * A conversation as the assistant view draws it, and how a run's events
 * change it (pure; unit tested in tests/ai-assistant-ui).
 *
 * Finished turns come from the conversation (GET conversations/<id>) and from
 * `turn` events, keyed by their seq, so a turn seen twice (loaded, then
 * replayed after a reload) is drawn once. The turn being written is `live`:
 * its text, progress notes, running tools and notices, rebuilt from deltas
 * and dropped when its `turn` event arrives (the server's finished turn
 * replaces it exactly). Frames of the followed run at or below `lastSeq` are
 * ignored, so a re-attach that overlaps never doubles a word.
 */

export type LiveTool = { id: string; name: string; title: string | null; done: boolean; ok: boolean | null; code: string | null }

export type LiveNotice = { kind: string; message: string | null; from: string | null; to: string | null }

export type LiveRun = {
  runId: string
  text: string
  thinking: string[]
  /** The thinking block the last note belongs to, and whether that note is still open (no other event since). */
  thinkingBlock: number | null
  thinkingOpen: boolean
  tools: LiveTool[]
  notices: LiveNotice[]
}

export type RunUsage = { usageIn: number; cachedRead: number; cacheWrite: number; usageOut: number; reasoning: number; estimated: boolean; calls: number; runWeighted: number }

export type Transcript = {
  conversationId: string | null
  title: string | null
  turns: DisplayTurn[]
  live: LiveRun | null
  /** The run this view follows (or followed last) and the last seq it applied. */
  runId: string | null
  lastSeq: number
  usage: RunUsage | null
  end: RunEnd | null
  /** Change ids the followed run reported (a write or a proposal), in order. */
  changes: Array<{ id: string; status: string | null; tool: string | null }>
}

export type Frame = { event: string; id: number | null; data: unknown }

export function emptyTranscript(): Transcript {
  return { conversationId: null, title: null, turns: [], live: null, runId: null, lastSeq: 0, usage: null, end: null, changes: [] }
}

/** A loaded conversation (no run followed yet). */
export function fromConversation(detail: ConversationDetail): Transcript {
  return { ...emptyTranscript(), conversationId: detail.conversation.id, title: detail.conversation.title, turns: sortTurns(detail.turns) }
}

/** Turns loaded again (after a run ended): the server's list wins, the followed run's state stays. */
export function withTurns(t: Transcript, detail: ConversationDetail): Transcript {
  if (t.conversationId !== detail.conversation.id) return t
  return { ...t, title: detail.conversation.title, turns: sortTurns(detail.turns) }
}

/** Follow `runId` from its first event (after a reload: the replay rebuilds the turn being written). */
export function followFromStart(t: Transcript, runId: string): Transcript {
  return { ...t, runId, lastSeq: 0, live: null, usage: null, end: null, changes: [] }
}

function sortTurns(turns: readonly DisplayTurn[]): DisplayTurn[] {
  const bySeq = new Map<number, DisplayTurn>()
  for (const turn of turns) if (turn && Number.isInteger(turn.seq)) bySeq.set(turn.seq, turn)
  return Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq)
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

function newLive(runId: string): LiveRun {
  return { runId, text: '', thinking: [], thinkingBlock: null, thinkingOpen: false, tools: [], notices: [] }
}

/** Apply one event of a run's stream. Unknown events change nothing. */
export function applyFrame(t: Transcript, frame: Frame): Transcript {
  const data = obj(frame.data)
  if (frame.event === 'ping') return t

  if (frame.event === 'run') {
    const runId = str(data.runId)
    if (!runId) return t
    const same = t.runId === runId
    const next: Transcript = {
      ...t,
      conversationId: str(data.conversationId) ?? t.conversationId,
      title: str(data.title) ?? t.title,
      runId,
      lastSeq: same ? t.lastSeq : 0,
      usage: same ? t.usage : null,
      end: null,
      changes: same ? t.changes : [],
      live: newLive(runId),
    }
    return frame.id !== null ? { ...next, lastSeq: Math.max(next.lastSeq, frame.id) } : next
  }

  // Every other event belongs to the run this view follows; a frame already applied is skipped.
  if (frame.id !== null && frame.id <= t.lastSeq) return t
  const lastSeq = frame.id !== null ? Math.max(t.lastSeq, frame.id) : t.lastSeq
  const live = t.live ? { ...t.live } : t.runId ? newLive(t.runId) : null
  if (live && frame.event !== 'thinking') live.thinkingOpen = false

  switch (frame.event) {
    case 'turn': {
      const seq = data.seq
      const role = data.role
      if (typeof seq !== 'number' || (role !== 'user' && role !== 'assistant' && role !== 'tool')) return { ...t, lastSeq }
      const turn: DisplayTurn = { seq, role, display: data.display as DisplayTurn['display'], inHistory: true, runId: t.runId, createdAt: Date.now() }
      // A display-only turn (stopped, failed, declined) is not in the history; the reload after the run says so exactly.
      const d = obj(data.display)
      if (d.stopped === true || d.failed === true || d.kind === 'declined') turn.inHistory = false
      const existing = t.turns.find((x) => x.seq === seq)
      const turns = sortTurns([...t.turns.filter((x) => x.seq !== seq), existing ? { ...existing, display: turn.display } : turn])
      if (live) {
        if (role === 'assistant') {
          live.text = ''
          live.thinking = []
          live.thinkingBlock = null
          live.notices = live.notices.filter((n) => n.kind === 'fallback')
        }
        if (role === 'tool') live.tools = []
      }
      return { ...t, turns, live, lastSeq }
    }
    case 'text':
      if (!live) return { ...t, lastSeq }
      live.text += str(data.delta) ?? ''
      return { ...t, live, lastSeq }
    case 'thinking': {
      if (!live) return { ...t, lastSeq }
      const delta = str(data.delta) ?? ''
      const block = typeof data.block === 'number' ? data.block : null
      if (live.thinkingOpen && live.thinkingBlock === block && live.thinking.length) {
        live.thinking = [...live.thinking.slice(0, -1), live.thinking[live.thinking.length - 1] + delta]
      } else live.thinking = [...live.thinking, delta]
      live.thinkingOpen = true
      live.thinkingBlock = block
      return { ...t, live, lastSeq }
    }
    case 'tool_start': {
      if (!live) return { ...t, lastSeq }
      const id = str(data.id)
      if (!id) return { ...t, live, lastSeq }
      live.tools = [...live.tools.filter((x) => x.id !== id), { id, name: str(data.name) ?? '', title: str(data.title), done: false, ok: null, code: null }]
      return { ...t, live, lastSeq }
    }
    case 'tool_end': {
      if (!live) return { ...t, lastSeq }
      const id = str(data.id)
      live.tools = live.tools.map((x) => (x.id === id ? { ...x, done: true, ok: data.ok === true, code: str(data.code) } : x))
      return { ...t, live, lastSeq }
    }
    case 'change': {
      const id = str(data.id)
      if (!id || !/^ch_[a-z2-7]{16}$/.test(id) || t.changes.some((c) => c.id === id)) return { ...t, live, lastSeq }
      return { ...t, live, lastSeq, changes: [...t.changes, { id, status: str(data.status), tool: str(data.tool) }] }
    }
    case 'notice': {
      if (!live) return { ...t, lastSeq }
      live.notices = [...live.notices, { kind: str(data.kind) ?? 'notice', message: str(data.message), from: str(data.from), to: str(data.to) }]
      return { ...t, live, lastSeq }
    }
    case 'usage': {
      const u = t.usage ?? { usageIn: 0, cachedRead: 0, cacheWrite: 0, usageOut: 0, reasoning: 0, estimated: false, calls: 0, runWeighted: 0 }
      return {
        ...t,
        live,
        lastSeq,
        usage: {
          usageIn: u.usageIn + num(data.usageIn),
          cachedRead: u.cachedRead + num(data.cachedRead),
          cacheWrite: u.cacheWrite + num(data.cacheWrite),
          usageOut: u.usageOut + num(data.usageOut),
          reasoning: u.reasoning + num(data.reasoning),
          estimated: u.estimated || data.estimated === true,
          calls: u.calls + 1,
          runWeighted: num(data.runWeighted) || u.runWeighted,
        },
      }
    }
    case 'run_end': {
      const state = str(data.state)
      const end: RunEnd = {
        state: (state as RunEnd['state']) ?? 'finished',
        reason: str(data.reason),
        message: str(data.message),
        ...(data.detail && typeof data.detail === 'object' ? { detail: data.detail as Record<string, unknown> } : {}),
        ...(data.stored === true ? { stored: true } : {}),
      }
      return { ...t, live: null, end, lastSeq }
    }
    default:
      return { ...t, live, lastSeq }
  }
}

/** Is the followed run still being written? */
export const isRunning = (t: Transcript): boolean => t.live !== null

/**
 * The changes a tools turn produced: a draft write (`saved`), a proposal
 * (`waiting_for_owner`) or a suggestion for an open editor (`sent_to_editor`),
 * as executeTool answered. Reads (get_change and the
 * like) name changes too and are not cards. The result is the server's own
 * JSON (capped at 4 KB, where change_id sits near the start).
 */
export function changesOfTools(display: ToolsDisplay): string[] {
  const out: string[] = []
  for (const r of display.results ?? []) {
    if (!r || !r.ok || typeof r.result !== 'string') continue
    let id: string | null = null
    let status: string | null = null
    try {
      const v = JSON.parse(r.result)
      if (v && typeof v === 'object') {
        id = typeof v.change_id === 'string' ? v.change_id : null
        status = typeof v.status === 'string' ? v.status : null
      }
    } catch {
      // A result cut at 4 KB: the leading fields are still whole.
      id = /"change_id":"(ch_[a-z2-7]{16})"/.exec(r.result)?.[1] ?? null
      status = /^\{"status":"([a-z_]{1,40})"/.exec(r.result)?.[1] ?? null
    }
    if (id && /^ch_[a-z2-7]{16}$/.test(id) && (status === 'saved' || status === 'waiting_for_owner' || status === 'sent_to_editor') && !out.includes(id)) out.push(id)
  }
  return out
}

/** The owner's most recent message (Ask again puts it back; ↑ recalls it). */
export function lastUserText(turns: readonly DisplayTurn[], beforeSeq = Number.POSITIVE_INFINITY): string | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]
    if (turn.seq >= beforeSeq) continue
    const d = turn.display as { kind?: string; text?: unknown }
    if (turn.role === 'user' && d.kind === 'user' && typeof d.text === 'string' && d.text.trim()) return d.text
  }
  return null
}

/** The last turn the provider will see: Continue goes on from a tool result or a cut answer; Retry re-sends a message. */
export function lastHistoryRole(turns: readonly DisplayTurn[]): DisplayTurn['role'] | null {
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i].inHistory) return turns[i].role
  return null
}
