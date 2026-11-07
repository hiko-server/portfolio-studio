import { useEffect, useRef } from 'react'
import type { Transcript } from './runState'
import type { RunView } from './types'

/** While an answer this view does not follow is being written, how often the page asks whether it still is. */
export const WATCH_MS = 3000

/**
 * The answer being written that this view does not follow, or null: another
 * conversation's, or one the owner left while it was written (New chat,
 * another conversation). A run this view follows says its own end.
 */
export function unfollowedRun(writing: RunView | null, transcript: Pick<Transcript, 'runId' | 'live'>): string | null {
  if (!writing?.live) return null
  return transcript.live && transcript.runId === writing.id ? null : writing.id
}

/**
 * The end of an answer this view does not follow (design §7.7: one run at a
 * time). Its event stream isn't read here, so while `runId` is set the view
 * asks GET /api/admin/ai/runs every WATCH_MS while the page is visible, and at
 * once when the page comes back into view, and calls `onOver` with what is
 * being written now (null, or another run) once it is no longer that one.
 * Without it, "another conversation is being answered", the rail's dot and a
 * disabled Send would outlive the answer until a reload.
 */
export function useRunWatch(runId: string | null, handlers: { onOver: (runId: string, active: RunView | null) => void; onUnauthorized: () => void }): void {
  const callbacks = useRef(handlers)
  callbacks.current = handlers

  useEffect(() => {
    if (!runId) return
    let cancelled = false
    let asking = false
    const ask = async () => {
      if (cancelled || asking || document.visibilityState !== 'visible') return
      asking = true
      try {
        const res = await fetch('/api/admin/ai/runs', { cache: 'no-store', credentials: 'same-origin' })
        if (cancelled) return
        if (res.status === 401) return callbacks.current.onUnauthorized()
        if (!res.ok) return
        const json = (await res.json()) as { active?: RunView | null }
        if (cancelled) return
        const active = json.active && json.active.live ? json.active : null
        if (active?.id !== runId) callbacks.current.onOver(runId, active)
      } catch {
        // A missed answer is asked again at the next tick.
      } finally {
        asking = false
      }
    }
    const timer = window.setInterval(() => void ask(), WATCH_MS)
    const onBack = () => void ask()
    document.addEventListener('visibilitychange', onBack)
    window.addEventListener('focus', onBack)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onBack)
      window.removeEventListener('focus', onBack)
    }
  }, [runId])
}
