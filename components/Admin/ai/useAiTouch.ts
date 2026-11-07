import { useEffect, useState } from 'react'

/** The AI change a document's current version came from (GET /api/admin/ai/changes?touching=). */
export type AiTouch = { id: string; title: string; kind: string }

/** Only these change ids are linked (lib/ai/apply CHANGE_ID_RE). */
const CHANGE_ID_RE = /^ch_[a-z2-7]{16}$/

/**
 * "Contains AI edits" (design §4.6, §8.2): whether what the owner is about
 * to publish or schedule came from AI — the document's current version is
 * the one an applied AI change wrote (asked of the server while `enabled`,
 * i.e. while the publish sheet or the schedule dialog is open), or the
 * editor holds AI-suggested edits it has not saved (`localChangeId`, the
 * editor's AI-touched state). Null when neither: nothing is shown, and the
 * server is only asked while the sheet is open. Small, so the editors carry
 * it without loading any of the assistant.
 */
export function useAiTouch(target: { kind: 'blog' | 'work' | 'page'; ref: string } | null, enabled: boolean, localChangeId: string | null = null): (AiTouch & { local: boolean }) | null {
  const [saved, setSaved] = useState<AiTouch | null>(null)
  const key = target ? `${target.kind}/${target.ref}` : null
  useEffect(() => {
    if (!enabled || !key) return
    let alive = true
    void fetch(`/api/admin/ai/changes?touching=${encodeURIComponent(key)}`, { cache: 'no-store', credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) return null
        const json = (await res.json()) as { touching?: { id?: unknown; title?: unknown; kind?: unknown } | null }
        const t = json.touching
        return t && typeof t.id === 'string' && CHANGE_ID_RE.test(t.id) ? { id: t.id, title: typeof t.title === 'string' ? t.title : '', kind: typeof t.kind === 'string' ? t.kind : '' } : null
      })
      .catch(() => null)
      .then((t) => {
        if (alive) setSaved(t)
      })
    return () => {
      alive = false
    }
  }, [enabled, key])
  if (localChangeId && CHANGE_ID_RE.test(localChangeId)) return { id: localChangeId, title: '', kind: '', local: true }
  return enabled && saved ? { ...saved, local: false } : null
}
