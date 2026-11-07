import { useCallback, useEffect, useRef, useState } from 'react'
import { readJsonObject } from '../shell/http'
import { NETWORK_ERROR } from '../shell/authMessages'
import { isEventStream, readEventStream } from './sseClient'
import { applyFrame, emptyTranscript, followFromStart, fromConversation, withTurns, type Frame, type Transcript } from './runState'
import type { ConversationDetail } from './types'

/**
 * A conversation and the run writing into it, as the assistant view follows
 * them (design §7.5, §7.7).
 *
 * The run lives on the server; this is only a view of it. `send` POSTs
 * /api/admin/ai/runs and reads its event stream; `open` loads a conversation
 * and, when a run is writing into it (after a reload, or a visit from
 * another page), re-attaches from its first kept event, so the turn being
 * written is rebuilt and every finished one is drawn once. A dropped
 * connection re-attaches from the last seq seen. Closing the page or
 * switching conversation stops only this view; `stop` is what stops a run.
 *
 * Paints are batched to about 50 ms (a reply arrives a few characters at a
 * time); the start, a finished turn and the end are drawn at once.
 *
 * Only the latest request decides what is shown: each `open` aborts the one
 * before it, and an answer that is no longer the latest (the owner picked
 * another conversation, started a new chat or sent while it loaded) is
 * dropped before it can draw a transcript or attach to a run. While a
 * conversation loads, the transcript is that conversation's, empty, so the
 * page never shows one conversation's messages under another's address. The
 * same holds at a run's end: once a newer request has taken over (the next
 * message went while the finished one was still being read again), the old
 * end is not reported, and only a send's own end clears its pending message.
 */

export type StartProblem = { code: string; error: string; runId?: string; conversationId?: string; field?: string }

/** The reasons a stream re-attaches before giving up (a few seconds of a flaky connection). */
const REATTACH_TRIES = 5
const PAINT_MS = 50
const IMMEDIATE = new Set(['run', 'turn', 'run_end', 'change'])

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const id = window.setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      window.clearTimeout(id)
      resolve()
    }, { once: true })
  })

