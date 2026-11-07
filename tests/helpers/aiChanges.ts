/**
 * Drives the owner's change routes (pages/api/admin/ai/changes/*) the way
 * the admin page does: read the card, send its preview hash back to
 * approve. On the editorial harness's signed-in session. Import inside a
 * test, after the harness moved the working directory. Test-only.
 */
import type { CallResult, Handler } from '../editorialHarness'

type Harness = { call: (handler: Handler, opts?: { method?: string; query?: Record<string, unknown>; body?: unknown; headers?: Record<string, string>; auth?: boolean; ip?: string }) => Promise<CallResult> }

export async function changeRoutes(h: Harness) {
  const item = (await import('../../pages/api/admin/ai/changes/[id]/index')).default as Handler
  const approveRoute = (await import('../../pages/api/admin/ai/changes/[id]/approve')).default as Handler
  const rejectRoute = (await import('../../pages/api/admin/ai/changes/[id]/reject')).default as Handler
  const undoRoute = (await import('../../pages/api/admin/ai/changes/[id]/undo')).default as Handler
  const listRoute = (await import('../../pages/api/admin/ai/changes/index')).default as Handler
  // A different client address per decision keeps long scenarios under the routes' per-client limit.
  let n = 0
  const ip = () => `127.0.${Math.floor(++n / 200) % 200}.${(n % 200) + 20}`
  const card = (id: string) => h.call(item, { query: { id }, ip: ip() })
  return {
    card,
    /** Approve with the hash the card shows now, or the one given. */
    async approve(id: string, hash?: string) {
      const shown = hash ?? (await card(id)).body?.preview_sha256
      return h.call(approveRoute, { method: 'POST', query: { id }, body: { preview_sha256: shown }, ip: ip() })
    },
    reject: (id: string, note?: string) => h.call(rejectRoute, { method: 'POST', query: { id }, body: note === undefined ? {} : { note }, ip: ip() }),
    undo: (id: string) => h.call(undoRoute, { method: 'POST', query: { id }, ip: ip() }),
    list: (state: 'waiting' | 'done' | 'all' = 'waiting') => h.call(listRoute, { query: { state }, ip: ip() }),
  }
}
