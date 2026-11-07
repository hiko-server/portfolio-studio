/**
 * The live events of assistant runs (SERVER-ONLY, design §7.7). A run lives
 * on the server; an HTTP response is only a view of it, so this is where its
 * events wait for whoever is watching — the browser that started it, the
 * same browser after a reload, or none at all.
 *
 * Each event has a monotonically increasing `seq` within its run. The
 * channel keeps the run's `run` event, every `turn` event (a finished turn
 * as the admin renders it, also in ai.db) and every event since the last
 * finished turn; the deltas of finished turns are dropped, because their
 * `turn` event replaces them. So a viewer that re-attaches with
 * `after=<the last seq it saw>` gets exactly what it missed, and a dropped
 * connection never loses a finished step. Memory per run is bounded.
 *
 * On globalThis: one registry per process across Next's runtimes.
 */

export type BusEventType = 'run' | 'text' | 'thinking' | 'tool_start' | 'tool_end' | 'change' | 'editor_edit' | 'notice' | 'usage' | 'turn' | 'run_end'

export type BusEvent = { seq: number; type: BusEventType; data: Record<string, unknown> }

type Listener = (e: BusEvent) => void

type Channel = {
  runId: string
  seq: number
  events: BusEvent[]
  bytes: number
  listeners: Set<Listener>
  ended: boolean
  endedAt: number | null
}

/** Events kept per run while it streams one turn (a single turn is bounded by the provider byte cap). */
const MAX_PENDING_BYTES = 12 * 1024 * 1024
/** How long a finished run's channel stays, for a viewer that reconnects right after the end. */
export const ENDED_TTL_MS = 10 * 60_000

type BusGlobal = typeof globalThis & { __aiBus?: Map<string, Channel> }
const g = globalThis as BusGlobal
const channels = (): Map<string, Channel> => (g.__aiBus ??= new Map())

function sweep(now: number) {
  for (const [id, ch] of channels()) if (ch.ended && ch.endedAt !== null && now - ch.endedAt > ENDED_TTL_MS && ch.listeners.size === 0) channels().delete(id)
}

/** Open the channel of a new run. */
export function openChannel(runId: string, now = Date.now()): void {
  sweep(now)
  channels().set(runId, { runId, seq: 0, events: [], bytes: 0, listeners: new Set(), ended: false, endedAt: null })
}

export function hasChannel(runId: string): boolean {
  return channels().has(runId)
}

/** The last seq a run has emitted (0 before any). */
export function lastSeq(runId: string): number {
  return channels().get(runId)?.seq ?? 0
}

/** Emit one event to every viewer of the run. */
export function emit(runId: string, type: BusEventType, data: Record<string, unknown>, now = Date.now()): BusEvent | null {
  const ch = channels().get(runId)
  if (!ch || ch.ended) return null
  const e: BusEvent = { seq: ++ch.seq, type, data }
  if (type === 'turn') {
    // A finished turn replaces the deltas that built it.
    ch.events = ch.events.filter((x) => x.type === 'run' || x.type === 'turn' || x.type === 'change' || x.type === 'usage' || x.type === 'notice')
    ch.bytes = ch.events.reduce((n, x) => n + sizeOf(x), 0)
  }
  ch.events.push(e)
  ch.bytes += sizeOf(e)
  while (ch.bytes > MAX_PENDING_BYTES) {
    // Never drop the run event or a finished turn; drop the oldest deltas.
    const at = ch.events.findIndex((x) => x.type === 'text' || x.type === 'thinking')
    if (at < 0) break
    ch.bytes -= sizeOf(ch.events[at])
    ch.events.splice(at, 1)
  }
  if (type === 'run_end') {
    ch.ended = true
    ch.endedAt = now
  }
  for (const l of [...ch.listeners]) {
    try {
      l(e)
    } catch {
      // A viewer that fails (its socket closed mid-write) is the viewer's problem, never the run's.
    }
  }
  return e
}

function sizeOf(e: BusEvent): number {
  try {
    return JSON.stringify(e.data).length + 32
  } catch {
    return 64
  }
}

/**
 * Watch a run from `after`: the kept events with a greater seq, then live
 * ones. Returns null when this process has no channel for the run (it ended
 * long ago, or before a restart). The returned function stops watching.
 */
export function subscribe(runId: string, after: number, listener: Listener): { replay: BusEvent[]; ended: boolean; stop: () => void } | null {
  const ch = channels().get(runId)
  if (!ch) return null
  const replay = ch.events.filter((e) => e.seq > after)
  ch.listeners.add(listener)
  return {
    replay,
    ended: ch.ended,
    stop: () => {
      ch.listeners.delete(listener)
    },
  }
}

/** For tests: forget every channel. */
export function resetBus(): void {
  channels().clear()
}