function parseData(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

export function useRun({ onUnauthorized, onEnded, onStarted }: { onUnauthorized: () => void; onEnded?: (t: Transcript) => void; onStarted?: (t: Transcript) => void }) {
  const [transcript, setTranscript] = useState<Transcript>(emptyTranscript)
  const current = useRef<Transcript>(transcript)
  const queue = useRef<Frame[]>([])
  const timer = useRef<number | null>(null)
  const stream = useRef<AbortController | null>(null)
  const [sending, setSending] = useState<string | null>(null)
  const [problem, setProblem] = useState<StartProblem | null>(null)
  const [stopping, setStopping] = useState(false)
  const [loadError, setLoadError] = useState<'not-found' | string | null>(null)
  /** A conversation is being loaded (nothing can be sent into it until it is shown). */
  const [opening, setOpening] = useState(false)
  /** The latest open, attach, reset or send: an older open's answer is dropped. */
  const latest = useRef(0)
  /** The latest send: only its own end clears the message on its way (an older run's end never clears a newer one's). */
  const sendSeq = useRef(0)
  const loader = useRef<AbortController | null>(null)
  const callbacks = useRef({ onUnauthorized, onEnded, onStarted })
  callbacks.current = { onUnauthorized, onEnded, onStarted }

  const commit = useCallback((next: Transcript) => {
    current.current = next
    setTranscript(next)
  }, [])

  const flush = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
    if (!queue.current.length) return
    let next = current.current
    const hadRun = next.live !== null
    for (const f of queue.current) next = applyFrame(next, f)
    queue.current = []
    commit(next)
    if (!hadRun && next.live) callbacks.current.onStarted?.(next)
  }, [commit])

  const enqueue = useCallback(
    (f: Frame) => {
      queue.current.push(f)
      if (IMMEDIATE.has(f.event)) flush()
      else if (timer.current === null) timer.current = window.setTimeout(flush, PAINT_MS)
    },
    [flush],
  )

  /** Read one response to its end: whether the run's end arrived, the connection dropped, or this view was closed. */
  const consume = useCallback(
    async (res: Response, ac: AbortController): Promise<'ended' | 'dropped' | 'aborted'> => {
      let ended = false
      try {
        await readEventStream(
          res,
          (f) => {
            if (f.event === 'run_end') ended = true
            enqueue({ event: f.event, id: f.id, data: parseData(f.data) })
          },
          ac.signal,
        )
      } catch {
        // A dropped connection: what arrived is kept, and the view re-attaches from it.
      }
      flush()
      if (ac.signal.aborted) return 'aborted'
      return ended ? 'ended' : 'dropped'
    },
    [enqueue, flush],
  )

  const reload = useCallback(
    async (conversationId: string, signal?: AbortSignal): Promise<ConversationDetail | null> => {
      try {
        const res = await fetch(`/api/admin/ai/conversations/${encodeURIComponent(conversationId)}`, { cache: 'no-store', credentials: 'same-origin', signal })
        if (res.status === 401) {
          callbacks.current.onUnauthorized()
          return null
        }
        if (!res.ok) return null
        return (await res.json()) as ConversationDetail
      } catch {
        return null
      }
    },
    [],
  )

  /** Follow a stream to the run's end, re-attaching after a dropped connection; then sync with the server's turns. */
  const follow = useCallback(
    async (res: Response, ac: AbortController) => {
      let outcome = await consume(res, ac)
      for (let tries = 1; outcome === 'dropped' && tries <= REATTACH_TRIES && !ac.signal.aborted; tries++) {
        await sleep(Math.min(8000, 400 * 2 ** tries), ac.signal)
        const t = current.current
        if (!t.runId || ac.signal.aborted) break
        let again: Response
        try {
          again = await fetch(`/api/admin/ai/runs/${encodeURIComponent(t.runId)}/events?after=${t.lastSeq}`, { cache: 'no-store', credentials: 'same-origin', signal: ac.signal })
        } catch {
          continue
        }
        if (again.status === 401) return callbacks.current.onUnauthorized()
        if (!again.ok || !isEventStream(again)) break
        outcome = await consume(again, ac)
      }
      if (outcome === 'aborted' || ac.signal.aborted) return
      if (outcome === 'dropped') {
        // The run may well go on on the server: say the view lost it; a reload follows it again.
        commit({ ...current.current, live: null, end: { state: 'failed', reason: 'connection', message: null } })
      }
      const id = current.current.conversationId
      if (id) {
        const detail = await reload(id, ac.signal)
        if (detail && !ac.signal.aborted) commit(withTurns(current.current, detail))
      }
      // A newer request took over while the conversation was read again (the next message was sent, another
      // conversation or a new chat opened): this run's end is no longer what the page shows, and saying it now
      // would speak over the newer one (its status line, its pending message, the cards' state).
      if (ac.signal.aborted) return
      if (stream.current === ac) stream.current = null
      setStopping(false)
      callbacks.current.onEnded?.(current.current)
    },
    [commit, consume, reload],
  )

  const closeStream = useCallback(() => {
    stream.current?.abort()
    stream.current = null
    queue.current = []
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
  }, [])

  /** A new request supersedes any conversation still loading. */
  const supersede = useCallback(() => {
    latest.current += 1
    loader.current?.abort()
    loader.current = null
    setOpening(false)
    return latest.current
  }, [])

  // Unmounted, a load still under way draws nothing and attaches to nothing. (Not aborted here: React's strict
  // mode runs this cleanup once between two mounts in development, and the load begun before it must still land.)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      closeStream()
    }
  }, [closeStream])

  const attach = useCallback(
    async (runId: string) => {
      supersede()
      closeStream()
      const ac = new AbortController()
      stream.current = ac
      commit(followFromStart(current.current, runId))
      let res: Response
      try {
        res = await fetch(`/api/admin/ai/runs/${encodeURIComponent(runId)}/events?after=0`, { cache: 'no-store', credentials: 'same-origin', signal: ac.signal })
      } catch {
        return
      }
      if (res.status === 401) return callbacks.current.onUnauthorized()
      if (!res.ok || !isEventStream(res)) return
      await follow(res, ac)
    },
    [closeStream, commit, follow, supersede],
  )

  /**
   * Show a conversation; re-attach when a run is writing into it. Resolves
   * null when it could not be shown, or when a later request superseded it
   * (then nothing of it was drawn).
   */
  const open = useCallback(
    async (conversationId: string): Promise<ConversationDetail | null> => {
      const mine = supersede()
      const ac = new AbortController()
      loader.current = ac
      closeStream()
      setProblem(null)
      setLoadError(null)
      setStopping(false)
      setOpening(true)
      // Another conversation's messages never stay on screen under this one's address.
      if (current.current.conversationId !== conversationId) commit({ ...emptyTranscript(), conversationId })
      const stale = () => latest.current !== mine || !mounted.current
      const done = () => {
        if (loader.current === ac) loader.current = null
        setOpening(false)
      }
      let res: Response
      try {
        res = await fetch(`/api/admin/ai/conversations/${encodeURIComponent(conversationId)}`, { cache: 'no-store', credentials: 'same-origin', signal: ac.signal })
      } catch {
        if (stale()) return null
        done()
        setLoadError(NETWORK_ERROR)
        return null
      }
      if (stale()) return null
      if (res.status === 401) {
        done()
        callbacks.current.onUnauthorized()
        return null
      }
      if (res.status === 404) {
        done()
        commit(emptyTranscript())
        setLoadError('not-found')
        return null
      }
      if (!res.ok) {
        const json = await readJsonObject(res)
        if (stale()) return null
        done()
        setLoadError(typeof json.error === 'string' ? json.error : `HTTP ${res.status}`)
        return null
      }
      let detail: ConversationDetail
      try {
        detail = (await res.json()) as ConversationDetail
      } catch {
        if (stale()) return null
        done()
        setLoadError(NETWORK_ERROR)
        return null
      }
      if (stale() || detail?.conversation?.id !== conversationId) return null
      done()
      commit(fromConversation(detail))
      if (detail.active?.live) void attach(detail.active.id)
      return detail
    },
    [attach, closeStream, commit, supersede],
  )

  /** A new chat: nothing shown, nothing followed. */
  const reset = useCallback(() => {
    supersede()
    closeStream()
    setProblem(null)
    setLoadError(null)
    setStopping(false)
    commit(emptyTranscript())
  }, [closeStream, commit, supersede])

  /**
   * Start a run: a message (new or existing conversation), or Continue/Retry
   * (`continue: true`, no message). Resolves true once the server accepted it.
   */
  const send = useCallback(
    async (body: { conversationId?: string | null; message?: string; continue?: boolean; providerId?: string | null; attachments?: unknown[] }): Promise<boolean> => {
      supersede()
      closeStream()
      setProblem(null)
      setStopping(false)
      setSending(body.message ?? '')
      const mine = ++sendSeq.current
      const settle = () => {
        if (sendSeq.current === mine) setSending(null)
      }
      const ac = new AbortController()
      stream.current = ac
      const payload: Record<string, unknown> = {}
      if (body.conversationId) payload.conversationId = body.conversationId
      if (body.message) payload.message = body.message
      if (body.continue) payload.continue = true
      if (!body.conversationId && body.providerId) payload.providerId = body.providerId
      // Chips, and from an open editor its state (lib/ai/attachments): the run is attached to that editor.
      if (body.attachments?.length) payload.attachments = body.attachments
      let res: Response
      try {
        res = await fetch('/api/admin/ai/runs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          credentials: 'same-origin',
          signal: ac.signal,
        })
      } catch {
        settle()
        if (!ac.signal.aborted) setProblem({ code: 'NETWORK', error: NETWORK_ERROR })
        return false
      }
      if (res.status === 401) {
        settle()
        callbacks.current.onUnauthorized()
        return false
      }
      if (!isEventStream(res)) {
        const json = await readJsonObject(res)
        settle()
        setProblem({
          code: typeof json.code === 'string' ? json.code : `HTTP_${res.status}`,
          error: typeof json.error === 'string' ? json.error : `HTTP ${res.status}`,
          ...(typeof json.runId === 'string' ? { runId: json.runId } : {}),
          ...(typeof json.conversationId === 'string' ? { conversationId: json.conversationId } : {}),
          ...(typeof json.field === 'string' ? { field: json.field } : {}),
        })
        return false
      }
      // A new run: follow it from its first event.
      if (current.current.runId) commit({ ...current.current, runId: null, lastSeq: 0 })
      void follow(res, ac).finally(settle)
      // The run event arrives first; the pending message stays on screen until its turn does.
      return true
    },
    [closeStream, commit, follow, supersede],
  )

  /** Stop the run being written (the server keeps what finished; proposals stay waiting). */
  const stop = useCallback(async () => {
    const t = current.current
    if (!t.runId || !t.live) return
    setStopping(true)
    try {
      const res = await fetch(`/api/admin/ai/runs/${encodeURIComponent(t.runId)}/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        credentials: 'same-origin',
      })
      if (res.status === 401) callbacks.current.onUnauthorized()
      if (!res.ok) setStopping(false)
    } catch {
      setStopping(false)
    }
  }, [])

  // The message being sent shows until the server's own user turn replaces it.
  useEffect(() => {
    if (sending === null || !transcript.live) return
    if (sending === '' || transcript.turns.some((x) => x.runId === transcript.runId && x.role === 'user')) setSending(null)
  }, [sending, transcript])

  return { transcript, open, reset, send, stop, attach, sending, problem, clearProblem: () => setProblem(null), stopping, loadError, opening, reloadTurns: reload, commit }
}
